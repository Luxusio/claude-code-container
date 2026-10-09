import { describe, expect, it } from "vitest";
import { createPhysicalStopApplication } from "../../../packages/device-lab/providers/application/physical-stop.mjs";
import type { PhysicalDevice, PhysicalSignalResult, PhysicalCommandResult, PhysicalExitResult, PhysicalStopPorts, PhysicalStopResponse } from "../../../packages/device-lab/providers/ports/physical-stop.mjs";

// These exact messages/flags were observed in the complete pre-extraction
// Android/iOS handlers at bd6f506. No private capture or task file is needed.
const id = "physical-control";
const timeout = (backend: string) => backend === "android-device"
    ? `Android real-device recording did not exit within 3000ms for ${id}; recording metadata and physical lease were preserved for retry.`
    : `iOS physical recording did not exit within 3000ms for ${id}; recording metadata and physical lease were preserved for retry.`;
type Backend = PhysicalStopPorts["backend"];
type Options = {
    inactive?: boolean; missing?: boolean; lifecyclePresent?: boolean; noAdb?: boolean;
    signal?: PhysicalSignalResult; adb?: PhysicalCommandResult; wait?: boolean; appium?: PhysicalExitResult;
    reject?: number; removeAtCas?: number; throwAtCas?: number;
    throwEffect?: "signal" | "adb" | "wait" | "appium";
    mutate?: "successor" | "missing" | "current";
};
function fixture(backend: Backend, options: Options = {}) {
    const original: PhysicalDevice = { id, status: "running", serial: "fake-serial", udid: "fake-udid", pid: 17,
        recording: { active: !options.inactive, pid: 777001, runtimeId: "recorder", extra: "retained" },
        appium: { runtimeId: "appium", extra: "retained" }, leaseClaimId: "lease", leaseClaimNonce: "nonce", extra: "original",
        ...(options.lifecyclePresent ? { lifecycle: null } : {}) };
    let current: PhysicalDevice | null = options.missing ? null : original;
    let cas = 0, ticks = 0;
    const calls: unknown[][] = [], rawError = new Error("native raw sentinel");
    const effect = (name: Options["throwEffect"]) => {
        if (options.throwEffect === name) throw rawError;
        if (options.mutate === "missing") current = null;
        else if (current && options.mutate === "successor") current = { ...current, lifecycle: { runtimeId: "successor" } };
        else if (current && options.mutate === "current") current = { ...current, extra: "current-extra" };
    };
    const common = {
        find: (deviceId: string) => { calls.push(["find", deviceId]); return current; },
        transition: (deviceId: string, expected: PhysicalDevice, replacement: PhysicalDevice | null) => {
            calls.push(["cas", deviceId, expected, replacement]); cas++;
            if (options.throwAtCas === cas) throw rawError;
            if (options.removeAtCas === cas) current = null;
            const before = current;
            const matched = Boolean(current && expected === current && options.reject !== cas);
            if (matched) current = replacement;
            return { found: Boolean(before), matched, currentDevice: before, device: matched ? replacement : before };
        },
        now: () => { const value = `clock-${ticks++}`; calls.push(["now", value]); return value; },
        runtimeId: () => { calls.push(["runtimeId"]); return "stop-generation"; },
        signalRecording: (recording: NonNullable<PhysicalDevice["recording"]>, signal: "SIGINT") => {
            calls.push(["signal", recording, signal]); effect("signal"); return options.signal ?? { attempted: true, signaled: true };
        },
        textResult: (ok: boolean, text: string | undefined): PhysicalStopResponse => ({ isError: !ok, content: [{ type: "text", text: text ?? "" }] }),
        jsonResult: (value: object): PhysicalStopResponse => ({ isError: false, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }),
        withTargetStatus: (device: PhysicalDevice) => { calls.push(["project", device]); return { ...device, projected: true }; },
    };
    const ports: PhysicalStopPorts = backend === "android-device" ? { ...common, backend,
        discoverAdb: () => { calls.push(["discover"]); return options.noAdb ? null : "fake-adb"; },
        stopAdbRecording: (adb, serial) => { calls.push(["adb", adb, serial]); effect("adb"); return options.adb ?? { status: 0, stdout: "", stderr: "" }; },
        waitRecordingExit: async (pid, ms) => { calls.push(["wait", pid, ms]); effect("wait"); return options.wait ?? true; },
    } : { ...common, backend,
        waitRecordingExit: async (recording, ms) => { calls.push(["wait", recording, ms]); effect("wait"); return options.wait ?? true; },
        stopOwnedAppium: async (appium, label) => { calls.push(["appium", appium, label]); effect("appium"); return options.appium ?? { exited: true }; },
    };
    return { app: createPhysicalStopApplication(ports), ports, original, calls, rawError,
        get current() { return current; }, get ticks() { return ticks; }, setCurrent(value: PhysicalDevice | null) { current = value; } };
}
type Fixture = ReturnType<typeof fixture>;
const body = (result: PhysicalStopResponse | undefined) => JSON.parse(result!.content[0].text) as Record<string, unknown>;
const effects = (f: Fixture) => f.calls.filter(row => ["discover", "signal", "adb", "wait", "appium"].includes(String(row[0])));
function success(f: Fixture, result: PhysicalStopResponse | undefined) {
    expect(body(result)).toEqual({ device: { ...f.current, projected: true }, stopped: false, detached: false, physicalDevicePoweredOff: false });
    expect(f.current).toMatchObject({ id, status: "attached", pid: null, appium: null, recording: null, leaseClaimId: "lease", leaseClaimNonce: "nonce" });
    expect(Object.hasOwn(f.current!, "lifecycle")).toBe(false);
    expect(f.calls.filter(row => row[0] === "cas")[0][2]).toBe(f.original);
    expect(f.calls.find(row => row[0] === "project")?.[1]).toBe(f.current);
}
function restored(f: Fixture, result: PhysicalStopResponse | undefined) {
    expect(result?.isError).toBe(true);
    expect(f.current).toMatchObject({ status: f.original.status, recording: f.original.recording, appium: f.original.appium,
        leaseClaimId: "lease", leaseClaimNonce: "nonce" });
    expect(Object.hasOwn(f.current!, "lifecycle")).toBe(Object.hasOwn(f.original, "lifecycle"));
    if (Object.hasOwn(f.original, "lifecycle")) expect(f.current?.lifecycle).toBe(f.original.lifecycle);
}

