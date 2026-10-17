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
type LifecyclePorts = WindowsSandboxLifecyclePorts<{ provider: "fixture" }, NativeResult>;
function lifecycleFixture(device: Device = { id: "sandbox", status: "stopped", sandboxId: guid, minimized: false }) {
    const base = fixture(device);
    let launched = false, time = 0;
    const effects: string[] = [], waits: number[] = [];
    const ports: LifecyclePorts = {
        ...base.ports,
        stopOwnedRuntime: (_binding, item, timeout) => { effects.push(`stop:${item.sandboxId}:${timeout}`); return { ok: true, evidence: { status: 0 } }; },
        readDevices: () => base.read() ? [base.read()!] : [],
        helperMetadata: () => ({ minimizeWatchdogCancelPath: "private-cancel", minimizeWatchdogResultPath: "private-result" }),
        writeConfig: () => "private-config", readConfig: () => "<Configuration/>", resetHelperMarkers: () => undefined,
        listRuntime: () => ({ ok: true, ids: launched ? [guid] : [], result: { status: 0 } }),
        stopRuntime: (_binding, id, timeout) => { effects.push(`compensate:${id}:${timeout}`); return { ok: true, result: { status: 0 } }; },
        timestampBefore: () => "2026-10-10T00:00:00.000Z", windowHandles: () => [101],
        launchConfig: (_path, _minimized, timeout) => { launched = true; effects.push(`launch:${timeout}`); return { ok: true, result: { status: 0 } }; },
        launchRuntime: () => { launched = true; effects.push("launch-cli"); return { ok: true, result: { status: 0 } }; },
        launchWatchdog: () => ({ ok: true, launch: { ok: true, pid: 17 } }),
        updateSingletonRuntimeId: (_item, _claimed, runtimeId, claimId) => { base.setSingleton({ deviceId: "sandbox", sandboxId: runtimeId, claimId }); return true; },
        waitForMinimizeConfirmation: async () => ({ ok: true }), launchSession: () => ({ ok: true }),
        scratchDirectory: () => "private-scratch", removeScratch: () => { effects.push("remove-scratch"); return undefined; },
        platform: "win32", monotonicNow: () => time, wait: async milliseconds => { waits.push(milliseconds); time += milliseconds; },
    };
    return { ...base, ports, effects, waits, elapse: (milliseconds: number) => { time += milliseconds; }, lifecycle: createWindowsSandboxLifecycle(ports) };
}

