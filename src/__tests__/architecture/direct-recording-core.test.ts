import { describe, expect, it } from "vitest";
import { createDirectRecordingApplication } from "../../../packages/device-lab/providers/application/direct-recording.mjs";
import type { RecordingRecord, RecordingStage } from "../../../packages/device-lab/providers/domain/direct-recording.mjs";
import type { RecordingCommonPorts, RecordingProcessPorts, AndroidRecordingPorts, MacosRecordingPorts, SimulatorRecordingPorts, SandboxRecordingPorts } from "../../../packages/device-lab/providers/ports/direct-recording.mjs";

const id = "owned-recording", destination = "/owned/final-video", remote = "/guest/owned-video";
const timestamp = "2026-10-11T00:00:00.000Z";
function unexpected(): never { throw new Error("Unallocated native effect"); }

function repository(recording: RecordingRecord | null) {
    const state: { device: RecordingRecord; files: Map<string, string> } = {
        device: { id, status: "running", recording }, files: new Map([[destination, "previous destination"]]),
    };
    const common: RecordingCommonPorts = {
        findDevice: deviceId => deviceId === id ? state.device : null,
        updateDevice(deviceId, update) {
            if (deviceId !== id) return null;
            state.device = update(state.device);
            return state.device;
        },
        runtimeId: () => "allocated-runtime", timestamp: () => timestamp,
        localPath: () => destination, validatePath: path => ({ ok: true, path }), prepareOutput: () => undefined,
    };
    const stage: RecordingStage = {
        path: destination, stagedPath: "/owned/output-stage/payload", stageRoot: "/owned/output-stage",
        cleanup() { state.files.delete(stage.stagedPath); },
    };
    return { state, common, stage };
}

const processLeaves: RecordingProcessPorts = {
    spawnRecorder: unexpected, readIdentity: () => ({ pid: 17, startToken: "owned-start", commandHash: "owned-command" }),
    observe: () => ({ status: "match" }), alive: () => true, signal: unexpected, waitExit: unexpected,
    createStage: unexpected, commitStage: unexpected,
    disposeStage(stage) { stage.cleanup(); return undefined; },
};

