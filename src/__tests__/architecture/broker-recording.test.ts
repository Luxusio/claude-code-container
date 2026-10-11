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

    it("clears an exited recording through the expected-record publication authority", () => {
        const { ports, device } = fixture();
        device.recording = activeRecording;
        ports.observeProcess = () => ({ status: "exited" });
        ports.publish = (actualOwner, state, id, expected, replacement) => {
            expect({ actualOwner, state, id, expected, replacement }).toEqual({
                actualOwner: owner, state: "android", id: "pixel", expected: activeRecording, replacement: null,
            });
            device.recording = null;
            return { found: true, matched: true, currentRecording: activeRecording, device };
        };
        expect(createBrokerRecordingApplication(ports).status(owner, request("device_record_video_status"))).toMatchObject({
            kind: "observed", recording: null,
        });
        expect(device.recording).toBeNull();
    });

    it("preserves a successor when stale-status publication loses its comparison", () => {
        const { ports, device } = fixture();
        device.recording = activeRecording;
        const successor = { ...activeRecording, runtimeId: "successor-runtime", pid: 23456 };
        ports.observeProcess = () => ({ status: "mismatch" });
        ports.publish = (_owner, _state, _id, expected, replacement) => {
            expect(expected).toEqual(activeRecording);
            expect(replacement).toBeNull();
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
        ports.stopAndroidRecording = serial => {
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
