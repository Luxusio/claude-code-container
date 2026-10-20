import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { readProcessIdentity, inspectProcessIdentity, signalOwnedRuntimeProcess } from '../state/process-identity.mjs';
import { createLocalOutputStage, restoreLocalOutputStage, populateLocalOutputStage, commitLocalOutputStage } from '../transfer-file.mjs';
import { createDirectRecordingApplication } from '../application/direct-recording.mjs';
import { recordingIdentityAvailable } from '../domain/direct-recording.mjs';
import { createWaitBudget } from '../wait-budget.mjs';
/** @typedef {import('../ports/direct-recording.mjs').DirectRecordingNative} Native
 * @typedef {import('../ports/direct-recording.mjs').RecordingNativeProcess} ProcessNative */
/** Native POSIX command encoding, never an application decision. @param {string} value */
function shellQuote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
/** @param {import('../domain/direct-recording.mjs').AdbRecordingTarget|import('../domain/direct-recording.mjs').SimulatorRecordingTarget|import('../domain/direct-recording.mjs').MacosRecordingTarget} target
 * @param {{remotePath:string,outputPath:string}} paths @param {number|null} timeLimitSec
 * @returns {import('../domain/direct-recording.mjs').RecordingCommand} */
function recorderCommand(target, paths, timeLimitSec) {
    if (target.kind === 'adb') return { executable: target.executable, args: [...target.prefix, 'shell', 'screenrecord', '--time-limit', String(timeLimitSec), paths.remotePath] };
    if (target.kind === 'simulator') return { executable: target.executable, args: ['simctl', 'io', target.target, 'recordVideo', paths.outputPath] };
    const limit = timeLimitSec ? `sleep ${Number(timeLimitSec)}; pkill -INT -f ${shellQuote(`screencapture.*${paths.remotePath}`)}` : 'wait';
    return { executable: target.executable, args: [...target.prefix, target.target, [`rm -f ${shellQuote(paths.remotePath)}`, `(screencapture -v ${shellQuote(paths.remotePath)} &)`, limit].join('; ')], env: target.env };
}
/** @param {(command:import('../domain/direct-recording.mjs').RecordingCommand)=>import('../ports/direct-recording.mjs').RecordingCommandResult} runCommand
 * @returns {import('../ports/direct-recording.mjs').RecordingRemoteEffects} */
function remoteEffects(runCommand) {
    return {
        fallbackStop: (target, remote, timeoutMs) => runCommand(target.kind === 'adb'
            ? { executable: target.executable, args: [...target.prefix, 'shell', 'pkill', '-2', 'screenrecord'] }
            : { executable: target.executable, args: [...target.prefix, target.target, `pkill -INT -f ${shellQuote(`screencapture.*${remote}`)} || true`], env: target.env, timeoutMs }),
        copyRecording: (target, remote, stagedPath, timeoutMs) => {
            const copied = runCommand(target.kind === 'adb'
                ? { executable: target.executable, args: [...target.prefix, 'pull', remote, stagedPath], timeoutMs }
                : { executable: target.scp, args: [...target.scpPrefix, `${target.target}:${remote}`, stagedPath], env: target.env, timeoutMs });
            return { ok: copied.status === 0, detail: copied.stderr || copied.stdout || `exit ${copied.status}`, output: { stdout: copied.stdout, stderr: copied.stderr, ...(target.kind === 'adb' ? { status: copied.status } : {}) } };
        },
        removeRecording: (target, remote, timeoutMs) => runCommand(target.kind === 'adb'
            ? { executable: target.executable, args: [...target.prefix, 'shell', 'rm', '-f', remote], timeoutMs }
            : { executable: target.executable, args: [...target.prefix, target.target, `rm -f ${shellQuote(remote)}`], env: target.env, timeoutMs }),
    };
}
/** @param {unknown} pid */
function alive(pid) {
    if (typeof pid !== 'number' || !pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}
/** @param {unknown} pid @param {number} timeoutMs */
async function waitExit(pid, timeoutMs) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        if (!alive(pid)) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return !alive(pid);
}
/** @param {import('../ports/direct-recording.mjs').RecordingNativeCommon} native
 * @returns {import('../ports/direct-recording.mjs').RecordingCommonPorts} */
