import { describe, expect, it } from "vitest";
import {
    DEVICE_LAB_OUTPUT_CONTRACTS,
    hasDeviceLabOutputContract,
    validateDeviceLabToolOutput,
} from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";

describe("device-lab public output contracts", () => {
    it("maps lifecycle and mobile session tools to explicit contracts", () => {
        expect(DEVICE_LAB_OUTPUT_CONTRACTS).toEqual(expect.objectContaining({
            device_create: "lifecycle-device-v1",
            device_status: "lifecycle-device-v1",
            device_start: "lifecycle-device-v1",
            device_stop: "lifecycle-device-v1",
            device_delete: "lifecycle-delete-v1",
            mobile_session_status: "mobile-session-status-v1",
        }));
        expect(hasDeviceLabOutputContract("device_start")).toBe(true);
        expect(hasDeviceLabOutputContract("mobile_tap")).toBe(true);
        expect(hasDeviceLabOutputContract("not_a_public_tool")).toBe(false);
    });

    it("covers every advertised public tool exactly once", () => {
        const advertised = TOOLS.map((tool: { name: string }) => tool.name).sort();
        const contracted = Object.keys(DEVICE_LAB_OUTPUT_CONTRACTS).sort();
        expect(contracted).toEqual(advertised);
        expect(contracted).toHaveLength(92);
    });

    it("returns typed lifecycle and session payloads", () => {
        const lifecycle = validateDeviceLabToolOutput("device_start", {
            device: { id: "ios-contract", status: "running" },
        });
        const session = validateDeviceLabToolOutput("mobile_session_status", {
            deviceId: "ios-contract",
            session: null,
        });

        expect(lifecycle.device.id).toBe("ios-contract");
        expect(session.deviceId).toBe("ios-contract");
    });

    it("reports the tool and missing field instead of leaking undefined access errors", () => {
        expect(() => validateDeviceLabToolOutput("device_status", { routedBy: "broker" }))
            .toThrow("device_status response contract violation: required device field is missing");
        expect(() => validateDeviceLabToolOutput("mobile_session_status", { session: null }))
            .toThrow("mobile_session_status response contract violation: required deviceId field is missing");
        expect(() => validateDeviceLabToolOutput("device_start", { ok: false, error: "provider-command-failed" }))
            .toThrow("device_start response contract violation: operation failed (provider-command-failed)");
    });
});
