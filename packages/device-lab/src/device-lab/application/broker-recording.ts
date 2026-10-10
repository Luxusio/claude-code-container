import { recordingProvider, recordingUnsupported, recordingSerial, recordingLaunchPlan, recordingObject } from "../domain/broker-recording.js";
import type { BrokerRecordingCommand, BrokerRecordingRequest, BrokerRecordingResponse, BrokerRecordingTarget } from "../domain/broker-recording.js";
import type { BrokerRecordingPorts, BrokerRecordingExecution } from "../ports/broker-recording.js";
const DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS = 3000;

export function createBrokerRecordingApplication(ports: BrokerRecordingPorts) {
    const findOwnerDeviceForTool = ports.findTarget;
    const transitionOwnerRecordingRuntime = ports.publish;
    const refreshPhysicalDeviceLeaseForOperation = ports.heartbeat;
    function commandSucceeded(result: BrokerRecordingExecution) { return result.status === 0 && !result.error; }
    function invokeDeviceRecordingStatus(ownerId: string, parsed: BrokerRecordingRequest) {
        const match = findOwnerDeviceForTool(ownerId, parsed);
        if ("status" in match) return match;
        const provider = recordingProvider(match.stateKey) || null;
        const observedRecording = recordingObject(match.device.recording) && !Array.isArray(match.device.recording)
            ? match.device.recording
            : null;
        const observation = observedRecording?.processIdentity && typeof observedRecording.pid === "number"
            ? ports.observeProcess(observedRecording.processIdentity, observedRecording.pid)
            : null;
        const recordingIsCurrent = !observation
            || observation.status === "match"
            || observation.status === "unavailable";
        const transition = recordingIsCurrent || !observedRecording
            ? null
            : transitionOwnerRecordingRuntime(ownerId, match.stateKey, String(parsed.deviceId), observedRecording, null);
        const recording = transition?.matched ? null : match.device.recording || null;
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId,
                    tool: parsed.tool,
                    deviceId: parsed.deviceId,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    recording,
                    provider,
                    supported: Boolean(provider),
                    source: "host-broker-owner-state",
                    startsDevices: false,
                },
            },
        };
    }

    function recordingStartPlan(ownerId: string, parsed: BrokerRecordingRequest, match: BrokerRecordingTarget): ReturnType<typeof recordingLaunchPlan> | { error: BrokerRecordingResponse } {
        const deviceId = String(parsed.deviceId);
        const now = ports.timestamp();
        if (match.stateKey === "android" || match.stateKey === "android-device") {
            const serial = recordingSerial(match.device);
            if (!serial) {
                return { error: { status: 400, payload: { ok: false, error: "missing-provider-metadata", missing: ["serial or port"], backend: match.backend, deviceId } } };
            }
            const localPath = parsed.localPath || ports.localPath(ownerId, match.stateKey, deviceId, "mp4");
            ports.prepareOutput(localPath);
            return recordingLaunchPlan(parsed, match, { executable: ports.executable("adb"), providerTarget: serial, localPath, timestamp: now });
        }
        if (match.stateKey === "ios") {
            const ownedTarget = ports.resolveIosTarget(ownerId, match.device);
            if (!ownedTarget.ok) {
                return { error: { status: 409, payload: { ok: false, error: ownedTarget.error, missing: ownedTarget.missing, backend: match.backend, deviceId } } };
            }
            const localPath = parsed.localPath || ports.localPath(ownerId, match.stateKey, deviceId, "mp4");
            ports.prepareOutput(localPath);
            return recordingLaunchPlan(parsed, match, { executable: ports.executable("xcrun"), providerTarget: ownedTarget.target, localPath, timestamp: now });
        }
        if (match.stateKey === "ios-device") return { error: recordingUnsupported(ownerId, parsed, match, "physical iOS recording is not mutated through broker.device.tool.invoke; use a dedicated Appium/Xcode/device-farm path when available") };
        if (match.stateKey === "windows") return { error: recordingUnsupported(ownerId, parsed, match, "Windows Sandbox recording is not broker-managed because it uses the guest-helper file channel") };
        if (match.stateKey === "macos") return { error: recordingUnsupported(ownerId, parsed, match, "macOS VM recording is not broker-managed because it uses the SSH guest-helper bridge") };
        return { error: recordingUnsupported(ownerId, parsed, match, "recording is not supported for this backend through broker.device.tool.invoke") };
    }

    async function invokeDeviceRecordingStart(ownerId: string, parsed: BrokerRecordingRequest) {
        const match = findOwnerDeviceForTool(ownerId, parsed);
        if ("status" in match) return match;
        if (["android", "android-device"].includes(match.stateKey) && parsed.timeLimitSec !== null && parsed.timeLimitSec > 180) {
            return { status: 400, payload: { ok: false, error: "android-recording-time-limit-invalid", detail: "timeLimitSec must be an integer from 1 to 180" } };
        }
        const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, match, String(parsed.deviceId));
        if (leaseFailure) return leaseFailure;
        const currentRecording = recordingObject(match.device.recording) ? match.device.recording : null;
        if (currentRecording?.active) {
            return { status: 409, payload: { ok: false, error: "recording-already-active", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, recording: currentRecording } };
        }
        const plan = recordingStartPlan(ownerId, parsed, match);
        if ("error" in plan) return plan.error;
        const execution = await ports.launch(plan.command, String(plan.recording.provider || parsed.tool));
        if (!commandSucceeded(execution)) {
            return { status: 502, payload: { ok: false, error: "recording-start-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, execution } };
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
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "recording-runtime-state-conflict",
                    ownerId,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    deviceId: parsed.deviceId,
                    found: transition.found,
                    currentRecording: transition.currentRecording,
                    rollback,
                },
            };
        }
        const updated = transition.device;
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId,
                    tool: parsed.tool,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    deviceId: parsed.deviceId,
                    provider: recording.provider,
                    recording,
                    device: updated,
                    execution,
                    source: "host-broker-owner-state",
                    startsDevices: false,
                },
            },
        };
    }

    async function invokeDeviceRecordingStop(ownerId: string, parsed: BrokerRecordingRequest) {
        const match = findOwnerDeviceForTool(ownerId, parsed);
        if ("status" in match) return match;
        const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, match, String(parsed.deviceId));
        if (leaseFailure) return leaseFailure;
        const recording = recordingObject(match.device.recording) ? match.device.recording : null;
        if (!recording?.active) {
            return { status: 409, payload: { ok: false, error: "recording-not-active", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, recording: recording || null } };
        }
        if (match.stateKey === "windows") return recordingUnsupported(ownerId, parsed, match, "Windows Sandbox recording stop is not broker-managed because it uses the guest-helper file channel");
        if (match.stateKey === "macos") return recordingUnsupported(ownerId, parsed, match, "macOS VM recording stop is not broker-managed because it uses the SSH guest-helper bridge");
        if (match.stateKey === "ios-device") return recordingUnsupported(ownerId, parsed, match, "physical iOS recording stop is not managed through broker.device.tool.invoke");

        const signal = ports.signal(recording, "SIGINT");
        if (!signal.ok) {
            return { status: 502, payload: { ok: false, error: "recording-stop-signal-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, signal, recording, startsDevices: false } };
        }
        const executions: BrokerRecordingExecution[] = [];
        let artifactCopy: BrokerRecordingExecution | null = null;
        let stopCommandFailed: BrokerRecordingExecution | null = null;
        const provider = recordingProvider(match.stateKey) || String(recording.provider || "unknown");
        const localPath = parsed.localPath || (typeof recording.localPath === "string" ? recording.localPath : ports.localPath(ownerId, match.stateKey, String(parsed.deviceId), "mp4"));
        ports.prepareOutput(localPath);
        let serial: string | null = null;
        if (match.stateKey === "android" || match.stateKey === "android-device") {
            serial = recordingSerial(match.device);
            if (!serial) return { status: 400, payload: { ok: false, error: "missing-provider-metadata", missing: ["serial or port"], backend: match.backend, deviceId: parsed.deviceId } };
            const pkillCommand: BrokerRecordingCommand = { mode: "exec", provider: "adb", executable: ports.executable("adb"), args: ["-s", serial, "shell", "pkill", "-2", "screenrecord"] };
            const pkill = ports.execute(pkillCommand);
            executions.push(pkill);
            if (!commandSucceeded(pkill)) stopCommandFailed = pkill;
        }
        const processExited = await ports.waitForExit(recording.pid, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS);
        if (!processExited) {
            return { status: 502, payload: { ok: false, error: "recording-process-still-running", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, signal, executions, recording, startsDevices: false } };
        }
        const hostRecorderWasSignaled = signal.attempted === true && signal.ok === true;
        if (stopCommandFailed && !hostRecorderWasSignaled && !("stale" in signal && signal.stale)) {
            return { status: 502, payload: { ok: false, error: "recording-stop-command-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, signal, executions, recording, startsDevices: false } };
        }
        if (match.stateKey === "android" || match.stateKey === "android-device") {
            if (!serial) return { status: 400, payload: { ok: false, error: "missing-provider-metadata", missing: ["serial or port"], backend: match.backend, deviceId: parsed.deviceId } };
            if (typeof recording.remotePath === "string" && recording.remotePath) {
                const pullCommand: BrokerRecordingCommand = { mode: "exec", provider: "adb", executable: ports.executable("adb"), args: ["-s", serial, "pull", recording.remotePath, localPath] };
                artifactCopy = ports.execute(pullCommand);
                if (artifactCopy) executions.push(artifactCopy);
                const rmCommand: BrokerRecordingCommand = { mode: "exec", provider: "adb", executable: ports.executable("adb"), args: ["-s", serial, "shell", "rm", "-f", recording.remotePath] };
                executions.push(ports.execute(rmCommand));
            }
        }
        const stoppedAt = ports.timestamp();
        const transition = transitionOwnerRecordingRuntime(ownerId, match.stateKey, String(parsed.deviceId), recording, null);
        if (!transition.matched) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "recording-runtime-state-conflict",
                    ownerId,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    deviceId: parsed.deviceId,
                    found: transition.found,
                    currentRecording: transition.currentRecording,
                    signal,
                    executions,
                },
            };
        }
        const updated = transition.device;
        const copyFailed = artifactCopy && !commandSucceeded(artifactCopy);
        return {
            status: copyFailed ? 502 : 200,
            payload: {
                ok: !copyFailed,
                ...(copyFailed ? { error: "recording-artifact-copy-failed" } : {}),
                result: {
                    ownerId,
                    tool: parsed.tool,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    deviceId: parsed.deviceId,
                    stopped: true,
                    provider,
                    signal,
                    executions,
                    recording: { ...recording, active: false, localPath, stoppedAt },
                    device: updated,
                    source: "host-broker-owner-state",
                    startsDevices: false,
                },
            },
        };
    }

    return { status: invokeDeviceRecordingStatus, start: invokeDeviceRecordingStart, stop: invokeDeviceRecordingStop };
}
