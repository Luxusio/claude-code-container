import { describe, expect, it } from "vitest";
import { createBrokerWindowsSandboxLifecycle, planBrokerWindowsSandboxCommand } from "../../../packages/device-lab/src/device-lab/application/lifecycle/windows-sandbox-lifecycle.js";
import { brokerWindowsSandboxReplacement } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/windows-sandbox-lifecycle.js";
import type { BrokerWindowsSandboxInput, BrokerWindowsSandboxCommand } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/windows-sandbox-lifecycle.js";
import type { BrokerWindowsSandboxLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/windows-sandbox-lifecycle.js";

const guid = "11111111-1111-4111-8111-111111111111";
const registeredGuid = "22222222-2222-4222-8222-222222222222";
function fixture() {
    let current: Record<string, unknown> | null = { id: "sandbox", status: "stopped", sandboxId: guid, configPath: "config", minimized: false };
    let launched = false, clock = 0, locked = false;
    const effects: string[] = [];
    const commands: BrokerWindowsSandboxCommand[] = [];
    const ports: BrokerWindowsSandboxLifecyclePorts = {
        execute: command => {
            commands.push(command);
            if (command.args?.[0] === "start") launched = true;
            return { mode: command.mode, provider: command.provider, status: 0, stdout: command.args?.[0] === "list" ? JSON.stringify(launched ? [registeredGuid] : []) : "" };
        },
        executable: () => "fake-wsb", stopRuntimeId: (_owner, item) => { const id = (item as { sandboxId?: unknown })?.sandboxId; return typeof id === "string" ? id : null; }, newRuntimeId: () => guid,
        readConfig: () => ({ ok: true, config: "<Configuration/>" }), isCanonicalConfig: () => true, writeConfig: () => undefined,
        claimSingleton: () => { locked = true; return { ok: true }; },
        releaseSingleton: () => { locked = false; effects.push("release-singleton"); return undefined; },
        updateSingletonRuntimeId: (_owner, _item, _claimed, actual) => { effects.push(`registered:${actual}`); return undefined; },
        helperPaths: () => ({ minimizeWatchdogCancelPath: "cancel", minimizeWatchdogResultPath: "result" }), removeMarker: () => undefined,
        runtimeIds: stdout => JSON.parse(stdout) as string[], windowSnapshotCommand: () => ({ mode: "exec", provider: "powershell", args: ["window-snapshot"] }), windowHandles: () => [101],
        watchdogCommand: () => ({ mode: "detached", provider: "powershell", args: ["watchdog"] }), waitForMinimizeConfirmation: () => ({ mode: "exec", provider: "window", status: 0 }),
        cancelWatchdog: () => ({ attempted: false, ok: true, cancelPath: "cancel" }),
        cleanupAuxiliary: (_owner, _parsed, expected) => ({ result: { ok: true, changed: false, appium: { cleared: false }, recording: { cleared: false }, minimizeWatchdog: { cleared: false } }, committed: false, device: expected }),
        inspectExpectedRecord: (_owner, _key, _id, expected) => ({ found: current !== null, matched: JSON.stringify(expected) === JSON.stringify(current), device: current }),
        cleanArtifacts: () => { effects.push("remove-artifacts"); return { ok: true, removed: false, deviceRoot: "scratch" }; },
        publish: (_owner, _key, _id, expected, change) => {
            expect(expected).toEqual(current);
            current = brokerWindowsSandboxReplacement(current, change);
            return { found: true, matched: true, device: current };
        },
        redactDevice: item => item, failureDetail: result => result.error || result.stderr || "provider failed", now: () => clock,
        timestampBefore: () => "2026-10-10T00:00:00.000Z", sleep: milliseconds => { clock += milliseconds; return undefined; },
        platform: "win32", commandTimeoutMs: 2300, outputLimit: 32768,
    };
    function input(command: "device_start" | "device_stop" | "device_delete"): BrokerWindowsSandboxInput {
        const parsed = { ok: true as const, backend: "windows-sandbox", stateKey: "windows", deviceId: "sandbox", command, force: false, dryRun: false, minimized: false };
        return { ownerId: "owner", parsed, expectedDevice: current, plan: { device: current, providerCommand: planBrokerWindowsSandboxCommand("owner", parsed, current, ports) } };
    }
    return { ports, effects, commands, input, app: createBrokerWindowsSandboxLifecycle(ports), read: () => current, locked: () => locked, replace: (record: Record<string, unknown>) => { current = record; } };
}

describe("broker Windows Sandbox lifecycle application", () => {
    it("registers the observed runtime and publishes start, stop and delete results", async () => {
        const f = fixture();
        expect(await f.app.start(f.input("device_start"))).toMatchObject({ status: 200, payload: { ok: true, result: { device: { status: "running", sandboxId: registeredGuid, requestedSandboxId: guid } } } });
        expect(f.locked()).toBe(true);
        expect(f.effects).toContain(`registered:${registeredGuid}`);
        expect(await f.app.stop(f.input("device_stop"))).toMatchObject({ status: 200, payload: { ok: true, result: { device: { status: "stopped" } } } });
        expect(f.locked()).toBe(false);
        expect(f.commands).toContainEqual(expect.objectContaining({ args: ["stop", "--id", registeredGuid] }));
        expect(await f.app.delete(f.input("device_delete"))).toMatchObject({ status: 200, payload: { ok: true } });
        expect(f.read()).toBeNull();
        expect(f.effects).toContain("remove-artifacts");
    });
    it("keeps ownership and reports concrete ambiguous registration evidence", async () => {
        const f = fixture();
        let launched = false;
        const ids = [registeredGuid, "33333333-3333-4333-8333-333333333333"];
        f.ports.execute = command => {
            f.commands.push(command);
            if (command.args?.[0] === "start") launched = true;
            return { mode: command.mode, provider: command.provider, status: 0, stdout: command.args?.[0] === "list" ? JSON.stringify(launched ? ids : []) : "" };
        };
        const result = await f.app.start(f.input("device_start"));
        expect(result).toMatchObject({ status: 502, payload: { ok: false, result: { execution: { mutatesHost: true, command: { registration: { error: expect.stringContaining("ambiguous runtimes") } } } } } });
        expect(f.read()).toMatchObject({ status: "stopped", sandboxId: guid });
        expect(f.locked()).toBe(true);
        expect(f.commands.some(command => command.args?.[0] === "stop")).toBe(false);
        expect(f.effects).not.toContain("remove-artifacts");
    });
    it("advances expected publication only after committed auxiliary cleanup", async () => {
        const f = fixture();
        const request = f.input("device_stop");
        const cleaned = { ...f.read(), recording: null };
        f.ports.cleanupAuxiliary = () => { f.replace(cleaned); return { result: { ok: true, changed: true, appium: {}, recording: { cleared: true }, minimizeWatchdog: {} }, device: cleaned, committed: true }; };
        expect(await f.app.stop(request)).toMatchObject({ status: 200, payload: { ok: true, result: { device: { status: "stopped", recording: null } } } });
    });
    it("blocks provider execution and preserves retry state after watchdog cleanup refusal", async () => {
        const f = fixture(), before = f.read();
        f.ports.cleanupAuxiliary = () => ({ result: { ok: false, changed: false, appium: {}, recording: {}, minimizeWatchdog: { cleared: false, cancellation: { ok: false, error: "marker denied" } } }, device: before, committed: false });
        expect(await f.app.stop(f.input("device_stop"))).toMatchObject({ status: 502, payload: { ok: false, error: "auxiliary-runtime-cleanup-failed", result: { invoked: false } } });
        expect(f.commands).toEqual([]);
        expect(f.effects).toEqual([]);
        expect(f.read()).toBe(before);
    });
    it("keeps its record when artifact cleanup fails after a stopped delete", async () => {
        const f = fixture(), before = f.read();
        f.ports.cleanArtifacts = () => ({ ok: false, removed: false, deviceRoot: "scratch", error: "access denied" });
        expect(await f.app.delete(f.input("device_delete"))).toMatchObject({ status: 502, payload: { ok: false, error: "windows-sandbox-device-artifact-cleanup-failed", result: { windowsDeviceArtifactCleanup: { error: "access denied" } } } });
        expect(f.read()).toBe(before);
    });
    it("preserves a successor when native execution races publication", async () => {
        const f = fixture(), request = f.input("device_stop");
        const successor = { id: "sandbox", status: "running", sandboxId: registeredGuid, generation: "successor" };
        f.ports.execute = command => { f.replace(successor); return { mode: command.mode, provider: command.provider, status: 0 }; };
        f.ports.publish = (_owner, _key, _id, expected) => { expect(expected).toBe(request.expectedDevice); return { found: true, matched: false, device: successor }; };
        expect(await f.app.stop(request)).toMatchObject({ status: 409, payload: { ok: false, error: "owner-device-state-conflict" } });
        expect(f.read()).toBe(successor);
        expect(f.effects).not.toContain("remove-artifacts");
    });
    it("reports watchdog launch failure while keeping the registered Sandbox running", async () => {
        const f = fixture(), request = f.input("device_start");
        request.parsed.minimized = true;
        request.plan!.providerCommand = { mode: "exec", provider: "wsb", executable: "fake-wsb", args: ["start"], sandboxId: guid, windowStyle: "minimized" };
        const execute = f.ports.execute;
        f.ports.execute = command => command.mode === "detached" ? { mode: command.mode, provider: command.provider, status: null, error: "watchdog unavailable" } : command.provider === "powershell" ? { mode: command.mode, provider: command.provider, status: 0, stdout: "[101]" } : execute(command);
        expect(await f.app.start(request)).toMatchObject({ status: 200, payload: { ok: true, result: { device: { status: "running", minimizeConfirmed: false, minimizeWarning: "watchdog unavailable" } } } });
        expect(f.locked()).toBe(true);
        expect(f.commands.some(command => command.args?.[0] === "stop")).toBe(false);
    });
    it("propagates the raw native execution fault without publishing a completed record", async () => {
        const f = fixture(), fault = new Error("native execution"), before = f.read();
        f.ports.execute = () => { throw fault; };
        await expect(f.app.stop(f.input("device_stop"))).rejects.toBe(fault);
        expect(f.read()).toBe(before);
        expect(f.effects).not.toContain("remove-artifacts");
    });
});
