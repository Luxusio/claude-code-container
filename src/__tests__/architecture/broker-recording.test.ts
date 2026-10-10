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
        executable: () => "/controlled/adb", resolveIosTarget: unexpected,
        localPath: () => "/private/new.mp4", prepareOutput: () => undefined,
        launch: unexpected, execute: unexpected, signal: unexpected, waitForExit: unexpected,
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
            status: 200, payload: { ok: true, result: { recording: activeRecording, supported: true, provider: "adb-screenrecord", startsDevices: false } },
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
            status: 200, payload: { ok: true, result: { recording: null } },
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
        expect(createBrokerRecordingApplication(ports).status(owner, request("device_record_video_status"))).toMatchObject({ status: 200 });
        expect(device.recording).toEqual(successor);
    });

    it("publishes a successful Android launch with defaults and its actual process identity", async () => {
        const { ports, device } = fixture();
        const identity = { incarnation: "new-process" };
        ports.launch = async command => {
            expect(command).toEqual({ mode: "detached", provider: "adb", executable: "/controlled/adb",
                args: ["-s", "emulator-5580", "shell", "screenrecord", "--time-limit", "180", "/sdcard/ccc-pixel-recording.mp4"] });
            return { status: 0, pid: 34567, processIdentity: identity };
        };
        expect(await createBrokerRecordingApplication(ports).start(owner, request("device_record_video_start"))).toMatchObject({ status: 200, payload: { ok: true } });
        expect(device.recording).toMatchObject({
            active: true, runtimeId: "new-runtime", pid: 34567, processIdentity: identity,
            localPath: "/private/new.mp4", remotePath: "/sdcard/ccc-pixel-recording.mp4", timeLimitSec: 180,
        });
    });

    it("does not publish a recording after launch failure", async () => {
        const { ports, device } = fixture();
        const execution = { status: 17, error: "provider launch denied" };
        ports.launch = async () => execution;
        ports.publish = unexpected;
        expect(await createBrokerRecordingApplication(ports).start(owner, request("device_record_video_start"))).toMatchObject({
            status: 502, payload: { ok: false, error: "recording-start-failed", execution },
        });
        expect(device.recording).toBeNull();
    });

    it("reports failed rollback truthfully without overwriting a publication successor", async () => {
        const { ports, device } = fixture();
        const successor = { ...activeRecording, runtimeId: "successor-runtime" };
        const rollback = { attempted: false, ok: false, reason: "runtime-process-identity-unavailable" };
        ports.launch = async () => ({ status: 0, pid: 34567, processIdentity: { incarnation: "new-process" } });
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
            status: 409, payload: { ok: false, error: "recording-runtime-state-conflict", currentRecording: successor, rollback },
        });
        expect(device.recording).toEqual(successor);
    });

    it("retains active metadata and skips artifact copy when exit remains unconfirmed", async () => {
        const { ports, device } = fixture();
        device.recording = activeRecording;
        ports.signal = () => ({ attempted: true, ok: true });
        ports.execute = command => {
            expect(command.args).toEqual(["-s", "emulator-5580", "shell", "pkill", "-2", "screenrecord"]);
            return { status: 0 };
        };
        ports.waitForExit = async () => false;
        ports.publish = unexpected;
        expect(await createBrokerRecordingApplication(ports).stop(owner, request("device_record_video_stop"))).toMatchObject({
            status: 502, payload: { ok: false, error: "recording-process-still-running", recording: activeRecording, startsDevices: false },
        });
        expect(device.recording).toEqual(activeRecording);
    });
});
