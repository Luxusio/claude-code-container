import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
    handlers: [] as Array<(request: any) => Promise<any>>,
    calls: [] as Array<{ name: string; args: any }>,
    inventory: [] as any[],
    android: [{ id: "phone" }] as any[],
    desktop: [{ id: "desktop" }] as any[],
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: any, handler: any) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@ccc/device-lab/providers/backends/android.mjs", async (original) => ({
    ...await original<Record<string, unknown>>(),
    listAndroidDevices: () => fixture.android,
    handleAndroidTool: async (name: string, args: any) => {
        if (args.deviceId !== "phone") return null;
        fixture.calls.push({ name, args });
        return { content: [{ type: "text", text: '{"ok":true}' }] };
    },
}));
vi.mock("@ccc/device-lab/providers/backends/windows-sandbox.mjs", async (original) => ({
    ...await original<Record<string, unknown>>(),
    listWindowsDevices: () => fixture.desktop,
    handleWindowsTool: async (name: string, args: any) => {
        if (args.deviceId !== "desktop") return null;
        fixture.calls.push({ name, args });
        return { content: [{ type: "text", text: '{"ok":true}' }] };
    },
}));
vi.mock("@ccc/device-lab/providers/display/x11.mjs", async (original) => ({
    ...await original<Record<string, unknown>>(),
    handleDisplayTool: async (name: string, args: any) => {
        fixture.calls.push({ name, args });
        return { content: [{ type: "text", text: '{"ok":true}' }] };
    },
}));
vi.mock("@ccc/device-lab/providers/backends/linux-vm.mjs", async (original) => ({
    ...await original<Record<string, unknown>>(),
    handleLinuxVmManagementTool: async () => null, handleLinuxVmTool: async () => null,
}));
vi.mock("../../device-lab-mcp/src/broker.mjs", async (original) => ({
    ...await original<Record<string, unknown>>(),
    implicitBrokerProbeOptions: () => ({}),
    observeBrokerInventory: async () => ({ ok: true, backends: fixture.inventory, receipt: { ok: true, result: { backends: fixture.inventory } } }),
    invokeBrokerLifecycle: async (args: any) => {
        fixture.calls.push({ name: args.command, args });
        return { ok: true, receipt: { ok: true, result: { ok: true, device: { id: args.deviceId, backend: args.backend } } } };
    },
    ensureMobileSession: async () => ({ ok: true, receipt: { ok: true } }),
    executeMobileEffect: async (args: any, effect: { kind: string }) => {
        const operations: Record<string, string> = { tap: "mobile_tap", "double-tap": "mobile_double_tap", "type-text": "mobile_type_text", "send-key": "mobile_key" };
        fixture.calls.push({ name: operations[effect.kind] || effect.kind, args });
        return { kind: "completed", receipt: { ok: true } };
    },
    brokerDeviceTool: async (args: any) => {
        fixture.calls.push({ name: args.tool, args });
        return { ok: true, result: { mcpResult: { content: [{ type: "text", text: '{"ok":true}' }] } } };
    },
}));
import { startServer } from "../../device-lab-mcp/src/server.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { TOOLS as OPERATIONS } from "../../device-lab-mcp/src/operation-tools.mjs";
const call = (name: string, args: any = {}) => fixture.handlers[1]({ params: { name, arguments: args } });
beforeAll(() => startServer());
beforeEach(() => {
    fixture.calls.length = 0;
    fixture.android = [{ id: "phone" }]; fixture.desktop = [{ id: "desktop" }];
    fixture.inventory = [{ stateKey: "android", devices: [{ id: "remote-phone" }] }, { stateKey: "windows-vm", devices: [{ id: "remote-desktop" }] }];
});

