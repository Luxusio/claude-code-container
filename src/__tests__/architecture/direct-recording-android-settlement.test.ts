import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectRecordingApplication } from "../../../packages/device-lab/providers/application/direct-recording.mjs";
import { createDirectRecording } from "../../../packages/device-lab/providers/adapters/direct-recording.mjs";
import type { RecordingRecord } from "../../../packages/device-lab/providers/domain/direct-recording.mjs";
import type { AndroidRecordingPorts, DirectRecordingNative } from "../../../packages/device-lab/providers/ports/direct-recording.mjs";

const deviceId = "selected-android", destination = "/owned/video.mp4", remote = "/sdcard/owned-video.mp4";
const identity = { pid: 17, startToken: "captured-start", commandHash: "a".repeat(64) };
const active = { active: true, runtimeId: "captured-recording", pid: 17, processIdentity: identity, remotePath: remote, localPath: destination };
type LocalStatus = "match" | "mismatch" | "exited" | "unavailable";
type GuestStatus = "running" | "absent" | "unavailable";

function fixture(recording: RecordingRecord = active, kind: AndroidRecordingPorts["kind"] = "android-emulator") {
    const state = {
        device: { id: deviceId, serial: "selected-device", leaseClaimId: "lease-one", leaseClaimNonce: "nonce-one", recording } as RecordingRecord,
        files: new Map([[destination, "previous destination"], [remote, "complete remote media"]]),
        local: "match" as LocalStatus, guest: "absent" as GuestStatus,
        copyOk: true, commitOk: true, fallbackOk: true, signalExits: true,
        now: 0, pauses: 0, tick: 1000, generation: 0,
        onPause: () => undefined as undefined, onGuest: () => undefined as undefined,
        onSignal: () => undefined as undefined, onFallback: () => undefined as undefined,
    };
    const effects: string[] = [], timeouts: number[] = [];
    const stage = { path: destination, stagedPath: "/owned/stage/payload", stageRoot: "/owned/stage", cleanup() { state.files.delete(this.stagedPath); } };
    const ports: AndroidRecordingPorts = {
        kind,
        findDevice: id => id === deviceId ? state.device : null,
        updateDevice(id, update) {
            if (id !== deviceId) return null;
            const next = update(state.device);
            if (next.recording !== state.device.recording) effects.push(next.recording === null ? "clear" : "publish");
            state.device = next;
            return state.device;
        },
        runtimeId: () => `finalization-${++state.generation}`, timestamp: () => "2026-10-20T00:00:00.000Z",
        localPath: () => destination, validatePath: path => ({ ok: true, path }), prepareOutput: () => { effects.push("prepare"); return undefined; },
        target: device => ({ kind: "ready", device, target: { kind: "adb", executable: "/allocated/adb", prefix: ["-s", String(device.serial)] } }),
        spawnRecorder: () => { throw new Error("Unexpected new recorder"); }, readIdentity: () => identity,
        observe: () => ({ status: state.local }), alive: () => state.local !== "exited",
        signal() { effects.push("signal"); state.onSignal(); if (state.signalExits) state.local = "exited"; return { signaled: true }; },
        waitExit: async () => state.local === "exited",
        budget(timeoutMs, intervalMs) {
            expect(timeoutMs).toBe(3000);
            expect(intervalMs).toBeGreaterThan(0);
            const deadline = state.now + timeoutMs;
            return {
                remaining: () => Math.max(0, deadline - state.now),
                requestTimeout: (maximum = timeoutMs) => Math.max(0, Math.min(maximum, deadline - state.now)),
                async pause() { effects.push("pause"); state.pauses++; state.now += state.tick; state.onPause(); },
            };
        },
        fallbackStop(_target, _remote, timeoutMs) {
            effects.push("fallback"); timeouts.push(timeoutMs!); state.onFallback(); return { ok: state.fallbackOk };
        },
        observeGuest(_target, timeoutMs) { effects.push("guest"); timeouts.push(timeoutMs); state.onGuest(); return { status: state.guest }; },
        createStage() { effects.push("stage"); return { ok: true, stage }; },
        copyRecording(_target, source, stagedPath) {
            effects.push("copy");
            state.files.set(stagedPath, state.copyOk ? state.files.get(source)! : "partial transfer");
            return { ok: state.copyOk, detail: state.copyOk ? "" : "copy denied", output: { status: state.copyOk ? 0 : 8, stdout: "copied", stderr: "" } };
        },
        commitStage(output) {
            effects.push("commit");
            if (!state.commitOk) return { ok: false, message: "publication denied" };
            state.files.set(output.path, state.files.get(output.stagedPath)!);
            return { ok: true };
        },
        removeRecording(_target, path) { effects.push("remove"); state.files.delete(path); return undefined; },
        disposeStage(output) { effects.push("dispose"); output.cleanup(); return undefined; },
    };
    const app = createDirectRecordingApplication(ports);
    const stop = () => app.request("device_record_video_stop", { deviceId });
    const retained = (expected: RecordingRecord = recording) => {
        expect(state.device.recording).toEqual(expected);
        expect(state.files.get(destination)).toBe("previous destination");
        expect(state.files.get(remote)).toBe("complete remote media");
        expect(state.files.has(stage.stagedPath)).toBe(false);
    };
    return { app, ports, state, stage, effects, timeouts, stop, retained };
}

