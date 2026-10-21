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
const settledAndroid = {
    budget: () => ({ remaining: () => 3000, requestTimeout: (maximum = 3000) => Math.min(3000, maximum), pause: async () => undefined }),
    observeGuest: () => ({ status: "absent" as const }),
};

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
            ...common, ...processLeaves, ...settledAndroid, kind: "android-emulator",
            target: device => ({ kind: "ready", device, target: { kind: "adb", executable: "/allocated/adb", prefix: ["-s", "emulator-5582"] } }),
            spawnRecorder(_target, _paths, _limit, onExit) {
                state.device = { ...state.device, recording: successor };
                notifyExit = onExit;
                return { pid: 17, startup: async () => ({ kind: "ready" }), signal: () => { recorderAlive = false; return undefined; }, unref: () => undefined };
            },
            alive: () => recorderAlive,
            fallbackStop: unexpected, copyRecording: unexpected, removeRecording: unexpected,
        };

        expect(await createDirectRecordingApplication(ports).request("device_record_video_start", { deviceId: id })).toMatchObject({
            kind: "failure", message: expect.stringContaining(`changed while starting for ${id}`),
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
        const previous = { active: true, runtimeId: "previous-runtime", pid: 17,
            processIdentity: { pid: 17, startToken: "owned-start", commandHash: "a".repeat(64) }, remotePath: remote, localPath: destination };
        const { state, common, stage } = repository(previous);
        state.files.set(remote, "known video bytes");
        const effects: string[] = [];
        let copySucceeds = false, generation = 0, localExited = false;
        const output = { stdout: "copied", stderr: "copy warning", status: 91 };
        const ports: AndroidRecordingPorts = {
            ...common, ...processLeaves, ...settledAndroid, kind: "android-emulator",
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
            observe: () => ({ status: localExited ? "exited" : "match" }),
            signal(recording) { expect(recording).toEqual(previous); effects.push("signal"); localExited = true; return { signaled: true }; },
            fallbackStop() { effects.push("fallback-stop"); return { ok: true }; },
            async waitExit() { return localExited; },
            observeGuest() { effects.push("observe-guest"); return { status: "absent" }; },
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
        expect(effects).toContain("signal");
        expect(effects.indexOf("observe-guest")).toBeLessThan(effects.indexOf("claim"));
        expect(effects.slice(effects.indexOf("claim"))).toEqual(["claim", "create-stage", "copy", "dispose"]);
        expect(state.device.recording).toMatchObject({ active: false, runtimeId: "finalization-1", recorderRuntimeId: "previous-runtime", remotePath: remote, localPath: destination });
        expect(state.files.get(destination)).toBe("previous destination");
        expect(state.files.get(remote)).toBe("known video bytes");
        expect(state.files.has(stage.stagedPath)).toBe(false);

        effects.length = 0;
        copySucceeds = true;
        expect(await application.request("device_record_video_stop", { deviceId: id })).toMatchObject({
            kind: "success", value: { deviceId: id, stopped: true, provider: "adb-screenrecord", ...output },
        });
        expect(effects).not.toContain("signal");
        expect(effects.indexOf("observe-guest")).toBeLessThan(effects.indexOf("claim"));
        expect(effects.slice(effects.indexOf("claim"))).toEqual(["claim", "create-stage", "copy", "commit", "clear", "remove", "dispose"]);
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

describe("direct recording allocated-stage lifetime", () => {
    function simulator(recording: RecordingRecord | null) {
        const { state, common, stage } = repository(recording), effects: string[] = [], disposed: RecordingStage[] = [];
        state.files.set(stage.stagedPath, "known video bytes");
        const ports: SimulatorRecordingPorts = {
            ...common, ...processLeaves, kind: "ios-simulator",
            target: device => ({ kind: "ready", device, target: { kind: "simulator", executable: "/allocated/xcrun", target: "OWNED-SIMULATOR" } }),
            createStage(_device, path, persistent) { effects.push(persistent ? "allocate-persistent" : "allocate-temporary"); expect(path).toBe(destination); return { ok: true, stage }; },
            restoreStage(_device, path, stagedPath) { effects.push("restore"); expect([path, stagedPath]).toEqual([destination, stage.stagedPath]); return { ok: true, stage }; },
            populateStage(source, output) { effects.push("populate"); expect(output).toBe(stage); state.files.set(output.stagedPath, state.files.get(source)!); return { ok: true }; },
            commitStage(output) { effects.push("commit"); expect(output).toBe(stage); state.files.set(output.path, state.files.get(output.stagedPath)!); return { ok: true }; },
            disposeStage(output) { effects.push("dispose"); disposed.push(output); output.cleanup(); return undefined; },
        };
        return { state, common, stage, ports, effects, disposed,
            stop: () => createDirectRecordingApplication(ports).request("device_record_video_stop", { deviceId: id, localPath: destination }) };
    }

    it.each(["commit refusal", "commit throw", "clear refusal", "clear throw"])("retains persistent Simulator stage after %s without attempting disposal", async fault => {
        const stagingPath = "/owned/output-stage/payload", previous = { active: false, runtimeId: "pending-runtime", localPath: destination, stagingPath };
        const f = simulator(previous), thrown = { code: "EIO", privateDetail: "preserved internal fault" };
        const successor = { active: true, runtimeId: "successor-runtime", stagingPath: "/owned/successor/payload" };
        if (fault === "commit refusal") f.ports.commitStage = () => ({ ok: false, message: "publication refused" });
        if (fault === "commit throw") f.ports.commitStage = () => { throw thrown; };
        if (fault.startsWith("clear")) {
            let updates = 0;
            f.ports.updateDevice = (deviceId, update) => {
                if (++updates === 2) {
                    if (fault === "clear throw") throw thrown;
                    f.state.device = { ...f.state.device, recording: successor };
                }
                return f.common.updateDevice(deviceId, update);
            };
        }

        const result = await f.stop().then(value => ({ kind: "returned" as const, value }), error => ({ kind: "thrown" as const, error }));
        if (fault.endsWith("throw")) {
            expect(result).toEqual({ kind: "thrown", error: thrown });
            if (result.kind !== "thrown") throw new Error("Expected persistent-stage throw");
            expect(result.error).toBe(thrown);
        } else expect(result).toMatchObject({ kind: "returned", value: { kind: "failure" } });
        expect(f.disposed).toEqual([]); expect(f.effects).not.toContain("populate"); expect(f.effects).not.toContain("allocate-temporary");
        expect(f.state.files.get(stagingPath)).toBe("known video bytes");
        expect(f.state.files.get(destination)).toBe(fault.startsWith("clear") ? "known video bytes" : "previous destination");
        if (fault === "clear refusal") expect(f.state.device.recording).toBe(successor);
        else expect(f.state.device.recording).toMatchObject({ active: false, stagingPath });
    });

    it.each(["populate", "commit", "clear"])("disposes the same temporary legacy Simulator stage once when %s throws", async fault => {
        const source = "/owned/legacy-recording.mp4", f = simulator({ active: false, runtimeId: "legacy-runtime", localPath: source });
        const thrown = { fault }; f.state.files.set(source, "legacy video bytes");
        if (fault === "populate") f.ports.populateStage = () => { throw thrown; };
        if (fault === "commit") f.ports.commitStage = () => { throw thrown; };
        if (fault === "clear") {
            let updates = 0;
            f.ports.updateDevice = (deviceId, update) => {
                if (++updates === 2) throw thrown;
                return f.common.updateDevice(deviceId, update);
            };
        }

        const result = await f.stop().then(value => ({ kind: "returned" as const, value }), error => ({ kind: "thrown" as const, error }));
        expect(result).toEqual({ kind: "thrown", error: thrown }); expect(f.disposed).toEqual([f.stage]); expect(f.disposed[0]).toBe(f.stage);
        expect(f.state.files.has(f.stage.stagedPath)).toBe(false); expect(f.state.files.get(source)).toBe("legacy video bytes");
        expect(f.state.files.get(destination)).toBe(fault === "clear" ? "legacy video bytes" : "previous destination");
        expect(f.state.device.recording).toMatchObject({ active: false, recorderRuntimeId: "legacy-runtime" });
    });

    it.each(["populate", "commit", "clear"])("retains legacy Simulator %s refusal and failed cleanup with truthful publication facts", async fault => {
        const source = "/owned/legacy-recording.mp4", f = simulator({ active: false, runtimeId: "legacy-runtime", localPath: source });
        const cleanupError = { code: "EACCES" }; f.state.files.set(source, "legacy video bytes");
        const successor = { active: true, runtimeId: "successor-runtime" };
        if (fault === "populate") f.ports.populateStage = () => ({ ok: false, message: "legacy source refused" });
        if (fault === "commit") f.ports.commitStage = () => ({ ok: false, message: "publication refused" });
        if (fault === "clear") {
            let updates = 0;
            f.ports.updateDevice = (deviceId, update) => {
                if (++updates === 2) f.state.device = { ...f.state.device, recording: successor };
                return f.common.updateDevice(deviceId, update);
            };
        }
        f.ports.disposeStage = stage => { f.disposed.push(stage); throw cleanupError; };

        const result = await f.stop();
        const message = fault === "populate" ? `legacy source refused. iOS Simulator legacy recording remains pending finalization for ${id}.`
            : fault === "commit" ? `publication refused. iOS Simulator recording remains pending finalization for ${id}.`
            : `iOS Simulator recording state changed while stopping for ${id}; successor state and staged artifact were preserved.`;
        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "failure",
            message,
        }, error: cleanupError, facts: fault === "clear" ? { outputPublished: true } : {} });
        if (!result || result.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.error).toBe(cleanupError); expect(f.disposed).toEqual([f.stage]);
        if (fault === "populate") expect(f.effects).not.toContain("commit");
        if (fault === "clear") expect(f.state.device.recording).toBe(successor);
        expect(f.state.files.get(destination)).toBe(fault === "clear" ? "legacy video bytes" : "previous destination");
        expect(f.state.files.get(source)).toBe("legacy video bytes");
    });

    it("retains completed Simulator publication and clear facts when final stage disposal fails", async () => {
        const f = simulator({ active: false, runtimeId: "pending-runtime", localPath: destination, stagingPath: "/owned/output-stage/payload" });
        const cleanupError = { code: "EACCES" };
        f.ports.disposeStage = stage => { f.disposed.push(stage); throw cleanupError; };

        const result = await f.stop();
        expect(result).toMatchObject({ kind: "cleanup-failure", primary: { kind: "success", value: { stopped: true, provider: "simctl-recordVideo" } },
            facts: { outputPublished: true, recordingStateCleared: true } });
        if (!result || result.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.error).toBe(cleanupError); expect(f.disposed).toEqual([f.stage]);
        expect(f.state.device.recording).toBeNull(); expect(f.state.files.get(destination)).toBe("known video bytes");
    });

    it.each(["not ready", "identity missing", "generation changed", "exited after admission"])("keeps %s start refusal when owned persistent-stage disposal fails", async fault => {
        const f = simulator(null), cleanupError = { code: "EACCES" }, signals: string[] = [];
        const successor = { active: true, runtimeId: "successor-runtime" };
        f.ports.disposeStage = stage => { f.disposed.push(stage); throw cleanupError; };
        f.ports.spawnRecorder = (_target, paths) => {
            expect(paths.outputPath).toBe(f.stage.stagedPath);
            if (fault === "generation changed") f.state.device = { ...f.state.device, recording: successor };
            return { pid: 17, startup: async () => fault === "not ready" ? { kind: "error", message: "start refused" } : { kind: "ready" },
                signal: signal => { signals.push(signal); return undefined; }, unref: () => undefined };
        };
        if (fault === "identity missing") f.ports.readIdentity = () => null;
        if (fault === "exited after admission") f.ports.alive = () => false;

        const result = await createDirectRecordingApplication(f.ports).request("device_record_video_start", { deviceId: id });
        const message = fault === "not ready" ? "iOS Simulator recordVideo recorder failed to start: start refused"
            : fault === "identity missing" ? `iOS Simulator recorder process identity could not be established for ${id}.`
            : fault === "generation changed" ? `iOS Simulator recording state changed while starting for ${id}; the new recorder was stopped.`
            : `iOS Simulator recorder exited before its state was committed for ${id}.`;
        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "failure", message }, error: cleanupError,
            facts: fault === "exited after admission" ? { recordingStateCleared: true } : {} });
        if (!result || result.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.error).toBe(cleanupError); expect(f.disposed).toEqual([f.stage]);
        expect(f.effects).toEqual(["allocate-persistent"]);
        if (fault === "generation changed") expect(f.state.device.recording).toBe(successor);
        else expect(f.state.device.recording).toBeNull();
        expect(signals).toEqual(fault === "identity missing" || fault === "generation changed" ? ["SIGINT"] : []);
    });

    it("transfers persistent-stage lifetime to a successfully admitted Simulator recorder", async () => {
        const f = simulator(null);
        f.ports.spawnRecorder = (_target, paths) => {
            expect(paths.outputPath).toBe(f.stage.stagedPath);
            return { pid: 17, startup: async () => ({ kind: "ready" }), signal: unexpected, unref: () => undefined };
        };
        f.ports.disposeStage = () => { throw new Error("An active recorder still owns this stage"); };

        expect(await createDirectRecordingApplication(f.ports).request("device_record_video_start", { deviceId: id })).toMatchObject({
            kind: "success", value: { recording: { active: true, stagingPath: f.stage.stagedPath, runtimeId: "allocated-runtime" } },
        });
        expect(f.effects).toEqual(["allocate-persistent"]); expect(f.state.files.get(f.stage.stagedPath)).toBe("known video bytes");
    });

    it("preserves a macOS copy throw and failed disposal of its allocated output stage", async () => {
        const { state, common, stage } = repository({ active: false, runtimeId: "pending-runtime", remotePath: remote, localPath: destination });
        const primaryError = { code: "EIO" }, cleanupError = { code: "EACCES" }, disposed: RecordingStage[] = [];
        const ports: MacosRecordingPorts = {
            ...common, ...processLeaves, kind: "macos-vm", prepareWorkspace: () => undefined,
            target: device => ({ kind: "ready", device, target: { kind: "ssh", executable: "/allocated/ssh", prefix: [], target: "owner@selected-guest", scp: "/allocated/scp", scpPrefix: [] } }),
            createStage: () => ({ ok: true, stage }), fallbackStop: unexpected,
            copyRecording: () => { throw primaryError; }, removeRecording: unexpected, commitStage: unexpected,
            disposeStage: output => { disposed.push(output); throw cleanupError; },
        };

        const result = await createDirectRecordingApplication(ports).request("device_record_video_stop", { deviceId: id });
        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "thrown", error: primaryError }, error: cleanupError, facts: {} });
        if (!result || result.kind !== "cleanup-failure" || result.primary.kind !== "thrown") throw new Error("Expected preserved throw");
        expect(result.primary.error).toBe(primaryError); expect(result.error).toBe(cleanupError);
        expect(disposed).toEqual([stage]); expect(disposed[0]).toBe(stage); expect(state.files.get(destination)).toBe("previous destination");
        expect(state.device.recording).toMatchObject({ active: false, remotePath: remote });
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
            if (kind !== "macos-vm" && command.args.includes("pidof")) {
                expect(command.args).toEqual(["-s", "selected-device", "shell", "pidof", "screenrecord"]);
                expect(command.timeoutMs).toBeGreaterThan(0);
                expect(command.timeoutMs).toBeLessThanOrEqual(3000);
                return { status: 1, stdout: "", stderr: "" };
            }
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