function common(native) {
    return {
        findDevice: id => native.findDevice(id),
        updateDevice: (id, update) => native.updateDevice(id, update),
        runtimeId: () => randomUUID(),
        timestamp: () => new Date().toISOString(),
        localPath: device => native.localPath(device),
        validatePath: path => native.validateLocalOutputPath(path, { label: 'recording-local-path' }),
        prepareOutput: (_device, path) => { mkdirSync(dirname(path), { recursive: true }); return undefined; },
    };
}
/** @param {ProcessNative} native @returns {import('../ports/direct-recording.mjs').RecordingProcessPorts & Pick<import('../ports/direct-recording.mjs').SimulatorRecordingPorts,'restoreStage'|'populateStage'>} */
function processBindings(native) {
    return {
        spawnRecorder(target, paths, timeLimitSec, exited) {
            const command = recorderCommand(target, paths, timeLimitSec);
            const child = spawn(command.executable, command.args, { detached: true, stdio: 'ignore', env: { ...process.env, ...command.env }, windowsHide: true });
            child.once('exit', exited);
            return {
                pid: child.pid,
                /** @param {number} timeoutMs @returns {ReturnType<import('../ports/direct-recording.mjs').RecorderHandle['startup']>} */
                startup(timeoutMs) {
                    return new Promise(resolve => {
                        let settled = false;
                        /** @param {Awaited<ReturnType<import('../ports/direct-recording.mjs').RecorderHandle['startup']>>} result */
                        const done = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
                        const timer = setTimeout(() => done({ kind: 'ready' }), timeoutMs);
                        child.once('error', error => done({ kind: 'error', message: error.message }));
                        child.once('exit', (code, signal) => done({ kind: 'exit', code, signal }));
                    });
                },
                signal: signal => { child.kill(signal); return undefined; },
                unref: () => { child.unref(); return undefined; },
            };
        },
        readIdentity: pid => readProcessIdentity(pid),
        observe: (identity, pid, remainingMs) => ({ status: inspectProcessIdentity(identity, pid, { remainingMs }).status }),
        alive,
        signal: (recording, remainingMs) => { const result = signalOwnedRuntimeProcess(recording, 'SIGINT', { remainingMs }); return { signaled: result.signaled, ...(result.exited !== undefined ? { exited: result.exited } : {}), ...(result.reason ? { reason: result.reason } : {}) }; },
        waitExit,
        createStage: (device, path, persistent) => {
            const result = createLocalOutputStage(path, { label: 'recording-local-path', ...(persistent ? { stageParent: native.recordingDirectory(device), stagePrefix: '.recording-stage-' } : {}) });
            return result.ok ? { ok: true, stage: result } : { ok: false, message: result.message };
        },
        restoreStage: (device, path, stagedPath) => {
            const result = restoreLocalOutputStage(path, stagedPath, { label: 'recording-local-path', stageParent: native.recordingDirectory(device), stagePrefix: '.recording-stage-' });
            return result.ok ? { ok: true, stage: result } : { ok: false, message: result.message };
        },
        populateStage: (source, stage) => {
            const result = populateLocalOutputStage(source, stage, { label: 'recording-local-path-stage' });
            return result.ok ? { ok: true } : { ok: false, message: result.message };
        },
        commitStage: stage => {
            const result = commitLocalOutputStage(stage, { label: 'recording-local-path', minBytes: 1 });
            return result.ok ? { ok: true } : { ok: false, message: result.message };
        },
        disposeStage: stage => { stage.cleanup(); return undefined; },
    };
}
/** Actual checked native producer. No backend imports or whole recording workflow is supplied.
 * @param {Native} native @returns {import('../ports/direct-recording.mjs').RecordingApplication} */
