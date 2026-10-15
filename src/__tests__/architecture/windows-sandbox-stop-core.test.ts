import { describe, expect, it } from "vitest";
import { createWindowsSandboxStop, createWindowsSandboxLifecycle } from "../../../packages/device-lab/providers/application/lifecycle/windows-sandbox-stop.mjs";
import type { WindowsSandboxLifecycleDevice as Device, WindowsSandboxLifecycle as Lifecycle, WindowsSandboxSingleton as Singleton, IsoTimestamp } from "../../../packages/device-lab/providers/domain/lifecycle/windows-sandbox-stop.mjs";
import type { WindowsSandboxStopPorts, WindowsSandboxLifecyclePorts } from "../../../packages/device-lab/providers/ports/lifecycle/windows-sandbox-stop.mjs";

type Ports = WindowsSandboxStopPorts<{ provider: 'fixture' }, { opaque: string }>;
const guid = "11111111-1111-4111-8111-111111111111";
const original: Device = { id: "sandbox", status: "running", sandboxId: guid, singletonClaimId: "old", recording: { active: true }, minimizeWatchdogLaunch: { pid: 17 }, helperSessionLaunch: { ok: true, minimizeWatchdogPid: 17 } };
function fixture(device: Device | undefined = { ...original }, changes: Partial<Ports> = {}) {
    let current: Device | undefined = device;
    let singleton: Singleton | null = device?.status === "stopped" ? null : { claimId: "old", sandboxId: guid, deviceId: "sandbox" };
    let tick = 0;
    const trace: string[] = [];
    const ports: Ports = {
        findDevice: id => { trace.push(`find:${id}`); return current; },
        readSingleton: () => { trace.push("singleton:read"); return singleton; },
        sameSingletonOwner: (lock, item) => { trace.push("singleton:owner"); return lock?.deviceId === item.id; },
        newRuntimeId: () => { trace.push("id"); return "operation"; },
        wallTimestamp: () => { trace.push("clock"); return `2026-10-08T00:00:00.00${++tick}Z` as IsoTimestamp; },
        transitionDevice: (id, expected, replacement) => {
            trace.push(`cas:${id}:${replacement?.status ?? "removed"}`);
            const matched = current === expected;
            if (matched) current = replacement ?? undefined;
            return { found: !!current, matched, currentDevice: expected, device: matched ? replacement : null };
        },
        claimSingleton: (item, sandboxId, claimId) => { trace.push("singleton:claim"); const lock = { deviceId: item.id, sandboxId, claimId }; singleton = lock; return { ok: true, lock }; },
        releaseSingleton: (_item, claimId) => { trace.push(`singleton:release:${claimId}`); if (singleton?.claimId !== claimId) return false; singleton = null; return true; },
        singletonGenerationMatches: item => { trace.push("generation"); return singleton?.claimId === item.singletonClaimId; },
        watchdogCancelPath: item => { trace.push(`watchdog:path:${item.id}`); return "private-cancel"; },
        cancelWatchdog: cancelPath => { trace.push("watchdog:cancel"); return { attempted: true, ok: true, cancelPath }; },
        discoverRuntime: () => { trace.push("discovery"); return { available: true, missing: [], binding: { provider: "fixture" } }; },
        stopOwnedRuntime: (binding, item, timeout) => { trace.push(`runtime:${binding.provider}:${item.sandboxId}:${timeout}`); return { ok: true, evidence: { opaque: "native" } }; },
        ...changes,
    };
    return { ports, trace, app: createWindowsSandboxStop(ports), read: () => current, replace: (item: Device | undefined) => { current = item; }, setSingleton: (value: Singleton | null) => { singleton = value; }, singleton: () => singleton };
}
const lifecycle: Lifecycle = { runtimeId: "operation", operation: "stop", claimedAt: "2026-10-08T00:00:00.000Z" };

