import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDirectRecording } from "../../../packages/device-lab/providers/adapters/direct-recording.mjs";
import { createDirectRecordingApplication } from "../../../packages/device-lab/providers/application/direct-recording.mjs";
import type { RecordingRecord, RecordingStage } from "../../../packages/device-lab/providers/domain/direct-recording.mjs";
import type { DirectRecordingNative, RecordingCommonPorts, RecordingProcessPorts, AndroidRecordingPorts, MacosRecordingPorts, SimulatorRecordingPorts, SandboxRecordingPorts } from "../../../packages/device-lab/providers/ports/direct-recording.mjs";

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
                return { ok: true, detail: "", output: { stdout: "copied", stderr: "" } };
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

    it("retains pending video after semantic copy failure and removes the remote only after a successful retry commits and clears", async () => {
        const previous = { active: true, runtimeId: "previous-runtime", pid: 17, remotePath: remote, localPath: destination };
        const { state, common, stage } = repository(previous);
        state.files.set(remote, "known video bytes");
        const effects: string[] = [];
        let copySucceeds = false, generation = 0;
        const output = { stdout: "copied", stderr: "copy warning", status: 91 };
        const ports: AndroidRecordingPorts = {
            ...common, ...processLeaves, kind: "android-emulator",
            runtimeId: () => `finalization-${++generation}`,
            updateDevice(deviceId, update) {
                return common.updateDevice(deviceId, current => {
                    const next = update(current);
                    if (next.recording === null) {
                        expect(state.files.get(destination)).toBe("known video bytes");
                        expect(state.files.has(remote)).toBe(true);
                        effects.push("clear");
                    } else if (next.recording !== current.recording) effects.push("claim");
                    return next;
                });
            },
            target: device => ({ kind: "ready", device, target: { kind: "adb", executable: "/allocated/adb", prefix: ["-s", "emulator-5582"] } }),
            signal(recording) { expect(recording).toEqual(previous); effects.push("signal"); return { signaled: true }; },
            fallbackStop() { effects.push("fallback-stop"); return { opaque: "ignored stop receipt" }; },
            async waitExit(pid, timeoutMs) { expect([pid, timeoutMs]).toEqual([17, 3000]); effects.push("wait"); return true; },
            createStage() { effects.push("create-stage"); return { ok: true, stage }; },
            copyRecording(_target, source, stagedPath, timeoutMs) {
                expect([source, stagedPath, timeoutMs]).toEqual([remote, stage.stagedPath, 300000]);
                effects.push("copy");
                state.files.set(stagedPath, copySucceeds ? "known video bytes" : "partial video bytes");
                return { ok: copySucceeds, detail: copySucceeds ? "" : "native transfer denied", output: copySucceeds ? output : { stdout: "success-looking output", stderr: "", status: 0 } };
            },
            commitStage(staged) {
                effects.push("commit");
                expect(state.device.recording).toMatchObject({ active: false, runtimeId: "finalization-2" });
                expect(state.files.get(staged.stagedPath)).toBe("known video bytes");
                state.files.set(staged.path, state.files.get(staged.stagedPath)!);
                return { ok: true };
            },
            removeRecording(_target, source) {
                expect(state.device.recording).toBeNull();
                expect(state.files.get(destination)).toBe("known video bytes");
                effects.push("remove");
                state.files.delete(source);
                return undefined;
            },
            disposeStage(staged) { effects.push("dispose"); staged.cleanup(); return undefined; },
        };
        const application = createDirectRecordingApplication(ports);

        expect(await application.request("device_record_video_stop", { deviceId: id })).toEqual({
            kind: "failure", message: `Error: native transfer denied. Android recording remains pending finalization for ${id}.`,
        });
        expect(effects).toEqual(["signal", "fallback-stop", "wait", "claim", "create-stage", "copy", "dispose"]);
        expect(state.device.recording).toMatchObject({ active: false, runtimeId: "finalization-1", recorderRuntimeId: "previous-runtime", remotePath: remote, localPath: destination });
        expect(state.files.get(destination)).toBe("previous destination");
        expect(state.files.get(remote)).toBe("known video bytes");
        expect(state.files.has(stage.stagedPath)).toBe(false);

        effects.length = 0;
        copySucceeds = true;
        expect(await application.request("device_record_video_stop", { deviceId: id })).toMatchObject({
            kind: "success", value: { deviceId: id, stopped: true, provider: "adb-screenrecord", ...output },
        });
        expect(effects).toEqual(["claim", "create-stage", "copy", "commit", "clear", "remove", "dispose"]);
        expect(state.device.recording).toBeNull();
        expect(state.files.get(destination)).toBe("known video bytes");
        expect(state.files.has(remote)).toBe(false);
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


describe("direct recording native copy observations", () => {
    it.each(["android-emulator", "android-device", "macos-vm"] as const)("normalizes %s native copy failures and preserves its public success fields", async kind => {
        const root = mkdtempSync(join(tmpdir(), "ccc-recording-copy-"));
        const output = join(root, "final-video.mp4");
        const previous = { active: false, runtimeId: "previous-runtime", remotePath: remote, localPath: output };
        const { state, common } = repository(previous);
        const stagePaths: string[] = [];
        let receipt: { status: number | null; stdout: string; stderr: string } = { status: 0, stdout: "", stderr: "" };
        let remotePresent = true, removals = 0;
        const env = { CCC_RECORDING_FIXTURE: "selected" };
        const runCommand: Extract<DirectRecordingNative, { kind: "macos-vm" }>["runCommand"] = command => {
            const copying = kind === "macos-vm" ? command.executable === "/allocated/scp" : command.args.includes("pull");
            if (copying) {
                const stagedPath = command.args[command.args.length - 1];
                expect(command).toEqual(kind === "macos-vm"
                    ? { executable: "/allocated/scp", args: ["-P", "2222", `owner@selected-guest:${remote}`, stagedPath], env, timeoutMs: 1245 }
                    : { executable: "/allocated/adb", args: ["-s", "selected-device", "pull", remote, stagedPath], timeoutMs: 300000 });
                stagePaths.push(stagedPath);
                writeFileSync(stagedPath, receipt.status === 0 ? "known video bytes" : "partial video bytes");
                return { ...receipt, nativeOnly: "private command detail" };
            }
            expect(command).toEqual(kind === "macos-vm"
                ? { executable: "/allocated/ssh", args: ["-p", "2222", "owner@selected-guest", `rm -f '${remote}'`], env, timeoutMs: 1245 }
                : { executable: "/allocated/adb", args: ["-s", "selected-device", "shell", "rm", "-f", remote], timeoutMs: 300000 });
            expect(state.device.recording).toBeNull();
            expect(readFileSync(output, "utf8")).toBe("known video bytes");
            expect(remotePresent).toBe(true);
            remotePresent = false;
            removals++;
            return { status: 88, stdout: "ignored removal receipt", stderr: "ignored removal error" };
        };
        const nativeCommon = {
            findDevice: common.findDevice, updateDevice: common.updateDevice,
            localPath: () => output, recordingDirectory: () => root,
            validateLocalOutputPath: (path: string) => ({ ok: true as const, path }),
        };
        const native: DirectRecordingNative = kind === "macos-vm"
            ? { ...nativeCommon, kind, runCommand, ensureWorkspace: () => undefined,
                resolveTarget: device => ({ kind: "ready", device, target: { kind: "ssh", executable: "/allocated/ssh", prefix: ["-p", "2222"], target: "owner@selected-guest", scp: "/allocated/scp", scpPrefix: ["-P", "2222"], env } }) }
            : { ...nativeCommon, kind, runCommand,
                resolveTarget: device => ({ kind: "ready", device, target: { kind: "adb", executable: "/allocated/adb", prefix: ["-s", "selected-device"] } }) };
        const label = kind === "macos-vm" ? "macOS VM" : kind === "android-device" ? "Android real-device" : "Android";
        try {
            writeFileSync(output, "previous destination");
            const application = createDirectRecording(native);
            for (const failed of [
                { status: 7, stdout: "transfer stdout", stderr: "transfer stderr", detail: "transfer stderr" },
                { status: 8, stdout: "transfer stdout", stderr: "", detail: "transfer stdout" },
                { status: null, stdout: "", stderr: "", detail: "exit null" },
            ]) {
                receipt = { status: failed.status, stdout: failed.stdout, stderr: failed.stderr };
                expect(await application.request("device_record_video_stop", { deviceId: id, helperTimeoutMs: 1245 })).toEqual({
                    kind: "failure", message: `Error: ${failed.detail}. ${label} recording remains pending finalization for ${id}.`,
                });
                expect(state.device.recording).toMatchObject({ active: false, recorderRuntimeId: "previous-runtime", remotePath: remote, localPath: output });
                expect(readFileSync(output, "utf8")).toBe("previous destination");
                expect(remotePresent).toBe(true);
                expect(removals).toBe(0);
                expect(existsSync(dirname(stagePaths[stagePaths.length - 1]))).toBe(false);
            }

            receipt = { status: 0, stdout: "  copied stdout\n", stderr: "  copied stderr\n" };
            const result = await application.request("device_record_video_stop", { deviceId: id, helperTimeoutMs: 1245 });
            expect(result).toMatchObject({ kind: "success", value: { deviceId: id, stopped: true, stdout: receipt.stdout, stderr: receipt.stderr } });
            if (!result || result.kind !== "success") throw new Error("Expected native copy success");
            expect(Object.keys(result.value).sort()).toEqual([
                "deviceId", "stopped", "provider", "recording", "stdout", "stderr",
                ...(kind === "android-device" ? [] : ["device"]), ...(kind === "macos-vm" ? [] : ["status"]),
            ].sort());
            if (kind !== "macos-vm") expect(result.value.status).toBe(0);
            expect(state.device.recording).toBeNull();
            expect(readFileSync(output, "utf8")).toBe("known video bytes");
            expect(remotePresent).toBe(false);
            expect(removals).toBe(1);
            for (const stagedPath of stagePaths) expect(existsSync(dirname(stagedPath))).toBe(false);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
