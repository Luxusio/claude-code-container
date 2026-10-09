import { describe, expect, it } from "vitest";
import { createAndroidPreviewPortAllocation } from "../../../packages/device-lab/src/device-lab/application/broker-observation-command-plan.js";
import type { LifecyclePreviewRequest } from "../../../packages/device-lab/src/device-lab/domain/broker-observation-command-plan.js";
import type { AndroidPreviewPortAllocationPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-observation.js";

// Existing checked broker policy is a migration prerequisite. These ORIGINAL
// controls retain lazy native port lookup/receiver identity and failure routing;
// they do not pretend the four lifecycle applications already exist.
describe("Android emulator original existing inward allocation seam", () => {
    it("looks up required effects lazily and keeps their receiver and native error identity", () => {
        type Ports = AndroidPreviewPortAllocationPorts<LifecyclePreviewRequest>;
        const trace: string[] = [], sentinel = { native: "inventory failure" }, receivers: boolean[] = [];
        const parsed: LifecyclePreviewRequest = { backend: "android-emulator", stateKey: "android", command: "device_create", deviceId: "original", force: false, dryRun: false, create: { port: 5555 } };
        const ports: Ports = {
            get valid() { trace.push("get-valid"); return function (this: Ports, port: unknown): port is number { receivers.push(this === ports); trace.push("valid"); return typeof port === "number" && port % 2 === 0; }; },
            get allocated() { trace.push("get-allocated"); return function (this: Ports): Set<number> { receivers.push(this === ports); trace.push("allocated"); throw sentinel; }; },
            get inventoryError() { trace.push("get-error"); return function (this: Ports, error: unknown): string { receivers.push(this === ports); trace.push("error"); expect(error).toBe(sentinel); return "original inventory error"; }; },
            get seed() { trace.push("get-seed"); return () => 0; },
        };
        const allocate = createAndroidPreviewPortAllocation(ports, 5554, 5682);
        expect(trace).toEqual([]);
        expect(allocate("original", parsed, [])).toEqual({ kind: "invalid" });
        expect(trace).toEqual(["get-valid", "valid"]);
        parsed.create!.port = 5560;
        expect(allocate("original", parsed, [])).toEqual({ kind: "inventory-failed", detail: "original inventory error" });
        expect(trace).toEqual(["get-valid", "valid", "get-valid", "valid", "get-allocated", "allocated", "get-error", "error"]);
        expect(receivers.every(Boolean)).toBe(true); expect(trace).not.toContain("get-seed");
    });
});
