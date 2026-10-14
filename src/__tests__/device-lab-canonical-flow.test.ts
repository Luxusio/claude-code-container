import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Keep public dispatch, normalization, policy and serialization; substitute only
// transport registration and provider results, capturing the arguments they see.
const fixture = vi.hoisted(() => ({
    handlers: [] as Array<(request: any) => Promise<any>>,
    calls: [] as Array<{ name: string; args: Record<string, any>; scope: number }>,
    scope: 0, nextScope: 0,
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../../device-lab-mcp/src/broker.mjs", async (importOriginal) => {
    const actual = await importOriginal<Record<string, any>>();
    return { ...actual, withBrokerOperation: async (fn: () => Promise<any>) => {
        const previous = fixture.scope;
        fixture.scope = ++fixture.nextScope;
        try { return await actual.withBrokerOperation(fn); } finally { fixture.scope = previous; }
    }, brokerAppium: async () => { throw new Error("unexpected inherited broker route"); },
    brokerDeviceTool: async () => { throw new Error("unexpected inherited device broker route"); } };
});
vi.mock("@ccc/device-lab/providers/backends/android.mjs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    listAndroidDevices: () => [{ id: "target-a" }],
    handleAndroidTool: async (name: string, args: Record<string, any>) => {
        fixture.calls.push({ name, args, scope: fixture.scope });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, status: 0, stdout: name === "device_exec" && args.command?.includes("CCC-LIST-V1") ? "CCC-LIST-V1\0END\u00000\0" : "", stderr: "", provider: "fixture" }) }], isError: false };
    },
}));
vi.mock("@ccc/device-lab/providers/backends/linux-vm.mjs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    handleLinuxVmManagementTool: async () => null, handleLinuxVmTool: async () => null,
}));
import { startServer } from "../../device-lab-mcp/src/server.mjs";
import { TOOLS, DEVICE_FLOW_TOOL_NAMES, publicToolName } from "../../device-lab-mcp/src/tools.mjs";

const hidden = ["mobile_install_app", "mobile_launch_app", "mobile_screenshot", "mobile_rotate_left", "mobile_rotate_right", "mobile_run_flow"];
const shared = { deviceId: "target-a" };
const direct = { implicitBroker: false };
const step = (args: Record<string, unknown> = {}, tool = "click") => ({ tool, arguments: { ...direct,
    ...(tool === "click" ? { x: 1, y: 2 } : {}), ...args } });
const call = (name: string, args: Record<string, unknown>) => fixture.handlers[1]({ params: { name, arguments: args } });
const parse = (result: any) => JSON.parse(result.content[0].text);
const flow = (steps: unknown[], args: Record<string, unknown> = {}) => call("run_flow", { ...shared, ...args, steps });
beforeAll(async () => { await startServer(); });
beforeEach(() => { fixture.calls.length = 0; fixture.scope = 0; fixture.nextScope = 0; });