describe("synchronous direct Sandbox stop core", () => {
    it("finishes stop synchronously, cancels its watchdog and releases its singleton", () => {
        const f = fixture();
        const result = f.app.stop("sandbox");
        expect(result).not.toBeInstanceOf(Promise);
        expect(result.kind).toBe("completed");
        expect(f.trace).toContain("watchdog:cancel");
        expect(f.trace).toContain(`runtime:fixture:${guid}:60000`);
        expect(f.singleton()).toBeNull();
        expect(f.read()).toMatchObject({ status: "stopped", sandboxId: guid, recording: original.recording, minimizeWatchdogLaunch: original.minimizeWatchdogLaunch, helperSessionLaunch: { ok: true, minimizeWatchdogPid: null }, lifecycle: null, singletonClaimId: null });
    });
    it("leaves missing target unhandled without other effects", () => {
        const f = fixture(); f.replace(undefined);
        expect(f.app.stop("sandbox")).toEqual({ kind: "unhandled" });
        expect(f.read()).toBeUndefined(); expect(f.trace).not.toContain("watchdog:cancel"); expect(f.trace).not.toContain("singleton:claim");
    });
    it.each(["start", "stop", "delete"] as const)("keeps shared %s claim status", operation => {
        const f = fixture(); const claim = f.app.claimLifecycle("sandbox", original, operation);
        expect(claim.claimed.status).toBe({ start: "starting", stop: "stopping", delete: "deleting" }[operation]);
    });
    it("returns claim conflict before any bind or provider mutation", () => {
        const f = fixture(undefined, { transitionDevice: () => ({ found: true, matched: false }) });
        expect(f.app.stop("sandbox")).toEqual({ kind: "conflict", operation: "stop-claim", transition: { found: true, matched: false } });
        expect(f.trace).not.toContain("generation"); expect(f.trace).not.toContain("watchdog:cancel");
    });
    it.each(["foreign", "invalid-guid"])("aborts after %s binding refusal", mode => {
        const f = fixture({ ...original, sandboxId: mode === "invalid-guid" ? "invalid" : guid }, { sameSingletonOwner: () => false, claimSingleton: () => ({ ok: false, error: "foreign" }) });
        const outcome = f.app.stop("sandbox"); expect(outcome.kind).toBe("refused");
        expect(f.read()?.status).toBe("running"); expect(f.trace).not.toContain("generation");
    });
    it("binds a missing singleton and releases exactly the new generation on bind CAS conflict", () => {
        const f = fixture(); f.setSingleton(null); let calls = 0;
        const transition = f.ports.transitionDevice;
        f.ports.transitionDevice = (...args) => ++calls === 2 ? { found: true, matched: false } : transition(...args);
        expect(f.app.stop("sandbox")).toMatchObject({ kind: "conflict", operation: "stop-singleton" });
        expect(f.trace).toContain("singleton:release:operation"); expect(f.trace).not.toContain("generation");
    });
    it.each(["generation", "cancel-false", "cancel-null", "cancel-undefined", "discovery", "guid", "native", "timeout"])("preserves the %s failure boundary", mode => {
        const evidence = { opaque: mode };
        const changes: Partial<Ports> = mode === "generation" ? { singletonGenerationMatches: () => false }
            : mode.startsWith("cancel") ? { cancelWatchdog: () => mode === "cancel-null" ? null : mode === "cancel-undefined" ? undefined : { attempted: true, ok: false, cancelPath: "private-cancel", error: "denied" } }
            : mode === "discovery" ? { discoverRuntime: () => ({ available: false, missing: ["wsb"], binding: { provider: "fixture" } }) }
            : mode === "native" || mode === "timeout" ? { stopOwnedRuntime: () => ({ ok: false, evidence }) } : {};
        const f = fixture({ ...original, sandboxId: mode === "guid" ? "invalid" : guid }, changes);
        const result = f.app.stop("sandbox");
        expect(result.kind).toBe(mode === "native" || mode === "timeout" ? "native-failure" : "refused");
        if (result.kind === "native-failure") expect(result.evidence).toBe(evidence);
        expect(f.read()?.status).toBe("running"); expect(f.trace.filter(item => item.startsWith("singleton:release"))).toEqual([]);
        if (mode === "discovery" || mode === "guid" || mode === "native" || mode === "timeout") expect(f.read()?.minimizeWatchdogLaunch).toBeNull();
    });
    it("preserves a successor after native stop and releases only the old singleton", () => {
        const f = fixture(); const successor: Device = { ...original, lifecycle: { ...lifecycle, runtimeId: "successor" } };
        f.ports.stopOwnedRuntime = () => { f.replace(successor); return { ok: true, evidence: { opaque: "native" } }; };
        expect(f.app.stop("sandbox")).toMatchObject({ kind: "conflict", operation: "stop", transition: { found: true, matched: false } });
        expect(f.read()).toBe(successor); expect(f.singleton()).toBeNull();
    });
    it.each([false, true])("completion CAS mismatch retains release return/throw behavior (throw=%s)", throws => {
        const f = fixture(); let calls = 0; const native = f.ports.transitionDevice; const fault = new Error("release");
        f.ports.transitionDevice = (...args) => ++calls === 2 ? { found: true, matched: false } : native(...args);
        f.ports.releaseSingleton = () => { f.trace.push("release"); if (throws) throw fault; return false; };
        if (throws) expect(() => f.app.stop("sandbox")).toThrow(fault);
        else expect(f.app.stop("sandbox")).toMatchObject({ kind: "conflict", operation: "stop" });
        expect(f.trace).toContain("release");
    });
    it("reconciles stopped singleton runtime while final commit keeps CURRENT sandbox fields", () => {
        const f = fixture({ id: "sandbox", status: "stopped" }); f.setSingleton({ deviceId: "sandbox", claimId: "old", sandboxId: guid });
        expect(f.app.stop("sandbox").kind).toBe("completed");
        expect(f.trace).toContain(`runtime:fixture:${guid}:60000`); expect(f.read()?.sandboxId).toBeUndefined();
    });
    it.each(["findDevice", "readSingleton", "sameSingletonOwner", "newRuntimeId", "wallTimestamp", "transitionDevice", "singletonGenerationMatches", "watchdogCancelPath", "cancelWatchdog", "discoverRuntime", "stopOwnedRuntime"] as const)("propagates raw %s faults without later effects", name => {
        const fault = new Error(name); const f = fixture(); f.ports[name] = (() => { f.trace.push(`throw:${name}`); throw fault; });
        expect(() => f.app.stop("sandbox")).toThrow(fault); expect(f.trace.at(-1)).toBe(`throw:${name}`);
        expect(f.trace.filter(item => item.startsWith("singleton:release"))).toEqual([]);
    });
    it.each(["claim", "bind", "abort", "complete"])("a thrown %s CAS prevents later release/abort", phase => {
        const f = fixture(); if (phase === "bind") f.setSingleton(null);
        if (phase === "abort") f.ports.singletonGenerationMatches = () => false;
        let count = 0; const native = f.ports.transitionDevice; const fault = new Error(phase);
        f.ports.transitionDevice = (...args) => { if (++count === (phase === "claim" ? 1 : 2)) { f.trace.push("cas:throw"); throw fault; } return native(...args); };
        expect(() => f.app.stop("sandbox")).toThrow(fault); expect(f.trace.at(-1)).toBe("cas:throw");
    });
    it.each(["absent", "undefined", "null", "value"])("abort restores own %s lifecycle and singleton fields", mode => {
        const prior: Device = { id: "sandbox", status: "running" };
        if (mode !== "absent") { prior.lifecycle = mode === "undefined" ? undefined : mode === "null" ? null : lifecycle; prior.singletonClaimId = mode === "undefined" ? undefined : mode === "null" ? null : "prior"; }
        const f = fixture({ ...prior, status: "stopping", lifecycle, singletonClaimId: "claimed" });
        f.app.abortLifecycle("sandbox", lifecycle, prior);
        for (const key of ["lifecycle", "singletonClaimId"] as const) { expect(Object.hasOwn(f.read()!, key)).toBe(mode !== "absent"); expect(f.read()?.[key]).toEqual(prior[key]); }
    });
    it.each(["same", "foreign", "missing"])("current lifecycle lookup handles %s", mode => {
        const f = fixture(); f.replace(mode === "missing" ? undefined : { ...original, lifecycle: { ...lifecycle, runtimeId: mode === "same" ? "operation" : "foreign" } });
        expect(f.app.currentLifecycleDevice("sandbox", lifecycle)).toBe(mode === "same" ? f.read() : null);
    });
    it("binds a missing singleton successfully without changing native authority", () => {
        const f = fixture(); f.setSingleton(null); expect(f.app.stop("sandbox").kind).toBe("completed");
        expect(f.trace).toContain("singleton:claim"); expect(f.singleton()).toBeNull();
    });
    it.each(["stopped", "claimed"])("bind %s bypass performs no native action", mode => {
        const f = fixture(); const claim = { lifecycle: { ...lifecycle, ...(mode === "claimed" ? { singletonClaimId: "old" } : {}) }, claimed: original, transition: { found: true, matched: true } };
        expect(f.app.bindLifecycleSingleton("sandbox", claim, { ...original, status: mode === "stopped" ? "stopped" : "running" })).toEqual({ ok: true, claim }); expect(f.trace).toEqual([]);
    });
    it("clears owned watchdog metadata after confirmed cancellation", () => {
        const f = fixture();
        const result = f.app.cleanupWatchdogs(original);
        expect(result).toMatchObject({ ok: true, changed: true, device: { minimizeWatchdogLaunch: null, helperSessionLaunch: { ok: true, minimizeWatchdogPid: null } } });
        expect(result.device.recording).toBe(original.recording);
        expect(f.trace).toContain("watchdog:cancel");
    });
    it("keeps watchdog evidence when cancellation is unconfirmed", () => {
        const f = fixture(original, { cancelWatchdog: () => ({ attempted: true, ok: false, error: "still running", cancelPath: "private-cancel" }) });
        expect(f.app.cleanupWatchdogs(original)).toMatchObject({ ok: false, changed: false, device: original });
        expect(f.read()).toBe(original);
    });
    it("requires explicit effect ports without ambient fallback", () => { expect(() => createWindowsSandboxStop({} as Ports)).toThrow("requires readSingleton"); });
});


