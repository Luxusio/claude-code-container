import { describe, expect, it } from "vitest";
import {
    WINDOWS_SANDBOX_HELPER_MAX_TIMEOUT_MS,
    WINDOWS_SANDBOX_HELPER_TIMEOUT_MS,
    windowsSandboxHelperTimeoutMs,
} from "@ccc/device-lab/providers/backends/windows-sandbox.mjs";
import {
    MAX_DEVICE_HELPER_TIMEOUT_MS,
    MAX_DEVICE_OPERATION_TIMEOUT_MS,
    HYPER_V_CREATE_RPC_TIMEOUT_MS,
    HYPER_V_HOST_LOCK_WAIT_MS,
    HYPER_V_LIFECYCLE_RPC_BUFFER_MS,
    HYPER_V_CLEANUP_RESERVE_MS,
    HYPER_V_MAX_BOOT_TIMEOUT_MS,
    HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS,
    HYPER_V_LINUX_GUI_TIMEOUT_MS,
    brokerDeviceToolExecutionTimeout,
    brokerLifecycleExecutionTimeout,
} from "../../device-lab-mcp/src/server.mjs";
import { TOOLS, toolOperation } from "../../device-lab-mcp/src/tools.mjs";
import {
    DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS,
    DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS,
    DEVICE_BROKER_HYPER_V_CREATE_POST_ACQUIRE_BUDGET_MS,
    DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS,
    DEVICE_BROKER_HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS,
    DEVICE_BROKER_HYPER_V_LINUX_GUI_TIMEOUT_MS,
    hyperVLifecycleCleanupTimeoutMs,
    DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS,
    DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS,
    DEVICE_BROKER_HYPER_V_IMAGE_ACQUIRE_TIMEOUT_MS,
    DEVICE_BROKER_HYPER_V_IMAGE_LOCK_WAIT_MS,
    DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS,
    deviceBrokerBackendToolTimeoutMs,
} from "@ccc/device-lab/device-lab-broker.js";

function toolProperty(toolName: string, property: string): Record<string, unknown> {
    const tool = TOOLS.find((candidate) => candidate.name === toolName);
    return ((tool?.inputSchema?.properties || {})[property] || {}) as Record<string, unknown>;
}

function snapshotRequestTimeout(action: string, args: Record<string, unknown> = {}) {
    const request = { deviceId: "owned-snapshot-vm", action, ...args };
    const operation = toolOperation("snapshot", request);
    expect(operation).toBe(`device_snapshot_${action}`);
    return brokerDeviceToolExecutionTimeout(operation!, request);
}