describe("direct Android recording settlement", () => {
    it("regression: unavailable local identity and failed fallback cannot publish success or remove recovery bytes", async () => {
        const f = fixture();
        f.state.local = "unavailable";
        f.state.guest = "running";
        f.state.fallbackOk = false;
        f.ports.signal = () => ({ signaled: false, reason: "runtime-process-identity-unavailable" });
        const result = await f.stop();
        expect(result).toMatchObject({ kind: "failure" });
        f.retained();
        expect(f.effects).not.toContain("publish");
        expect(f.effects).not.toContain("stage");
        expect(f.effects).not.toContain("remove");
    });

    it("regression: failed stop followed by a copy retry must reprove settlement before publishing or deleting", async () => {
        const f = fixture();
        f.state.local = "unavailable";
        f.state.guest = "running";
        f.state.fallbackOk = false;
        f.state.copyOk = false;
        f.ports.signal = () => ({ signaled: false, reason: "runtime-process-identity-unavailable" });
        const first = await f.stop();
        f.state.copyOk = true;
        const second = await f.stop();
        expect([first, second]).toEqual([expect.objectContaining({ kind: "failure" }), expect.objectContaining({ kind: "failure" })]);
        f.retained();
        expect(f.effects).not.toContain("copy");
        expect(f.effects).not.toContain("clear");
        expect(f.effects).not.toContain("remove");
    });

    it.each([
        ["missing", undefined], ["empty", {}], ["wrong pid", { ...identity, pid: 18 }],
        ["empty start", { ...identity, startToken: "" }], ["invalid hash", { ...identity, commandHash: "invalid" }],
    ] as const)("retains active media with %s expected identity even if guest appears absent", async (_name, processIdentity) => {
        const recording = { ...active, processIdentity };
        const f = fixture(recording);
        expect(await f.stop()).toMatchObject({ kind: "failure" });
        f.retained();
        expect(f.effects).not.toContain("signal");
        expect(f.effects).not.toContain("fallback");
        expect(f.effects).not.toContain("stage");
    });

    it.each(["android-emulator", "android-device"] as const)("%s status and duplicate start preserve a mismatched active generation without guest polling", async kind => {
        const f = fixture(active, kind);
        f.state.local = "mismatch";
        expect(await f.app.request("device_record_video_status", { deviceId })).toMatchObject({ kind: "success", value: { recording: active } });
        expect(await f.app.request("device_record_video_start", { deviceId })).toMatchObject({ kind: "failure" });
        f.retained();
        expect(f.effects).toEqual([]);
    });

    it.each(["running", "unavailable"] as const)("identity mismatch with a %s guest preserves the current process and recording", async status => {
        const f = fixture();
        f.state.local = "mismatch"; f.state.guest = status;
        expect(await f.stop()).toMatchObject({ kind: "failure" });
        f.retained();
        expect(f.effects).not.toContain("signal");
        expect(f.effects).not.toContain("fallback");
        expect(f.effects).not.toContain("stage");
    });

    it("recovers a mismatched identity only after fresh guest absence without signalling either successor", async () => {
        const f = fixture(); f.state.local = "mismatch";
        expect(await f.stop()).toMatchObject({ kind: "success", value: { stopped: true } });
        expect(f.effects).not.toContain("signal"); expect(f.effects).not.toContain("fallback");
        expect(f.state.files.get(destination)).toBe("complete remote media");
        expect(f.state.files.has(remote)).toBe(false); expect(f.state.device.recording).toBeNull();
    });

    it("signal acknowledgement without local exit cannot publish settled media", async () => {
        const f = fixture(); f.state.signalExits = false;
        expect(await f.stop()).toMatchObject({ kind: "failure" });
        f.retained(); expect(f.effects).toContain("signal"); expect(f.effects).not.toContain("stage");
        expect(f.state.now).toBe(3000);
    });

    it("verified ESRCH from identity-bound signalling permits recovery after selected guest absence", async () => {
        const f = fixture();
        f.ports.signal = () => { f.state.local = "exited"; return { signaled: false, exited: true, reason: "runtime-process-exited" }; };
        expect(await f.stop()).toMatchObject({ kind: "success", value: { stopped: true } });
        expect(f.state.files.get(destination)).toBe("complete remote media");
        expect(f.state.files.has(remote)).toBe(false); expect(f.state.device.recording).toBeNull();
    });

    it.each(["running", "unavailable"] as const)("fallback acknowledgement while selected guest is %s cannot grant finalization", async status => {
        const f = fixture(); f.state.guest = status;
        expect(await f.stop()).toMatchObject({ kind: "failure" });
        f.retained(); expect(f.effects).toContain("fallback"); expect(f.effects).not.toContain("stage");
    });

    it("failed fallback still permits recovery after independently proven local exit and guest absence", async () => {
        const f = fixture(); f.state.local = "exited"; f.state.fallbackOk = false;
        expect(await f.stop()).toMatchObject({ kind: "success", value: { stopped: true } });
        expect(f.effects).not.toContain("signal");
        expect(f.state.files.get(destination)).toBe("complete remote media");
        expect(f.state.device.recording).toBeNull(); expect(f.state.files.has(remote)).toBe(false);
    });

    it("waits for delayed local and guest cessation within the same allowance", async () => {
        const f = fixture(); f.state.signalExits = false; f.state.guest = "running";
        f.state.onPause = () => { f.state.local = "exited"; f.state.guest = "absent"; return undefined; };
        expect(await f.stop()).toMatchObject({ kind: "success", value: { stopped: true } });
        expect(f.state.pauses).toBeGreaterThan(0);
        expect(f.timeouts.every(timeout => timeout > 0 && timeout <= 3000)).toBe(true);
        expect(f.state.files.get(destination)).toBe("complete remote media");
    });

    it.each(["legacy pending", "natural child exit"])("%s requires fresh guest absence and never repeats a local stop", async origin => {
        const recording = { ...active, active: false, ...(origin === "natural child exit" ? { endedAt: "captured-exit" } : {}) };
        const f = fixture(recording); f.state.guest = "running";
        expect(await f.stop()).toMatchObject({ kind: "failure" }); f.retained();
        expect(f.effects).not.toContain("signal"); expect(f.effects).not.toContain("fallback");
        f.state.guest = "absent";
        expect(await f.stop()).toMatchObject({ kind: "success", value: { stopped: true } });
        expect(f.state.files.get(destination)).toBe("complete remote media");
    });

    it.each(["copy", "commit"])("%s failure preserves pending bytes and retry rechecks guest without another signal", async failure => {
        const f = fixture(); f.state.copyOk = failure !== "copy"; f.state.commitOk = failure !== "commit";
        expect(await f.stop()).toMatchObject({ kind: "failure" });
        const pending = f.state.device.recording as RecordingRecord;
        expect(pending).toMatchObject({ active: false, remotePath: remote }); f.retained(pending);
        const signalCount = f.effects.filter(effect => effect === "signal").length;
        f.state.copyOk = true; f.state.commitOk = true; f.state.guest = "unavailable";
        expect(await f.stop()).toMatchObject({ kind: "failure" }); f.retained(pending);
        f.state.guest = "absent";
        expect(await f.stop()).toMatchObject({ kind: "success", value: { stopped: true } });
        expect(f.effects.filter(effect => effect === "signal")).toHaveLength(signalCount);
        expect(f.state.files.get(destination)).toBe("complete remote media"); expect(f.state.files.has(remote)).toBe(false);
    });

    it.each(["generation", "target", "lease"])("preserves a %s successor appearing during a yielded observation", async conflict => {
        const f = fixture(active, "android-device"); f.state.guest = "running";
        let successor: RecordingRecord | undefined;
        f.state.onPause = () => {
            successor = { ...f.state.device, ...(conflict === "generation" ? { recording: { ...active, runtimeId: "successor-generation" } }
                : conflict === "target" ? { serial: "successor-device" } : { leaseClaimId: "lease-two", leaseClaimNonce: "nonce-two" }) };
            f.state.device = successor; f.state.guest = "absent"; return undefined;
        };
        expect(await f.stop()).toMatchObject({ kind: "failure" });
        expect(f.state.device).toEqual(successor); f.retained(successor!.recording as RecordingRecord);
        expect(f.effects).not.toContain("stage");
        expect(f.effects.slice(f.effects.indexOf("pause") + 1)).not.toContain("fallback");
        expect(f.effects.slice(f.effects.indexOf("pause") + 1)).not.toContain("guest");
    });

    it("rejects a generation successor created by a local signal before dispatching fallback", async () => {
        const f = fixture(); const successor = { ...active, runtimeId: "successor-generation" };
        f.state.onSignal = () => { f.state.device = { ...f.state.device, recording: successor }; return undefined; };
        expect(await f.stop()).toMatchObject({ kind: "failure" }); f.retained(successor);
        expect(f.effects).not.toContain("fallback"); expect(f.effects).not.toContain("guest");
    });

    it.each(["fallback", "guest"])("late positive %s evidence at expiry cannot create a stage or dispatch another command", async where => {
        const f = fixture();
        if (where === "fallback") f.state.onFallback = () => { f.state.now = 3000; return undefined; };
        else f.state.onGuest = () => { f.state.now = 3000; return undefined; };
        expect(await f.stop()).toMatchObject({ kind: "failure" }); f.retained();
        expect(f.effects).not.toContain("stage");
        if (where === "fallback") expect(f.effects).not.toContain("guest");
        expect(f.timeouts.every(timeout => timeout > 0 && timeout <= 3000)).toBe(true);
    });

    it("an exhausted allowance refuses every native dispatch before signalling", async () => {
        const f = fixture();
        f.ports.budget = () => ({ remaining: () => 0, requestTimeout: () => 0, pause: async () => { throw new Error("Expired allowance must not wait"); } });
        expect(await f.stop()).toMatchObject({ kind: "failure" }); f.retained();
        expect(f.effects).toEqual([]);
    });

    it("a successor published by a guest observation preserves its own state and all recovery bytes", async () => {
        const f = fixture(); const successor = { ...active, runtimeId: "successor-after-probe" };
        f.state.onGuest = () => { f.state.device = { ...f.state.device, recording: successor }; return undefined; };
        expect(await f.stop()).toMatchObject({ kind: "failure" }); f.retained(successor);
        expect(f.effects).not.toContain("stage"); expect(f.effects).not.toContain("remove");
    });
});