describe("canonical public contract", () => {
    it("advertises only unique unprefixed callable tools", async () => {
        const catalog = await fixture.handlers[0]({});
        expect(catalog.tools).toEqual(TOOLS);
        expect(new Set(TOOLS.map(tool => tool.name)).size).toBe(TOOLS.length);
        expect(TOOLS.every(tool => !/^(device|mobile|display)_/.test(tool.name))).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(catalog.tools))).toBeLessThan(57211);
    });
    it("publishes a finite canonical flow enum, required tool and optional target defaults", () => {
        const schema: any = TOOLS.find((entry: any) => entry.name === "run_flow")!.inputSchema;
        expect(schema.required).toEqual(["steps"]);
        expect(schema.properties.steps).toMatchObject({ minItems: 1, maxItems: 50 });
        expect(schema.properties.steps.items.required).toEqual(["tool"]);
        expect(schema.properties.steps.items.properties).not.toHaveProperty("name");
        expect(schema.properties.steps.items.properties.tool.enum).toEqual(DEVICE_FLOW_TOOL_NAMES);
        expect(new Set(DEVICE_FLOW_TOOL_NAMES).size).toBe(DEVICE_FLOW_TOOL_NAMES.length);
        expect(schema.properties).toHaveProperty("deviceId");
        expect(schema.properties).not.toHaveProperty("incarnationId");
        expect(DEVICE_FLOW_TOOL_NAMES.every(name => TOOLS.some(tool => tool.name === name))).toBe(true);
        for (const name of [...hidden, "start", "exec", "run_flow", "backends"]) expect(DEVICE_FLOW_TOOL_NAMES).not.toContain(name);
    });
    it.each([...hidden, "device_broker_shutdown", "device_broker_rpc", "device_broker_lease", "device_broker_attach", "device_broker_apple", "device_broker_command", "device_broker_appium", "device_image_create", "device_image_clone"])("rejects removed public tool %s before any broker scope or provider", async (name) => {
        const result = await call(name, { ...shared, ...direct, confirmDestructive: true });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(`Unknown tool: ${name}`);
        expect(fixture.calls).toEqual([]);
        expect(fixture.nextScope).toBe(0);
    });
    it.each(["install_app", "launch_app"])("accepts canonical %s standalone and in flows", async (tool) => {
        const args = { deviceId: shared.deviceId, ...direct, ...(tool === "launch_app" ? { appId: "example.app" } : { path: "/fixture/app.apk" }) };
        const directResult = await call(tool, args);
        expect(directResult.isError, JSON.stringify(directResult)).toBe(false);
        expect(parse(await flow([step(args, tool)])).ok).toBe(true);
        expect(fixture.calls.map(entry => publicToolName(entry.name))).toEqual([tool, tool]);
    });
    it.each([{ name: "click" }, { name: "click", tool: "click" }])("rejects legacy step name %j without dispatch", async (item) => {
        const result = parse(await flow([{ ...item, arguments: direct }, step()], { stopOnError: false }));
        expect(result.ok).toBe(false);
        expect(result.results[0].error).toContain("name is not supported");
        expect(result.results[1].isError).toBe(false);
        expect(fixture.calls).toHaveLength(1);
    });
    it.each(DEVICE_FLOW_TOOL_NAMES.filter(name => name !== "move"))("dispatches advertised flow choice %s through the existing handler", async (tool) => {
        const sample = { ...(tool === "record_video" ? { action: "status" } : tool === "permission" ? { action: "grant", permission: "android.permission.CAMERA" } : {}),
            handle: "42", x1: 1, y1: 2, x2: 3, y2: 4, level: 50, key: "HOME", text: "needle", appId: "example.app", path: "/fixture/app.apk", confirmDestructive: true,
            view: "available", backend: "android-emulator", wifi: false };
        const properties = TOOLS.find(entry => entry.name === tool)!.inputSchema.properties;
        const arguments_ = { ...direct, ...Object.fromEntries(Object.entries(sample).filter(([key]) => Object.hasOwn(properties, key))) };
        const result = parse(await flow([{ tool, arguments: arguments_ }]));
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(fixture.calls.map(call => publicToolName(call.name))).toEqual([tool === "list_files" ? "exec" : tool]);
    });
    it.each(["mobile_install_app", "mobile_launch_app", "start", "exec", "backends", "run_flow", "mobile_run_flow", "unknown_action"])("rejects %s in the canonical flow before dispatch", async (name) => {
        const result = parse(await flow([step({}, name)]));
        expect(result).toMatchObject({ ok: false, stoppedAt: 0 });
        expect(result.results[0].error).toContain("does not allow step tool");
        expect(fixture.calls).toEqual([]);
    });
});

