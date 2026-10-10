import { describe, expect, it } from "vitest";
import { createWindowsSandboxStop } from "../../../packages/device-lab/providers/application/lifecycle/windows-sandbox-stop.mjs";
import type { WindowsSandboxLifecycleDevice as Device, WindowsSandboxLifecycle as Lifecycle, WindowsSandboxSingleton as Singleton, IsoTimestamp } from "../../../packages/device-lab/providers/domain/lifecycle/windows-sandbox-stop.mjs";
import type { WindowsSandboxStopPorts } from "../../../packages/device-lab/providers/ports/lifecycle/windows-sandbox-stop.mjs";

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
            trace.push(`cas:${id}:${replacement.status}`);
            const matched = current === expected;
            if (matched) current = replacement;
            return { found: !!current, matched, currentDevice: expected, device: matched ? replacement : null };
        },
        claimSingleton: (item, sandboxId, claimId) => { trace.push("singleton:claim"); singleton = { deviceId: item.id, sandboxId, claimId }; return { ok: true, lock: singleton }; },
        releaseSingleton: (_item, claimId) => { trace.push(`singleton:release:${claimId}`); if (singleton?.claimId !== claimId) return false; singleton = null; return true; },
        singletonGenerationMatches: item => { trace.push("generation"); return singleton?.claimId === item.singletonClaimId; },
        watchdogCancelPath: item => { trace.push(`watchdog:path:${item.id}`); return "private-cancel"; },
        cancelWatchdog: cancelPath => { trace.push("watchdog:cancel"); return { attempted: true, ok: true, cancelPath }; },
        discoverRuntime: () => { trace.push("discovery"); return { available: true, missing: [], binding: { provider: "fixture" } }; },
        stopOwnedRuntime: (binding, item, timeout) => { trace.push(`runtime:${binding.provider}:${item.sandboxId}:${timeout}`); return { ok: true, evidence: { opaque: "native" } }; },
        ...changes,
    };
    return { ports, trace, app: createWindowsSandboxStop(ports), read: () => current, replace: (item: Device | undefined) => { current = item; }, setSingleton: (value: Singleton | null) => { singleton = value; } };
}
const lifecycle: Lifecycle = { runtimeId: "operation", operation: "stop", claimedAt: "2026-10-08T00:00:00.000Z" };

describe("synchronous direct Sandbox stop core", () => {
    it("finishes all effects synchronously and commits CURRENT plus only own helper metadata", () => {
        const f = fixture();
        const result = f.app.stop("sandbox");
        expect(result).not.toBeInstanceOf(Promise);
        expect(result.kind).toBe("completed");
        expect(f.trace).toEqual(["find:sandbox", "singleton:read", "singleton:owner", "id", "clock", "clock", "cas:sandbox:stopping", "generation", "watchdog:path:sandbox", "watchdog:cancel", "discovery", `runtime:fixture:${guid}:60000`, "clock", "find:sandbox", "clock", "cas:sandbox:stopped", "singleton:release:old"]);
        expect(f.read()).toMatchObject({ status: "stopped", sandboxId: guid, recording: original.recording, minimizeWatchdogLaunch: original.minimizeWatchdogLaunch, helperSessionLaunch: { ok: true, minimizeWatchdogPid: null }, lifecycle: null, singletonClaimId: null });
    });
    it("leaves missing target unhandled without other effects", () => {
        const f = fixture(); f.replace(undefined);
        expect(f.app.stop("sandbox")).toEqual({ kind: "unhandled" }); expect(f.trace).toEqual(["find:sandbox"]);
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
    it("preserves a successor and releases old generation before the second missing-current lookup", () => {
        const f = fixture(); const successor: Device = { ...original, lifecycle: { ...lifecycle, runtimeId: "successor" } };
        f.ports.stopOwnedRuntime = () => { f.replace(successor); return { ok: true, evidence: { opaque: "native" } }; };
        expect(f.app.stop("sandbox")).toMatchObject({ kind: "conflict", operation: "stop", transition: { found: true, matched: false } });
        expect(f.read()).toBe(successor); expect(f.trace.slice(-3)).toEqual(["find:sandbox", "singleton:release:old", "find:sandbox"]);
    });
    it.each([false, true])("completion CAS mismatch retains release return/throw behavior (throw=%s)", throws => {
        const f = fixture(); let calls = 0; const native = f.ports.transitionDevice; const fault = new Error("release");
        f.ports.transitionDevice = (...args) => ++calls === 2 ? { found: true, matched: false } : native(...args);
        f.ports.releaseSingleton = () => { f.trace.push("release"); if (throws) throw fault; return false; };
        if (throws) expect(() => f.app.stop("sandbox")).toThrow(fault);
        else expect(f.app.stop("sandbox")).toMatchObject({ kind: "conflict", operation: "stop" });
        expect(f.trace.at(-1)).toBe("release");
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
        expect(f.trace).toContain("singleton:claim"); expect(f.trace.at(-1)).toBe("singleton:release:operation");
    });
    it.each(["stopped", "claimed"])("bind %s bypass performs no native action", mode => {
        const f = fixture(); const claim = { lifecycle: { ...lifecycle, ...(mode === "claimed" ? { singletonClaimId: "old" } : {}) }, claimed: original, transition: { found: true, matched: true } };
        expect(f.app.bindLifecycleSingleton("sandbox", claim, { ...original, status: mode === "stopped" ? "stopped" : "running" })).toEqual({ ok: true, claim }); expect(f.trace).toEqual([]);
    });
    it.each([undefined, null, false, 0, "", {}, [], { minimizeWatchdogPid: 17 }])("retains cleanup helper spread for %j", helper => {
        const item = { id: "sandbox", status: "stopped", helperSessionLaunch: helper } as Device;
        const f = fixture(); const result = f.app.cleanupWatchdogs(item);
        const expected = helper && typeof helper === "object" ? { ...helper, minimizeWatchdogPid: null } : helper;
        expect(result.device.helperSessionLaunch).toEqual(expected); expect(result.device.minimizeWatchdogLaunch).toBeNull();
    });
    it.each([undefined, null, "17", 1.5, 0, -1, 17])("filters watchdog PID %j and resolves metadata even without cancellation", pid => {
        const f = fixture(); const result = f.app.cleanupWatchdogs({ id: "sandbox", status: "stopped", helperSessionLaunch: { minimizeWatchdogPid: pid } } as Device);
        expect(result.changed).toBe(pid === 17); expect(f.trace[0]).toBe("watchdog:path:sandbox"); expect(f.trace.length).toBe(pid === 17 ? 2 : 1);
    });
    it.each([null, undefined, false, 0, "", {}, { pid: 17 }])("uses nonnull watchdog launch %j as cancellation evidence", launch => {
        const f = fixture(); const result = f.app.cleanupWatchdogs({ id: "sandbox", status: "stopped", minimizeWatchdogLaunch: launch } as Device);
        expect(result.changed).toBe(launch != null); expect(f.trace.filter(x => x === "watchdog:cancel")).toHaveLength(launch != null ? 1 : 0);
    });
    it("deduplicates candidate PIDs but cancels once for distinct PIDs too", () => {
        for (const pid of [17, 18]) { const f = fixture(); f.app.cleanupWatchdogs({ ...original, helperSessionLaunch: { minimizeWatchdogPid: pid } }); expect(f.trace).toEqual(["watchdog:path:sandbox", "watchdog:cancel"]); }
    });
    it("requires explicit effect ports without ambient fallback", () => { expect(() => createWindowsSandboxStop({} as Ports)).toThrow("requires readSingleton"); });
});
