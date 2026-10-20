import { createRuntimeGenerationTransitions } from './runtime-generation.mjs';
import { recordingGenerationMatches } from '../domain/runtime-generation.mjs';
import { recordingOf, recordingString, recordingLabel, recordingProvider, recordingInputError, recordingIdentityAvailable, recordingAdbTargetMatches } from '../domain/direct-recording.mjs';
/** @typedef {import('../domain/direct-recording.mjs').RecordingRecord} Record
 * @typedef {import('../domain/direct-recording.mjs').RecordingArguments} Args
 * @typedef {import('../domain/direct-recording.mjs').RecordingOutcome} Outcome
 * @typedef {import('../ports/direct-recording.mjs').AndroidRecordingPorts|import('../ports/direct-recording.mjs').SimulatorRecordingPorts|import('../ports/direct-recording.mjs').MacosRecordingPorts} ProcessPorts */
/** @param {string} message @returns {import('../domain/direct-recording.mjs').RecordingRefusal} */
function failure(message) { return { kind: 'failure', message }; }
/** @param {import('../ports/direct-recording.mjs').DirectRecordingPorts} ports */
export function createDirectRecordingApplication(ports) {
    const generation = createRuntimeGenerationTransitions({ updateDevice: (id, update) => ports.updateDevice(id, update), newRuntimeId: () => ports.runtimeId() });
    const label = recordingLabel(ports.kind), provider = recordingProvider(ports.kind);
    /** @param {unknown} id @param {Record} recording @returns {undefined} */
    function exited(id, recording) {
        generation.transitionRecordingGeneration(id, recording, { ...recording, active: false, endedAt: ports.timestamp() }, ports.timestamp());
        return undefined;
    }
    /** @param {ProcessPorts} effects @param {Record} device @returns {Record} */
    function reconcileProcess(effects, device) {
        const current = recordingOf(device);
        if (!current?.active || !current.pid) return device;
        const android = ports.kind === 'android-emulator' || ports.kind === 'android-device';
        if (android && !recordingIdentityAvailable(current.processIdentity, current.pid)) return device;
        const observed = current.processIdentity ? effects.observe(current.processIdentity, current.pid) : null;
        if (android && observed?.status !== 'exited') return device;
        if (observed ? observed.status === 'match' || observed.status === 'unavailable' : effects.alive(current.pid)) return device;
        const pending = { ...current, active: false, endedAt: ports.timestamp() };
        return ports.updateDevice(device.id, item => recordingGenerationMatches(current, item.recording) ? { ...item, recording: pending, updatedAt: ports.timestamp() } : item) || device;
    }
    /** Re-resolve through native authority while retaining the captured selection and attachment.
     * @param {import('../ports/direct-recording.mjs').AndroidRecordingPorts} effects @param {string} id
     * @param {Record} captured @param {Record|null} expected @param {import('../domain/direct-recording.mjs').AdbRecordingTarget} target
     * @param {string} [operation]
     * @param {{remaining():number}} [waitBudget]
     * @returns {import('../domain/direct-recording.mjs').RecordingRefusal|null} */
    function currentAndroid(effects, id, captured, expected, target, operation = 'device_record_video_stop', waitBudget) {
        const fields = effects.kind === 'android-device' ? ['serial', 'leaseClaimId', 'leaseClaimNonce'] : ['serial', 'port'];
        /** @param {Record|null|undefined} device */
        const matches = device => Boolean(device && recordingGenerationMatches(expected, device.recording)
            && fields.every(field => device[field] === captured[field]));
        const changed = () => failure(`${label} recording state or target changed while ${operation === 'device_record_video_start' ? 'starting' : 'stopping'} for ${id}; successor state and remote artifact were preserved.`);
        const expired = () => failure(`${label} recording settlement could not be confirmed within 3000ms for ${id}; recording state and remote artifact were preserved for retry.`);
        if (waitBudget && !(waitBudget.remaining() >= 1)) return expired();
        const device = effects.findDevice(id);
        if (!device || !matches(device)) return changed();
        if (waitBudget && !(waitBudget.remaining() >= 1)) return expired();
        const admission = effects.target(device, operation, { capturedTarget: target, waitBudget });
        if (admission.kind !== 'ready') return admission;
        if (waitBudget && !(waitBudget.remaining() >= 1)) return expired();
        if (!matches(admission.device) || !recordingAdbTargetMatches(target, admission.target) || !matches(effects.findDevice(id))) return changed();
        return null;
    }
    /** @param {import('../ports/direct-recording.mjs').AndroidRecordingPorts} effects @param {string} id
     * @param {Record} previous @param {import('../domain/direct-recording.mjs').AdbRecordingTarget} target
     * @param {()=>import('../domain/direct-recording.mjs').RecordingRefusal|null} current
     * @param {import('../ports/direct-recording.mjs').RecordingSettlementBudget} budget
     * @returns {Promise<import('../domain/direct-recording.mjs').RecordingRefusal|null>} */
    async function settleAndroid(effects, id, previous, target, current, budget) {
        const remainingMs = () => budget.remaining();
        const unconfirmed = () => failure(`${label} recording settlement could not be confirmed within 3000ms for ${id}; recording state and remote artifact were preserved for retry.`);
        const admitted = () => !(remainingMs() >= 1) ? unconfirmed() : current() || (remainingMs() >= 1 ? null : unconfirmed());
        const allowance = () => Math.floor(Math.min(budget.requestTimeout(), remainingMs()));
        let refused = admitted();
        if (refused) return refused;
        let hostSettled = !previous.active, stopGuest = false;
        if (previous.active) {
            if (!recordingIdentityAvailable(previous.processIdentity, previous.pid)) return unconfirmed();
            const observed = effects.observe(previous.processIdentity, previous.pid, remainingMs);
            refused = admitted();
            if (refused) return refused;
            if (observed.status === 'unavailable') return unconfirmed();
            hostSettled = observed.status === 'exited' || observed.status === 'mismatch';
            stopGuest = observed.status !== 'mismatch';
            if (observed.status === 'match') {
                const signal = effects.signal(previous, remainingMs);
                refused = admitted();
                if (refused) return refused;
                if (signal.reason === 'runtime-process-identity-missing' || signal.reason === 'runtime-process-identity-unavailable') return unconfirmed();
                if (signal.reason === 'runtime-process-identity-mismatch') { hostSettled = true; stopGuest = false; }
                else hostSettled = signal.exited === true;
            }
        }
        if (stopGuest) {
            refused = admitted();
            if (refused) return refused;
            const timeout = allowance();
            if (!(timeout >= 1)) return unconfirmed();
            effects.fallbackStop(target, String(previous.remotePath), timeout);
            refused = admitted();
            if (refused) return refused;
        }
        for (;;) {
            refused = admitted();
            if (refused) return refused;
            if (!hostSettled) {
                const observed = effects.observe(previous.processIdentity, previous.pid, remainingMs);
                refused = admitted();
                if (refused) return refused;
                if (observed.status === 'unavailable') return unconfirmed();
                hostSettled = observed.status === 'exited' || observed.status === 'mismatch';
            }
            const timeout = allowance();
            if (!(timeout >= 1)) return unconfirmed();
            const guest = effects.observeGuest(target, timeout);
            refused = admitted();
            if (refused) return refused;
            if (guest.status === 'unavailable') return unconfirmed();
            if (hostSettled && guest.status === 'absent') return null;
            await budget.pause();
        }
    }
    /** @param {import('../ports/direct-recording.mjs').SandboxRecordingPorts} effects @param {Record} device @param {number} timeout */
    async function reconcileHelper(effects, device, timeout) {
        const current = recordingOf(device);
        if (!current?.active) return { device, statusCheck: null };
        const result = await effects.helper(device, 'record_status', { sessionId: current.sessionId }, timeout);
        if (result.error !== undefined) return { device, statusCheck: result.error };
        if (!result.response.ok) return { device, statusCheck: result.response.error || 'Windows helper recording status failed' };
        if (!result.response.recording?.active) {
            if (current.localPath) {
                const archive = effects.archivePath(result.helper, result.response.recording?.archivePath || result.response.recording?.hostArchivePath, `${current.sessionId}.zip`);
                if (!archive) return { device, statusCheck: 'Windows helper recording output is missing or unsafe' };
                const policy = effects.validatePath(String(current.localPath));
                if (!policy.ok) return { device, statusCheck: policy.message };
                effects.prepareOutput(device, policy.path);
                const copy = effects.copyArchive(archive, policy.path);
                if (!copy.ok) return { device, statusCheck: copy.error };
            }
            const updated = effects.updateDevice(device.id, item => recordingGenerationMatches(current, item.recording) ? { ...item, recording: null, updatedAt: effects.timestamp() } : item);
            return { device: updated || device, statusCheck: result.response.recording || null };
        }
        return { device, statusCheck: result.response.recording };
    }
    /** @param {Args} args @returns {Promise<Outcome|undefined>} */
    async function status(args) {
        const device = ports.findDevice(args.deviceId);
        if (!device) return undefined;
        if (ports.kind === 'windows-sandbox') {
            const result = await reconcileHelper(ports, device, args.helperTimeoutMs || 1000);
            return { kind: 'success', value: { deviceId: args.deviceId, recording: recordingOf(result.device), provider, helper: result.statusCheck || null } };
        }
        return { kind: 'success', value: { deviceId: args.deviceId, recording: recordingOf(reconcileProcess(ports, device)), provider } };
    }
    /** @param {ProcessPorts} effects @param {import('../ports/direct-recording.mjs').RecorderHandle} child */
    async function terminateNewRecorder(effects, child) {
        try { child.signal('SIGINT'); } catch { /* allocated recorder already exited */ }
        if (await effects.waitExit(child.pid, 1000)) return true;
        try { child.signal('SIGKILL'); } catch { /* allocated recorder already exited */ }
        return effects.waitExit(child.pid, 1000);
    }
    /** @param {Args} args @returns {Promise<Outcome|undefined>} */
    async function start(args) {
        let device = ports.findDevice(args.deviceId);
        if (!device) return undefined;
        const inputError = recordingInputError(ports.kind, args.timeLimitSec);
        if (inputError) return failure(inputError);
        if (ports.kind === 'windows-sandbox') return startHelper(ports, device, args);
        /** @type {import('../domain/direct-recording.mjs').AdbRecordingTarget|import('../domain/direct-recording.mjs').SimulatorRecordingTarget|import('../domain/direct-recording.mjs').MacosRecordingTarget|undefined} */
        let target;
        if (ports.kind === 'android-device') {
            const admission = ports.target(device, 'device_record_video_start');
            if (admission.kind !== 'ready') return admission;
            target = admission.target;
            device = reconcileProcess(ports, admission.device);
        }
        const previous = recordingOf(device);
        if (previous) return failure(`${label} recording ${previous.active ? 'already active' : 'pending finalization'} for ${args.deviceId}`);
        if (!target) {
            const admission = ports.target(device, 'device_record_video_start');
            if (admission.kind !== 'ready') return admission;
            target = admission.target;
        }
        /** @type {(()=>import('../domain/direct-recording.mjs').RecordingRefusal|null)|undefined} */
        let startGuard;
        if ((ports.kind === 'android-emulator' || ports.kind === 'android-device') && target.kind === 'adb') {
            const effects = ports, captured = { ...device }, selected = { ...target, prefix: [...target.prefix] };
            target = selected;
            startGuard = () => currentAndroid(effects, args.deviceId, captured, previous, selected, 'device_record_video_start');
        }
        if (ports.kind === 'macos-vm') ports.prepareWorkspace(device);
        const local = args.localPath || ports.localPath(device);
        const policy = ports.validatePath(local);
        if (!policy.ok) return failure(policy.message);
        const beforeOutput = startGuard ? startGuard() : null;
        if (beforeOutput) return beforeOutput;
        ports.prepareOutput(device, policy.path);
        /** @type {import('../domain/direct-recording.mjs').RecordingStage|null} */
        let stage = null;
        if (ports.kind === 'ios-simulator') {
            const created = ports.createStage(device, policy.path, true);
            if (!created.ok) return failure(created.message);
            stage = created.stage;
        }
        const remote = args.remotePath || (ports.kind === 'macos-vm' ? `/tmp/ccc-${device.id}-recording.mov` : `/sdcard/ccc-${device.id}-recording.mp4`);
        const timeLimitSec = ports.kind === 'android-emulator' || ports.kind === 'android-device' ? args.timeLimitSec ?? 180 : args.timeLimitSec || null;
        /** @type {Record|null} */ let recording = null;
        let didExit = false;
        const beforeSpawn = startGuard ? startGuard() : null;
        if (beforeSpawn) return beforeSpawn;
        const child = ports.spawnRecorder(target, { remotePath: remote, outputPath: stage?.stagedPath || policy.path }, timeLimitSec, () => { didExit = true; if (recording) exited(args.deviceId, recording); return undefined; });
        const runtimeId = ports.runtimeId();
        const ready = await child.startup(150);
        const processLabel = ports.kind === 'ios-simulator' ? `${label} recordVideo` : ports.kind === 'macos-vm' ? `${label} screencapture` : `${label} screenrecord`;
        if (ready.kind !== 'ready') {
            if (stage) ports.disposeStage(stage);
            return failure(ready.kind === 'error' ? `${processLabel} recorder failed to start: ${ready.message}` : `${processLabel} recorder exited before it was ready: ${ready.signal || `exit ${ready.code}`}`);
        }
        const afterStartup = startGuard ? startGuard() : null;
        if (afterStartup) {
            try { child.signal('SIGINT'); } catch { /* allocated recorder already exited */ }
            return afterStartup;
        }
        const identity = ports.readIdentity(child.pid);
        if (!identity) {
            try { child.signal('SIGINT'); } catch { /* allocated recorder already exited */ }
            if (stage) ports.disposeStage(stage);
            return failure(`${label} recorder process identity could not be established for ${args.deviceId}.`);
        }
        const afterIdentity = startGuard ? startGuard() : null;
        if (afterIdentity) {
            try { child.signal('SIGINT'); } catch { /* allocated recorder already exited */ }
            return afterIdentity;
        }
        recording = { active: true, provider, runtimeId, pid: child.pid, processIdentity: identity, localPath: policy.path,
            ...(ports.kind === 'ios-simulator' ? { stagingPath: stage?.stagedPath } : { remotePath: remote, timeLimitSec }), startedAt: ports.timestamp() };
        child.unref();
        /** @type {import('./runtime-generation.mjs').GenerationTransition} */
        let committed;
        if (ports.kind === 'macos-vm') {
            try { committed = generation.transitionRecordingGeneration(args.deviceId, previous, recording, ports.timestamp()); }
            catch (error) {
                recording = null;
                const terminated = await terminateNewRecorder(ports, child);
                const detail = error instanceof Error ? error.message : String(error);
                return failure(`${label} recording metadata persistence failed for ${args.deviceId}; the new recorder was ${terminated ? 'stopped' : 'sent termination signals'}: ${detail}`);
            }
        } else committed = generation.transitionRecordingGeneration(args.deviceId, previous, recording, ports.timestamp());
        if (!committed.committed) {
            if (ports.kind === 'macos-vm') {
                recording = null;
                const terminated = await terminateNewRecorder(ports, child);
                return failure(`${label} recording state changed while starting for ${args.deviceId}; the new recorder was ${terminated ? 'stopped' : 'sent termination signals'}.`);
            }
            try { child.signal('SIGINT'); } catch { /* allocated recorder already exited */ }
            if (stage) ports.disposeStage(stage);
            return failure(`${label} recording state changed while starting for ${args.deviceId}; the new recorder was stopped.`);
        }
        if (didExit || !ports.alive(child.pid)) {
            generation.transitionRecordingGeneration(args.deviceId, recording, null, ports.timestamp());
            if (stage) ports.disposeStage(stage);
            return failure(`${label} recorder exited before its state was committed for ${args.deviceId}.`);
        }
        return { kind: 'success', value: { deviceId: args.deviceId, recording: committed.device ? recordingOf(committed.device) : null } };
    }
    /** @param {import('../ports/direct-recording.mjs').SandboxRecordingPorts} effects @param {Record} device @param {Args} args @returns {Promise<Outcome>} */
    async function startHelper(effects, device, args) {
        if (recordingOf(device)?.active) {
            device = (await reconcileHelper(effects, device, args.helperTimeoutMs || 1000)).device;
            if (recordingOf(device)?.active) return failure(`${label} recording already active for ${args.deviceId}`);
        }
        const sessionId = `recording-${effects.runtimeId()}`;
        const policy = effects.validatePath(args.localPath || effects.localPath(device));
        if (!policy.ok) return failure(policy.message);
        effects.prepareOutput(device, policy.path);
        const result = await effects.helper(device, 'record_start', { sessionId, intervalMs: args.timeLimitSec && args.timeLimitSec < 30 ? 500 : 1000, timeLimitSec: args.timeLimitSec || 0 }, args.helperTimeoutMs || 5000);
        if (result.error !== undefined) return failure(result.error);
        if (!result.response.ok) return failure(result.response.error || 'Windows helper recording start failed');
        const recording = { active: true, provider, runtimeId: effects.runtimeId(), sessionId, localPath: policy.path, remotePath: result.response.recording?.frameDir || null, timeLimitSec: args.timeLimitSec || null, startedAt: effects.timestamp() };
        const committed = generation.transitionRecordingGeneration(args.deviceId, recordingOf(device), recording, effects.timestamp());
        if (!committed.committed) {
            await effects.helper(device, 'record_stop', { sessionId }, args.helperTimeoutMs || 5000);
            return failure(`${label} recording state changed while starting for ${args.deviceId}; the new recorder was stopped.`);
        }
        return { kind: 'success', value: { deviceId: args.deviceId, recording: committed.device ? recordingOf(committed.device) : null, helper: result.response.recording || null } };
    }
    /** @param {Args} args @returns {Promise<Outcome|undefined>} */
    async function finalize(args) {
        let device = ports.findDevice(args.deviceId);
        if (!device) return undefined;
        if (ports.kind === 'windows-sandbox') return stopHelper(ports, device, args);
        /** @type {import('../domain/direct-recording.mjs').AdbRecordingTarget|import('../domain/direct-recording.mjs').SimulatorRecordingTarget|import('../domain/direct-recording.mjs').MacosRecordingTarget|undefined} */
        let target;
        if (ports.kind === 'android-device') {
            const admission = ports.target(device, 'device_record_video_stop');
            if (admission.kind !== 'ready') return admission;
            target = admission.target;
            device = admission.device;
        }
        const saved = recordingOf(device);
        const previous = saved && (ports.kind === 'android-emulator' || ports.kind === 'android-device')
            ? { ...saved, ...(recordingIdentityAvailable(saved.processIdentity, saved.pid) ? { processIdentity: { ...saved.processIdentity } } : {}) } : saved;
        if (!previous) return failure(`No ${label} recording active for ${args.deviceId}`);
        if (ports.kind !== 'ios-simulator' && !target) {
            const admission = ports.target(device, 'device_record_video_stop');
            if (admission.kind !== 'ready') return admission;
            target = admission.target;
        }
        const policy = ports.validatePath(args.localPath || recordingString(previous, 'localPath') || ports.localPath(device));
        if (!policy.ok) return failure(policy.message);
        /** @type {((expected:Record|null,waitBudget?:{remaining():number})=>import('../domain/direct-recording.mjs').RecordingRefusal|null)|undefined} */
        let guard;
        if (ports.kind === 'android-emulator' || ports.kind === 'android-device') {
            if (!target || target.kind !== 'adb') return failure(`${label} recording target unavailable`);
            const effects = ports, captured = { ...device }, selected = { ...target, prefix: [...target.prefix] };
            target = selected;
            guard = (expected, waitBudget) => currentAndroid(effects, args.deviceId, captured, expected, selected, 'device_record_video_stop', waitBudget);
            const budget = effects.budget(3000, 50);
            const settled = await settleAndroid(effects, args.deviceId, previous, selected, () => currentAndroid(effects, args.deviceId, captured, previous, selected, 'device_record_video_stop', budget), budget);
            if (settled) return settled;
            const refused = guard(previous, budget);
            if (refused) return refused;
            if (!(budget.remaining() >= 1)) return failure(`${label} recording settlement could not be confirmed within 3000ms for ${args.deviceId}; recording state and remote artifact were preserved for retry.`);
        } else if (previous.active) {
            const signal = ports.signal(previous);
            if (ports.kind === 'ios-simulator' && !signal.signaled && signal.reason !== 'runtime-process-exited') return failure(`${label} recording process could not be safely stopped for ${args.deviceId} (${signal.reason || 'unknown'}); state remains active.`);
            if (ports.kind === 'macos-vm' && target && target.kind !== 'simulator') {
                ports.fallbackStop(target, String(previous.remotePath), args.helperTimeoutMs);
            }
            if (signal.signaled && !await ports.waitExit(previous.pid, 3000)) return failure(`${label} recording did not exit within 3000ms for ${args.deviceId}; state remains active.`);
        }
        const claimed = generation.claimRecordingFinalization(args.deviceId, previous, { localPath: policy.path }, ports.timestamp());
        const savedPending = claimed.device ? recordingOf(claimed.device) : null;
        const pending = guard && savedPending ? { ...savedPending } : savedPending;
        if (!claimed.committed || !pending) return failure(`${label} recording state changed while stopping for ${args.deviceId}; successor state was preserved.`);
        if (ports.kind === 'ios-simulator') return finalizeSimulator(ports, device, previous, pending, policy.path, args);
        let refused = guard ? guard(pending) : null;
        if (refused) return refused;
        ports.prepareOutput(device, policy.path);
        refused = guard ? guard(pending) : null;
        if (refused) return refused;
        const created = ports.createStage(device, policy.path, false);
        if (!created.ok) return failure(created.message);
        const stage = created.stage;
        try {
            refused = guard ? guard(pending) : null;
            if (refused) return refused;
            const remote = String(pending.remotePath);
            if (!target || target.kind === 'simulator') return failure(`${label} recording target unavailable`);
            const transferTimeout = ports.kind === 'macos-vm' ? args.helperTimeoutMs : 300000;
            const copied = ports.copyRecording(target, remote, stage.stagedPath, transferTimeout);
            refused = guard ? guard(pending) : null;
            if (refused) return refused;
            if (!copied.ok) return failure(`Error: ${copied.detail}. ${label} recording remains pending finalization for ${args.deviceId}.`);
            const committed = ports.commitStage(stage);
            refused = guard ? guard(pending) : null;
            if (refused) return refused;
            if (!committed.ok) return failure(`${committed.message}. ${label} recording remains pending finalization for ${args.deviceId}.`);
            const cleared = generation.transitionRecordingGeneration(args.deviceId, pending, null, ports.timestamp());
            if (!cleared.committed) return failure(`${label} recording state changed while stopping for ${args.deviceId}; successor state and remote artifact were preserved.`);
            refused = guard ? guard(null) : null;
            if (refused) return refused;
            ports.removeRecording(target, remote, transferTimeout);
            return { kind: 'success', value: { deviceId: args.deviceId, stopped: true, provider, recording: { ...pending, active: false, localPath: policy.path, stoppedAt: ports.timestamp() }, ...(ports.kind === 'android-device' ? {} : { device: cleared.device }), ...copied.output } };
        } finally { ports.disposeStage(stage); }
    }
    /** @param {import('../ports/direct-recording.mjs').SimulatorRecordingPorts} effects @param {Record} device @param {Record} previous @param {Record} pending @param {string} path @param {Args} args @returns {Promise<Outcome>} */
    async function finalizeSimulator(effects, device, previous, pending, path, args) {
        const persistent = recordingString(pending, 'stagingPath');
        const created = persistent ? effects.restoreStage(device, path, persistent) : effects.createStage(device, path, false);
        if (!created.ok) return failure(`${created.message}. ${label} recording remains pending finalization for ${args.deviceId}.`);
        const stage = created.stage;
        if (!persistent) {
            const populated = effects.populateStage(String(previous.stagingPath || previous.localPath), stage);
            if (!populated.ok) { effects.disposeStage(stage); return failure(`${populated.message}. ${label} legacy recording remains pending finalization for ${args.deviceId}.`); }
        }
        const committed = effects.commitStage(stage);
        if (!committed.ok) {
            if (!persistent) effects.disposeStage(stage);
            return failure(`${committed.message}. ${label} recording remains pending finalization for ${args.deviceId}.`);
        }
        const cleared = generation.transitionRecordingGeneration(args.deviceId, pending, null, effects.timestamp());
        if (!cleared.committed) {
            if (!persistent) effects.disposeStage(stage);
            return failure(`${label} recording state changed while stopping for ${args.deviceId}; successor state and staged artifact were preserved.`);
        }
        effects.disposeStage(stage);
        return { kind: 'success', value: { deviceId: args.deviceId, stopped: true, provider, recording: { ...pending, active: false, localPath: path, stoppedAt: effects.timestamp() }, device: cleared.device } };
    }
    /** @param {import('../ports/direct-recording.mjs').SandboxRecordingPorts} effects @param {Record} device @param {Args} args @returns {Promise<Outcome>} */
    async function stopHelper(effects, device, args) {
        const previous = recordingOf(device);
        if (!previous?.active) return failure(`No ${label} recording active for ${args.deviceId}`);
        const policy = effects.validatePath(args.localPath || recordingString(previous, 'localPath') || effects.localPath(device));
        if (!policy.ok) return failure(policy.message);
        const result = await effects.helper(device, 'record_stop', { sessionId: previous.sessionId }, args.helperTimeoutMs || 10000);
        if (result.error !== undefined) return failure(`${result.error}. ${label} recording state preserved for retry for ${args.deviceId}.`);
        const error = !result.response.ok ? result.response.error || 'Windows helper recording stop failed' : null;
        if (error) return failure(`${error}. ${label} recording state preserved for retry for ${args.deviceId}.`);
        const archive = effects.archivePath(result.helper, result.response.recording?.archivePath || result.response.recording?.hostArchivePath, `${previous.sessionId}.zip`);
        if (!archive) return failure(`Windows helper recording output is missing or unsafe. ${label} recording state preserved for retry for ${args.deviceId}.`);
        effects.prepareOutput(device, policy.path);
        const copied = effects.copyArchive(archive, policy.path);
        if (!copied.ok) return failure(`Windows helper recording output copy failed: ${copied.error}. ${label} recording state preserved for retry for ${args.deviceId}.`);
        const cleared = generation.transitionRecordingGeneration(args.deviceId, previous, null, effects.timestamp());
        if (!cleared.committed && cleared.device && recordingOf(cleared.device)) return failure(`${label} recording state changed while stopping for ${args.deviceId}; successor state was preserved.`);
        return { kind: 'success', value: { deviceId: args.deviceId, stopped: true, provider, recording: { ...previous, active: false, localPath: policy.path, stoppedAt: effects.timestamp() }, device: cleared.device, helper: result.response.recording || null } };
    }
    /** @param {string} name @param {Args} args @returns {Promise<Outcome|undefined>} */
    async function request(name, args) {
        if (name === 'device_record_video_status') return status(args);
        if (name === 'device_record_video_start') return start(args);
        if (name === 'device_record_video_stop') return finalize(args);
        return undefined;
    }
    return { request, exited };
}
