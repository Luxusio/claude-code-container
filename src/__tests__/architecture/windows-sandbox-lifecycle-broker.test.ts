import { describe, expect, it } from "vitest";
import { createBrokerWindowsSandboxLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/windows-sandbox-lifecycle.js";
import { brokerWindowsSandboxReplacement } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/windows-sandbox-lifecycle.js";
import type { BrokerWindowsSandboxInput } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/windows-sandbox-lifecycle.js";
import type { BrokerWindowsSandboxLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/windows-sandbox-lifecycle.js";

const guid = "11111111-1111-4111-8111-111111111111";
const registeredGuid = "22222222-2222-4222-8222-222222222222";
type Prepared = { operation: string; target: string };
type Receipt = { native: "wsb" };
function fixture() {
    let current: Record<string, unknown> | null = { id: "sandbox", status: "stopped", sandboxId: guid, configPath: "config", minimized: false };
    let launched = false, clock = 0, locked = false;
    const effects: string[] = [];
    const runs: Prepared[] = [];
    const ports: BrokerWindowsSandboxLifecyclePorts<Prepared, Receipt> = {
        prepare: (_owner, request) => {
            const target = request.command === "device_start" ? guid : typeof current?.sandboxId === "string" ? current.sandboxId : guid;
            return { kind: "ready", handle: { operation: request.command, target }, operationKind: "runtime", sandboxId: target, minimized: request.minimized === true };
        },
        run: handle => {
            runs.push(handle);
            if (handle.operation === "device_start") launched = true;
            return { status: 0, stdout: "", receipt: { native: "wsb" } };
        },
        listRuntime: () => ({ status: 0, stdout: JSON.stringify(launched ? [registeredGuid] : []) }),
        isCanonicalConfig: () => true, writeConfig: () => undefined,
        claimSingleton: () => { locked = true; return { ok: true }; },
        releaseSingleton: () => { locked = false; effects.push("release-singleton"); return undefined; },
        updateSingletonRuntimeId: (_owner, _item, _claimed, actual) => { effects.push(`registered:${actual}`); return undefined; },
        helperPaths: () => ({ minimizeWatchdogCancelPath: "cancel", minimizeWatchdogResultPath: "result" }), removeMarker: () => undefined,
        runtimeIds: stdout => JSON.parse(stdout) as string[], snapshotWindows: () => ({ status: 0, stdout: "[101]" }), windowHandles: () => [101],
        launchWatchdog: () => ({ status: 0 }), waitForMinimizeConfirmation: () => ({ status: 0 }),
        cancelWatchdog: () => ({ attempted: false, ok: true, cancelPath: "cancel" }),
        cleanupAuxiliary: (_owner, _parsed, expected) => ({ result: { ok: true, changed: false, appium: { cleared: false }, recording: { cleared: false }, minimizeWatchdog: { cleared: false } }, committed: false, device: expected }),
        inspectExpectedRecord: (_owner, _key, _id, expected) => ({ found: current !== null, matched: JSON.stringify(expected) === JSON.stringify(current), device: current }),
        cleanArtifacts: () => { effects.push("remove-artifacts"); return { ok: true, removed: false, deviceRoot: "scratch" }; },
        publish: (_owner, _key, _id, expected, change) => {
            expect(expected).toEqual(current);
            current = brokerWindowsSandboxReplacement(current, change);
            return { found: true, matched: true, device: current };
        },
        now: () => clock,
        timestampBefore: () => "2026-10-10T00:00:00.000Z", sleep: milliseconds => { clock += milliseconds; return undefined; },
        platform: "win32", commandTimeoutMs: 2300, outputLimit: 32768,
    };
    function input(command: "device_start" | "device_stop" | "device_delete"): BrokerWindowsSandboxInput<Prepared> {
        const parsed = { ok: true as const, backend: "windows-sandbox", stateKey: "windows", deviceId: "sandbox", command, force: false, dryRun: false, minimized: false };
        return { ownerId: "owner", parsed, device: current, expectedDevice: current, prepared: ports.prepare("owner", parsed, current) };
    }
    return { ports, effects, runs, input, app: createBrokerWindowsSandboxLifecycle(ports), read: () => current, locked: () => locked, replace: (record: Record<string, unknown>) => { current = record; } };
}

describe("broker Windows Sandbox lifecycle application", () => {
    it("registers the observed runtime and publishes start, stop and delete results", async () => {
        const f = fixture();
        expect(await f.app.start(f.input("device_start"))).toMatchObject({ kind: "completed", success: true, facts: { device: { status: "running", sandboxId: registeredGuid, requestedSandboxId: guid }, execution: { receipt: { native: "wsb" } } } });
        expect(f.locked()).toBe(true);
        expect(f.effects).toContain(`registered:${registeredGuid}`);
        expect(await f.app.stop(f.input("device_stop"))).toMatchObject({ kind: "completed", success: true, facts: { device: { status: "stopped" } } });
        expect(f.locked()).toBe(false);
        expect(f.runs).toContainEqual({ operation: "device_stop", target: registeredGuid });
        expect(await f.app.delete(f.input("device_delete"))).toMatchObject({ kind: "completed", success: true });
        expect(f.read()).toBeNull();
        expect(f.effects).toContain("remove-artifacts");
    });
    it("blocks a preexisting requested runtime before claiming or canceling markers", async () => {
        const f = fixture(), before = f.read();
        f.ports.listRuntime = () => ({ status: 0, stdout: JSON.stringify([guid]) });
        f.ports.removeMarker = () => { f.effects.push("remove-marker"); return undefined; };
        expect(await f.app.start(f.input("device_start"))).toMatchObject({
            kind: "refused", category: "provider-failed", error: "windows-sandbox-runtime-already-present", facts: { invoked: false, mutatesHost: false },
        });
        expect(f.locked()).toBe(false);
        expect(f.read()).toBe(before);
        expect(f.effects).not.toContain("remove-marker");
        expect(f.runs).toEqual([]);
    });
    it("keeps ownership and reports concrete ambiguous registration evidence", async () => {
        const f = fixture();
        let launched = false;
        const ids = [registeredGuid, "33333333-3333-4333-8333-333333333333"];
        f.ports.run = handle => { f.runs.push(handle); launched = true; return { status: 0 }; };
        f.ports.listRuntime = () => ({ status: 0, stdout: JSON.stringify(launched ? ids : []) });
        const result = await f.app.start(f.input("device_start"));
        expect(result).toMatchObject({ kind: "indeterminate", success: false, facts: { mutatesHost: true, registration: { error: expect.stringContaining("ambiguous runtimes") } } });
        expect(f.read()).toMatchObject({ status: "stopped", sandboxId: guid });
        expect(f.locked()).toBe(true);
        expect(f.runs.some(handle => handle.operation === "device_stop")).toBe(false);
        expect(f.effects).not.toContain("remove-artifacts");
    });
    it("advances expected publication only after committed auxiliary cleanup", async () => {
        const f = fixture();
        const request = f.input("device_stop");
        const cleaned = { ...f.read(), recording: null };
        f.ports.cleanupAuxiliary = () => { f.replace(cleaned); return { result: { ok: true, changed: true, appium: {}, recording: { cleared: true }, minimizeWatchdog: {} }, device: cleaned, committed: true }; };
        expect(await f.app.stop(request)).toMatchObject({ kind: "completed", success: true, facts: { device: { status: "stopped", recording: null } } });
    });
    it("blocks provider execution and preserves retry state after watchdog cleanup refusal", async () => {
        const f = fixture(), before = f.read();
        f.ports.cleanupAuxiliary = () => ({ result: { ok: false, changed: false, appium: {}, recording: {}, minimizeWatchdog: { cleared: false, cancellation: { ok: false, error: "marker denied" } } }, device: before, committed: false });
        expect(await f.app.stop(f.input("device_stop"))).toMatchObject({ kind: "refused", category: "provider-failed", error: "auxiliary-runtime-cleanup-failed", facts: { invoked: false } });
        expect(f.runs).toEqual([]);
        expect(f.effects).toEqual([]);
        expect(f.read()).toBe(before);
    });
    it("keeps its record when artifact cleanup fails after a stopped delete", async () => {
        const f = fixture(), before = f.read();
        f.ports.cleanArtifacts = () => ({ ok: false, removed: false, deviceRoot: "scratch", error: "access denied" });
        expect(await f.app.delete(f.input("device_delete"))).toMatchObject({ kind: "refused", category: "provider-failed", error: "windows-sandbox-device-artifact-cleanup-failed", facts: { artifactCleanup: { error: "access denied" } } });
        expect(f.read()).toBe(before);
    });
    it("preserves a successor when native execution races publication", async () => {
        const f = fixture(), request = f.input("device_stop");
        const successor = { id: "sandbox", status: "running", sandboxId: registeredGuid, generation: "successor" };
        f.ports.run = () => { f.replace(successor); return { status: 0 }; };
        f.ports.publish = (_owner, _key, _id, expected) => { expect(expected).toBe(request.expectedDevice); return { found: true, matched: false, device: successor }; };
        expect(await f.app.stop(request)).toMatchObject({ kind: "refused", category: "conflict", error: "owner-device-state-conflict" });
        expect(f.read()).toBe(successor);
        expect(f.effects).not.toContain("remove-artifacts");
    });
    it("reports a final start publication conflict while retaining the launched runtime", async () => {
        const f = fixture(), request = f.input("device_start");
        const successor = { id: "sandbox", status: "starting", sandboxId: guid, generation: "successor" };
        f.ports.publish = (_owner, _key, _id, expected) => {
            expect(expected).toBe(request.expectedDevice);
            f.replace(successor);
            return { found: true, matched: false, device: successor };
        };
        expect(await f.app.start(request)).toMatchObject({
            kind: "refused", category: "conflict", error: "owner-device-state-conflict",
            facts: { device: successor, invoked: true, mutatesHost: true,
                runtime: { sandboxId: registeredGuid }, publication: { found: true, matched: false } },
        });
        expect(f.read()).toBe(successor);
        expect(f.locked()).toBe(true);
        expect(f.effects).not.toContain("release-singleton");
    });
    it("reports watchdog launch failure while keeping the registered Sandbox running", async () => {
        const f = fixture(), request = f.input("device_start");
        request.parsed.minimized = true;
        request.prepared = f.ports.prepare(request.ownerId, request.parsed, request.device);
        f.ports.launchWatchdog = () => ({ status: null, error: "watchdog unavailable" });
        expect(await f.app.start(request)).toMatchObject({ kind: "completed", success: true, facts: { device: { status: "running", minimizeConfirmed: false, minimizeWarning: "watchdog unavailable" }, watchdog: { error: "watchdog unavailable" } } });
        expect(f.locked()).toBe(true);
        expect(f.runs.some(handle => handle.operation === "device_stop")).toBe(false);
    });
    it("propagates the raw native execution fault without publishing a completed record", async () => {
        const f = fixture(), fault = new Error("native execution"), before = f.read();
        f.ports.run = () => { throw fault; };
        await expect(f.app.stop(f.input("device_stop"))).rejects.toBe(fault);
        expect(f.read()).toBe(before);
        expect(f.effects).not.toContain("remove-artifacts");
    });
});