describe("direct Sandbox lifecycle application", () => {
    it("starts the registered runtime, then stops and deletes its owned scratch", async () => {
        const f = lifecycleFixture();
        const started = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(started).toMatchObject({ kind: "completed", device: { status: "running", sandboxId: guid, launchMode: "wsb-file" } });
        if (started.kind === "completed") expect(started.device).toBe(f.read());
        expect(f.singleton()).toMatchObject({ deviceId: "sandbox", sandboxId: guid });
        expect(f.effects).toContain("launch:120000");
        expect(f.lifecycle.stop({ deviceId: "sandbox" })).toMatchObject({ kind: "completed", device: { status: "stopped" } });
        expect(f.singleton()).toBeNull();
        const deleted = f.lifecycle.delete({ deviceId: "sandbox" });
        expect(deleted).not.toBeInstanceOf(Promise);
        expect(deleted).toEqual({ kind: "deleted", deleted: "sandbox", scratchRemoved: "private-scratch" });
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
        expect(result).toMatchObject({ kind: "registration-failed", ambiguous: true, cleanupIds: [], releaseLockAfterFailure: false,
            registration: { ok: false, observedIds: observed, newIds: observed, error: `Windows Sandbox launch produced multiple new runtimes: ${observed.join(", ")}` } });
        expect(f.effects).toEqual([]);
        expect(f.read()).toMatchObject({ status: "starting", lifecycle: { operation: "start" } });
        expect(f.singleton()).toMatchObject({ deviceId: "sandbox", claimId: "operation" });
    });
    it("retains its claim when the last registration inventory is unavailable after an earlier empty inventory", async () => {
        const f = lifecycleFixture(), native = { status: 9, stderr: "inventory unavailable" };
        let lists = 0;
        f.ports.listRuntime = () => ++lists <= 2
            ? { ok: true, ids: [], result: { status: 0 } }
            : { ok: false, ids: [], result: native };
        const result = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(result).toMatchObject({ kind: "registration-failed", releaseLockAfterFailure: false, runtimeGone: false,
            registration: { ok: false, lastObservationOk: false, observedIds: [], newIds: [] } });
        if (result.kind === "registration-failed") {
            expect(result.registration.result).toBe(native);
            expect(result.registration.error).toContain("within 60000ms");
        }
        expect(f.singleton()).toMatchObject({ deviceId: "sandbox", claimId: "operation" });
        expect(f.read()).toMatchObject({ status: "starting", lifecycle: { operation: "start" } });
        expect(f.effects.some(effect => effect.startsWith("compensate:"))).toBe(false);
    });
    it("keeps native watchdog metadata separate from its settled minimize warning", async () => {
        const f = lifecycleFixture(), launch = { ok: false, pid: 17, error: "native watchdog error" };
        f.ports.launchWatchdog = () => ({ ok: false, launch, warning: "settled minimize warning" });
        f.ports.waitForMinimizeConfirmation = async () => { throw new Error("failed watchdog must not wait for confirmation"); };
        expect(await f.lifecycle.start({ deviceId: "sandbox", minimized: true })).toMatchObject({ kind: "completed",
            device: { status: "running", minimizeConfirmed: false, minimizeWarning: "settled minimize warning" } });
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
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toMatchObject({ kind: "conflict", operation: "start-complete",
            detail: { runtimeStopped: false, compensationRefused: true, watchdogCleaned: false, singletonReleased: false } });
        expect(f.read()).toBe(successor);
        expect(f.singleton()).toMatchObject({ claimId: "successor", sandboxId: guid });
        expect(watchdogCancellations).toBe(0);
        expect(f.effects.some(effect => effect.startsWith("compensate:"))).toBe(false);
        expect(f.effects).not.toContain("remove-scratch");
    });
    it("refuses forced delete while watchdog termination is unconfirmed", () => {
        const f = lifecycleFixture(original);
        f.ports.cancelWatchdog = () => ({ attempted: true, ok: false, error: "still running", cancelPath: "private-cancel" });
        expect(f.lifecycle.delete({ deviceId: "sandbox", force: true })).toMatchObject({ kind: "refused" });
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
    it("returns an unhandled semantic result from each missing-device entrypoint", async () => {
        const f = lifecycleFixture(); f.replace(undefined);
        expect(await f.lifecycle.start({ deviceId: "missing" })).toEqual({ kind: "unhandled" });
        expect(f.lifecycle.stop({ deviceId: "missing" })).toEqual({ kind: "unhandled" });
        expect(f.lifecycle.delete({ deviceId: "missing" })).toEqual({ kind: "unhandled" });
        expect(f.effects).toEqual([]); expect(f.trace.some(item => item.startsWith("cas:"))).toBe(false);
    });
    it.each(["running", "starting", "stopping", "deleting"])("refuses start and nonforced delete while %s without claims", async status => {
        const f = lifecycleFixture({ id: "sandbox", status, sandboxId: guid });
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toEqual({ kind: "refused", error: `Refusing to start sandbox while status is ${status}` });
        expect(f.lifecycle.delete({ deviceId: "sandbox" })).toEqual({ kind: "refused", error: `Refusing to delete sandbox while status is ${status}` });
        expect(f.effects).toEqual([]); expect(f.trace.some(item => item.startsWith("cas:"))).toBe(false);
    });
    it("refuses unavailable start prerequisites before claiming", async () => {
        const f = lifecycleFixture();
        f.ports.discoverRuntime = () => ({ available: false, missing: ["wsb", "helper"], binding: { provider: "fixture" } });
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toEqual({ kind: "refused", error: "Windows Sandbox backend missing prerequisites: wsb, helper" });
        expect(f.trace.some(item => item.startsWith("cas:"))).toBe(false); expect(f.effects).toEqual([]);
    });
    it.each(["claim", "lock"])("preserves the exact start %s transition as a conflict", async phase => {
        const f = lifecycleFixture(), transition = { found: true, matched: false };
        const native = f.ports.transitionDevice; let calls = 0;
        f.ports.transitionDevice = (...args) => ++calls === (phase === "claim" ? 1 : 2) ? transition : native(...args);
        const result = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(result).toEqual({ kind: "conflict", operation: phase === "claim" ? "start-claim" : "start-lock", transition });
        if (result.kind === "conflict") expect(result.transition).toBe(transition);
        expect(f.effects).toEqual([]);
        expect(f.trace.filter(item => item.startsWith("singleton:release"))).toEqual(phase === "lock" ? ["singleton:release:operation"] : []);
    });
    it("restores the original start claim after a singleton refusal", async () => {
        const f = lifecycleFixture(); const before = f.read();
        f.ports.claimSingleton = () => ({ ok: false, error: "owned by somebody else" });
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toEqual({ kind: "refused", error: "owned by somebody else" });
        expect(f.read()).toMatchObject({ status: "stopped", sandboxId: guid });
        expect(Object.hasOwn(f.read()!, "lifecycle")).toBe(Object.hasOwn(before!, "lifecycle"));
        expect(f.effects).toEqual([]); expect(f.singleton()).toBeNull();
    });
    it.each(["inventory", "launch"])("returns original %s command failure evidence before registration or compensation", async phase => {
        const f = lifecycleFixture(), native = { status: 7, stdout: "stdout first", stderr: "stderr first", error: { message: "opaque" } };
        let lists = 0, launches = 0;
        f.ports.listRuntime = () => { lists++; return { ok: phase !== "inventory", ids: [], result: native }; };
        f.ports.launchConfig = () => { launches++; return { ok: false, result: native }; };
        const result = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(result).toEqual({ kind: "native-failure", evidence: native });
        if (result.kind === "native-failure") expect(result.evidence).toBe(native);
        expect(lists).toBe(1); expect(launches).toBe(phase === "launch" ? 1 : 0);
        expect(f.read()?.status).toBe("stopped"); expect(f.singleton()).toBeNull(); expect(f.effects).toEqual([]);
    });
    it("refuses an existing native runtime before launch and releases only its claim", async () => {
        const f = lifecycleFixture(), other = "22222222-2222-4222-8222-222222222222";
        f.ports.listRuntime = () => ({ ok: true, ids: [other], result: { status: 0 } });
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toEqual({ kind: "refused", error: `Windows Sandbox already has a running runtime before sandbox start: ${other}. Stop it before starting an owner-scoped device.` });
        expect(f.read()?.status).toBe("stopped"); expect(f.singleton()).toBeNull(); expect(f.effects).toEqual([]);
    });
    it("publishes a unique substitute registration without encoding device or helper-session facts", async () => {
        const f = lifecycleFixture(), actual = "22222222-2222-4222-8222-222222222222";
        let lists = 0;
        f.ports.listRuntime = () => ({ ok: true, ids: ++lists === 1 ? [] : [actual], result: { status: 0 } });
        const result = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(result).toMatchObject({ kind: "completed", device: { status: "running", sandboxId: actual, requestedSandboxId: guid,
            helperSessionLaunch: { ok: true, skipped: true, reason: "wsb-file launch creates the interactive Sandbox session", launchMode: "wsb-file" } } });
        if (result.kind === "completed") expect(result.device).toBe(f.read());
        expect(f.singleton()).toMatchObject({ sandboxId: actual, claimId: "operation" });
    });
    it("returns singleton-conflict facts and compensates the observed substitute only under its exact claim", async () => {
        const f = lifecycleFixture(), actual = "22222222-2222-4222-8222-222222222222";
        let lists = 0;
        f.ports.listRuntime = () => ({ ok: true, ids: ++lists === 1 ? [] : [actual], result: { status: 0 } });
        f.ports.updateSingletonRuntimeId = () => false;
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toEqual({ kind: "singleton-conflict", deviceId: "sandbox", runtimeStopped: true, compensationRefused: false, watchdogCleaned: true });
        expect(f.effects).toContain(`compensate:${actual}:60000`);
        expect(f.read()?.status).toBe("stopped");
        // Existing singleton-conflict recovery restores the record but retains the singleton until reconciled.
        expect(f.singleton()).toMatchObject({ claimId: "operation", sandboxId: guid });
    });
    it("preserves a successor when substitute registration loses singleton ownership", async () => {
        const f = lifecycleFixture(), actual = "22222222-2222-4222-8222-222222222222";
        let lists = 0;
        f.ports.listRuntime = () => ({ ok: true, ids: ++lists === 1 ? [] : [actual], result: { status: 0 } });
        const successor: Device = { id: "sandbox", status: "running", sandboxId: actual, singletonClaimId: "successor", lifecycle: { ...lifecycle, runtimeId: "successor", operation: "start" } };
        f.ports.updateSingletonRuntimeId = () => { f.replace(successor); f.setSingleton({ deviceId: "sandbox", claimId: "successor", sandboxId: actual }); return false; };
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toEqual({ kind: "singleton-conflict", deviceId: "sandbox", runtimeStopped: false, compensationRefused: true, watchdogCleaned: false });
        expect(f.read()).toBe(successor); expect(f.singleton()?.claimId).toBe("successor");
        expect(f.effects.filter(item => item.startsWith("compensate:"))).toEqual([]); expect(f.trace).not.toContain("watchdog:cancel");
    });
    it("retains opaque CLI session warnings while publishing an otherwise successful start", async () => {
        const f = lifecycleFixture(), session = { ok: false, error: "viewer launch refused", pid: 19 };
        Object.defineProperty(f.ports, "platform", { value: "linux" });
        f.ports.launchSession = () => session;
        const result = await f.lifecycle.start({ deviceId: "sandbox", minimized: true });
        expect(result).toMatchObject({ kind: "completed", device: { launchMode: "wsb-cli-start", status: "running", helperSessionLaunch: session } });
        if (result.kind === "completed") expect(result.device.helperSessionLaunch).toBe(session);
        expect(f.effects).toContain("launch-cli"); expect(f.waits).toEqual([]);
    });
    it("keeps timely minimize confirmation and native watchdog launch as separate facts", async () => {
        const f = lifecycleFixture(), launch = { ok: true, pid: 17 };
        f.ports.launchWatchdog = () => ({ ok: true, launch });
        f.ports.waitForMinimizeConfirmation = async path => { expect(path).toBe("private-result"); return { ok: true }; };
        const result = await f.lifecycle.start({ deviceId: "sandbox", minimized: true });
        expect(result).toMatchObject({ kind: "completed", device: { minimizeConfirmed: true, minimizeWarning: null } });
        if (result.kind === "completed") expect(result.device.minimizeWatchdogLaunch).toBe(launch);
    });
    it.each(["claim", "complete"])("returns delete %s conflict without removing scratch or a successor", phase => {
        const f = lifecycleFixture(), native = f.ports.transitionDevice, transition = { found: true, matched: false };
        let calls = 0;
        f.ports.transitionDevice = (...args) => ++calls === (phase === "claim" ? 1 : 2) ? transition : native(...args);
        const result = f.lifecycle.delete({ deviceId: "sandbox" });
        expect(result).toEqual({ kind: "conflict", operation: phase === "claim" ? "delete-claim" : "delete", transition });
        if (result.kind === "conflict") expect(result.transition).toBe(transition);
        expect(f.read()).toBeDefined(); expect(f.effects).not.toContain("remove-scratch");
    });
    it("returns forced-delete native evidence and restores retry metadata", () => {
        const f = lifecycleFixture(original), native = { status: 7, stderr: "stop denied", stdout: "native detail" };
        f.ports.stopOwnedRuntime = () => ({ ok: false, evidence: native });
        const result = f.lifecycle.delete({ deviceId: "sandbox", force: true });
        expect(result).toEqual({ kind: "native-failure", evidence: native });
        if (result.kind === "native-failure") expect(result.evidence).toBe(native);
        expect(f.read()).toMatchObject({ status: "running", singletonClaimId: "old", minimizeWatchdogLaunch: null });
        expect(f.singleton()?.claimId).toBe("old"); expect(f.effects).not.toContain("remove-scratch");
    });
    it("preserves a same-GUID successor after forced delete stops only the old generation", () => {
        const f = lifecycleFixture(original), successor: Device = { ...original, singletonClaimId: "successor", lifecycle: { ...lifecycle, runtimeId: "successor", operation: "start" } };
        f.ports.stopOwnedRuntime = () => { f.replace(successor); f.setSingleton({ deviceId: "sandbox", sandboxId: guid, claimId: "successor" }); return { ok: true, evidence: { status: 0 } }; };
        expect(f.lifecycle.delete({ deviceId: "sandbox", force: true })).toMatchObject({ kind: "conflict", operation: "delete" });
        expect(f.read()).toBe(successor); expect(f.singleton()?.claimId).toBe("successor"); expect(f.effects).not.toContain("remove-scratch");
    });
});

describe("Sandbox registration elapsed allowance and exact-owned compensation", () => {
    it.each([-86_400_000, 86_400_000])("ignores a wall-clock jump of %s while registration consumes its own allowance", async jump => {
        const f = lifecycleFixture(); let lists = 0, wall = Date.parse("2026-10-10T00:00:00.000Z");
        f.ports.wallTimestamp = () => new Date(wall).toISOString() as IsoTimestamp;
        const caps: number[] = [];
        f.ports.listRuntime = (_binding, cap) => {
            caps.push(cap); lists++;
            if (lists === 2) { wall += jump; f.elapse(59_001); }
            return { ok: true, ids: lists === 3 ? [guid] : [], result: { status: 0 } };
        };
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toMatchObject({ kind: "completed", device: { updatedAt: new Date(wall).toISOString() } });
        expect(caps).toEqual([10000, 10000, 499]); expect(f.waits).toEqual([500]);
    });
    it("clamps its last sleep and never dispatches a final expired inventory", async () => {
        const f = lifecycleFixture(); let lists = 0;
        const caps: number[] = [];
        f.ports.listRuntime = (_binding, cap) => { caps.push(cap); if (++lists === 2) f.elapse(59_999); return { ok: true, ids: [], result: { status: 0 } }; };
        const result = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(result).toMatchObject({ kind: "registration-failed", cleanupIds: [], runtimeGone: true, releaseLockAfterFailure: true,
            registration: { lastObservationOk: true, observedIds: [], newIds: [] } });
        expect(caps).toEqual([10000, 10000]); expect(f.waits).toEqual([1]);
        expect(f.read()?.status).toBe("stopped"); expect(f.singleton()).toBeNull();
    });
    it("does not pass a fractional sub-millisecond remainder to a native inventory", async () => {
        const f = lifecycleFixture(); let lists = 0;
        f.ports.listRuntime = () => { if (++lists === 2) f.elapse(59_999.75); return { ok: true, ids: [], result: { status: 0 } }; };
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toMatchObject({ kind: "registration-failed" });
        expect(lists).toBe(2); expect(f.waits.every(ms => ms > 0 && ms <= 0.25)).toBe(true);
    });
    it.each([60_000, 60_001])("rejects registration observed after %sms but retains its exact facts for cleanup", async elapsed => {
        const f = lifecycleFixture(), native = { status: 0, stdout: "opaque late native list", stderr: "diagnostic" };
        let lists = 0;
        f.ports.listRuntime = () => { if (++lists === 1) return { ok: true, ids: [], result: { status: 0 } }; f.elapse(elapsed); return { ok: true, ids: [guid], result: native }; };
        const result = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(result).toMatchObject({ kind: "registration-failed", ambiguous: false, cleanupIds: [guid], runtimeGone: true, releaseLockAfterFailure: true,
            registration: { lastObservationOk: true, observedIds: [guid], newIds: [guid] }, cleanup: { ok: true, stopped: [guid], failed: [], refused: false }, cleanupVerify: null });
        if (result.kind === "registration-failed") expect(result.registration.result).toBe(native);
        expect(f.effects).toContain(`compensate:${guid}:60000`); expect(lists).toBe(2); expect(f.waits).toEqual([]);
        expect(f.read()?.status).toBe("stopped"); expect(f.singleton()).toBeNull();
    });
    it("rejects a late substitute without treating it as exact-owned cleanup authority", async () => {
        const f = lifecycleFixture(), actual = "22222222-2222-4222-8222-222222222222";
        let lists = 0;
        f.ports.listRuntime = () => { if (++lists === 1) return { ok: true, ids: [], result: { status: 0 } }; f.elapse(60_000); return { ok: true, ids: [actual], result: { status: 0 } }; };
        expect(await f.lifecycle.start({ deviceId: "sandbox" })).toMatchObject({ kind: "registration-failed", cleanupIds: [actual], releaseLockAfterFailure: false,
            registration: { observedIds: [actual], newIds: [actual] }, cleanup: { ok: false, stopped: [], failed: [], refused: true } });
        expect(f.effects.filter(item => item.startsWith("compensate:"))).toEqual([]);
        expect(f.read()?.status).toBe("starting"); expect(f.singleton()?.claimId).toBe("operation");
    });
    it("retains late ambiguous observations without authorizing any native stop", async () => {
        const f = lifecycleFixture(), ids = [guid, "22222222-2222-4222-8222-222222222222"], native = { status: 0, stdout: "both observed" };
        let lists = 0;
        f.ports.listRuntime = () => { if (++lists === 1) return { ok: true, ids: [], result: { status: 0 } }; f.elapse(60_001); return { ok: true, ids, result: native }; };
        const result = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(result).toMatchObject({ kind: "registration-failed", ambiguous: true, cleanupIds: [], releaseLockAfterFailure: false,
            registration: { lastObservationOk: true, observedIds: ids, newIds: ids } });
        if (result.kind === "registration-failed") expect(result.registration.result).toBe(native);
        expect(f.effects.filter(item => item.startsWith("compensate:"))).toEqual([]); expect(f.singleton()?.claimId).toBe("operation");
    });
    it("cannot fabricate absence from a late unavailable inventory", async () => {
        const f = lifecycleFixture(), native = { status: 8, stderr: "unavailable after timeout" }; let lists = 0;
        f.ports.listRuntime = () => { if (++lists === 1) return { ok: true, ids: [], result: { status: 0 } }; f.elapse(60_000); return { ok: false, ids: [], result: native }; };
        const result = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(result).toMatchObject({ kind: "registration-failed", runtimeGone: false, releaseLockAfterFailure: false,
            registration: { lastObservationOk: false, observedIds: [], newIds: [] } });
        if (result.kind === "registration-failed") expect(result.registration.result).toBe(native);
        expect(f.singleton()?.claimId).toBe("operation"); expect(f.read()?.status).toBe("starting");
    });
    it.each(["absent", "present", "unavailable"])("preserves native compensation evidence and truthful %s verification after stop failure", async verification => {
        const f = lifecycleFixture(), native = { status: 7, stderr: "native cleanup denied" }, verificationResult = { status: verification === "unavailable" ? 9 : 0, stdout: "verification" };
        let lists = 0;
        f.ports.listRuntime = () => {
            if (++lists === 1) return { ok: true, ids: [], result: { status: 0 } };
            if (lists === 2) { f.elapse(60_000); return { ok: true, ids: [guid], result: { status: 0 } }; }
            return { ok: verification !== "unavailable", ids: verification === "present" ? [guid] : [], result: verificationResult };
        };
        f.ports.stopRuntime = () => ({ ok: false, result: native });
        const result = await f.lifecycle.start({ deviceId: "sandbox" });
        expect(result).toMatchObject({ kind: "registration-failed", runtimeGone: verification === "absent", releaseLockAfterFailure: verification === "absent",
            cleanup: { ok: false, stopped: [], failed: [{ id: guid, result: native }], refused: false }, cleanupVerify: { ok: verification !== "unavailable" } });
        if (result.kind === "registration-failed") {
            expect(result.cleanup.failed[0].result).toBe(native); expect(result.cleanupVerify?.result).toBe(verificationResult);
        }
        expect(f.singleton() === null).toBe(verification === "absent"); expect(lists).toBe(3);
    });
    it("retains its watchdog and claim when registration compensation cannot confirm cancellation", async () => {
        const f = lifecycleFixture(), cancellation = { attempted: true, ok: false, error: "watchdog still alive", cancelPath: "private-cancel" };
        let lists = 0;
        f.ports.listRuntime = () => { if (++lists === 2) f.elapse(60_000); return { ok: true, ids: lists === 1 ? [] : [guid], result: { status: 0 } }; };
        f.ports.cancelWatchdog = () => cancellation;
        expect(await f.lifecycle.start({ deviceId: "sandbox", minimized: true })).toMatchObject({ kind: "registration-failed", releaseLockAfterFailure: false,
            cleanup: { refused: true }, watchdogCleanup: { ok: false, cancellation } });
        expect(f.read()).toMatchObject({ status: "starting", minimizeWatchdogLaunch: { pid: 17 } });
        expect(f.singleton()?.claimId).toBe("operation"); expect(f.effects.filter(item => item.startsWith("compensate:"))).toEqual([]);
    });
    it("never cancels or stops a same-GUID successor after a late inventory", async () => {
        const f = lifecycleFixture(), successor: Device = { ...original, lifecycle: { ...lifecycle, runtimeId: "successor", operation: "start" }, singletonClaimId: "successor" };
        let lists = 0;
        f.ports.listRuntime = () => {
            if (++lists === 1) return { ok: true, ids: [], result: { status: 0 } };
            f.elapse(60_000); f.replace(successor); f.setSingleton({ deviceId: "sandbox", sandboxId: guid, claimId: "successor" });
            return { ok: true, ids: [guid], result: { status: 0 } };
        };
        expect(await f.lifecycle.start({ deviceId: "sandbox", minimized: true })).toMatchObject({ kind: "registration-failed", releaseLockAfterFailure: false,
            cleanup: { refused: true }, watchdogCleanup: { ok: false, changed: false } });
        expect(f.read()).toBe(successor); expect(f.singleton()?.claimId).toBe("successor");
        expect(f.trace).not.toContain("watchdog:cancel"); expect(f.effects.filter(item => item.startsWith("compensate:"))).toEqual([]);
    });
});