describe("direct Android recording stage cleanup", () => {
    function failDisposal(f: ReturnType<typeof fixture>) {
        const error = { code: "EACCES", message: "private stage removal detail" };
        const disposed: unknown[] = [];
        f.ports.disposeStage = stage => { expect(stage).toBe(f.stage); f.effects.push("dispose"); disposed.push(stage); throw error; };
        return { error, disposed };
    }

    it("preserves a copy refusal and pending recovery bytes when its allocated stage cannot be removed", async () => {
        const f = fixture({ ...active, active: false }); f.state.copyOk = false;
        const cleanup = failDisposal(f);
        const result = await f.stop();

        expect(result).toEqual({ kind: "cleanup-failure", primary: {
            kind: "failure", message: `Error: copy denied. Android recording remains pending finalization for ${deviceId}.`,
        }, error: cleanup.error, facts: {} });
        if (!result || result.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.error).toBe(cleanup.error);
        expect(cleanup.disposed).toEqual([f.stage]); expect(cleanup.disposed[0]).toBe(f.stage);
        expect(f.state.device.recording).toMatchObject({ active: false, remotePath: remote });
        expect(f.state.files.get(destination)).toBe("previous destination");
        expect(f.state.files.get(remote)).toBe("complete remote media");
        expect(f.state.files.get(f.stage.stagedPath)).toBe("partial transfer");
        expect(f.effects).not.toContain("commit"); expect(f.effects).not.toContain("remove");
    });

    it("retains successful finalization and its positive facts when only stage removal fails", async () => {
        const f = fixture({ ...active, active: false }); const cleanup = failDisposal(f);
        const result = await f.stop();

        expect(result).toMatchObject({ kind: "cleanup-failure", primary: {
            kind: "success", value: { deviceId, stopped: true, provider: "adb-screenrecord", status: 0 },
        }, facts: { outputPublished: true, recordingStateCleared: true } });
        if (!result || result.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.error).toBe(cleanup.error); expect(cleanup.disposed).toEqual([f.stage]);
        expect(f.effects.slice(f.effects.indexOf("stage"))).toEqual(["stage", "copy", "commit", "clear", "remove", "dispose"]);
        expect(f.state.device.recording).toBeNull(); expect(f.state.files.has(remote)).toBe(false);
        expect(f.state.files.get(destination)).toBe("complete remote media");
    });

    it.each([0, undefined])("retains a falsy copy throw %j together with failed single-stage cleanup", async thrown => {
        const f = fixture({ ...active, active: false }); const cleanup = failDisposal(f);
        f.ports.copyRecording = () => { f.effects.push("copy"); throw thrown; };

        const result = await f.stop();
        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "thrown", error: thrown }, error: cleanup.error, facts: {} });
        if (!result || result.kind !== "cleanup-failure" || result.primary.kind !== "thrown") throw new Error("Expected preserved thrown primary");
        expect(result.primary.error).toBe(thrown); expect(result.error).toBe(cleanup.error);
        expect(cleanup.disposed).toEqual([f.stage]); expect(f.effects).not.toContain("commit");
        expect(f.effects).not.toContain("clear"); expect(f.effects).not.toContain("remove");
        expect(f.state.files.get(destination)).toBe("previous destination"); expect(f.state.files.has(remote)).toBe(true);
    });

    it.each([0, undefined])("successful cleanup rethrows the exact falsy copy failure %j", async thrown => {
        const f = fixture({ ...active, active: false }), disposed: unknown[] = [];
        f.ports.copyRecording = () => { throw thrown; };
        f.ports.disposeStage = stage => { disposed.push(stage); stage.cleanup(); return undefined; };

        const observed = await f.stop().then(value => ({ returned: true, value }), error => ({ returned: false, error }));
        expect(observed).toEqual({ returned: false, error: thrown }); expect(disposed).toEqual([f.stage]);
        expect(f.effects).not.toContain("commit"); expect(f.effects).not.toContain("clear");
    });

    it("does not claim output publication after a refused commit and failed cleanup", async () => {
        const f = fixture({ ...active, active: false }); f.state.commitOk = false;
        const cleanup = failDisposal(f);
        expect(await f.stop()).toEqual({ kind: "cleanup-failure", primary: {
            kind: "failure", message: `publication denied. Android recording remains pending finalization for ${deviceId}.`,
        }, error: cleanup.error, facts: {} });
        expect(cleanup.disposed).toEqual([f.stage]); expect(f.state.files.get(destination)).toBe("previous destination");
        expect(f.effects).not.toContain("clear"); expect(f.effects).not.toContain("remove");
    });

    it("records committed output before a generation successor causes guard refusal and cleanup also fails", async () => {
        const f = fixture({ ...active, active: false }); const cleanup = failDisposal(f);
        const commit = f.ports.commitStage, successor = { ...active, runtimeId: "successor-after-publication" };
        f.ports.commitStage = stage => {
            const result = commit(stage); f.state.device = { ...f.state.device, recording: successor }; return result;
        };

        const result = await f.stop();
        expect(result).toMatchObject({ kind: "cleanup-failure", primary: {
            kind: "failure", message: expect.stringContaining("state or target changed while stopping"),
        }, error: cleanup.error, facts: { outputPublished: true } });
        if (!result || result.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.facts).toEqual({ outputPublished: true });
        expect(cleanup.disposed).toEqual([f.stage]); expect(f.state.device.recording).toBe(successor);
        expect(f.state.files.get(destination)).toBe("complete remote media"); expect(f.state.files.has(remote)).toBe(true);
        expect(f.effects).not.toContain("clear"); expect(f.effects).not.toContain("remove");
    });

    it("retains both positive facts after clear succeeds but fresh attachment validation and cleanup fail", async () => {
        const f = fixture({ ...active, active: false }, "android-device"), cleanup = failDisposal(f);
        const update = f.ports.updateDevice;
        f.ports.updateDevice = (id, change) => {
            const next = update(id, change);
            if (next?.recording === null) f.state.device = { ...next, leaseClaimNonce: "successor-attachment" };
            return f.state.device;
        };

        expect(await f.stop()).toMatchObject({ kind: "cleanup-failure", primary: { kind: "failure" },
            error: cleanup.error, facts: { outputPublished: true, recordingStateCleared: true } });
        expect(cleanup.disposed).toEqual([f.stage]); expect(f.state.device.recording).toBeNull();
        expect(f.state.device.leaseClaimNonce).toBe("successor-attachment"); expect(f.effects).not.toContain("remove");
        expect(f.state.files.get(destination)).toBe("complete remote media"); expect(f.state.files.has(remote)).toBe(true);
    });

    it("preserves post-clear remote-removal throws and completed facts when stage cleanup fails too", async () => {
        const f = fixture({ ...active, active: false }); const cleanup = failDisposal(f), removeError = { code: "EIO" };
        f.ports.removeRecording = () => { f.effects.push("remove"); throw removeError; };

        const result = await f.stop();
        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "thrown", error: removeError },
            error: cleanup.error, facts: { outputPublished: true, recordingStateCleared: true } });
        if (!result || result.kind !== "cleanup-failure" || result.primary.kind !== "thrown") throw new Error("Expected preserved thrown primary");
        expect(result.primary.error).toBe(removeError); expect(result.error).toBe(cleanup.error);
        expect(cleanup.disposed).toEqual([f.stage]); expect(f.state.device.recording).toBeNull();
        expect(f.state.files.get(destination)).toBe("complete remote media"); expect(f.state.files.has(remote)).toBe(true);
    });

    it("retains the exact native admission refusal returned after stage allocation alongside cleanup failure", async () => {
        const f = fixture({ ...active, active: false }), cleanup = failDisposal(f);
        const refusal = { kind: "native" as const, value: { publicDiagnostic: "attachment refused" } };
        const target = f.ports.target;
        f.ports.target = (device, operation, validation) => f.effects.includes("stage") ? refusal : target(device, operation, validation);

        const result = await f.stop();
        expect(result).toEqual({ kind: "cleanup-failure", primary: refusal, error: cleanup.error, facts: {} });
        if (!result || result.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.primary).toBe(refusal); expect(cleanup.disposed).toEqual([f.stage]);
        expect(f.effects).not.toContain("copy"); expect(f.effects).not.toContain("clear"); expect(f.effects).not.toContain("remove");
    });
});

