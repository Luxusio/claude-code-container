import { describe, expect, it } from "vitest";
import {
    WINDOWS_SANDBOX_HELPER_MAX_TIMEOUT_MS,
    WINDOWS_SANDBOX_HELPER_TIMEOUT_MS,
    windowsSandboxHelperTimeoutMs,
} from "../../device-lab-mcp/src/backends/windows-sandbox.mjs";
import {
    MAX_DEVICE_HELPER_TIMEOUT_MS,
    MAX_DEVICE_OPERATION_TIMEOUT_MS,
    brokerDeviceToolExecutionTimeout,
    brokerLifecycleExecutionTimeout,
} from "../../device-lab-mcp/src/server.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import {
    DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS,
    DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS,
    deviceBrokerBackendToolTimeoutMs,
} from "../device-lab-broker.js";

function toolProperty(toolName: string, property: string): Record<string, unknown> {
    const tool = TOOLS.find((candidate) => candidate.name === toolName);
    return ((tool?.inputSchema?.properties || {})[property] || {}) as Record<string, unknown>;
}

describe("device-lab public timeout bounds", () => {
    it("advertises finite helper and wait limits on every affected public tool", () => {
        const helperTools = [
            "device_exec",
            "device_screenshot",
            "device_click",
            "device_double_click",
            "device_key",
            "device_type",
            "device_scroll",
            "device_cursor_position",
            "device_window_list",
            "device_accessibility_snapshot",
            "device_record_video_stop",
            "device_record_video_status",
            "device_upload",
            "device_download",
        ];
        for (const tool of helperTools) {
            expect(toolProperty(tool, "helperTimeoutMs"), tool).toEqual(expect.objectContaining({
                minimum: 1,
                maximum: MAX_DEVICE_HELPER_TIMEOUT_MS,
                type: "number",
            }));
        }

        expect(toolProperty("device_start", "bootTimeoutMs")).toEqual(expect.objectContaining({
            minimum: 1,
            maximum: MAX_DEVICE_OPERATION_TIMEOUT_MS,
        }));
        for (const tool of ["mobile_wait_for_text", "mobile_wait_for_app"]) {
            expect(toolProperty(tool, "timeoutMs"), tool).toEqual(expect.objectContaining({
                minimum: 1,
                maximum: MAX_DEVICE_OPERATION_TIMEOUT_MS,
            }));
            expect(toolProperty(tool, "intervalMs"), tool).toEqual(expect.objectContaining({
                minimum: 1,
                maximum: 60000,
            }));
        }
    });

    it("caps MCP broker HTTP deadlines even when schema validation is bypassed", () => {
        expect(brokerDeviceToolExecutionTimeout("device_exec", { helperTimeoutMs: Number.MAX_SAFE_INTEGER })).toEqual({
            rpcTimeoutMs: MAX_DEVICE_HELPER_TIMEOUT_MS + 30000,
        });
        expect(brokerDeviceToolExecutionTimeout("mobile_wait_for_text", { timeoutMs: Number.MAX_SAFE_INTEGER })).toEqual({
            rpcTimeoutMs: MAX_DEVICE_OPERATION_TIMEOUT_MS + 30000,
        });
        expect(brokerDeviceToolExecutionTimeout("device_exec", { rpcTimeoutMs: Number.MAX_SAFE_INTEGER })).toEqual({
            rpcTimeoutMs: MAX_DEVICE_OPERATION_TIMEOUT_MS + 30000,
        });
        expect(brokerDeviceToolExecutionTimeout("device_record_video_status", { helperTimeoutMs: 5000 })).toEqual({
            rpcTimeoutMs: 35000,
        });
        expect(brokerDeviceToolExecutionTimeout("device_inventory", {})).toEqual({
            rpcTimeoutMs: 60000,
        });
    });

    it("allows ordinary provider lifecycle operations to exceed 30 seconds", () => {
        expect(brokerLifecycleExecutionTimeout({ backend: "windows-sandbox" })).toEqual({
            rpcTimeoutMs: 120000,
        });
        expect(brokerLifecycleExecutionTimeout({
            backend: "windows-sandbox",
            waitForBoot: true,
            bootTimeoutMs: 180000,
        })).toEqual({
            rpcTimeoutMs: 195000,
        });
    });

    it("caps host broker child deadlines independently of the MCP server", () => {
        expect(DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS).toBe(MAX_DEVICE_HELPER_TIMEOUT_MS);
        expect(DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS).toBe(MAX_DEVICE_OPERATION_TIMEOUT_MS);
        expect(deviceBrokerBackendToolTimeoutMs("device_exec", { helperTimeoutMs: Number.MAX_SAFE_INTEGER })).toBe(DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS + 15000);
        expect(deviceBrokerBackendToolTimeoutMs("mobile_wait_for_app", { timeoutMs: Number.MAX_SAFE_INTEGER })).toBe(DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS + 15000);
        expect(deviceBrokerBackendToolTimeoutMs("device_exec", { timeoutMs: Number.MAX_SAFE_INTEGER })).toBe(30000);
        expect(deviceBrokerBackendToolTimeoutMs("device_exec", { helperTimeoutMs: -1 })).toBe(30000);
    });

    it("caps direct Windows helper polling independently of routing", () => {
        expect(WINDOWS_SANDBOX_HELPER_MAX_TIMEOUT_MS).toBe(MAX_DEVICE_HELPER_TIMEOUT_MS);
        expect(windowsSandboxHelperTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(WINDOWS_SANDBOX_HELPER_MAX_TIMEOUT_MS);
        expect(windowsSandboxHelperTimeoutMs(0)).toBe(WINDOWS_SANDBOX_HELPER_TIMEOUT_MS);
        expect(windowsSandboxHelperTimeoutMs(0.5)).toBe(1);
    });
});
