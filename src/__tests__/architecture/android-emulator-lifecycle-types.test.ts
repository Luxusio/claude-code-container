import { describe, expect, it } from "vitest";
import { createAndroidPreviewPortAllocation } from "../../../packages/device-lab/src/device-lab/application/broker-observation-command-plan.js";
import type { LifecyclePreviewRequest } from "../../../packages/device-lab/src/device-lab/domain/broker-observation-command-plan.js";
import type { AndroidPreviewPortAllocationPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-observation.js";

// ORIGINAL checked contract for the already-inward broker preview allocator.
// New direct and four-operation contracts do not exist at original-capture GO;
// this fixture establishes their prerequisite, not their completion or credit.
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
