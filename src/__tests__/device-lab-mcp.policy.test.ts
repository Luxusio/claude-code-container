import { callInternalBroker } from "./helpers/device-lab-mcp-fixture.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES, evaluateDestructivePolicy } from "../../device-lab-mcp/src/policy/destructive.mjs";
import { TOOLS, publicToolName, toolOperation } from "../../device-lab-mcp/src/tools.mjs";
import { ownerDeviceOperationTools } from "@ccc/device-lab/providers/state/device-operation-policy.mjs";
import {
    cleanupDeviceLabMcpTestContext,
    createDeviceLabMcpTestContext,
    TIMEOUT,
    type DeviceLabMcpTestContext,
} from "./helpers/device-lab-mcp-fixture.js";

const HIDDEN_DESTRUCTIVE_POLICY_TOOLS = new Set([
    "device_broker_shutdown",
    "device_broker_command",
    "device_broker_appium",
]);

function publicPolicyName(name: string): string {
    return name === "mobile_toggle_airplane_mode" ? "set_network" : publicToolName(name);
}

function publicPolicyArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(args).map(([key, value]) => [
        key === "packageName" || key === "bundleId" ? "appId"
            : name === "mobile_toggle_airplane_mode" && key === "enabled" ? "airplaneMode" : key,
        value,
    ]));
}

function textPayload(result: Awaited<ReturnType<DeviceLabMcpTestContext["client"]["callTool"]>>) {
    return (result.content as Array<{ text?: string }>)[0].text ?? "";
}

function jsonPayload(result: Awaited<ReturnType<DeviceLabMcpTestContext["client"]["callTool"]>>) {
    return JSON.parse(textPayload(result));
}