describe("direct recording generation and artifact outcomes", () => {
    it("stops a new recorder refused by generation admission without changing the successor on exit", async () => {
        const { state, common } = repository(null);
        const successor = { active: true, runtimeId: "successor-runtime", pid: 29, remotePath: "/guest/successor-video" };
        let recorderAlive = true, notifyExit: () => undefined = unexpected;
        const ports: AndroidRecordingPorts = {
            ...common, ...processLeaves, kind: "android-emulator",
            target: device => ({ kind: "ready", device, target: { kind: "adb", executable: "/allocated/adb", prefix: ["-s", "emulator-5582"] } }),
            spawnRecorder(_target, _paths, _limit, onExit) {
                state.device = { ...state.device, recording: successor };
                notifyExit = onExit;
                return { pid: 17, startup: async () => ({ kind: "ready" }), signal: () => { recorderAlive = false; return undefined; }, unref: () => undefined };
            },
            alive: () => recorderAlive,
            fallbackStop: unexpected, copyRecording: unexpected, removeRecording: unexpected,
        };

        expect(await createDirectRecordingApplication(ports).request("device_record_video_start", { deviceId: id })).toEqual({
            kind: "failure", message: `Android recording state changed while starting for ${id}; the new recorder was stopped.`,
        });
        expect(recorderAlive).toBe(false);
        expect(state.device.recording).toEqual(successor);
        notifyExit();
        expect(state.device.recording).toEqual(successor);
    });

    it("retains a remote artifact and successor after publishing local video but losing final generation admission", async () => {
        const previous = { active: false, runtimeId: "previous-runtime", remotePath: remote, localPath: destination };
        const { state, common, stage } = repository(previous);
        const successor = { active: true, runtimeId: "successor-runtime", remotePath: "/guest/successor-video" };
        state.files.set(remote, "known video bytes");
        const ports: MacosRecordingPorts = {
            ...common, ...processLeaves, kind: "macos-vm", prepareWorkspace: () => undefined,
            target: device => ({ kind: "ready", device, target: { kind: "ssh", executable: "/allocated/ssh", prefix: [], target: "owner@selected-guest", scp: "/allocated/scp", scpPrefix: [] } }),
            createStage: () => ({ ok: true, stage }), fallbackStop: unexpected,
            copyRecording(_target, source, output) {
                const bytes = state.files.get(source);
                if (bytes === undefined) throw new Error("Selected guest artifact missing");
                state.files.set(output, bytes);
                return { status: 0, stdout: "copied", stderr: "" };
            },
            commitStage(output) {
                const bytes = state.files.get(output.stagedPath);
                if (bytes === undefined) throw new Error("Allocated output stage missing");
                state.files.set(output.path, bytes);
                state.device = { ...state.device, recording: successor };
                return { ok: true };
            },
            removeRecording(_target, source) { state.files.delete(source); return { status: 0, stdout: "", stderr: "" }; },
        };

        expect(await createDirectRecordingApplication(ports).request("device_record_video_stop", { deviceId: id })).toEqual({
            kind: "failure", message: `macOS VM recording state changed while stopping for ${id}; successor state and remote artifact were preserved.`,
        });
        expect(state.device.recording).toEqual(successor);
        expect(state.files.get(destination)).toBe("known video bytes");
        expect(state.files.get(remote)).toBe("known video bytes");
        expect(state.files.has(stage.stagedPath)).toBe(false);
    });

    it("keeps a legacy Simulator source and destination when populating its finalization stage fails", async () => {
        const source = "/owned/legacy-video.mp4";
        const previous = { active: false, runtimeId: "legacy-runtime", localPath: source };
        const { state, common, stage } = repository(previous);
        state.files.set(source, "legacy video bytes");
        const ports: SimulatorRecordingPorts = {
            ...common, ...processLeaves, kind: "ios-simulator",
            target: device => ({ kind: "ready", device, target: { kind: "simulator", executable: "/allocated/xcrun", target: "OWNED-SIMULATOR" } }),
            createStage: () => ({ ok: true, stage }), restoreStage: unexpected,
            populateStage(input, output) {
                expect(state.files.get(input)).toBe("legacy video bytes");
                state.files.set(output.stagedPath, "partial stage bytes");
                return { ok: false, message: "native source read refused" };
            },
        };

        expect(await createDirectRecordingApplication(ports).request("device_record_video_stop", { deviceId: id, localPath: destination })).toEqual({
            kind: "failure", message: `native source read refused. iOS Simulator legacy recording remains pending finalization for ${id}.`,
        });
        expect(state.device.recording).toMatchObject({ active: false, runtimeId: "allocated-runtime", recorderRuntimeId: "legacy-runtime", localPath: destination });
        expect(state.files.get(source)).toBe("legacy video bytes");
        expect(state.files.get(destination)).toBe("previous destination");
        expect(state.files.has(stage.stagedPath)).toBe(false);
    });

    it("preserves a Sandbox successor when completed-status archive publication races with its generation", async () => {
        const previous = { active: true, runtimeId: "previous-runtime", sessionId: "owned-session", localPath: destination };
        const { state, common } = repository(previous);
        const archive = "/owned/downloads/owned-session.zip";
        const completed = { active: false, sessionId: "owned-session", state: "Completed", archivePath: archive };
        const successor = { active: true, runtimeId: "successor-runtime", sessionId: "successor-session", localPath: destination };
        state.files.set(archive, "known archive bytes");
        const ports: SandboxRecordingPorts = {
            ...common, kind: "windows-sandbox",
            helper: async () => ({ response: { ok: true, recording: completed }, helper: { downloads: "/owned/downloads" } }),
            archivePath: (_helper, path) => path === archive ? archive : null,
            copyArchive(source, output) {
                const bytes = state.files.get(source);
                if (bytes === undefined) throw new Error("Owned archive missing");
                state.files.set(output, bytes);
                state.device = { ...state.device, recording: successor };
                return { ok: true };
            },
        };

        expect(await createDirectRecordingApplication(ports).request("device_record_video_status", { deviceId: id })).toEqual({
            kind: "success", value: { deviceId: id, recording: successor, provider: "windows-helper-frame-archive", helper: completed },
        });
        expect(state.device.recording).toEqual(successor);
        expect(state.files.get(destination)).toBe("known archive bytes");
        expect(state.files.get(archive)).toBe("known archive bytes");
    });

    it("reports missing-helper-record Sandbox status without throwing or clearing active metadata", async () => {
        const previous = { active: true, runtimeId: "previous-runtime", sessionId: "owned-session", localPath: destination };
        const { state, common } = repository(previous);
        const ports: SandboxRecordingPorts = {
            ...common, kind: "windows-sandbox",
            helper: async () => ({ response: { ok: true }, helper: { downloads: "/owned/downloads" } }),
            archivePath: () => null, copyArchive: unexpected,
        };

        expect(await createDirectRecordingApplication(ports).request("device_record_video_status", { deviceId: id })).toEqual({
            kind: "success", value: { deviceId: id, recording: previous, provider: "windows-helper-frame-archive", helper: "Windows helper recording output is missing or unsafe" },
        });
        expect(state.device.recording).toEqual(previous);
        expect(state.files.get(destination)).toBe("previous destination");
    });
});
