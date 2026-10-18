import { describe, expect, it } from "vitest";
import { createAndroidPreviewPortAllocation } from "../../../packages/device-lab/src/device-lab/application/broker-observation-command-plan.js";
import type { LifecyclePreviewRequest } from "../../../packages/device-lab/src/device-lab/domain/broker-observation-command-plan.js";
import type { AndroidPreviewPortAllocationPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-observation.js";
import { createAndroidEmulatorLifecycle } from "../../../packages/device-lab/providers/application/lifecycle/android-emulator-lifecycle.mjs";
import { createBrokerAndroidEmulatorLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/android-emulator-lifecycle.js";
import type { BrokerAndroidCreatePortAllocationPorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/android-emulator-lifecycle.js";
import type { BrokerAndroidLifecycleInput } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/android-emulator-lifecycle.js";
import type { AndroidEmulatorDevice, AndroidEmulatorLifecyclePorts } from "../../../packages/device-lab/providers/ports/lifecycle/android-emulator-lifecycle.mjs";
import { directLifecyclePorts, type DirectLifecycleResult, type DirectOwnedChild, type BrokerAndroidTestPorts as BrokerAndroidEmulatorLifecyclePorts, type BrokerAndroidTestEffect } from "../helpers/android-emulator-lifecycle-fixture.js";

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

type DirectPorts = AndroidEmulatorLifecyclePorts<DirectOwnedChild>;
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
const directStepsRequired: [OptionalKeys<DirectPorts>] extends [never] ? true : false = true;
const brokerStepsRequired: [OptionalKeys<BrokerAndroidEmulatorLifecyclePorts>] extends [never] ? true : false = true;
void directStepsRequired; void brokerStepsRequired;
function directOperationContractNegatives(): void {
    const direct = directLifecyclePorts().ports;
    const { launchAndroidEmulator, ...missingSpawn } = direct; void launchAndroidEmulator;
    // @ts-expect-error actual spawned native handle effect is required
    createAndroidEmulatorLifecycle(missingSpawn);
    // @ts-expect-error allocation is synchronously observed
    const asyncAllocation: DirectPorts = { ...direct, resolveAndroidEmulatorPort: async () => ({ ok: true, port: 5630 }) };
    // @ts-expect-error native command observation is synchronously available
    const asyncCommand: DirectPorts = { ...direct, provisionAndroidAvd: async () => ({ ok: true, diagnostic: {} }) };
    // @ts-expect-error raw transition requires both found and matched observations
    const weakTransition: DirectPorts = { ...direct, transitionAndroidDevice: () => ({ matched: true }) };
    // @ts-expect-error spawn crosses the actual native handle, not merely its PID
    const pidOnlySpawn: DirectPorts = { ...direct, launchAndroidEmulator: async () => ({ pid: 424242 }) };
    // @ts-expect-error identity observation is asynchronous
    const syncIdentity: DirectPorts = { ...direct, waitForProcessIdentity: () => ({ startToken: "native" }) };
    // @ts-expect-error bounded owned termination reports an exited boolean
    const weakTermination: DirectPorts = { ...direct, terminateOwnedRuntimeProcessTree: async () => ({ ok: true }) };
    // @ts-expect-error raw native device ids are strings
    const malformedRecord: DirectPorts = { ...direct, readAndroidDevices: () => [{ id: 5 }] };
    void asyncAllocation; void asyncCommand; void weakTransition; void pidOnlySpawn; void syncIdentity; void weakTermination; void malformedRecord;
}
void directOperationContractNegatives;

function brokerOperationContractPositives(broker: BrokerAndroidEmulatorLifecyclePorts): void {
    const asyncEffects: BrokerAndroidEmulatorLifecyclePorts = {
        ...broker,
        executePrepared: async (...args) => await broker.executePrepared(...args),
        observeStopInventory: async (...args) => await broker.observeStopInventory(...args),
        observeBootProbe: async (...args) => await broker.observeBootProbe(...args),
        metadataObservation: async (...args) => await broker.metadataObservation(...args),
        sleep: async ms => { await broker.sleep(ms); },
        livePorts: async () => await broker.livePorts(),
        liveAvds: async () => await broker.liveAvds(),
        avdProcesses: async (...args) => await broker.avdProcesses(...args),
        avdArtifacts: async (...args) => await broker.avdArtifacts(...args),
        removeAvdArtifacts: async (name, owner, root, verifyInactive) => {
            const inactive: boolean = await verifyInactive();
            void inactive;
            return await broker.removeAvdArtifacts(name, owner, root, async () => await verifyInactive());
        },
        cleanupAuxiliary: async (...args) => await broker.cleanupAuxiliary(...args),
    };
    const pendingSleep: PromiseLike<void> = Promise.resolve();
    const thenablePacing: BrokerAndroidEmulatorLifecyclePorts = { ...broker, sleep: () => pendingSleep };
    void [asyncEffects, thenablePacing];
}
void brokerOperationContractPositives;

function brokerOperationContractNegatives(broker: BrokerAndroidEmulatorLifecyclePorts): void {
    // @ts-expect-error asynchronous pacing cannot resolve to a native result or number
    const malformedSleep: BrokerAndroidEmulatorLifecyclePorts = { ...broker, sleep: async () => 250 };
    // @ts-expect-error asynchronous command results still require settled success
    const malformedAsyncExecution: BrokerAndroidEmulatorLifecyclePorts = { ...broker, executePrepared: async () => ({ mode: "exec", provider: "adb" }) };
    // @ts-expect-error committed auxiliary cleanup must carry its complete result/device observation
    const weakCleanup: BrokerAndroidEmulatorLifecyclePorts = { ...broker, cleanupAuxiliary: () => ({ committed: true }) };
    // @ts-expect-error complete-record conditional publication is synchronously observed
    const asyncPublication: BrokerAndroidEmulatorLifecyclePorts = { ...broker, transition: async () => ({ found: true, matched: true, device: null }) };
    // @ts-expect-error create claim remains a synchronous repository transaction
    const asyncClaim: BrokerAndroidEmulatorLifecyclePorts = { ...broker, claimDefinition: async () => ({ ok: true, device: {} }) };
    // @ts-expect-error native boot preparation remains synchronous
    const asyncPreparation: BrokerAndroidEmulatorLifecyclePorts = { ...broker, prepareBootProbe: async () => ({ kind: "ready", effect: { action: "boot-probe" } }) };
    // @ts-expect-error a live observation promise must resolve to bounded inventory facts
    const malformedAsyncInventory: BrokerAndroidEmulatorLifecyclePorts = { ...broker, livePorts: async () => [5630] };
    // @ts-expect-error asynchronous auxiliary cleanup still requires its complete observation
    const malformedAsyncCleanup: BrokerAndroidEmulatorLifecyclePorts = { ...broker, cleanupAuxiliary: async () => ({ committed: true }) };
    // @ts-expect-error asynchronous artifact removal must report what was removed
    const malformedAsyncRemoval: BrokerAndroidEmulatorLifecyclePorts = { ...broker, removeAvdArtifacts: async () => ({ ok: true }) };
    // @ts-expect-error live inventory needs its bounded native result, not a bare list
    const weakInventory: BrokerAndroidEmulatorLifecyclePorts = { ...broker, livePorts: () => [5630] };
    const { now, ...withoutClock } = broker; void now;
    // @ts-expect-error native capacity clock is required even with every other step present
    const missingClock: BrokerAndroidEmulatorLifecyclePorts = withoutClock;
    const { observeStopInventory, ...withoutStopInventory } = broker;
    // @ts-expect-error stop requires a settled native inventory observation
    createBrokerAndroidEmulatorLifecycle(withoutStopInventory);
    const { observeBootProbe, ...withoutBootProbe } = broker;
    // @ts-expect-error boot requires a settled native readiness observation
    createBrokerAndroidEmulatorLifecycle(withoutBootProbe);
    // @ts-expect-error a raw process result does not carry settled command success
    const rawExecution: BrokerAndroidEmulatorLifecyclePorts = { ...broker, executePrepared: () => ({ mode: "exec", provider: "adb", status: 0 }) };
    // @ts-expect-error settled async stop inventory must distinguish availability from serial presence
    const weakStopInventory: BrokerAndroidEmulatorLifecyclePorts = { ...broker, observeStopInventory: async () => ({ ok: true, mode: "exec", provider: "adb", available: true }) };
    // @ts-expect-error successful settled async native execution alone is not a boot readiness observation
    const weakBootProbe: BrokerAndroidEmulatorLifecyclePorts = { ...broker, observeBootProbe: async () => ({ ok: true, mode: "exec", provider: "adb" }) };
    const allocation: BrokerAndroidCreatePortAllocationPorts = { previewAllocation: () => ({ ok: true, port: 5630 }), livePorts: async () => ({ ok: true, ports: new Set<number>() }) };
    // @ts-expect-error pure preview allocation remains synchronous
    const asyncPreview: BrokerAndroidCreatePortAllocationPorts = { ...allocation, previewAllocation: async () => ({ ok: true, port: 5630 }) };
    void [malformedSleep, malformedAsyncExecution, weakCleanup, asyncPublication, asyncClaim, asyncPreparation, malformedAsyncInventory, malformedAsyncCleanup, malformedAsyncRemoval, weakInventory, missingClock, observeStopInventory, observeBootProbe, rawExecution, weakStopInventory, weakBootProbe, asyncPreview];
}
void brokerOperationContractNegatives;

async function brokerSemanticConsumer(ports: BrokerAndroidEmulatorLifecyclePorts, input: BrokerAndroidLifecycleInput<BrokerAndroidTestEffect>): Promise<void> {
    const app = createBrokerAndroidEmulatorLifecycle(ports);
    const outcome = await app.start(input);
    // @ts-expect-error lifecycle outcomes do not expose HTTP response bodies
    const payload = outcome.payload;
    // @ts-expect-error lifecycle outcomes do not expose HTTP response status
    const status = outcome.status;
    const { executePrepared, ...withoutExecution } = ports;
    // @ts-expect-error a prepared native effect requires its execution capability
    createBrokerAndroidEmulatorLifecycle(withoutExecution);
    // @ts-expect-error the core cannot submit arbitrary executable/argv recipes
    ports.executePrepared({ executable: "adb", args: [] }, { timeoutMs: 1000, outputLimit: 1024 });
    void [payload, status, executePrepared];
}
void brokerSemanticConsumer;

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
        expect(result).toMatchObject({ kind: "started", boot: { ready: false, skipped: true }, device: { raw: device.raw } });
        expect(f.current()?.runtime?.pid).toBe(f.child.pid);
    });
});