type NativeResult = { status: number; stdout?: string; stderr?: string; error?: { message?: string } };
type Response = { ok: boolean; value?: unknown; error?: string; operation?: string };
type LifecyclePorts = WindowsSandboxLifecyclePorts<{ provider: "fixture" }, NativeResult, Response>;
function lifecycleFixture(device: Device = { id: "sandbox", status: "stopped", sandboxId: guid, minimized: false }) {
    const base = fixture(device);
    let launched = false, time = 0;
    const effects: string[] = [];
    const ports: LifecyclePorts = {
        ...base.ports,
        stopOwnedRuntime: (_binding, item, timeout) => { effects.push(`stop:${item.sandboxId}:${timeout}`); return { ok: true, evidence: { status: 0 } }; },
        readDevices: () => base.read() ? [base.read()!] : [],
        helperMetadata: () => ({ minimizeWatchdogCancelPath: "private-cancel", minimizeWatchdogResultPath: "private-result" }),
        writeConfig: () => "private-config", readConfig: () => "<Configuration/>", resetHelperMarkers: () => undefined,
        listRuntime: () => ({ ok: true, ids: launched ? [guid] : [], result: { status: 0 } }),
        stopRuntime: (_binding, id, timeout) => { effects.push(`compensate:${id}:${timeout}`); return { ok: true, result: { status: 0 } }; },
        registrationDiagnostic: () => " fixture-native-diagnostic",
        timestampBefore: () => "2026-10-10T00:00:00.000Z", windowHandles: () => [101],
        launchConfig: (_path, _minimized, timeout) => { launched = true; effects.push(`launch:${timeout}`); return { ok: true, result: { status: 0 } }; },
        launchRuntime: () => { launched = true; effects.push("launch-cli"); return { ok: true, result: { status: 0 } }; },
        launchWatchdog: () => ({ ok: true, launch: { ok: true, pid: 17 } }),
        updateSingletonRuntimeId: (_item, _claimed, runtimeId, claimId) => { base.setSingleton({ deviceId: "sandbox", sandboxId: runtimeId, claimId }); return true; },
        waitForMinimizeConfirmation: async () => ({ ok: true }), launchSession: () => ({ ok: true }),
        scratchDirectory: () => "private-scratch", removeScratch: () => { effects.push("remove-scratch"); return undefined; },
        platform: "win32", now: () => time, wait: async milliseconds => { time += milliseconds; },
        targetStatus: item => item,
        lifecycleConflict: (_id, operation) => ({ ok: false, error: "owner-device-state-conflict", operation }),
        textResult: (ok, error) => ({ ok, error }), jsonResult: value => ({ ok: true, value }), fail: result => ({ ok: false, error: result.stderr || result.error?.message || "native-failed" }),
    };
    return { ...base, ports, effects, lifecycle: createWindowsSandboxLifecycle(ports) };
}