describe("complete physical stop application preserves original policy", () => {
    for (const backend of ["android-device", "ios-device"] as const) describe(backend, () => {
        it("returns missing without clock, claim or cleanup", async () => {
            const f = fixture(backend, { missing: true }); expect(await f.app.stop(id)).toBeUndefined(); expect(f.calls).toEqual([["find", id]]);
        });
        it.each([false, true])("keeps claim-conflict found=%s ahead of effects", async found => {
            const f = fixture(backend, { reject: 1, ...(found ? {} : { removeAtCas: 1 }) });
            expect(body(await f.app.stop(id))).toEqual({ ok: false, error: "owner-device-state-conflict", backend, deviceId: id, operation: "stop-claim", found });
            expect(effects(f)).toEqual([]); expect(f.ticks).toBe(2);
        });
        it.each([false, true])("stops active/inactive=%s with exact false flags and raw-current fields", async inactive => {
            const f = fixture(backend, { inactive, mutate: inactive ? undefined : "current" }); success(f, await f.app.stop(id));
            expect(f.current?.extra).toBe(inactive ? "original" : "current-extra"); expect(f.ticks).toBe(3);
            if (inactive) expect(effects(f).map(row => row[0])).toEqual(backend === "android-device" ? ["discover"] : ["appium"]);
            else expect(effects(f)).toEqual(backend === "android-device"
                ? [["discover"], ["signal", f.original.recording, "SIGINT"], ["adb", "fake-adb", "fake-serial"], ["wait", 777001, 3000]]
                : [["signal", f.original.recording, "SIGINT"], ["wait", f.original.recording, 3000], ["appium", f.original.appium, "iOS physical Appium"]]);
        });
        it("treats a signaled recorder timeout as failure before further cleanup", async () => {
            const f = fixture(backend, { wait: false }); const result = await f.app.stop(id); restored(f, result);
            expect(result?.content[0].text).toBe(timeout(backend)); expect(f.ticks).toBe(3);
            expect(effects(f).some(row => row[0] === "appium")).toBe(false);
        });
        it.each([false, true])("guarded abort restores lifecycle property presence=%s", async lifecyclePresent => {
            const f = fixture(backend, { lifecyclePresent, noAdb: true, signal: { attempted: false, signaled: false, reason: "unsafe" } });
            restored(f, await f.app.stop(id)); expect(f.ticks).toBe(3);
        });
        it.each(["successor", "missing"] as const)("final observation protects %s", async mutate => {
            const f = fixture(backend, { mutate }); expect(body(await f.app.stop(id))).toMatchObject({ operation: "stop", found: mutate === "successor" });
            if (mutate === "successor") expect(f.current?.lifecycle?.runtimeId).toBe("successor"); else expect(f.current).toBeNull();
            expect(f.calls.filter(row => row[0] === "cas")).toHaveLength(1);
        });
        it.each(["successor", "missing"] as const)("abort does not restore over %s", async mutate => {
            const f = fixture(backend, { mutate, noAdb: true, signal: { attempted: false, signaled: false, reason: "unsafe" } });
            expect((await f.app.stop(id))?.isError).toBe(true); expect(f.calls.filter(row => row[0] === "cas")).toHaveLength(1);
            if (mutate === "successor") expect(f.current?.lifecycle?.runtimeId).toBe("successor"); else expect(f.current).toBeNull();
        });
        it("commit CAS rejection keeps claimed state and exact conflict", async () => {
            const f = fixture(backend, { inactive: true, reject: 2 }); expect(body(await f.app.stop(id))).toEqual({ ok: false, error: "owner-device-state-conflict", backend, deviceId: id, operation: "stop", found: true });
            expect(f.current?.status).toBe("stopping"); expect(f.current?.recording).toBe(f.original.recording);
        });
        it("abort CAS rejection preserves native failure and claimed state", async () => {
            const f = fixture(backend, { reject: 2, noAdb: true, signal: { attempted: false, signaled: false, reason: "unsafe" } });
            expect((await f.app.stop(id))?.isError).toBe(true); expect(f.current?.status).toBe("stopping");
        });
        it.each([1, 2])("propagates raw claim/final CAS throw %s", async throwAtCas => {
            const f = fixture(backend, { inactive: true, throwAtCas }); await expect(f.app.stop(id)).rejects.toBe(f.rawError);
            expect(f.current?.status).toBe(throwAtCas === 1 ? "running" : "stopping");
        });
        it("propagates raw abort CAS throw", async () => {
            const f = fixture(backend, { throwAtCas: 2, noAdb: true, signal: { attempted: false, signaled: false, reason: "unsafe" } });
            await expect(f.app.stop(id)).rejects.toBe(f.rawError); expect(f.current?.status).toBe("stopping");
        });
        for (const throwEffect of backend === "android-device" ? ["signal", "adb", "wait"] as const : ["signal", "wait", "appium"] as const) it(`propagates raw ${throwEffect} throw without abort`, async () => {
            const f = fixture(backend, { throwEffect }); await expect(f.app.stop(id)).rejects.toBe(f.rawError);
            expect(f.current?.status).toBe("stopping"); expect(f.calls.filter(row => row[0] === "cas")).toHaveLength(1);
        });
        it("shares detach claims and guarded abort without losing current fields", () => {
            const f = fixture(backend); const claim = f.app.claimLifecycle(id, f.original, "detach"); expect(f.current?.status).toBe("detaching");
            const current = { ...f.current!, extra: "new-current" }; f.setCurrent(current);
            expect(f.app.currentLifecycleDevice(id, claim.lifecycle)).toBe(current);
            f.app.abortLifecycle(id, claim.lifecycle, f.original); expect(f.current?.extra).toBe("new-current"); expect(f.current?.status).toBe("running");
            expect(f.calls.filter(row => row[0] === "cas")[1][2]).toBe(current);
        });
    });
    it.each([
        { signal: { attempted: false, signaled: false, exited: true }, adb: { status: 17, stderr: "raw", stdout: "" }, noAdb: false },
        { signal: { attempted: false, signaled: false, exited: true }, noAdb: true },
        { signal: { attempted: false, signaled: false, reason: "unsafe" }, noAdb: false },
    ])("Android unsignaled exit/fallback observes available ADB before deciding %#", async options => {
        const f = fixture("android-device", options); success(f, await f.app.stop(id));
        expect(effects(f).map(row => row[0])).toEqual(options.noAdb ? ["discover", "signal"] : ["discover", "signal", "adb"]);
    });
    it.each([
        [{ status: 7, stderr: "stderr raw", stdout: "stdout raw" }, "stderr raw"],
        [{ status: 7, stderr: "", stdout: "stdout raw" }, "stdout raw"],
        [{ status: null, stderr: "", stdout: "" }, "exit null"],
    ] as const)("Android keeps raw stderr/stdout/status precedence %#", async (adb, ending) => {
        const f = fixture("android-device", { signal: { attempted: false, signaled: false, reason: "signal raw" }, adb });
        const result = await f.app.stop(id); restored(f, result);
        expect(result?.content[0].text).toBe(`Android real-device recording cleanup failed for ${id}: signal raw; ${ending}. Recording metadata and physical lease were preserved for retry.`);
    });
    it("Android absent fallback preserves default raw reason", async () => {
        const f = fixture("android-device", { noAdb: true, signal: { attempted: false, signaled: false } }); const result = await f.app.stop(id); restored(f, result);
        expect(result?.content[0].text).toBe(`Android real-device recording cleanup failed for ${id}: owned recorder signaling failed; ADB fallback unavailable. Recording metadata and physical lease were preserved for retry.`);
    });
    it("iOS native exited reason precedes signaled and skips recording wait", async () => {
        const f = fixture("ios-device", { signal: { attempted: false, signaled: false, reason: "runtime-process-exited" } }); success(f, await f.app.stop(id));
        expect(effects(f).map(row => row[0])).toEqual(["signal", "appium"]);
    });
    it.each([undefined, "unsafe"])("iOS exited flag alone does not permit Appium, reason=%s", async reason => {
        const f = fixture("ios-device", { signal: { attempted: false, signaled: false, exited: true, reason } }); const result = await f.app.stop(id); restored(f, result);
        expect(result?.content[0].text).toBe(`iOS physical recording process could not be safely stopped for ${id} (${reason || "unknown"}); recording metadata and physical lease were preserved for retry.`);
        expect(effects(f).map(row => row[0])).toEqual(["signal"]);
    });
    it.each([false, true])("iOS partial Appium failure records active/inactive=%s with exact clocks", async inactive => {
        const f = fixture("ios-device", { inactive, appium: { exited: false, reason: "native", error: "raw Appium failure" } });
        const result = await f.app.stop(id); expect(result?.content[0].text).toBe("raw Appium failure; Appium metadata and physical lease were preserved for retry.");
        expect(f.current?.appium).toBe(f.original.appium); expect(f.current?.status).toBe("running");
        expect(f.current?.recording).toEqual(inactive ? f.original.recording : { ...f.original.recording, active: false, endedAt: "clock-2" });
        expect(f.current?.updatedAt).toBe(inactive ? "clock-2" : "clock-3"); expect(f.ticks).toBe(inactive ? 3 : 4);
    });
    it("iOS partial failure preserves a successor despite endedAt clock observation", async () => {
        const f = fixture("ios-device", { mutate: "successor", appium: { exited: false, error: "raw Appium failure" } });
        expect((await f.app.stop(id))?.isError).toBe(true); expect(f.current?.lifecycle?.runtimeId).toBe("successor");
        expect(f.current?.recording).toBe(f.original.recording); expect(f.ticks).toBe(3);
    });
});
