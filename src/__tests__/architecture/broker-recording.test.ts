import { describe, expect, it } from "vitest";
import { createBrokerRecordingApplication } from "../../../packages/device-lab/src/device-lab/application/broker-recording.js";
import type { BrokerRecordingRequest } from "../../../packages/device-lab/src/device-lab/domain/broker-recording.js";
import type { BrokerRecordingPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-recording.js";

const owner = "recording-owner";
const activeRecording = {
    active: true, provider: "adb-screenrecord", authority: "host-broker", processOwner: "host-broker",
    startedBy: "broker.device.recording.start", runtimeId: "previous-runtime", pid: 12345,
    processIdentity: { incarnation: "previous-process" }, remotePath: "/sdcard/previous.mp4",
    localPath: "/private/previous.mp4",
};
const request = (tool: string): BrokerRecordingRequest => ({
    tool, backend: "android-emulator", stateKey: "android", deviceId: "pixel",
    remotePath: null, localPath: null, timeLimitSec: null,
});
function unexpected(): never { throw new Error("unexpected native effect"); }

function fixture() {
    const device: Record<string, unknown> = { id: "pixel", status: "running", port: 5580, recording: null };
    const ports: BrokerRecordingPorts = {
        findTarget: () => ({ stateKey: "android", backend: "android-emulator", device }),
        heartbeat: () => null,
        observeProcess: unexpected,
        publish: (_owner, _state, _id, _expected, replacement) => {
            device.recording = replacement;
            return { found: true, matched: true, currentRecording: replacement, device };
        },
        resolveIosTarget: unexpected,
        localPath: () => "/private/new.mp4", prepareOutput: () => undefined,
        launchAndroidRecording: unexpected, launchIosRecording: unexpected,
        stopAndroidRecording: unexpected, pullAndroidRecording: unexpected, removeAndroidRecording: unexpected,
        signal: unexpected, waitForExit: unexpected,
        timestamp: () => "2026-10-11T00:00:00.000Z", runtimeId: () => "new-runtime",
    };
    return { ports, device };
}

function stoppedFixture() {
    const { ports, device } = fixture();
    device.recording = { ...activeRecording };
    const effects: string[] = [];
    ports.observeProcess = () => ({ status: "match" });
    ports.signal = () => {
        effects.push("signal");
        return { attempted: true, ok: true, receipt: {} };
    };
    ports.stopAndroidRecording = (context, serial) => {
        expect(context).toMatchObject({ ownerId: owner, target: { stateKey: "android", device: { id: "pixel" } }, recording: activeRecording });
        expect(serial).toBe("emulator-5580");
        effects.push("stop");
        return { status: 0, receipt: {} };
    };
    ports.waitForExit = async () => {
        effects.push("exit");
        return true;
    };
    ports.pullAndroidRecording = (context, serial, remotePath, localPath) => {
        expect(context).toMatchObject({ ownerId: owner, recording: { ...activeRecording, active: false, artifactCopyPending: true } });
        expect({ serial, remotePath, localPath }).toEqual({ serial: "emulator-5580", remotePath: activeRecording.remotePath, localPath: activeRecording.localPath });
        effects.push("pull");
        return { status: 0, receipt: {} };
    };
    ports.removeAndroidRecording = (context, serial, remotePath) => {
        expect(context).toMatchObject({ ownerId: owner, recording: { ...activeRecording, active: false, artifactCopyPending: true, artifactCopied: true } });
        expect({ serial, remotePath }).toEqual({ serial: "emulator-5580", remotePath: activeRecording.remotePath });
        effects.push("remove");
        return { status: 0, receipt: {} };
    };
    ports.publish = (_owner, _state, _id, expected, replacement) => {
        expect(device.recording).toEqual(expected);
        effects.push(replacement === null ? "clear" : replacement.artifactCopied ? "copied" : "pending");
        device.recording = replacement;
        return { found: true, matched: true, currentRecording: replacement, device };
    };
    return { ports, device, effects };
}

describe("broker recording artifact recovery", () => {
    it("publishes pending and copied evidence before their native effects, then clears after removal", async () => {
        const { ports, device, effects } = stoppedFixture();
        expect(await createBrokerRecordingApplication(ports).stop(owner, request("device_record_video_stop"))).toMatchObject({
            kind: "stopped", recording: { active: false, runtimeId: activeRecording.runtimeId, localPath: activeRecording.localPath },
        });
        expect(effects).toEqual(["signal", "stop", "exit", "pending", "pull", "copied", "remove", "clear"]);
        expect(device.recording).toBeNull();
    });

    it("retains the exact stopped recording through repeated copy failures and retries without stopping again", async () => {
        const { ports, device, effects } = stoppedFixture();
        let attempts = 0;
        ports.pullAndroidRecording = context => {
            expect(context.recording).toMatchObject({ active: false, artifactCopyPending: true, runtimeId: activeRecording.runtimeId });
            effects.push("pull");
            return { status: ++attempts < 3 ? 17 : 0, receipt: { attempt: attempts } };
        };
        const app = createBrokerRecordingApplication(ports);
        for (let attempt = 1; attempt <= 2; attempt++) {
            expect(await app.stop(owner, request("device_record_video_stop"))).toMatchObject({
                kind: "stopped-with-copy-failure", error: "recording-artifact-copy-failed",
                recording: { active: false, artifactCopyPending: true, runtimeId: activeRecording.runtimeId },
            });
            expect(device.recording).toMatchObject({ ...activeRecording, active: false, artifactCopyPending: true });
            expect(effects).not.toContain("remove");
            expect(effects).not.toContain("clear");
        }
        expect(await app.stop(owner, request("device_record_video_stop"))).toMatchObject({ kind: "stopped" });
        expect(effects.filter(effect => effect === "signal")).toHaveLength(1);
        expect(effects.filter(effect => effect === "stop")).toHaveLength(1);
        expect(attempts).toBe(3);
        expect(device.recording).toBeNull();
    });

    it.each([false, true])("preserves pending status and refuses a new start when copied=%s", async copied => {
        const { ports, device } = fixture();
        const pending = { ...activeRecording, active: false, artifactCopyPending: true, stoppedAt: ports.timestamp(), ...(copied ? { artifactCopied: true } : {}) };
        device.recording = pending;
        ports.observeProcess = unexpected;
        ports.publish = unexpected;
        const app = createBrokerRecordingApplication(ports);
        expect(app.status(owner, request("device_record_video_status"))).toMatchObject({ kind: "observed", recording: pending });
        expect(await app.start(owner, request("device_record_video_start"))).toMatchObject({ kind: "refused", reason: "conflict", recording: pending });
        expect(device.recording).toEqual(pending);
    });

    it.each(["exited", "mismatch"] as const)("recovers a positively %s recorder without signalling or remote pkill", async status => {
        const { ports, device, effects } = stoppedFixture();
        ports.observeProcess = () => ({ status });
        ports.signal = unexpected;
        ports.stopAndroidRecording = unexpected;
        expect(await createBrokerRecordingApplication(ports).stop(owner, request("device_record_video_stop"))).toMatchObject({ kind: "stopped" });
        expect(effects).not.toContain("signal");
        expect(effects).not.toContain("stop");
        expect(device.recording).toBeNull();
    });

    it("performs no stop or artifact effects when the recorder identity is unavailable", async () => {
        const { ports, device } = fixture();
        device.recording = activeRecording;
        ports.observeProcess = () => ({ status: "unavailable" });
        ports.signal = unexpected;
        ports.publish = unexpected;
        expect(await createBrokerRecordingApplication(ports).stop(owner, request("device_record_video_stop"))).toMatchObject({ kind: "refused" });
        expect(device.recording).toEqual(activeRecording);
    });

    it.each(["pending", "copied"] as const)("stops downstream effects when %s publication throws", async stage => {
        const { ports, device, effects } = stoppedFixture();
        const publish = ports.publish;
        ports.publish = (...args) => {
            const replacement = args[4];
            if (replacement && Boolean(replacement.artifactCopied) === (stage === "copied")) throw new Error("state publication denied");
            return publish(...args);
        };
        await createBrokerRecordingApplication(ports).stop(owner, request("device_record_video_stop")).catch(() => undefined);
        expect(effects).not.toContain("remove");
        expect(effects).not.toContain("clear");
        if (stage === "pending") {
            expect(effects).not.toContain("pull");
            expect(device.recording).toEqual(activeRecording);
        } else {
            expect(effects).toContain("pull");
            expect(device.recording).toMatchObject({ active: false, artifactCopyPending: true });
            expect(device.recording).not.toHaveProperty("artifactCopied", true);
        }
    });

    it.each(["pending", "copied", "clear"] as const)("preserves a same-path successor on %s publication conflict", async stage => {
        const { ports, device, effects } = stoppedFixture();
        const successor = { ...activeRecording, runtimeId: "same-path-successor", pid: 23456 };
        const publish = ports.publish;
        ports.publish = (...args) => {
            const replacement = args[4];
            const currentStage = replacement === null ? "clear" : replacement.artifactCopied ? "copied" : "pending";
            if (currentStage !== stage) return publish(...args);
            device.recording = successor;
            return { found: true, matched: false, currentRecording: successor, device: null };
        };
        expect(await createBrokerRecordingApplication(ports).stop(owner, request("device_record_video_stop"))).toMatchObject({
            kind: "refused", error: "recording-runtime-state-conflict", currentRecording: successor,
        });
        expect(device.recording).toEqual(successor);
        expect(effects).not.toContain("clear");
        if (stage === "pending") expect(effects).not.toContain("pull");
        if (stage !== "clear") expect(effects).not.toContain("remove");
    });

    it("retains copied evidence after removal failure and retries removal without copying again", async () => {
        const { ports, device, effects } = stoppedFixture();
        let attempts = 0;
        ports.removeAndroidRecording = context => {
            expect(context.recording).toMatchObject({ active: false, artifactCopyPending: true, artifactCopied: true });
            effects.push("remove");
            return { status: ++attempts === 1 ? 17 : 0, receipt: {} };
        };
        const app = createBrokerRecordingApplication(ports);
        expect(await app.stop(owner, request("device_record_video_stop"))).toMatchObject({ kind: "refused" });
        expect(device.recording).toMatchObject({ ...activeRecording, active: false, artifactCopyPending: true, artifactCopied: true });
        ports.pullAndroidRecording = unexpected;
        ports.signal = unexpected;
        ports.stopAndroidRecording = unexpected;
        expect(await app.stop(owner, request("device_record_video_stop"))).toMatchObject({ kind: "stopped" });
        expect(effects.filter(effect => effect === "pull")).toHaveLength(1);
        expect(attempts).toBe(2);
        expect(device.recording).toBeNull();
    });

    it("retains copy-complete evidence when final clear conflicts without replacing the record", async () => {
        const { ports, device } = stoppedFixture();
        const publish = ports.publish;
        ports.publish = (...args) => args[4] === null
            ? { found: true, matched: false, currentRecording: device.recording, device: null }
            : publish(...args);
        expect(await createBrokerRecordingApplication(ports).stop(owner, request("device_record_video_stop"))).toMatchObject({ kind: "refused", error: "recording-runtime-state-conflict" });
        expect(device.recording).toMatchObject({ active: false, artifactCopyPending: true, artifactCopied: true, runtimeId: activeRecording.runtimeId });
    });

    it.each([false, true])("preserves a newer same-runtime recovery snapshot from delayed status when copied=%s", copied => {
        const { ports, device } = fixture();
        device.recording = activeRecording;
        const pending = { ...activeRecording, active: false, artifactCopyPending: true, stoppedAt: ports.timestamp(), ...(copied ? { artifactCopied: true } : {}) };
        ports.observeProcess = () => ({ status: "exited" });
        ports.publish = (_owner, _state, _id, expected, replacement) => {
            expect(expected).toEqual(activeRecording);
            expect(replacement).toEqual({ ...activeRecording, active: false, artifactCopyPending: true, stoppedAt: ports.timestamp() });
            device.recording = pending;
            return { found: true, matched: false, currentRecording: pending, device: null };
        };
        expect(createBrokerRecordingApplication(ports).status(owner, request("device_record_video_status"))).toMatchObject({ kind: "observed", recording: pending });
        expect(device.recording).toEqual(pending);
    });
});

describe("broker recording current policies", () => {
    it("retains recording metadata when process identity cannot be observed", () => {
        const { ports, device } = fixture();
        device.recording = activeRecording;
        ports.observeProcess = () => ({ status: "unavailable" });
        ports.publish = unexpected;
        expect(createBrokerRecordingApplication(ports).status(owner, request("device_record_video_status"))).toMatchObject({
            kind: "observed", recording: activeRecording, supported: true, provider: "adb-screenrecord",
        });
        expect(device.recording).toEqual(activeRecording);
    });

    it("publishes pending media after natural recorder exit through the expected-record authority", () => {
        const { ports, device } = fixture();
        device.recording = activeRecording;
        ports.observeProcess = () => ({ status: "exited" });
        const pending = { ...activeRecording, active: false, artifactCopyPending: true, stoppedAt: ports.timestamp() };
        ports.publish = (actualOwner, state, id, expected, replacement) => {
            expect({ actualOwner, state, id, expected, replacement }).toEqual({
                actualOwner: owner, state: "android", id: "pixel", expected: activeRecording, replacement: pending,
            });
            device.recording = pending;
            return { found: true, matched: true, currentRecording: pending, device };
        };
        expect(createBrokerRecordingApplication(ports).status(owner, request("device_record_video_status"))).toMatchObject({
            kind: "observed", recording: pending,
        });
        expect(device.recording).toEqual(pending);
    });

    it("preserves a successor when stale-status publication loses its comparison", () => {
        const { ports, device } = fixture();
        device.recording = activeRecording;
        const successor = { ...activeRecording, runtimeId: "successor-runtime", pid: 23456 };
        ports.observeProcess = () => ({ status: "mismatch" });
        ports.publish = (_owner, _state, _id, expected, replacement) => {
            expect(expected).toEqual(activeRecording);
            expect(replacement).toEqual({ ...activeRecording, active: false, artifactCopyPending: true, stoppedAt: ports.timestamp() });
            device.recording = successor;
            return { found: true, matched: false, currentRecording: successor, device: null };
        };
        expect(createBrokerRecordingApplication(ports).status(owner, request("device_record_video_status"))).toMatchObject({ kind: "observed" });
        expect(device.recording).toEqual(successor);
    });

    it("publishes a successful Android launch with defaults and its actual process identity", async () => {
        const { ports, device } = fixture();
        const identity = { incarnation: "new-process" };
        ports.launchAndroidRecording = async (serial, remotePath, timeLimitSec, localPath) => {
            expect({ serial, remotePath, timeLimitSec, localPath }).toEqual({ serial: "emulator-5580",
                remotePath: "/sdcard/ccc-pixel-recording.mp4", timeLimitSec: 180, localPath: "/private/new.mp4" });
            return { status: 0, pid: 34567, processIdentity: identity, receipt: { launch: "controlled" } };
        };
        expect(await createBrokerRecordingApplication(ports).start(owner, request("device_record_video_start"))).toMatchObject({ kind: "started" });
        expect(device.recording).toMatchObject({
            active: true, runtimeId: "new-runtime", pid: 34567, processIdentity: identity,
            localPath: "/private/new.mp4", remotePath: "/sdcard/ccc-pixel-recording.mp4", timeLimitSec: 180,
        });
    });

    it("does not publish a recording after launch failure", async () => {
        const { ports, device } = fixture();
        const execution = { status: 17, error: "provider launch denied", receipt: { launch: "denied" } };
        ports.launchAndroidRecording = async () => execution;
        ports.publish = unexpected;
        expect(await createBrokerRecordingApplication(ports).start(owner, request("device_record_video_start"))).toMatchObject({
            kind: "refused", reason: "provider-failed", error: "recording-start-failed", execution,
        });
        expect(device.recording).toBeNull();
    });

    it("reports failed rollback truthfully without overwriting a publication successor", async () => {
        const { ports, device } = fixture();
        const successor = { ...activeRecording, runtimeId: "successor-runtime" };
        const rollback = { attempted: false, ok: false, receipt: { reason: "runtime-process-identity-unavailable" } };
        ports.launchAndroidRecording = async () => ({ status: 0, pid: 34567, processIdentity: { incarnation: "new-process" }, receipt: {} });
        ports.publish = () => {
            device.recording = successor;
            return { found: true, matched: false, currentRecording: successor, device: null };
        };
        ports.signal = (recording, signal) => {
            expect(recording).toMatchObject({ runtimeId: "new-runtime", pid: 34567 });
            expect(signal).toBe("SIGINT");
            return rollback;
        };
        expect(await createBrokerRecordingApplication(ports).start(owner, request("device_record_video_start"))).toMatchObject({
            kind: "refused", reason: "conflict", error: "recording-runtime-state-conflict", currentRecording: successor, rollback,
        });
        expect(device.recording).toEqual(successor);
    });

    it("retains active metadata and skips artifact copy when exit remains unconfirmed", async () => {
        const { ports, device } = fixture();
        device.recording = activeRecording;
        ports.signal = () => ({ attempted: true, ok: true, receipt: {} });
        ports.observeProcess = () => ({ status: "match" });
        ports.stopAndroidRecording = (context, serial) => {
            expect(context).toMatchObject({ ownerId: owner, recording: activeRecording });
            expect(serial).toBe("emulator-5580");
            return { status: 0, receipt: {} };
        };
        ports.waitForExit = async () => false;
        ports.publish = unexpected;
        expect(await createBrokerRecordingApplication(ports).stop(owner, request("device_record_video_stop"))).toMatchObject({
            kind: "uncertain", reason: "provider-failed", error: "recording-process-still-running", recording: activeRecording,
        });
        expect(device.recording).toEqual(activeRecording);
    });
});