describe("direct Android recording native guest observations", () => {
    afterEach(() => vi.restoreAllMocks());

    it("producer forwards the captured target and shared live allowance through native settlement revalidation", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-android-target-validation-"));
        const output = join(root, "video.mp4"), previous = { ...active, active: false, localPath: output };
        let device: RecordingRecord = { id: deviceId, recording: previous }, clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const target = { kind: "adb" as const, executable: "/allocated/adb", prefix: ["-s", "selected-device"] };
        const validations: Array<NonNullable<Parameters<AndroidRecordingPorts["target"]>[2]>> = [];
        const native: DirectRecordingNative = {
            kind: "android-emulator", findDevice: () => device, updateDevice: (_id, update) => { device = update(device); return device; },
            localPath: () => output, recordingDirectory: () => root, validateLocalOutputPath: path => ({ ok: true, path }),
            resolveTarget(current, _operation, validation) {
                if (validation) validations.push(validation);
                return { kind: "ready", device: current, target };
            },
            runCommand(command) {
                if (command.args.includes("pidof")) { clock = 1500; return { status: 1, stdout: "", stderr: "" }; }
                if (command.args.includes("pull")) writeFileSync(command.args.at(-1)!, "complete remote media");
                return { status: 0, stdout: "", stderr: "" };
            },
        };
        try {
            writeFileSync(output, "previous destination");
            expect(await createDirectRecording(native).request("device_record_video_stop", { deviceId })).toMatchObject({ kind: "success", value: { stopped: true } });
            const bounded = validations.filter(validation => validation.waitBudget);
            expect(bounded.length).toBeGreaterThan(0);
            for (const validation of validations) expect(validation.capturedTarget).toEqual(target);
            for (const validation of bounded) expect(validation.waitBudget!.remaining()).toBe(1500);
            expect(device.recording).toBeNull(); expect(readFileSync(output, "utf8")).toBe("complete remote media");
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it.each([
        ["empty success", { status: 0, stdout: "", stderr: "" }],
        ["malformed", { status: 0, stdout: "screenrecord 27", stderr: "" }],
        ["zero pid", { status: 0, stdout: "0", stderr: "" }],
        ["negative pid", { status: 0, stdout: "-27", stderr: "" }],
        ["fractional pid", { status: 0, stdout: "27.5", stderr: "" }],
        ["transport failure", { status: 17, stdout: "", stderr: "device offline" }],
        ["dirty absence", { status: 1, stdout: "", stderr: "permission denied" }],
        ["absence with output", { status: 1, stdout: "27", stderr: "" }],
        ["signal", { status: 1, stdout: "", stderr: "", signal: "SIGTERM" }],
        ["native error", { status: 1, stdout: "", stderr: "", error: new Error("transport refused") }],
    ] as const)("%s native observation retains pending metadata, bytes and destination", async (_name, observation) => {
        const root = mkdtempSync(join(tmpdir(), "ccc-android-observation-"));
        const output = join(root, "video.mp4");
        const previous = { ...active, active: false, localPath: output };
        let device: RecordingRecord = { id: deviceId, recording: previous };
        const commands: string[][] = [];
        const native: DirectRecordingNative = {
            kind: "android-emulator", findDevice: () => device,
            updateDevice: (_id, update) => { device = update(device); return device; },
            localPath: () => output, recordingDirectory: () => root, validateLocalOutputPath: path => ({ ok: true, path }),
            resolveTarget: current => ({ kind: "ready", device: current, target: { kind: "adb", executable: "/allocated/adb", prefix: ["-s", "selected-device"] } }),
            runCommand(command) { commands.push(command.args); expect(command.timeoutMs).toBeGreaterThan(0); expect(command.timeoutMs).toBeLessThanOrEqual(3000); return observation; },
        };
        try {
            writeFileSync(output, "previous destination");
            expect(await createDirectRecording(native).request("device_record_video_stop", { deviceId })).toMatchObject({ kind: "failure" });
            expect(device.recording).toEqual(previous); expect(readFileSync(output, "utf8")).toBe("previous destination");
            expect(commands).toEqual([["-s", "selected-device", "shell", "pidof", "screenrecord"]]);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it.each(["27", "27  28\n"])("positive numeric pid list %j is running until a later clean absence", async pids => {
        const root = mkdtempSync(join(tmpdir(), "ccc-android-observation-"));
        const output = join(root, "video.mp4");
        const previous = { ...active, active: false, localPath: output };
        let device: RecordingRecord = { id: deviceId, recording: previous }, probes = 0, removed = false;
        const native: DirectRecordingNative = {
            kind: "android-device", findDevice: () => device, updateDevice: (_id, update) => { device = update(device); return device; },
            localPath: () => output, recordingDirectory: () => root, validateLocalOutputPath: path => ({ ok: true, path }),
            resolveTarget: current => ({ kind: "ready", device: current, target: { kind: "adb", executable: "/allocated/adb", prefix: ["-s", "selected-device"] } }),
            runCommand(command) {
                if (command.args.includes("pidof")) {
                    expect(readFileSync(output, "utf8")).toBe("previous destination"); expect(device.recording).toEqual(previous);
                    expect(command.timeoutMs).toBeGreaterThan(0); expect(command.timeoutMs).toBeLessThanOrEqual(3000);
                    return ++probes === 1 ? { status: 0, stdout: pids, stderr: "" } : { status: 1, stdout: "", stderr: "" };
                }
                if (command.args.includes("pull")) { expect(probes).toBe(2); writeFileSync(command.args.at(-1)!, "complete remote media"); }
                else { expect(command.args).toEqual(["-s", "selected-device", "shell", "rm", "-f", remote]); removed = true; }
                return { status: 0, stdout: "", stderr: "" };
            },
        };
        try {
            writeFileSync(output, "previous destination");
            expect(await createDirectRecording(native).request("device_record_video_stop", { deviceId })).toMatchObject({ kind: "success", value: { stopped: true } });
            expect(probes).toBe(2); expect(removed).toBe(true); expect(device.recording).toBeNull(); expect(readFileSync(output, "utf8")).toBe("complete remote media");
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("producer refuses guest absence returned after its monotonic deadline", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-android-observation-"));
        const output = join(root, "video.mp4"), previous = { ...active, active: false, localPath: output };
        let device: RecordingRecord = { id: deviceId, recording: previous }, clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const native: DirectRecordingNative = {
            kind: "android-emulator", findDevice: () => device, updateDevice: (_id, update) => { device = update(device); return device; },
            localPath: () => output, recordingDirectory: () => root, validateLocalOutputPath: path => ({ ok: true, path }),
            resolveTarget: current => ({ kind: "ready", device: current, target: { kind: "adb", executable: "/allocated/adb", prefix: ["-s", "selected-device"] } }),
            runCommand(command) { expect(command.args).toContain("pidof"); expect(command.timeoutMs).toBe(3000); clock = 3000; return { status: 1, stdout: "", stderr: "" }; },
        };
        try {
            writeFileSync(output, "previous destination");
            expect(await createDirectRecording(native).request("device_record_video_stop", { deviceId })).toMatchObject({ kind: "failure" });
            expect(device.recording).toEqual(previous); expect(readFileSync(output, "utf8")).toBe("previous destination");
            expect(existsSync(join(root, ".recording-stage-"))).toBe(false);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