describe("direct Sandbox lifecycle application", () => {
    it("starts the registered runtime, then stops and deletes its owned scratch", async () => {
        const f = lifecycleFixture();
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toMatchObject({ ok: true, value: { device: { status: "running", sandboxId: guid, launchMode: "wsb-file" } } });
        expect(f.singleton()).toMatchObject({ deviceId: "sandbox", sandboxId: guid });
        expect(f.effects).toContain("launch:120000");
        expect(f.lifecycle.stop({ deviceId: "sandbox" })).toMatchObject({ ok: true, value: { device: { status: "stopped" } } });
        expect(f.singleton()).toBeNull();
        expect(f.lifecycle.delete({ deviceId: "sandbox" })).toMatchObject({ ok: true, value: { deleted: "sandbox", scratchRemoved: "private-scratch" } });
        expect(f.read()).toBeUndefined();
        expect(f.effects).toContain("remove-scratch");
    });
    it("retains lifecycle ownership without stopping ambiguous observed runtimes", async () => {
        const f = lifecycleFixture();
        const observed = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
        let launched = false;
        f.ports.launchConfig = () => { launched = true; return { ok: true, result: { status: 0 } }; };
        f.ports.listRuntime = () => ({ ok: true, ids: launched ? observed : [], result: { status: 0 } });
        f.ports.stopRuntime = (_binding, id) => { f.effects.push(`cleanup-failed:${id}`); return { ok: false, result: { status: 7, stderr: "stop denied" } }; };
        const result = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(result).toMatchObject({ ok: false });
        expect(result?.error).toContain("multiple new runtimes");
        expect(result?.error).toContain("cleanupSkipped=ambiguous-runtime-ownership lockRetained=true");
        expect(f.effects).toEqual([]);
        expect(f.read()).toMatchObject({ status: "starting", lifecycle: { operation: "start" } });
        expect(f.singleton()).toMatchObject({ deviceId: "sandbox", claimId: "operation" });
        for (const id of observed) expect(result?.error).toContain(id);
    });
    it("retains its claim when the last registration inventory is unavailable after an earlier empty inventory", async () => {
        const f = lifecycleFixture(), native = { status: 9, stderr: "inventory unavailable" };
        let lists = 0;
        f.ports.listRuntime = () => ++lists <= 2
            ? { ok: true, ids: [], result: { status: 0 } }
            : { ok: false, ids: [], result: native };
        f.ports.registrationDiagnostic = result => { expect(result).toBe(native); return " retained-native-diagnostic"; };
        const result = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(result).toMatchObject({ ok: false });
        expect(result?.error).toContain("within 60000ms");
        expect(result?.error).toContain("retained-native-diagnostic");
        expect(f.singleton()).toMatchObject({ deviceId: "sandbox", claimId: "operation" });
        expect(f.read()).toMatchObject({ status: "starting", lifecycle: { operation: "start" } });
        expect(f.effects.some(effect => effect.startsWith("compensate:"))).toBe(false);
    });
    it("keeps native watchdog metadata separate from its settled minimize warning", async () => {
        const f = lifecycleFixture(), launch = { ok: false, pid: 17, error: "native watchdog error" };
        f.ports.launchWatchdog = () => ({ ok: false, launch, warning: "settled minimize warning" });
        f.ports.waitForMinimizeConfirmation = async () => { throw new Error("failed watchdog must not wait for confirmation"); };
        expect(await f.lifecycle.start({ deviceId: "sandbox", minimized: true })).toMatchObject({ ok: true,
            value: { device: { status: "running", minimizeConfirmed: false, minimizeWarning: "settled minimize warning" } } });
        expect(f.read()?.minimizeWatchdogLaunch).toBe(launch);
        expect(f.read()?.minimizeWatchdogLaunch).not.toHaveProperty("warning");
        expect(f.singleton()).toMatchObject({ sandboxId: guid });
    });
    it("never stops or cancels the watchdog of a same-GUID successor when start publication loses its CAS", async () => {
        const f = lifecycleFixture();
        let watchdogCancellations = 0;
        f.ports.cancelWatchdog = cancelPath => { watchdogCancellations++; return { attempted: true, ok: true, cancelPath }; };
        const successor: Device = { id: "sandbox", status: "running", sandboxId: guid, singletonClaimId: "successor", lifecycle: { runtimeId: "successor", operation: "start", claimedAt: "2026-10-10T00:00:00.000Z" } };
        f.ports.launchConfig = () => { f.replace(successor); f.setSingleton({ deviceId: "sandbox", sandboxId: guid, claimId: "successor" }); return { ok: true, result: { status: 0 } }; };
        f.ports.listRuntime = () => ({ ok: true, ids: f.read() === successor ? [guid] : [], result: { status: 0 } });
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toMatchObject({ ok: false, error: "owner-device-state-conflict", operation: "start-complete" });
        expect(f.read()).toBe(successor);
        expect(f.singleton()).toMatchObject({ claimId: "successor", sandboxId: guid });
        expect(watchdogCancellations).toBe(0);
        expect(f.effects.some(effect => effect.startsWith("compensate:"))).toBe(false);
        expect(f.effects).not.toContain("remove-scratch");
    });
    it("refuses forced delete while watchdog termination is unconfirmed", () => {
        const f = lifecycleFixture(original);
        f.ports.cancelWatchdog = () => ({ attempted: true, ok: false, error: "still running", cancelPath: "private-cancel" });
        expect(f.lifecycle.delete({ deviceId: "sandbox", force: true })).toMatchObject({ ok: false });
        expect(f.read()).toMatchObject({ status: "running", minimizeWatchdogLaunch: original.minimizeWatchdogLaunch });
        expect(f.singleton()).toMatchObject({ claimId: "old" });
        expect(f.effects).toEqual([]);
    });
    it("leaves truthful partial effects when scratch removal throws after record deletion", () => {
        const f = lifecycleFixture(), fault = new Error("scratch denied");
        f.ports.removeScratch = () => { expect(f.read()).toBeUndefined(); expect(f.singleton()).toBeNull(); throw fault; };
        expect(() => f.lifecycle.delete({ deviceId: "sandbox" })).toThrow(fault);
        expect(f.read()).toBeUndefined();
        expect(f.singleton()).toBeNull();
    });
});
