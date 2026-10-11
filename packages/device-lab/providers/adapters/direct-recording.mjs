import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { readProcessIdentity, inspectProcessIdentity, signalOwnedRuntimeProcess } from '../state/process-identity.mjs';
import { createLocalOutputStage, restoreLocalOutputStage, populateLocalOutputStage, commitLocalOutputStage } from '../transfer-file.mjs';
import { createDirectRecordingApplication } from '../application/direct-recording.mjs';
/** @typedef {import('../ports/direct-recording.mjs').DirectRecordingNative} Native
 * @typedef {import('../ports/direct-recording.mjs').RecordingNativeProcess} ProcessNative */
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
        spawn(command, exited) {
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
        observe: (identity, pid) => ({ status: inspectProcessIdentity(identity, pid).status }),
        alive,
        signal: recording => { const result = signalOwnedRuntimeProcess(recording, 'SIGINT'); return { signaled: result.signaled, ...(result.reason ? { reason: result.reason } : {}) }; },
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
            execute: command => native.runCommand(command),
            prepareWorkspace: device => native.ensureWorkspace(device),
        };
        return createDirectRecordingApplication(ports);
    }
    /** @type {import('../ports/direct-recording.mjs').AndroidRecordingPorts} */
    const ports = { ...base, ...processPorts, kind: native.kind,
        target: (device, operation) => native.resolveTarget(device, operation),
        execute: command => native.runCommand(command),
        prepareOutput: (device, path) => { mkdirSync(native.recordingDirectory(device), { recursive: true }); mkdirSync(dirname(path), { recursive: true }); return undefined; },
    };
    return createDirectRecordingApplication(ports);
}
