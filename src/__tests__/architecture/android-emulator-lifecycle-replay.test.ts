import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";
import { ORIGINAL_ANDROID_LIFECYCLE, originalObservation, privateBrokerHome } from "../helpers/android-emulator-lifecycle-fixture.js";
import { addAndroidEmulatorUsedPorts, selectAndroidEmulatorPort, validateAndroidEmulatorPortRequest } from "../../../packages/device-lab/providers/domain/lifecycle/android-emulator-lifecycle.mjs";

type Allocation = { ok: true; port: number } | { ok: false; error: string; detail?: string; allowed?: string };
type NativeAllocation = { resolveAndroidEmulatorPort(owner: string, id: string, requested?: number, additional?: Iterable<number>): Allocation };
const project = fileURLToPath(new URL("../../../", import.meta.url));
const allocatorUrl = pathToFileURL(join(project, "packages/device-lab/providers/state/android-emulator-port-allocation.mjs")).href;

describe("Android emulator original native allocation witnesses", () => {
    it("moved pure pool selection preserves the immutable native observations and mutable used-port carrier", () => {
        const used = new Set<number>();
        expect(validateAndroidEmulatorPortRequest(5555)).toEqual({ ok: false, error: "invalid-android-emulator-port", allowed: "even integer 5554-5682" });
        expect(selectAndroidEmulatorPort(used, undefined, 38)).toEqual({ ok: true, port: ORIGINAL_ANDROID_LIFECYCLE.firstPort });
        addAndroidEmulatorUsedPorts(used, [5555, 0, NaN, ORIGINAL_ANDROID_LIFECYCLE.firstPort]);
        expect(used).toEqual(new Set([ORIGINAL_ANDROID_LIFECYCLE.firstPort]));
        expect(selectAndroidEmulatorPort(used, undefined, 38)).toEqual({ ok: true, port: ORIGINAL_ANDROID_LIFECYCLE.nextPort });
    });
    it("retains deterministic selection, live-port filtering, scan order and bounded exhaustion", async () => {
        const fixture = privateBrokerHome(), restore = isolateDeviceLabTestEnvironment(fixture.home);
        try {
            const native = await import(allocatorUrl) as NativeAllocation;
            const owner = ORIGINAL_ANDROID_LIFECYCLE.allocationOwner, id = ORIGINAL_ANDROID_LIFECYCLE.allocationId;
            const first = native.resolveAndroidEmulatorPort(owner, id);
            expect(first.ok).toBe(true); if (!first.ok) throw Error(first.error);
            expect(first.port).toBe(ORIGINAL_ANDROID_LIFECYCLE.firstPort);
            expect(first.port % 2).toBe(0); expect(first.port).toBeGreaterThanOrEqual(5554); expect(first.port).toBeLessThanOrEqual(5682);
            expect(native.resolveAndroidEmulatorPort(owner, id)).toEqual(first);
            const second = native.resolveAndroidEmulatorPort(owner, id, undefined, [5555, 0, NaN, first.port]);
            expect(second).toEqual({ ok: true, port: ORIGINAL_ANDROID_LIFECYCLE.nextPort });
            const pool = Array.from({ length: 65 }, (_, index) => 5554 + index * 2);
            const exhausted = native.resolveAndroidEmulatorPort(owner, id, undefined, pool);
            expect(exhausted).toEqual({ ok: false, error: "android-emulator-port-pool-exhausted" });
            const explicit = native.resolveAndroidEmulatorPort(owner, id, first.port, [first.port]);
            expect(explicit).toEqual({ ok: false, error: "android-emulator-port-conflict", detail: `port-${first.port}-already-allocated` });
            originalObservation("allocation-selection", { first, second, exhausted, explicit });
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
            originalObservation("allocation-admission", { invalid, corrupt, foreignBytes: readFileSync(path, "utf8") });
        } finally { restore(); fixture.remove(); }
    });

    it("complete direct handler preserves accessor receiver/order and thrown identity before native commands", async () => {
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
            const args: Record<string, unknown> = {}, trace: string[] = [], receivers: boolean[] = [], thrown = new Error("original accessor sentinel");
            for (const [key, value] of Object.entries({ backend: "android-emulator", name: "Getter", deviceId: "android-getter", avdName: "unused", port: 5555, systemImage: "unused" })) {
                Object.defineProperty(args, key, { get() { trace.push(key); receivers.push(this === args); if (key === "port") throw thrown; return value; } });
            }
            await expect(facade.handleAndroidTool("device_create", args)).rejects.toBe(thrown);
            expect(trace).toEqual(ORIGINAL_ANDROID_LIFECYCLE.directAccessorReads);
            expect(receivers.every(Boolean)).toBe(true); expect(denied).toEqual({ spawn: 0, spawnSync: 0, signal: 0 });
            originalObservation("direct-accessor", { trace, receivers, sameThrownIdentity: true, denied: { ...denied } });
            // Separate guard-negative witness: count the attempt before throwing.
            expect(() => childProcess.spawn("/unallocated/provider", [])).toThrow("DENIED spawn");
            expect(denied).toEqual({ spawn: 1, spawnSync: 0, signal: 0 });
            originalObservation("native-denial-control", { denied });
        } finally {
            childProcess.spawn = savedSpawn; childProcess.spawnSync = savedSpawnSync; process.kill = savedKill;
            syncBuiltinESMExports(); restore(); fixture.remove();
        }
    });
});