describe("unprefixed unified actions", () => {
    it("advertises one unique catalog with no platform prefix", async () => {
        expect((await fixture.handlers[0]({})).tools).toEqual(TOOLS);
        expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(TOOLS.length);
        expect(TOOLS.some((tool) => /^(device|mobile|display)_/.test(tool.name))).toBe(false);
    });
    it.each(TOOLS.filter((tool) => tool.inputSchema.required?.includes("deviceId") || tool.name === "run_flow"))(
        "$name routes by deviceId without a public backend selector", async (tool) => {
            expect(tool.inputSchema.properties).not.toHaveProperty("backend");
            const result = await call(tool.name, { deviceId: "phone", backend: "android-emulator" });
            expect(result.isError).toBe(true);
            expect(JSON.stringify(result)).toContain("omit backend");
            expect(fixture.calls).toEqual([]);
        });
    it.each(OPERATIONS.map((tool) => tool.name))("rejects old public name %s before operations", async (name) => {
        expect((await call(name, { deviceId: "phone", x: 1, y: 2 })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
    });
    it.each([
        ["click", "mobile_tap", "device_click", { x: 1, y: 2 }],
        ["click", "mobile_double_tap", "device_double_click", { count: 2, x: 1, y: 2 }],
        ["type", "mobile_type_text", "device_type", { text: "hello" }],
        ["key", "mobile_key", "device_key", { key: "Enter" }],
    ] as const)("routes %s by device for both direct and broker calls", async (name, mobile, desktop, args) => {
        for (const [deviceId, expected, route] of [
            ["phone", mobile, { implicitBroker: false }], ["desktop", desktop, { implicitBroker: false }],
            ["remote-phone", mobile, {}], ["remote-desktop", desktop, {}],
        ] as const) {
            const response = await call(name, { deviceId, ...args, ...route });
            expect(response.content).toEqual([{ type: "text", text: "ok" }]);
            expect(fixture.calls.at(-1)?.name).toBe(expected);
        }
    });
    it("supports current display through the same click and move tools", async () => {
        for (const name of ["click", "move"]) {
            const result = await call(name, { deviceId: "x11-current-display", x: 1, y: 2 });
            expect(result.content).toEqual([{ type: "text", text: "ok" }]);
            expect(fixture.calls.at(-1)?.name).toBe(`display_${name}`);
        }
    });
    it("resolves host-only lifecycle and explicit Appium targets without local device records", async () => {
        for (const name of ["status", "start"]) {
            const result = await call(name, { deviceId: "remote-desktop", broker: true });
            expect(result.isError).not.toBe(true);
            expect(fixture.calls.at(-1)?.args).toMatchObject({ backend: "windows-vm", deviceId: "remote-desktop" });
        }
        const result = await call("home", { deviceId: "remote-phone", broker: true });
        expect(result.isError).not.toBe(true);
        expect(fixture.calls.at(-1)?.args).toMatchObject({ backend: "android-emulator", deviceId: "remote-phone" });
    });
    it("does not route missing or ambiguous host IDs or desktop IDs to Appium", async () => {
        expect((await call("start", { deviceId: "missing", broker: true })).isError).toBe(true);
        expect((await call("home", { deviceId: "remote-desktop", broker: true })).isError).toBe(true);
        fixture.inventory.push({ stateKey: "ios", devices: [{ id: "remote-phone" }] });
        expect((await call("home", { deviceId: "remote-phone", broker: true })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
    });
    it("rejects unsupported mobile buttons and desktop key codes", async () => {
        expect((await call("click", { deviceId: "phone", x: 1, y: 2, button: "right", implicitBroker: false })).isError).toBe(true);
        expect((await call("key", { deviceId: "desktop", keyCode: 3, implicitBroker: false })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
    });
    it("rejects conflicting backend and ambiguous owner identities", async () => {
        expect((await call("click", { deviceId: "remote-phone", backend: "windows-vm", x: 1, y: 2 })).isError).toBe(true);
        fixture.desktop = [{ id: "phone" }];
        expect((await call("click", { deviceId: "phone", x: 1, y: 2, implicitBroker: false })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
    });
    it("rejects ambiguous direct targets before lifecycle or mobile provider effects", async () => {
        fixture.desktop = [{ id: "phone" }];
        for (const name of ["status", "start", "home", "screenshot"]) {
            const result = await call(name, { deviceId: "phone", implicitBroker: false });
            expect(result.isError).toBe(true);
            expect(JSON.stringify(result)).toContain("ambiguous-device-backend");
        }
        expect(fixture.calls).toEqual([]);
    });
    it("does not let a display backend override another explicit device ID", async () => {
        expect((await call("click", { deviceId: "phone", backend: "x11-current-display", x: 1, y: 2, implicitBroker: false })).isError).toBe(true);
        expect((await call("click", { deviceId: "x11-current-display", backend: "android-emulator", x: 1, y: 2, implicitBroker: false })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
    });
    it("separates cursor query from movement and preserves confirmation", async () => {
        for (const [name, args] of [["move", { x: 1 }], ["cursor_position", { x: 1, y: 2 }], ["set_network", { wifi: false }]] as const) {
            expect((await call(name, { deviceId: "phone", implicitBroker: false, ...args })).isError).toBe(true);
        }
        expect(fixture.calls).toEqual([]);
    });
    it("keeps concurrent calls and flow targets request-local", async () => {
        await Promise.all([call("click", { deviceId: "phone", x: 1, y: 2, implicitBroker: false }), call("click", { deviceId: "desktop", x: 3, y: 4, implicitBroker: false })]);
        expect(fixture.calls.map(({ name, args }) => [name, args.deviceId])).toEqual([["mobile_tap", "phone"], ["device_click", "desktop"]]);
        const result = await call("run_flow", { deviceId: "phone", steps: [{ tool: "click", arguments: { x: 1, y: 2, implicitBroker: false } }, { tool: "click", arguments: { deviceId: "desktop", x: 3, y: 4, implicitBroker: false } }] });
        expect(result.isError).toBe(false);
        expect(fixture.calls.slice(-2).map(({ name }) => name)).toEqual(["mobile_tap", "device_click"]);
    });
});
