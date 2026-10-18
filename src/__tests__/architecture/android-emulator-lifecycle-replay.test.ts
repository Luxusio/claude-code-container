import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";
import { brokerLifecyclePorts, privateBrokerHome } from "../helpers/android-emulator-lifecycle-fixture.js";
import { addAndroidEmulatorUsedPorts, selectAndroidEmulatorPort, validateAndroidEmulatorPortRequest } from "../../../packages/device-lab/providers/domain/lifecycle/android-emulator-lifecycle.mjs";
import { createBrokerAndroidEmulatorLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/android-emulator-lifecycle.js";

type Allocation = { ok: true; port: number } | { ok: false; error: string; detail?: string; allowed?: string };
type NativeAllocation = { resolveAndroidEmulatorPort(owner: string, id: string, requested?: number, additional?: Iterable<number>): Allocation };
const project = fileURLToPath(new URL("../../../", import.meta.url));
const allocatorUrl = pathToFileURL(join(project, "packages/device-lab/providers/state/android-emulator-port-allocation.mjs")).href;

describe("Android emulator current allocation and native refusals", () => {
    it("moved pure pool selection checks port pool bounds and mutable used-port carrier", () => {
        const used = new Set<number>();
        expect(validateAndroidEmulatorPortRequest(5555)).toEqual({ ok: false, error: "invalid-android-emulator-port", allowed: "even integer 5554-5682" });
        expect(selectAndroidEmulatorPort(used, undefined, 38)).toEqual({ ok: true, port: 5630 });
        addAndroidEmulatorUsedPorts(used, [5555, 0, NaN, 5630]);
        expect(used).toEqual(new Set([5630]));
        expect(selectAndroidEmulatorPort(used, undefined, 38)).toEqual({ ok: true, port: 5632 });
    });
    it("retains deterministic selection, live-port filtering, scan order and bounded exhaustion", async () => {
        const fixture = privateBrokerHome(), restore = isolateDeviceLabTestEnvironment(fixture.home);
        try {
            const native = await import(allocatorUrl) as NativeAllocation;
            const owner = "0123456789abcdef", id = "android-allocation";
            const first = native.resolveAndroidEmulatorPort(owner, id);
            expect(first.ok).toBe(true); if (!first.ok) throw Error(first.error);
            
            expect(first.port % 2).toBe(0); expect(first.port).toBeGreaterThanOrEqual(5554); expect(first.port).toBeLessThanOrEqual(5682);
            expect(native.resolveAndroidEmulatorPort(owner, id)).toEqual(first);
            const second = native.resolveAndroidEmulatorPort(owner, id, undefined, [5555, 0, NaN, first.port]);
            expect(second.ok).toBe(true); if (second.ok) expect(second.port).not.toBe(first.port);
            const pool = Array.from({ length: 65 }, (_, index) => 5554 + index * 2);
            const exhausted = native.resolveAndroidEmulatorPort(owner, id, undefined, pool);
            expect(exhausted).toEqual({ ok: false, error: "android-emulator-port-pool-exhausted" });
            const explicit = native.resolveAndroidEmulatorPort(owner, id, first.port, [first.port]);
            expect(explicit).toEqual({ ok: false, error: "android-emulator-port-conflict", detail: `port-${first.port}-already-allocated` });

        } finally { restore(); fixture.remove(); }
    });

    it("rejects invalid request before corrupt all-owner inventory and preserves its bytes", async () => {
        const fixture = privateBrokerHome(), restore = isolateDeviceLabTestEnvironment(fixture.home);
        try {
            const native = await import(allocatorUrl) as NativeAllocation;
            const foreign = join(fixture.home, ".ccc/devices/owners", "6162636465666768", "android");
            mkdirSync(foreign, { recursive: true }); const path = join(foreign, "devices.json"); writeFileSync(path, "{");
            const invalid = native.resolveAndroidEmulatorPort("0123456789abcdef", "android-original-allocation", 5555);
            expect(invalid).toEqual({ ok: false, error: "invalid-android-emulator-port", allowed: "even integer 5554-5682" });
            const corrupt = native.resolveAndroidEmulatorPort("0123456789abcdef", "android-original-allocation", 5668);
            expect(corrupt).toEqual({ ok: false, error: "android-emulator-port-inventory-unavailable", detail: "owner-devices-state-invalid" });
            expect(readFileSync(path, "utf8")).toBe("{");

        } finally { restore(); fixture.remove(); }
    });

    it("propagates an argument failure before native commands and counts denied spawn", async () => {
        const fixture = privateBrokerHome(), restore = isolateDeviceLabTestEnvironment(fixture.home);
        const savedSpawn = childProcess.spawn, savedSpawnSync = childProcess.spawnSync, savedKill = process.kill;
        const denied = { spawn: 0, spawnSync: 0, signal: 0 };
        const deny = (kind: keyof typeof denied): never => { denied[kind]++; throw Error("DENIED " + kind); };
        childProcess.spawn = () => deny("spawn"); childProcess.spawnSync = () => deny("spawnSync");
        process.kill = (pid, signal) => pid === process.pid && signal === 0 ? savedKill(pid, signal) : deny("signal");
        syncBuiltinESMExports();
        try {
            const facadeUrl = pathToFileURL(join(project, "packages/device-lab/providers/backends/android.mjs")).href;
            const facade = await import(facadeUrl) as { handleAndroidTool(name: string, args: Record<string, unknown>): Promise<unknown> };
            const thrown = new Error("native argument fault");
            const args = {backend:"android-emulator",name:"Argument",deviceId:"android-argument",avdName:"unused",systemImage:"unused",get port(){throw thrown;}};
            await expect(facade.handleAndroidTool("device_create", args)).rejects.toBe(thrown);
            expect(denied).toEqual({ spawn:0,spawnSync:0,signal:0 });
            // Separate guard-negative witness: count the attempt before throwing.
            expect(() => childProcess.spawn("/unallocated/provider", [])).toThrow("DENIED spawn");
            expect(denied).toEqual({ spawn: 1, spawnSync: 0, signal: 0 });

        } finally {
            childProcess.spawn = savedSpawn; childProcess.spawnSync = savedSpawnSync; process.kill = savedKill;
            syncBuiltinESMExports(); restore(); fixture.remove();
        }
    });
});

describe("Android broker pending launch recovery replay", () => {
    const device = () => ({ id: "android-unit", backend: "android-emulator", avdName: "ccc-owner-unit", port: 5630, status: "stopped", extra: { retained: true } });

    it("failed launch survives refused stop, confirmed stop clears recovery, and the next start has a fresh identity", async () => {
        const original = device(), f = brokerLifecyclePorts(original), execute = f.ports.executePrepared;
        let launchSucceeds = false, stopSucceeds = false;
        const seenRuntimeIds: unknown[] = [];
        f.ports.executePrepared = async (effect, options) => {
            const native = await execute(effect, options);
            if (effect.action === "start") {
                seenRuntimeIds.push((f.current()?.lifecycle as Record<string, unknown> | undefined)?.runtimeId);
                return { ...native, ok: launchSucceeds };
            }
            return { ...native, ok: effect.action === "stop" ? stopSucceeds : native.ok };
        };
        const app = createBrokerAndroidEmulatorLifecycle(f.ports);
        expect(await app.start(f.input("device_start", { waitForBoot: false }))).toMatchObject({ kind: "provider-failed", invoked: true, mutatesHost: true });
        const reservation = f.current();
        expect(reservation).toMatchObject({ status: "starting", lifecycle: { runtimeId: "android-broker-runtime-1", operation: "start", claimedAt: "native-timestamp" } });

        expect(await app.stop(f.input("device_stop"))).toMatchObject({ kind: "provider-failed" });
        expect(f.current()).toBe(reservation); expect(f.publications).toEqual([original]);

        stopSucceeds = true;
        expect(await app.stop(f.input("device_stop"))).toMatchObject({ kind: "completed", device: { status: "stopped", bootReady: false, extra: original.extra } });
        expect(f.current()?.lifecycle).toBeFalsy();
        expect(f.commands.filter(command => command.effect.action === "stop")).toHaveLength(2);
        expect(f.trace).toContain("processes");

        launchSucceeds = true;
        expect(await app.start(f.input("device_start", { waitForBoot: false }))).toMatchObject({ kind: "completed", device: { status: "running", bootReady: false } });
        expect(seenRuntimeIds).toEqual(["android-broker-runtime-1", "android-broker-runtime-2"]);
        expect(f.current()?.lifecycle).toBeFalsy();
    });

    it("unconfirmed cleanup stop retains the pending marker until native absence is confirmed", async () => {
        const f = brokerLifecyclePorts(device());
        f.ports.prepareBootProbe = () => ({ kind: "unavailable", observation: { ok: false, mode: "noop", provider: "adb" } });
        const app = createBrokerAndroidEmulatorLifecycle(f.ports);
        await app.start(f.input("device_start", { waitForBoot: true }));
        const reservation = f.current();
        expect(reservation).toMatchObject({ status: "starting", lifecycle: { runtimeId: "android-broker-runtime-1" } });
        const inventory = f.ports.observeStopInventory;
        f.ports.observeStopInventory = () => ({ ok: false, mode: "exec", provider: "adb", available: false, serialPresent: false });
        expect(await app.stop(f.input("device_stop"))).toMatchObject({ kind: "stop-unconfirmed", invoked: true, mutatesHost: true });
        expect(f.current()).toBe(reservation); expect(f.publications).toHaveLength(1);
        f.ports.observeStopInventory = inventory;
        expect(await app.stop(f.input("device_stop"))).toMatchObject({ kind: "completed", device: { status: "stopped" } });
        expect(f.current()?.lifecycle).toBeFalsy();
    });

    it("confirmed predecessor stop cannot clear a same-target successor reservation", async () => {
        const f = brokerLifecyclePorts(device()), execute = f.ports.executePrepared;
        f.ports.prepareBootProbe = () => ({ kind: "unavailable", observation: { ok: false, mode: "noop", provider: "adb" } });
        const app = createBrokerAndroidEmulatorLifecycle(f.ports);
        await app.start(f.input("device_start", { waitForBoot: true }));
        const reservation = f.current();
        expect(reservation).toMatchObject({ status: "starting", lifecycle: { runtimeId: "android-broker-runtime-1" } });
        const successor = { ...device(), status: "starting", lifecycle: { runtimeId: "successor", operation: "start", claimedAt: "later" } };
        f.ports.executePrepared = async (effect, options) => { const result = await execute(effect, options); if (effect.action === "stop") f.replace(successor); return result; };
        const result = await app.stop(f.input("device_stop"));
        expect(result).toMatchObject({ kind: "publication-conflict", invoked: true, mutatesHost: true });
        expect(f.current()).toBe(successor); expect(f.publications.at(-1)).toEqual(reservation);
        expect(f.commands.filter(command => command.effect.action === "stop")).toHaveLength(1);
    });
});