export function createDirectRecording(native) {
    const base = common(native);
    if (native.kind === 'windows-sandbox') {
        /** @type {import('../ports/direct-recording.mjs').SandboxRecordingPorts} */
        const ports = { ...base, kind: native.kind,
            helper: (device, action, request, timeout) => native.helperRequest(device, action, request, timeout),
            archivePath: (helper, path, name) => native.verifiedArchivePath(helper, path, name),
            copyArchive: (source, destination) => native.copyFile(source, destination),
        };
        return createDirectRecordingApplication(ports);
    }
    const processPorts = processBindings(native);
    if (native.kind === 'ios-simulator') {
        /** @type {import('../ports/direct-recording.mjs').SimulatorRecordingPorts} */
        const ports = { ...base, ...processPorts, kind: native.kind,
            target: (device, operation) => native.resolveTarget(device, operation),
            prepareOutput: (device, path) => { mkdirSync(native.recordingDirectory(device), { recursive: true }); mkdirSync(dirname(path), { recursive: true }); return undefined; },
        };
        return createDirectRecordingApplication(ports);
    }
    if (native.kind === 'macos-vm') {
        /** @type {import('../ports/direct-recording.mjs').MacosRecordingPorts} */
        const ports = { ...base, ...processPorts, kind: native.kind,
            target: (device, operation) => native.resolveTarget(device, operation),
            ...remoteEffects(command => native.runCommand(command)),
            prepareWorkspace: device => native.ensureWorkspace(device),
        };
        return createDirectRecordingApplication(ports);
    }
    /** @type {import('../ports/direct-recording.mjs').AndroidRecordingPorts} */
    const ports = { ...base, ...processPorts, kind: native.kind,
        target: (device, operation, validation) => native.resolveTarget(device, operation, validation),
        ...remoteEffects(command => native.runCommand(command)),
        budget: (timeoutMs, intervalMs) => createWaitBudget(timeoutMs, intervalMs),
        observe: (identity, pid, remainingMs) => recordingIdentityAvailable(identity, pid)
            ? processPorts.observe(identity, pid, remainingMs) : { status: 'unavailable' },
        signal: (recording, remainingMs) => recordingIdentityAvailable(recording.processIdentity, recording.pid)
            ? processPorts.signal(recording, remainingMs) : { signaled: false, reason: 'runtime-process-identity-unavailable' },
        fallbackStop(target, _remote, timeoutMs) {
            if (!(timeoutMs >= 1)) return { ok: false };
            try {
                const result = native.runCommand({ executable: target.executable, args: [...target.prefix, 'shell', 'pkill', '-2', 'screenrecord'], timeoutMs });
                return { ok: result.status === 0 && !result.error && !result.signal };
            } catch { return { ok: false }; }
        },
        observeGuest(target, timeoutMs) {
            if (!(timeoutMs >= 1)) return { status: 'unavailable' };
            try {
                const result = native.runCommand({ executable: target.executable, args: [...target.prefix, 'shell', 'pidof', 'screenrecord'], timeoutMs });
                if (result.error || result.signal || result.stderr) return { status: 'unavailable' };
                if (result.status === 1 && result.stdout === '') return { status: 'absent' };
                const pids = result.stdout.trim();
                return result.status === 0 && /^[1-9][0-9]*(?:\s+[1-9][0-9]*)*$/.test(pids)
                    ? { status: 'running' } : { status: 'unavailable' };
            } catch { return { status: 'unavailable' }; }
        },
        prepareOutput: (device, path) => { mkdirSync(native.recordingDirectory(device), { recursive: true }); mkdirSync(dirname(path), { recursive: true }); return undefined; },
    };
    return createDirectRecordingApplication(ports);
}