describe("device-lab destructive action policy", () => {
    it("exposes the same owner-scoped GUI contract for both Hyper-V guest backends", () => {
        const guiTools = ["screenshot", "click", "key", "type", "scroll", "cursor_position", "move"];
        for (const backend of ["windows-vm", "linux-vm"]) {
            const ownerOperations = ownerDeviceOperationTools(backend);
            for (const name of guiTools) {
                const tool = TOOLS.find((candidate) => candidate.name === name);
                expect(tool?.inputSchema?.properties).not.toHaveProperty("backend");
                expect(tool?.inputSchema?.required).toContain("deviceId");
                expect(tool?.inputSchema?.properties).not.toHaveProperty("incarnationId");
                expect(ownerOperations).toContain(toolOperation(name));
            }
        }
        const cursor = TOOLS.find((candidate) => candidate.name === "move");
        expect(cursor?.inputSchema?.properties?.x).toEqual(expect.objectContaining({ type: "integer", minimum: 0 }));
        expect(cursor?.inputSchema?.properties?.y).toEqual(expect.objectContaining({ type: "integer", minimum: 0 }));
    });

    let context: DeviceLabMcpTestContext;
    let client: DeviceLabMcpTestContext["client"];

    beforeAll(async () => {
        context = await createDeviceLabMcpTestContext();
        client = context.client;
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupDeviceLabMcpTestContext(context);
    }, TIMEOUT);

    it("classifies direct and broker-routed destructive actions", () => {
        expect(evaluateDestructivePolicy("device_delete", { deviceId: "delete-basic" })).toEqual(expect.objectContaining({
            ok: false,
            actions: ["device-delete"],
            confirmationField: "confirmDestructive",
        }));
        expect(evaluateDestructivePolicy("device_delete", { deleteAvd: true, confirmDestructive: true })).toEqual(expect.objectContaining({
            ok: true,
            destructive: true,
            actions: ["device-delete", "delete-avd"],
        }));
        expect(evaluateDestructivePolicy("device_status", { deviceId: "safe" })).toEqual({
            ok: true,
            destructive: false,
            actions: [],
        });
        expect(evaluateDestructivePolicy("device_broker_appium", {
            action: "request",
            method: "POST",
            path: "/execute/sync",
            body: { script: "mobile: shell", args: [{ command: "pm", args: ["clear", "com.example"] }] },
        })).toEqual(expect.objectContaining({
            ok: false,
            actions: ["app-data-clear"],
        }));
        expect(evaluateDestructivePolicy("device_broker_appium", {
            action: "request",
            method: "POST",
            path: "/execute/sync",
            body: { script: "mobile: shell", args: [{ command: "am", args: ["broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", "true"] }] },
        })).toEqual(expect.objectContaining({
            ok: false,
            actions: ["device-network-change"],
        }));
    });

    it("exposes confirmDestructive in affected tool schemas", { timeout: TIMEOUT }, async () => {
        const result = await client.listTools();
        for (const { name } of DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES) {
            if (HIDDEN_DESTRUCTIVE_POLICY_TOOLS.has(name)) continue;
            const policy = evaluateDestructivePolicy(name, {});
            const examplePolicy = evaluateDestructivePolicy(name, DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES.find((item) => item.name === name)?.args || {});
            expect(policy.destructive || examplePolicy.destructive).toBe(true);
            const tool = result.tools.find((item) => item.name === publicPolicyName(name));
            expect(tool?.inputSchema).toEqual(expect.objectContaining({
                properties: expect.objectContaining({
                    confirmDestructive: expect.objectContaining({ type: "boolean" }),
                }),
            }));
        }
    });

    it("requires and accepts confirmation for every destructive policy schema example", () => {
        for (const { name, args } of DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES) {
            expect(evaluateDestructivePolicy(name, args)).toEqual(expect.objectContaining({
                ok: false,
                destructive: true,
                confirmationField: "confirmDestructive",
            }));
            expect(evaluateDestructivePolicy(name, { ...args, confirmDestructive: true })).toEqual(expect.objectContaining({
                ok: true,
                destructive: true,
            }));
        }
    });

    it("keeps confirmDestructive schemas and destructive policy examples in lockstep", () => {
        const schemaTools = TOOLS
            .filter((tool) => Object.prototype.hasOwnProperty.call(tool.inputSchema?.properties || {}, "confirmDestructive"))
            .map((tool) => tool.name)
            .sort();
        const policyTools = [...new Set(DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES.map(({ name }) => name))]
            .filter((name) => !HIDDEN_DESTRUCTIVE_POLICY_TOOLS.has(name))
            .map(publicPolicyName).filter((name, index, all) => all.indexOf(name) === index).sort();

        expect(schemaTools).toEqual(policyTools);
    });

    it("denies destructive direct tools before backend routing unless confirmed", { timeout: TIMEOUT }, async () => {
        const denied = await client.callTool({
            name: "snapshot",
            arguments: { action: "delete", deviceId: "missing-macos", snapshotName: "before-test" },
        });
        expect(denied.isError).toBe(true);
        expect(jsonPayload(denied)).toEqual(expect.objectContaining({
            ok: false,
            policy: expect.objectContaining({
                error: "destructive-action-confirmation-required",
                confirmationField: "confirmDestructive",
                actions: ["snapshot-delete"],
            }),
        }));

        const confirmed = await client.callTool({
            name: "snapshot",
            arguments: { action: "delete", deviceId: "missing-macos", snapshotName: "before-test", confirmDestructive: true },
        });
        expect(confirmed.isError).toBe(true);
        expect(textPayload(confirmed)).not.toContain("destructive-action-confirmation-required");
    });

    it("rejects removed broker entry points regardless of destructive confirmation", { timeout: TIMEOUT }, async () => {
        for (const name of HIDDEN_DESTRUCTIVE_POLICY_TOOLS) {
            for (const confirmDestructive of [false, true]) {
                const result = await client.callTool({ name, arguments: { confirmDestructive } });
                expect(result.isError).toBe(true);
                expect(jsonPayload(result).error).toBe(`Unknown tool: ${name}`);
            }
        }
    });

    it("does not gate non-destructive status tools", { timeout: TIMEOUT }, async () => {
        const list = await client.callTool({ name: "devices", arguments: {} });
        expect(list.isError).not.toBe(true);
        expect(jsonPayload(list)).toEqual(expect.objectContaining({
            ownerId: expect.any(String),
            devices: expect.any(Array),
        }));

        const brokerPlan = await callInternalBroker(client, { operation: "brokerCommand",
            arguments: {
                action: "plan",
                backend: "windows-sandbox",
                command: "device_delete",
                deviceId: "win-metadata-delete",
                force: true,
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(brokerPlan.isError).toBe(true);
        expect(jsonPayload(brokerPlan)).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-rpc-unavailable",
        }));

        const directDelete = await client.callTool({
            name: "delete",
            arguments: { deviceId: "missing-safe-delete-plan" },
        });
        expect(directDelete.isError).toBe(true);
        expect(jsonPayload(directDelete).policy).toEqual(expect.objectContaining({
            error: "destructive-action-confirmation-required",
            actions: ["device-delete"],
        }));
    });

    it("enforces destructive policy inside device_run_flow steps", { timeout: TIMEOUT }, async () => {
        const denied = await client.callTool({
            name: "run_flow",
            arguments: {
                steps: [
                    {
                        tool: "clear_app_data",
                        arguments: { deviceId: "android-flow-owned", appId: "com.example.flow" },
                    },
                ],
            },
        });
        expect(denied.isError).toBe(true);
        expect(jsonPayload(denied)).toEqual(expect.objectContaining({
            ok: false,
            stoppedAt: 0,
            results: [
                expect.objectContaining({
                    tool: "clear_app_data",
                    isError: true,
                    content: [
                        expect.objectContaining({
                            value: expect.objectContaining({
                                policy: expect.objectContaining({
                                    error: "destructive-action-confirmation-required",
                                    actions: ["app-data-clear"],
                                }),
                            }),
                        }),
                    ],
                }),
            ],
        }));

        const confirmed = await client.callTool({
            name: "run_flow",
            arguments: {
                steps: [
                    {
                        tool: "clear_app_data",
                        arguments: { deviceId: "android-flow-owned", appId: "com.example.flow", confirmDestructive: true },
                    },
                ],
            },
        });
        expect(confirmed.isError).toBe(true);
        const payload = jsonPayload(confirmed);
        expect(payload.ok).toBe(false);
        expect(JSON.stringify(payload)).not.toContain("destructive-action-confirmation-required");
    });

    it("enforces destructive policy for every destructive device_run_flow step", { timeout: TIMEOUT }, async () => {
        const mobileExamples = DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES
            .filter(({ name }) => name.startsWith("mobile_"))
            .map(({ name, args }) => ({ tool: publicPolicyName(name), arguments: { ...publicPolicyArguments(name, args), deviceId: "android-flow-owned" } }));
        const denied = await client.callTool({
            name: "run_flow",
            arguments: {
                stopOnError: false,
                steps: mobileExamples,
            },
        });
        expect(denied.isError).toBe(true);
        const payload = jsonPayload(denied) as { ok: boolean; results: Array<{ tool: string; isError: boolean; content: Array<{ value?: { policy?: { error?: string; confirmationField?: string } } }> }> };
        expect(payload.ok).toBe(false);
        expect(payload.results.map((result) => result.tool)).toEqual(mobileExamples.map((step) => step.tool));
        for (const result of payload.results) {
            expect(result.isError).toBe(true);
            expect(result.content[0].value?.policy).toEqual(expect.objectContaining({
                error: "destructive-action-confirmation-required",
                confirmationField: "confirmDestructive",
            }));
        }
    });
});
