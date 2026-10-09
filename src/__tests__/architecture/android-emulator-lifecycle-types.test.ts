import { describe, expect, it } from "vitest";
import { createAndroidPreviewPortAllocation } from "../../../packages/device-lab/src/device-lab/application/broker-observation-command-plan.js";
import type { LifecyclePreviewRequest } from "../../../packages/device-lab/src/device-lab/domain/broker-observation-command-plan.js";
import type { AndroidPreviewPortAllocationPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-observation.js";
import { createAndroidEmulatorLifecycle } from "../../../packages/device-lab/providers/application/lifecycle/android-emulator-lifecycle.mjs";
import type { AndroidEmulatorDevice, AndroidEmulatorLifecyclePorts } from "../../../packages/device-lab/providers/ports/lifecycle/android-emulator-lifecycle.mjs";
import type { BrokerAndroidEmulatorLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/android-emulator-lifecycle.js";
import { directLifecyclePorts, type DirectLifecycleResult, type DirectOwnedChild } from "../helpers/android-emulator-lifecycle-fixture.js";

// ORIGINAL checked contract for the already-inward broker preview allocator.
// Retain the original prerequisite alongside the candidate operation contracts.
type Ports = AndroidPreviewPortAllocationPorts<LifecyclePreviewRequest>;
const valid: Ports = {
    valid: (port: unknown): port is number => typeof port === "number" && Number.isInteger(port) && port >= 5554 && port <= 5682 && port % 2 === 0,
    allocated: () => new Set<number>(), inventoryError: () => "original-error", seed: () => 0,
};
function originalRequiredPortNegatives(): void {
    // @ts-expect-error native inventory observation is required
    const missing: Ports = { valid: valid.valid, inventoryError: valid.inventoryError, seed: valid.seed };
    // @ts-expect-error inventory is synchronously observed; Promise is incompatible
    const asyncInventory: Ports = { ...valid, allocated: async () => new Set<number>() };
    // @ts-expect-error a synchronous numeric seed is required
    const asyncSeed: Ports = { ...valid, seed: async () => 0 };
    // @ts-expect-error valid must narrow unknown to number, not merely return boolean
    const booleanValidation: Ports = { ...valid, valid: (_port: unknown): boolean => true };
    void missing; void asyncInventory; void asyncSeed; void booleanValidation;
}
void originalRequiredPortNegatives;

type DirectPorts = AndroidEmulatorLifecyclePorts<DirectLifecycleResult, DirectOwnedChild>;
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
const directStepsRequired: [OptionalKeys<DirectPorts>] extends [never] ? true : false = true;
const brokerStepsRequired: [OptionalKeys<BrokerAndroidEmulatorLifecyclePorts>] extends [never] ? true : false = true;
void directStepsRequired; void brokerStepsRequired;
function directOperationContractNegatives(): void {
    const direct = directLifecyclePorts().ports;
    const { spawnAndroidEmulator, ...missingSpawn } = direct; void spawnAndroidEmulator;
    // @ts-expect-error actual spawned native handle effect is required
    createAndroidEmulatorLifecycle(missingSpawn);
    // @ts-expect-error allocation is synchronously observed
    const asyncAllocation: DirectPorts = { ...direct, resolveAndroidEmulatorPort: async () => ({ ok: true, port: 5630 }) };
    // @ts-expect-error native command observation is synchronously available
    const asyncCommand: DirectPorts = { ...direct, run: async () => ({ status: 0, stdout: "", stderr: "" }) };
    // @ts-expect-error raw transition requires both found and matched observations
    const weakTransition: DirectPorts = { ...direct, transitionAndroidDevice: () => ({ matched: true }) };
    // @ts-expect-error spawn crosses the actual native handle, not merely its PID
    const pidOnlySpawn: DirectPorts = { ...direct, spawnAndroidEmulator: async () => ({ pid: 424242 }) };
    // @ts-expect-error identity observation is asynchronous
    const syncIdentity: DirectPorts = { ...direct, waitForProcessIdentity: () => ({ startToken: "native" }) };
    // @ts-expect-error bounded owned termination reports an exited boolean
    const weakTermination: DirectPorts = { ...direct, terminateOwnedRuntimeProcessTree: async () => ({ ok: true }) };
    // @ts-expect-error raw native device ids are strings
    const malformedRecord: DirectPorts = { ...direct, readAndroidDevices: () => [{ id: 5 }] };
    void asyncAllocation; void asyncCommand; void weakTransition; void pidOnlySpawn; void syncIdentity; void weakTermination; void malformedRecord;
}
void directOperationContractNegatives;

function brokerOperationContractNegatives(broker: BrokerAndroidEmulatorLifecyclePorts): void {
    // @ts-expect-error polling pacing must finish synchronously, not return a Promise
    const asyncSleep: BrokerAndroidEmulatorLifecyclePorts = { ...broker, sleep: async () => undefined };
    // @ts-expect-error provider command result is a synchronous native observation
    const asyncExecution: BrokerAndroidEmulatorLifecyclePorts = { ...broker, execute: async () => ({ mode: "exec", provider: "adb", status: 0 }) };
    // @ts-expect-error committed auxiliary cleanup must carry its complete result/device observation
    const weakCleanup: BrokerAndroidEmulatorLifecyclePorts = { ...broker, cleanupAuxiliary: () => ({ committed: true }) };
    // @ts-expect-error complete-record conditional publication is synchronously observed
    const asyncPublication: BrokerAndroidEmulatorLifecyclePorts = { ...broker, transition: async () => ({ found: true, matched: true, device: null }) };
    // @ts-expect-error live inventory needs its bounded native result, not a bare list
    const weakInventory: BrokerAndroidEmulatorLifecyclePorts = { ...broker, livePorts: () => [5630] };
    const { now, ...withoutClock } = broker; void now;
    // @ts-expect-error native capacity clock is required even with every other step present
    const missingClock: BrokerAndroidEmulatorLifecyclePorts = withoutClock;
    void asyncSleep; void asyncExecution; void weakCleanup; void asyncPublication; void weakInventory; void missingClock;
}
void brokerOperationContractNegatives;

describe("Android emulator original checked prerequisite port contract", () => {
    it("uses the existing broker allocation contract with mutable native inventory and request carriers", () => {
        const used = new Set<number>([5554]);
        const parsed: LifecyclePreviewRequest = { backend: "android-emulator", stateKey: "android", command: "device_create", deviceId: "original", force: false, dryRun: true, create: {} };
        const allocate = createAndroidPreviewPortAllocation({ ...valid, allocated: () => used }, 5554, 5682);
        expect(allocate("original", parsed, [5556])).toEqual({ kind: "allocated", port: 5558 });
        expect(used).toEqual(new Set([5554, 5556]));
        parsed.create!.port = 5560;
        expect(allocate("original", parsed, [])).toEqual({ kind: "allocated", port: 5560 });
    });
});

describe("Android emulator lifecycle current direct and broker contracts", () => {
    it("retains mutable raw devices and an actual typed child handle through the public factory", async () => {
        const device: AndroidEmulatorDevice = { id: "android-unit", avdName: "ccc-owner-unit", port: 5630, status: "stopped", raw: { sentinel: true } };
        device.status = "stopped"; const f = directLifecyclePorts(device);
        const lifecycle = createAndroidEmulatorLifecycle(f.ports);
        const result: DirectLifecycleResult | undefined = await lifecycle.start({ deviceId: device.id, waitForBoot: false });
        expect(result).toMatchObject({ ok: true, payload: { boot: { ready: false, skipped: true }, device: { raw: device.raw } } });
        expect(f.current()?.runtime?.pid).toBe(f.child.pid);
    });
});