describe("shared target selection", () => {
    it("inherits only target fields and starts a fresh broker scope for every step", async () => {
        const input = [step(), step({ deviceId: shared.deviceId })];
        const original = structuredClone(input);
        expect(parse(await flow(input, { viaBroker: true, autolaunch: true, port: 1234 })).ok).toBe(true);
        expect(fixture.calls.map(call => call.args)).toEqual([
            { ...shared, ...direct, x: 1, y: 2 },
            { ...shared, ...direct, x: 1, y: 2 },
        ]);
        expect(fixture.calls[0].scope).toBeGreaterThan(0);
        expect(fixture.calls[0].scope).not.toBe(fixture.calls[1].scope);
        expect(input).toEqual(original);
    });
    it("shares only deviceId across actions with different input schemas", async () => {
        expect(parse(await flow([step({}, "click"), step({}, "home")])).ok).toBe(true);
        expect(fixture.calls[0].args).not.toHaveProperty("incarnationId");
        expect(fixture.calls[1].args).not.toHaveProperty("incarnationId");
    });
    it.each([{ deviceId: "target-b" }])("resets the entire inherited target group on %j", async (override) => {
        expect(parse(await flow([step(override)])).ok).toBe(true);
        expect(fixture.calls[0].args).toEqual({ ...direct, x: 1, y: 2, ...override });
    });
    it.each([{}, null, { deviceId: "target-b", backend: "ios-simulator" }])("rejects nested options %j without forwarding or mutating", async (options) => {
        const result = parse(await flow([step({ options })]));
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).toContain("Use flat tool arguments");
        expect(fixture.calls).toEqual([]);
    });
    it.each([null, "../outside", 42, ""])("preserves invalid explicit deviceId %j for validation", async (deviceId) => {
        const result = parse(await flow([step({ deviceId })]));
        expect(result).toMatchObject({ ok: false, stoppedAt: 0 });
        expect(JSON.stringify(result)).toContain("device-id-invalid");
        expect(fixture.calls).toEqual([]);
    });
    it.each([null, "a".repeat(32)])("rejects explicit obsolete generation %j without provider effects", async incarnationId => {
        expect(parse(await flow([step({ incarnationId })])).ok).toBe(false);
        expect(fixture.calls).toEqual([]);
        expect(parse(await flow([step()], { incarnationId })).ok).toBe(false);
        expect(fixture.calls).toEqual([]);
    });
    it("rejects backend selectors without provider effects", async () => {
        const rejected = parse(await flow([step({ backend: null })]));
        expect(rejected.ok).toBe(false);
        expect(JSON.stringify(rejected)).toContain("omit backend");
        expect(fixture.calls).toEqual([]);
    });
    it.each(["devices"])("does not add target fields to target-neutral %s", async (tool) => {
        expect(parse(await flow([step({ view: "available", backend: "android-emulator" }, tool)])).ok).toBe(true);
        expect(fixture.calls[0].args).toEqual({ ...direct, backend: "android-emulator" });
    });
    it.each([null, [], "bad", 7, false])("rejects explicitly malformed arguments %j before dispatch", async (arguments_) => {
        const result = parse(await flow([{ tool: "click", arguments: arguments_ }, step()], { stopOnError: false }));
        expect(result.ok).toBe(false);
        expect(result.results[0].error).toMatch(/arguments.*object/);
        expect(result.results[1].isError).toBe(false);
        expect(fixture.calls).toHaveLength(1);
    });
});

describe("flow policy and bounds", () => {
    it.each(["uninstall_app", "clear_app_data", "set_battery", "set_network"])("does not inherit confirmation for %s", async (tool) => {
        const args = tool === "set_network" ? { wifi: false, airplaneMode: false }
            : tool === "set_battery" ? { level: 50 } : { appId: "example.app" };
        const denied = parse(await flow([step(args, tool)], { confirmDestructive: true, force: true }));
        expect(denied).toMatchObject({ ok: false, error: "run_flow does not support confirmDestructive" });
        const missingStepConfirmation = parse(await flow([step(args, tool)]));
        expect(JSON.stringify(missingStepConfirmation)).toContain("destructive-action-confirmation-required");
        expect(fixture.calls).toEqual([]);
        const allowed = parse(await flow([step({ ...args, confirmDestructive: true }, tool)]));
        expect(allowed.ok).toBe(true);
        expect(fixture.calls).toHaveLength(1);
    });
    it.each(["run_flow"])("%s rejects empty and oversized flows before dispatch", async (name) => {
        for (const steps of [[], Array.from({ length: 51 }, () => step())]) {
            const result = await call(name, { ...shared, steps });
            expect(result.isError).toBe(true);
            expect(fixture.calls).toEqual([]);
        }
        const valid = parse(await call(name, { ...shared, steps: Array.from({ length: 50 }, () => step()) }));
        expect(valid.ok).toBe(true);
        expect(fixture.calls).toHaveLength(50);
        expect(new Set(fixture.calls.map(call => call.scope)).size).toBe(50);
    });
});
