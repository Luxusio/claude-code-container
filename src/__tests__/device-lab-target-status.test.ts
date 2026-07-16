import { describe, expect, it } from "vitest";
import { normalizeTargetStatus, withTargetStatus } from "../../device-lab-mcp/src/status.mjs";

describe("device-lab target status normalizer", () => {
    it("normalizes virtual, physical, and current-display targets with stable defaults", () => {
        expect(normalizeTargetStatus({ id: "vm", status: "stopped", creatable: true })).toEqual(expect.objectContaining({
            targetKind: "virtual-device",
            creatable: true,
            attachable: false,
            runtimeState: "stopped",
            readiness: { state: "stopped" },
            leaseState: { state: "not-required" },
            sessionState: expect.objectContaining({ state: "none" }),
        }));

        expect(normalizeTargetStatus({ id: "phone", backend: "android-device", physical: true, status: "attached", attachable: true, serial: "SERIAL" })).toEqual(expect.objectContaining({
            targetKind: "physical-device",
            creatable: false,
            attachable: true,
            runtimeState: "attached",
            readiness: { state: "ready" },
            leaseState: expect.objectContaining({ state: "missing", hardwareId: "SERIAL" }),
        }));

        expect(withTargetStatus({ id: "x11-current-display", kind: "display", lifecycle: "current", creatable: false })).toEqual(expect.objectContaining({
            targetKind: "current-display",
            runtimeState: "current",
            targetStatus: expect.objectContaining({
                targetKind: "current-display",
                readiness: { state: "ready" },
            }),
        }));
    });
});
