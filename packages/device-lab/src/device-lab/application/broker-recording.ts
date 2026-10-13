import { recordingProvider, recordingUnsupported, recordingSerial, recordingLaunchPlan, recordingObject, recordingCopyPending } from "../domain/broker-recording.js";
import type { BrokerRecordingRequest, BrokerRecordingRefusal, BrokerRecordingStatusOutcome, BrokerRecordingStartOutcome, BrokerRecordingStopOutcome, BrokerRecordingTarget } from "../domain/broker-recording.js";
import type { BrokerRecordingPorts, BrokerRecordingExecution, BrokerRecordingSignal } from "../ports/broker-recording.js";
const DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS = 3000;

export function createBrokerRecordingApplication(ports: BrokerRecordingPorts) {
    const findOwnerDeviceForTool = ports.findTarget;
    const transitionOwnerRecordingRuntime = ports.publish;
    const refreshPhysicalDeviceLeaseForOperation = ports.heartbeat;
    function commandSucceeded(result: BrokerRecordingExecution) { return result.status === 0 && !result.error; }
    function invokeDeviceRecordingStatus(ownerId: string, parsed: BrokerRecordingRequest): BrokerRecordingStatusOutcome {
        const match = findOwnerDeviceForTool(ownerId, parsed);
        if ("kind" in match) return match;
        const provider = recordingProvider(match.stateKey) || null;
        const observedRecording = recordingObject(match.device.recording) && !Array.isArray(match.device.recording)
            ? match.device.recording
            : null;
        const pending = recordingCopyPending(observedRecording);
        const observation = !pending && observedRecording?.processIdentity && typeof observedRecording.pid === "number"
            ? ports.observeProcess(observedRecording.processIdentity, observedRecording.pid)
            : null;
        const recorderEnded = observation?.status === "mismatch" || observation?.status === "exited";
        const stopped = observedRecording && recorderEnded
            ? {...observedRecording, active: false, stoppedAt: ports.timestamp()} : null;
        const recovery = stopped && recordingCopyPending(stopped) ? {...stopped, artifactCopyPending: true} : null;
        const transition = !pending && observedRecording && recorderEnded
            ? transitionOwnerRecordingRuntime(ownerId, match.stateKey, String(parsed.deviceId), observedRecording, recovery)
            : null;
        const recording = transition?.matched ? transition.device?.recording || null
            : transition ? transition.currentRecording : match.device.recording || null;
        return {kind: "observed", ownerId, tool: parsed.tool, deviceId: parsed.deviceId, backend: match.backend, stateKey: match.stateKey, recording, provider, supported: Boolean(provider)};
    }

    function recordingStartPlan(ownerId: string, parsed: BrokerRecordingRequest, match: BrokerRecordingTarget): {recording: ReturnType<typeof recordingLaunchPlan>; providerTarget: string; localPath: string} | { error: BrokerRecordingRefusal } {
        const deviceId = String(parsed.deviceId);
        const now = ports.timestamp();
        if (match.stateKey === "android" || match.stateKey === "android-device") {
            const serial = recordingSerial(match.device);
            if (!serial) {
                return { error: {kind: "refused", reason: "invalid", error: "missing-provider-metadata", missing: ["serial or port"], backend: match.backend, deviceId} };
            }
            const localPath = parsed.localPath || ports.localPath(ownerId, match.stateKey, deviceId, "mp4");
            ports.prepareOutput(localPath);
            return {recording: recordingLaunchPlan(parsed, match, {localPath, timestamp: now}), providerTarget: serial, localPath};
        }
        if (match.stateKey === "ios") {
            const ownedTarget = ports.resolveIosTarget(ownerId, match.device);
            if (!ownedTarget.ok) {
                return { error: {kind: "refused", reason: "conflict", error: ownedTarget.error, missing: ownedTarget.missing, backend: match.backend, deviceId} };
            }
            const localPath = parsed.localPath || ports.localPath(ownerId, match.stateKey, deviceId, "mp4");
            ports.prepareOutput(localPath);
            return {recording: recordingLaunchPlan(parsed, match, {localPath, timestamp: now}), providerTarget: ownedTarget.target, localPath};
        }
        if (match.stateKey === "ios-device") return { error: recordingUnsupported(ownerId, parsed, match, "physical iOS recording is not mutated through broker.device.tool.invoke; use a dedicated Appium/Xcode/device-farm path when available") };
        if (match.stateKey === "windows") return { error: recordingUnsupported(ownerId, parsed, match, "Windows Sandbox recording is not broker-managed because it uses the guest-helper file channel") };
        if (match.stateKey === "macos") return { error: recordingUnsupported(ownerId, parsed, match, "macOS VM recording is not broker-managed because it uses the SSH guest-helper bridge") };
        return { error: recordingUnsupported(ownerId, parsed, match, "recording is not supported for this backend through broker.device.tool.invoke") };
    }

    async function invokeDeviceRecordingStart(ownerId: string, parsed: BrokerRecordingRequest): Promise<BrokerRecordingStartOutcome> {
        const match = findOwnerDeviceForTool(ownerId, parsed);
        if ("kind" in match) return match;
        if (["android", "android-device"].includes(match.stateKey) && parsed.timeLimitSec !== null && parsed.timeLimitSec > 180) {
            return {kind: "refused", reason: "invalid", error: "android-recording-time-limit-invalid", detail: "timeLimitSec must be an integer from 1 to 180"};
        }
        const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, match, String(parsed.deviceId));
        if (leaseFailure) return leaseFailure;
        const currentRecording = recordingObject(match.device.recording) ? match.device.recording : null;
        if (recordingCopyPending(currentRecording)) {
            return {kind: "refused", reason: "conflict", error: "recording-artifact-copy-pending", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, recording: currentRecording};
        }
        if (currentRecording?.active) {
            return {kind: "refused", reason: "conflict", error: "recording-already-active", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, recording: currentRecording};
        }
        const plan = recordingStartPlan(ownerId, parsed, match);
        if ("error" in plan) return plan.error;
        const label = String(plan.recording.provider || parsed.tool);
        const execution = match.stateKey === "android" || match.stateKey === "android-device"
            ? await ports.launchAndroidRecording(plan.providerTarget, plan.recording.remotePath || "", plan.recording.timeLimitSec || 180, plan.localPath, label)
            : await ports.launchIosRecording(plan.providerTarget, plan.localPath, label);
        if (!commandSucceeded(execution)) {
            return {kind: "refused", reason: "provider-failed", error: "recording-start-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, execution};
        }
        const recording: Record<string, unknown> = {
            ...plan.recording,
            runtimeId: ports.runtimeId(),
            pid: execution.pid ?? null,
            ...(execution.processIdentity ? { processIdentity: execution.processIdentity } : {}),
        };
        const transition = transitionOwnerRecordingRuntime(ownerId, match.stateKey, String(parsed.deviceId), currentRecording, recording);
        if (!transition.matched) {
            const rollback = ports.signal(recording, "SIGINT");
            return {kind: "refused", reason: "conflict", error: "recording-runtime-state-conflict", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, found: transition.found, currentRecording: transition.currentRecording, rollback};
        }
        const updated = transition.device;
        return {kind: "started", ownerId, tool: parsed.tool, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, provider: recording.provider, recording, device: updated, execution};
    }

    async function invokeDeviceRecordingStop(ownerId: string, parsed: BrokerRecordingRequest): Promise<BrokerRecordingStopOutcome> {
        const match = findOwnerDeviceForTool(ownerId, parsed);
        if ("kind" in match) return match;
        const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, match, String(parsed.deviceId));
        if (leaseFailure) return leaseFailure;
        const recording = recordingObject(match.device.recording) && !Array.isArray(match.device.recording) ? match.device.recording : null;
        const pending = recordingCopyPending(recording);
        if (!recording || (!recording.active && !pending)) {
            return {kind: "refused", reason: "conflict", error: "recording-not-active", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, recording: recording || null};
        }
        if (match.stateKey === "windows") return recordingUnsupported(ownerId, parsed, match, "Windows Sandbox recording stop is not broker-managed because it uses the guest-helper file channel");
        if (match.stateKey === "macos") return recordingUnsupported(ownerId, parsed, match, "macOS VM recording stop is not broker-managed because it uses the SSH guest-helper bridge");
        if (match.stateKey === "ios-device") return recordingUnsupported(ownerId, parsed, match, "physical iOS recording stop is not managed through broker.device.tool.invoke");

        const android = match.stateKey === "android" || match.stateKey === "android-device";
        const serial = android ? recordingSerial(match.device) : null;
        if (android && !serial) return {kind: "refused", reason: "invalid", error: "missing-provider-metadata", missing: ["serial or port"], backend: match.backend, deviceId: parsed.deviceId};
        const recoverableAndroid = android && recordingCopyPending({...recording, active: false, stoppedAt: ports.timestamp()});
        const observation = !pending && recoverableAndroid
            ? ports.observeProcess(recording.processIdentity, typeof recording.pid === "number" ? recording.pid : NaN) : null;
        if (observation?.status === "unavailable") {
            return {kind: "refused", reason: "provider-failed", error: "recording-stop-signal-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, recording};
        }
        const recorderEnded = observation?.status === "exited" || observation?.status === "mismatch";
        const context = {ownerId, target: match, recording};
        const signal: BrokerRecordingSignal = pending || recorderEnded
            ? {attempted: false, ok: true, receipt: null} : ports.signal(recording, "SIGINT", context);
        if (!signal.ok) {
            return {kind: "refused", reason: "provider-failed", error: "recording-stop-signal-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, signal, recording};
        }
        const alreadyStopped = pending || recorderEnded || signal.stale === true;
        const executions: BrokerRecordingExecution[] = [];
        let stopCommandFailed: BrokerRecordingExecution | null = null;
        const provider = recordingProvider(match.stateKey) || String(recording.provider || "unknown");
        // A copy-complete receipt identifies the destination already copied, even if a retry supplies another path.
        const localPath = recording.artifactCopied === true && typeof recording.localPath === "string" ? recording.localPath
            : parsed.localPath || (typeof recording.localPath === "string" ? recording.localPath : ports.localPath(ownerId, match.stateKey, String(parsed.deviceId), "mp4"));
        if (android && serial && !alreadyStopped) {
            const stop = ports.stopAndroidRecording(context, serial);
            executions.push(stop);
            if (!commandSucceeded(stop)) {
                // Guard refusals cannot be excused by a successful host signal.
                if (["recording-runtime-state-conflict", "physical-device-not-attached", "recording-process-identity-unavailable", "recording-process-not-broker-owned"].includes(stop.error || "")) {
                    return {kind: "refused", reason: "provider-failed", error: "recording-stop-command-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, signal, executions, recording};
                }
                stopCommandFailed = stop;
            }
        }
        const processExited = alreadyStopped || await ports.waitForExit(recording.pid, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS);
        if (!processExited) {
            return {kind: "uncertain", reason: "provider-failed", error: "recording-process-still-running", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, signal, executions, recording};
        }
        const hostRecorderWasSignaled = signal.attempted === true && signal.ok === true;
        if (stopCommandFailed && !hostRecorderWasSignaled && !alreadyStopped) {
            return {kind: "refused", reason: "provider-failed", error: "recording-stop-command-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, signal, executions, recording};
        }
        let stoppedRecording: Record<string, unknown> = {...recording, active: false, localPath, stoppedAt: pending ? recording.stoppedAt : ports.timestamp()};
        let expectedRecording = recording;
        if (android && serial && recordingCopyPending(stoppedRecording)) {
            stoppedRecording = {...stoppedRecording, artifactCopyPending: true};
            const retained = transitionOwnerRecordingRuntime(ownerId, match.stateKey, String(parsed.deviceId), recording, stoppedRecording);
            if (!retained.matched) {
                return {kind: "refused", reason: "conflict", error: "recording-runtime-state-conflict", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, found: retained.found, currentRecording: retained.currentRecording, signal, executions};
            }
            if (stoppedRecording.artifactCopied !== true) {
                ports.prepareOutput(localPath);
                const artifactCopy = ports.pullAndroidRecording({ownerId, target: match, recording: stoppedRecording}, serial, String(stoppedRecording.remotePath), localPath);
                executions.push(artifactCopy);
                if (!commandSucceeded(artifactCopy)) {
                    return {kind: "stopped-with-copy-failure", error: "recording-artifact-copy-failed", ownerId, tool: parsed.tool, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, provider, signal, executions, recording: stoppedRecording, device: retained.device};
                }
                const copiedRecording = {...stoppedRecording, artifactCopied: true};
                const copied = transitionOwnerRecordingRuntime(ownerId, match.stateKey, String(parsed.deviceId), stoppedRecording, copiedRecording);
                if (!copied.matched) {
                    return {kind: "refused", reason: "conflict", error: "recording-runtime-state-conflict", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, found: copied.found, currentRecording: copied.currentRecording, signal, executions};
                }
                stoppedRecording = copiedRecording;
            }
            const removal = ports.removeAndroidRecording({ownerId, target: match, recording: stoppedRecording}, serial, String(stoppedRecording.remotePath));
            executions.push(removal);
            if (!commandSucceeded(removal)) {
                return {kind: "refused", reason: "provider-failed", error: "recording-artifact-remove-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, signal, executions, recording: stoppedRecording};
            }
            expectedRecording = stoppedRecording;
        }
        const transition = transitionOwnerRecordingRuntime(ownerId, match.stateKey, String(parsed.deviceId), expectedRecording, null);
        if (!transition.matched) {
            return {kind: "refused", reason: "conflict", error: "recording-runtime-state-conflict", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, found: transition.found, currentRecording: transition.currentRecording, signal, executions};
        }
        return {kind: "stopped", ownerId, tool: parsed.tool, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, provider, signal, executions,
            recording: {...stoppedRecording, ...(recordingCopyPending(stoppedRecording) ? {artifactCopyPending: false} : {})}, device: transition.device};
    }

    return { status: invokeDeviceRecordingStatus, start: invokeDeviceRecordingStart, stop: invokeDeviceRecordingStop };
}