describe("device-lab public timeout bounds", () => {
    it("advertises finite helper and wait limits on every affected public tool", () => {
        const helperTools = [
            "screenshot",
            "click",
            "key",
            "type",
            "scroll",
            "cursor_position",
            "window_list",
            "ui",
            "record_video",
            "upload",
            "download",
            "install_app",
            "move",
        ];
        for (const tool of helperTools) {
            expect(toolProperty(tool, "timeoutMs"), tool).toEqual(expect.objectContaining({
                minimum: 1,
                maximum: MAX_DEVICE_HELPER_TIMEOUT_MS,
                type: "number",
            }));
        }

        expect(toolProperty("start", "bootTimeoutMs")).toEqual(expect.objectContaining({
            minimum: 1,
            maximum: HYPER_V_MAX_BOOT_TIMEOUT_MS,
        }));
        expect(toolProperty("reboot", "bootTimeoutMs")).toEqual(expect.objectContaining({
            minimum: 1,
            maximum: HYPER_V_MAX_BOOT_TIMEOUT_MS,
        }));
        expect(toolProperty("exec", "timeoutMs")).toEqual(expect.objectContaining({
            type: "number",
            minimum: 1,
            maximum: MAX_DEVICE_OPERATION_TIMEOUT_MS,
        }));
        expect(TOOLS.every(tool => !("helperTimeoutMs" in tool.inputSchema.properties))).toBe(true);
        for (const tool of ["wait_for_text", "wait_for_app"]) {
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

    describe("Hyper-V snapshot broker completion", () => {
        const routes = [
            { backend: "windows-vm" },
            { backend: "linux-vm", provider: "hyper-v" },
            { backend: "linux-vm" },
            {}, // Public snapshot calls omit backend; owner inventory resolves it at the broker.
        ];

        it.each(routes)("waits for create preflight, mutation and cleanup before returning: %j", (route) => {
            const timeout = snapshotRequestTimeout("create", route);
            // Preflight can consume 30s before a 45s native create; keep its 30s recovery
            // reserve and 15s return margin instead of dropping the reply at the old 60s.
            expect(timeout).toEqual({ rpcTimeoutMs: 120000 });
            expect(timeout.rpcTimeoutMs).toBeGreaterThanOrEqual(30000 + 45000 + 30000 + 15000);
        });

        it.each(routes)("keeps the full restore and Linux guest-readiness window: %j", (route) => {
            const timeout = snapshotRequestTimeout("restore", route);
            expect(timeout).toEqual({ rpcTimeoutMs: 285000 });
            expect(timeout.rpcTimeoutMs).toBeGreaterThanOrEqual(120000 + 120000 + 30000 + 15000);
        });

        it.each(routes)("waits for deletion and its cleanup outcome: %j", (route) => {
            const timeout = snapshotRequestTimeout("delete", route);
            expect(timeout).toEqual({ rpcTimeoutMs: 165000 });
            expect(timeout.rpcTimeoutMs).toBeGreaterThanOrEqual(120000 + 30000 + 15000);
        });

        it.each(routes)("keeps list bounded without adding a mutation cleanup reserve: %j", (route) => {
            expect(snapshotRequestTimeout("list", route)).toEqual({ rpcTimeoutMs: 60000 });
        });

        it("retains unrelated provider defaults and introduces no snapshot timeout argument", () => {
            for (const route of [
                { backend: "macos-vm" },
                { backend: "linux-vm", provider: "container-qemu" },
            ]) {
                for (const action of ["list", "create", "restore", "delete"]) {
                    expect(snapshotRequestTimeout(action, route), `${route.backend}/${route.provider || "default"}/${action}`)
                        .toEqual({ rpcTimeoutMs: 60000 });
                }
            }
            for (const property of ["timeoutMs", "rpcTimeoutMs", "helperTimeoutMs"]) {
                expect(toolProperty("snapshot", property)).toEqual({});
            }
        });

        it("preserves explicit caller timeout precedence and bounds on snapshot requests", () => {
            for (const action of ["list", "create", "restore", "delete"]) {
                const route = { backend: "windows-vm" };
                expect(snapshotRequestTimeout(action, { ...route, rpcTimeoutMs: 4500.9, timeoutMs: 9000 }))
                    .toEqual({ rpcTimeoutMs: 4500 });
                expect(snapshotRequestTimeout(action, { ...route, timeoutMs: 5500.9 }))
                    .toEqual({ rpcTimeoutMs: 5500 });
                expect(snapshotRequestTimeout(action, { ...route, helperTimeoutMs: 5000 }))
                    .toEqual({ rpcTimeoutMs: 35000 });
                expect(snapshotRequestTimeout(action, { ...route, rpcTimeoutMs: 0 }))
                    .toEqual({ rpcTimeoutMs: 30000 });
                expect(snapshotRequestTimeout(action, { ...route, rpcTimeoutMs: Number.MAX_SAFE_INTEGER }))
                    .toEqual({ rpcTimeoutMs: MAX_DEVICE_OPERATION_TIMEOUT_MS + 30000 });
            }
        });
    });

    it("keeps the MCP client's containment reserve equal to the broker's", () => {
        // Two constants, two packages, one meaning. The broker adds this to its cleanup deadline so
        // containment can run after the operation deadline; if the client waits less, it drops the
        // reply carrying scrubContainmentFailed — the one signal that a guest may still be up with
        // a live autologon. A silent divergence here loses that signal with nothing failing.
        expect(HYPER_V_CLEANUP_RESERVE_MS).toBe(DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS);
        expect(HYPER_V_LINUX_GUI_TIMEOUT_MS).toBe(DEVICE_BROKER_HYPER_V_LINUX_GUI_TIMEOUT_MS);

        // The equality above is not the invariant that matters — it only holds today because both
        // sides independently spell out the same four-term sum. What must be true is that the
        // client waits at least as long as the broker's outer window; otherwise the reply carrying
        // scrubContainmentFailed is dropped exactly in the case the reserve exists to cover. Change
        // the broker to add 2x the reserve and the equality above still passes while this fails.
        for (const backend of ["windows-vm", "linux-vm"] as const) {
            for (const command of ["device_start", "device_reboot"] as const) {
                // Default boot budget, matching what the broker assumes when bootTimeoutMs is absent.
                const operationTimeoutMs = DEVICE_BROKER_HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS + (5 * 60 * 1000)
                    + (backend === "linux-vm" ? DEVICE_BROKER_HYPER_V_LINUX_GUI_TIMEOUT_MS : 0);
                const client = brokerLifecycleExecutionTimeout({ backend, command }).rpcTimeoutMs;
                const brokerOuterWindow = DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS
                    + hyperVLifecycleCleanupTimeoutMs(backend, command, operationTimeoutMs);
                expect(client, `${backend}/${command}: client must outwait the broker`).toBeGreaterThanOrEqual(brokerOuterWindow);
            }
        }
    });

    it("allows ordinary provider lifecycle operations to exceed 30 seconds", () => {
        expect(brokerLifecycleExecutionTimeout({ backend: "macos-vm", command: "device_start", waitForBoot: true })).toEqual({ rpcTimeoutMs: 315000 });
        expect(brokerLifecycleExecutionTimeout({ backend: "android-emulator", command: "device_start", waitForBoot: true })).toEqual({ rpcTimeoutMs: 75000 });
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
        expect(brokerLifecycleExecutionTimeout({ backend: "windows-vm", command: "device_create", name: "automatic-image" })).toEqual({
            rpcTimeoutMs: HYPER_V_CREATE_RPC_TIMEOUT_MS,
        });
        expect(brokerLifecycleExecutionTimeout({ backend: "linux-vm", command: "device_create", name: "automatic-image", rpcTimeoutMs: Number.MAX_SAFE_INTEGER })).toEqual({
            rpcTimeoutMs: HYPER_V_CREATE_RPC_TIMEOUT_MS,
        });
        expect(brokerLifecycleExecutionTimeout({ backend: "windows-vm", command: "device_create", name: "automatic-image", rpcTimeoutMs: 30000 })).toEqual({
            rpcTimeoutMs: HYPER_V_CREATE_RPC_TIMEOUT_MS,
        });
        expect(brokerLifecycleExecutionTimeout({
            backend: "windows-vm",
            command: "device_start",
            name: "spoofed-create",
            sourceImage: "spoofed.vhdx",
            image: "spoofed-image",
        })).toEqual({
            rpcTimeoutMs: HYPER_V_HOST_LOCK_WAIT_MS + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS + (5 * 60 * 1000) + HYPER_V_CLEANUP_RESERVE_MS + HYPER_V_LIFECYCLE_RPC_BUFFER_MS,
        });
        expect(brokerLifecycleExecutionTimeout({ backend: "windows-vm", command: "device_start" })).toEqual({
            rpcTimeoutMs: HYPER_V_HOST_LOCK_WAIT_MS + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS + (5 * 60 * 1000) + HYPER_V_CLEANUP_RESERVE_MS + HYPER_V_LIFECYCLE_RPC_BUFFER_MS,
        });
        expect(brokerLifecycleExecutionTimeout({ backend: "linux-vm", command: "device_reboot", bootTimeoutMs: HYPER_V_MAX_BOOT_TIMEOUT_MS })).toEqual({
            rpcTimeoutMs: HYPER_V_HOST_LOCK_WAIT_MS + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS + HYPER_V_MAX_BOOT_TIMEOUT_MS + HYPER_V_LINUX_GUI_TIMEOUT_MS + HYPER_V_CLEANUP_RESERVE_MS + HYPER_V_LIFECYCLE_RPC_BUFFER_MS,
        });
        expect(brokerLifecycleExecutionTimeout({
            backend: "linux-vm",
            command: "device_reboot",
            bootTimeoutMs: HYPER_V_MAX_BOOT_TIMEOUT_MS,
            rpcTimeoutMs: 30000,
        })).toEqual({
            rpcTimeoutMs: HYPER_V_HOST_LOCK_WAIT_MS + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS + HYPER_V_MAX_BOOT_TIMEOUT_MS + HYPER_V_LINUX_GUI_TIMEOUT_MS + HYPER_V_CLEANUP_RESERVE_MS + HYPER_V_LIFECYCLE_RPC_BUFFER_MS,
        });
        expect(brokerLifecycleExecutionTimeout({
            backend: "windows-vm",
            command: "device_start",
            bootTimeoutMs: Number.MAX_SAFE_INTEGER,
        })).toEqual({
            rpcTimeoutMs: HYPER_V_HOST_LOCK_WAIT_MS + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS + HYPER_V_MAX_BOOT_TIMEOUT_MS + HYPER_V_CLEANUP_RESERVE_MS + HYPER_V_LIFECYCLE_RPC_BUFFER_MS,
        });
        expect(brokerLifecycleExecutionTimeout({
            backend: "linux-vm",
            command: "device_reboot",
            rpcTimeoutMs: Number.MAX_SAFE_INTEGER,
        })).toEqual({
            rpcTimeoutMs: HYPER_V_HOST_LOCK_WAIT_MS + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS + (5 * 60 * 1000) + HYPER_V_LINUX_GUI_TIMEOUT_MS + HYPER_V_CLEANUP_RESERVE_MS + HYPER_V_LIFECYCLE_RPC_BUFFER_MS,
        });
        // The client still computes a no-boot timeout for this shape, but the broker refuses the
        // request at validation, so the path is unreachable end to end. Kept as a pin on the
        // client's arithmetic, labelled so it is not read as evidence the request is live —
        // src/__tests__/device-lab-broker.commands.test.ts is where the refusal is asserted.
        expect(brokerLifecycleExecutionTimeout({
            backend: "windows-vm",
            command: "device_start",
            waitForBoot: false,
            timeoutMs: 30000,
        })).toEqual({
            rpcTimeoutMs: HYPER_V_HOST_LOCK_WAIT_MS + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS + HYPER_V_LIFECYCLE_RPC_BUFFER_MS,
        });
        expect(brokerLifecycleExecutionTimeout({ backend: "windows-vm", command: "device_stop" })).toEqual({
            rpcTimeoutMs: HYPER_V_HOST_LOCK_WAIT_MS + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS + HYPER_V_LIFECYCLE_RPC_BUFFER_MS,
        });
    });

    it("caps host broker child deadlines independently of the MCP server", () => {
        expect(DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS).toBe(MAX_DEVICE_HELPER_TIMEOUT_MS);
        expect(DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS).toBe(MAX_DEVICE_OPERATION_TIMEOUT_MS);
        expect(DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS).toBe(HYPER_V_MAX_BOOT_TIMEOUT_MS);
        expect(deviceBrokerBackendToolTimeoutMs("device_exec", { helperTimeoutMs: Number.MAX_SAFE_INTEGER })).toBe(DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS + 15000);
        expect(deviceBrokerBackendToolTimeoutMs("mobile_wait_for_app", { timeoutMs: Number.MAX_SAFE_INTEGER })).toBe(DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS + 15000);
        expect(deviceBrokerBackendToolTimeoutMs("device_exec", { timeoutMs: Number.MAX_SAFE_INTEGER })).toBe(30000);
        expect(deviceBrokerBackendToolTimeoutMs("device_exec", { helperTimeoutMs: -1 })).toBe(30000);
    });

    it("composes the Hyper-V create deadline from every bounded phase", () => {
        expect(DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS).toBe(
            DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS
            + DEVICE_BROKER_HYPER_V_IMAGE_LOCK_WAIT_MS
            + DEVICE_BROKER_HYPER_V_IMAGE_ACQUIRE_TIMEOUT_MS
            + DEVICE_BROKER_HYPER_V_CREATE_POST_ACQUIRE_BUDGET_MS,
        );
        expect(DEVICE_BROKER_HYPER_V_CREATE_POST_ACQUIRE_BUDGET_MS).toBeGreaterThan(60 * 60 * 1000);
        expect(DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    });

    it("caps direct Windows helper polling independently of routing", () => {
        expect(WINDOWS_SANDBOX_HELPER_MAX_TIMEOUT_MS).toBe(MAX_DEVICE_HELPER_TIMEOUT_MS);
        expect(windowsSandboxHelperTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(WINDOWS_SANDBOX_HELPER_MAX_TIMEOUT_MS);
        expect(windowsSandboxHelperTimeoutMs(0)).toBe(WINDOWS_SANDBOX_HELPER_TIMEOUT_MS);
        expect(windowsSandboxHelperTimeoutMs(0.5)).toBe(1);
    });
});
