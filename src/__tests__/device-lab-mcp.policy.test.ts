import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES, evaluateDestructivePolicy } from "../../device-lab-mcp/src/policy/destructive.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
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

function textPayload(result: Awaited<ReturnType<DeviceLabMcpTestContext["client"]["callTool"]>>) {
    return (result.content as Array<{ text?: string }>)[0].text ?? "";
}

function jsonPayload(result: Awaited<ReturnType<DeviceLabMcpTestContext["client"]["callTool"]>>) {
    return JSON.parse(textPayload(result));
}

describe("device-lab destructive action policy", () => {
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
            const tool = result.tools.find((item) => item.name === name);
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
            .sort();

        expect(schemaTools).toEqual(policyTools);
    });

    it("denies destructive direct tools before backend routing unless confirmed", { timeout: TIMEOUT }, async () => {
        const denied = await client.callTool({
            name: "device_snapshot_delete",
            arguments: { deviceId: "missing-macos", snapshotName: "before-test" },
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
            name: "device_snapshot_delete",
            arguments: { deviceId: "missing-macos", snapshotName: "before-test", confirmDestructive: true },
        });
        expect(confirmed.isError).toBe(true);
        expect(textPayload(confirmed)).not.toContain("destructive-action-confirmation-required");
    });

    it("denies destructive broker calls before broker routing unless confirmed", { timeout: TIMEOUT }, async () => {
        const deniedCommand = await client.callTool({
            name: "device_broker_command",
            arguments: {
                action: "invoke",
                backend: "windows-sandbox",
                command: "device_delete",
                deviceId: "win-force-delete",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(deniedCommand.isError).toBe(true);
        expect(jsonPayload(deniedCommand).policy).toEqual(expect.objectContaining({
            error: "destructive-action-confirmation-required",
            actions: ["broker-device-delete"],
        }));

        const confirmedCommand = await client.callTool({
            name: "device_broker_command",
            arguments: {
                action: "invoke",
                backend: "windows-sandbox",
                command: "device_delete",
                deviceId: "win-force-delete",
                confirmDestructive: true,
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(confirmedCommand.isError).not.toBe(true);
        expect(jsonPayload(confirmedCommand)).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-rpc-unavailable",
        }));

        const deniedAppium = await client.callTool({
            name: "device_broker_appium",
            arguments: {
                action: "request",
                backend: "android-emulator",
                deviceId: "android-owned",
                method: "POST",
                path: "/appium/device/remove_app",
                body: { appId: "com.example" },
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(deniedAppium.isError).toBe(true);
        expect(jsonPayload(deniedAppium).policy).toEqual(expect.objectContaining({
            error: "destructive-action-confirmation-required",
            actions: ["app-uninstall"],
        }));

        const confirmedAppium = await client.callTool({
            name: "device_broker_appium",
            arguments: {
                action: "request",
                backend: "android-emulator",
                deviceId: "android-owned",
                method: "POST",
                path: "/appium/device/remove_app",
                body: { appId: "com.example" },
                confirmDestructive: true,
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(confirmedAppium.isError).not.toBe(true);
        expect(jsonPayload(confirmedAppium)).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-rpc-unavailable",
        }));
    });

    it("does not gate non-destructive status tools", { timeout: TIMEOUT }, async () => {
        const list = await client.callTool({ name: "device_list", arguments: {} });
        expect(list.isError).not.toBe(true);
        expect(jsonPayload(list)).toEqual(expect.objectContaining({
            ownerId: expect.any(String),
            devices: expect.any(Array),
        }));

        const brokerPlan = await client.callTool({
            name: "device_broker_command",
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
        expect(brokerPlan.isError).not.toBe(true);
        expect(jsonPayload(brokerPlan)).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-rpc-unavailable",
        }));

        const directDelete = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "missing-safe-delete-plan" },
        });
        expect(directDelete.isError).toBe(true);
        expect(jsonPayload(directDelete).policy).toEqual(expect.objectContaining({
            error: "destructive-action-confirmation-required",
            actions: ["device-delete"],
        }));
    });

    it("enforces destructive policy inside mobile_run_flow steps", { timeout: TIMEOUT }, async () => {
        const denied = await client.callTool({
            name: "mobile_run_flow",
            arguments: {
                steps: [
                    {
                        tool: "mobile_clear_app_data",
                        arguments: { deviceId: "android-flow-owned", packageName: "com.example.flow" },
                    },
                ],
            },
        });
        expect(denied.isError).not.toBe(true);
        expect(jsonPayload(denied)).toEqual(expect.objectContaining({
            ok: false,
            stoppedAt: 0,
            results: [
                expect.objectContaining({
                    tool: "mobile_clear_app_data",
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
            name: "mobile_run_flow",
            arguments: {
                steps: [
                    {
                        tool: "mobile_clear_app_data",
                        arguments: { deviceId: "android-flow-owned", packageName: "com.example.flow", confirmDestructive: true },
                    },
                ],
            },
        });
        expect(confirmed.isError).not.toBe(true);
        const payload = jsonPayload(confirmed);
        expect(payload.ok).toBe(false);
        expect(JSON.stringify(payload)).not.toContain("destructive-action-confirmation-required");
    });

    it("enforces destructive policy for every destructive mobile_run_flow step", { timeout: TIMEOUT }, async () => {
        const mobileExamples = DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES
            .filter(({ name }) => name.startsWith("mobile_"))
            .map(({ name, args }) => ({ tool: name, arguments: { deviceId: "android-flow-owned", ...args } }));
        const denied = await client.callTool({
            name: "mobile_run_flow",
            arguments: {
                stopOnError: false,
                steps: mobileExamples,
            },
        });
        expect(denied.isError).not.toBe(true);
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
