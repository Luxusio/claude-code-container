import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ handlers: [] as any[], calls: [] as any[], rpc: [] as string[], broken: false }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: unknown) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
function response(name: string, args: any) {
    fixture.calls.push({ name, args });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, device: { id: args.deviceId || "new" }, entries: [], stdout: "", status: 0 }) }] };
}
vi.mock("@ccc/device-lab/providers/backends/android.mjs", async original => ({
    ...await original<Record<string, unknown>>(), listAndroidDevices: () => [{ id: "phone", backend: "android-emulator" }],
    handleAndroidTool: (name: string, args: any) => args.deviceId === "phone" ? response(name, args) : null,
}));
vi.mock("@ccc/device-lab/providers/backends/ios-simulator.mjs", async original => ({
    ...await original<Record<string, unknown>>(), listIosDevices: () => [{ id: "ios", backend: "ios-simulator" }],
    handleIosTool: (name: string, args: any) => args.deviceId === "ios" ? response(name, args) : null,
}));
vi.mock("@ccc/device-lab/providers/backends/linux-vm.mjs", async original => ({
    ...await original<Record<string, unknown>>(), handleLinuxVmManagementTool: () => null, handleLinuxVmTool: () => null,
}));
vi.mock("../../device-lab-mcp/src/broker.mjs", async original => {
    const actual = await original<Record<string, any>>();
    const observe = async (method: string) => {
        fixture.rpc.push(method);
        const receipt = fixture.broken ? { ok: false, error: "broker-unavailable" } : { ok: true, result: { backends: [
            { name: "android-emulator", stateKey: "android", status: "available", devices: [{ id: "phone", backend: "android-emulator" }] },
            { name: "ios-simulator", stateKey: "ios", status: "unavailable", devices: [{ id: "ios", backend: "ios-simulator" }] },
        ] } };
        return { ...actual.brokerObservation(receipt), backends: receipt.result?.backends ?? null, devices: null, payloadReceipt: receipt.result };
    };
    return {
        ...actual, implicitBrokerProbeOptions: () => ({}),
        observeBrokerStatus: async () => ({ ok: true, available: true, receipt: { available: true } }),
        observeBrokerBackends: () => observe("broker.backends"),
        observeBrokerInventory: () => observe("broker.inventory"),
        brokerDeviceTool: async (args: any) => ({ ok: true, result: { mcpResult: response(args.tool, args) } }),
    };
});
import { startServer } from "../../device-lab-mcp/src/server.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { normalizePublicToolArgs, toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { validateDeviceLabToolOutput } from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";

const call = (name: string, args: any = {}) => fixture.handlers[1]({ params: { name, arguments: args } });
const parse = (result: any) => JSON.parse(result.content[0].text);
beforeAll(() => startServer());
beforeEach(() => { fixture.calls = []; fixture.rpc = []; fixture.broken = false; });

describe("simplified public Device Lab API", () => {
    it("lists owned IDs in one inventory call and supports filtering without another probe", async () => {
        const result = await call("devices", { backend: "android-emulator" });
        expect(parse(result)).toEqual([expect.objectContaining({ deviceId: "phone" })]);
        expect(fixture.rpc).toEqual(["broker.inventory"]);
        expect(validateDeviceLabToolOutput("devices", parse(result))).toEqual(parse(result));
    });
    it("exposes prerequisite and candidate views explicitly", async () => {
        const backends = await call("devices", { view: "backends", backend: "ios-simulator" });
        expect(parse(backends).backends).toEqual([expect.objectContaining({ name: "ios-simulator" })]);
        expect(fixture.rpc).toEqual(["broker.backends"]);
        const available = await call("devices", { view: "available" });
        expect(available.isError).not.toBe(true);
        expect(parse(available).backends).toHaveLength(8);
        await call("devices", { view: "available", backend: "android-emulator" });
        expect(fixture.calls.at(-1)).toMatchObject({ name: "device_inventory", args: { backend: "android-emulator" } });
    });
    it("does not convert broker failure into an empty successful list", async () => {
        fixture.broken = true;
        const result = await call("devices");
        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe("broker-unavailable");
    });
    it("uses the same devices view in a flow", async () => {
        const result = await call("run_flow", { steps: [{ tool: "devices" }] });
        expect(result.isError).not.toBe(true);
        expect(fixture.rpc).toEqual(["broker.inventory"]);
    });
    it.each(["phone", "ios"])("normalizes app identity for direct and flow operations on %s", async deviceId => {
        const direct = { deviceId, implicitBroker: false, appId: "com.example.app" };
        expect((await call("stop_app", direct)).isError).not.toBe(true);
        expect(fixture.calls.at(-1)?.args).toMatchObject({ packageName: "com.example.app", bundleId: "com.example.app" });
        expect(fixture.calls.at(-1)?.args).not.toHaveProperty("appId");
        const flow = await call("run_flow", { deviceId, steps: [{ tool: "permission", arguments: { implicitBroker: false, appId: "com.example.app", permission: "camera", action: "grant" } }] });
        expect(flow.isError).not.toBe(true);
        expect(fixture.calls.at(-1)?.args).toMatchObject({ permission: "camera", service: "camera" });
    });
    it.each([
        ["stop_app", { packageName: "legacy" }], ["stop_app", { bundleId: "legacy" }],
        ["launch_app", { appId: "app", component: "app/.Main" }], ["stop_app", { appId: "" }],
        ["permission", { appId: "app", action: "grant", service: "camera" }],
        ["set_network", { airplaneMode: "true", confirmDestructive: true }],
        ["set_network", {}],
    ])("rejects invalid %s before execution", async (name, args) => {
        expect((await call(name as string, { deviceId: "phone", implicitBroker: false, ...args as object })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
        expect(fixture.rpc).toEqual([]);
    });
    it.each(["broker", "viaBroker"])("routes explicit %s network control through the checked provider", async route => {
        const result = await call("set_network", { deviceId: "phone", [route]: true, airplaneMode: false, wifi: true, confirmDestructive: true });
        expect(result.isError).not.toBe(true);
        expect(fixture.calls.at(-1)).toMatchObject({ name: "mobile_set_network", args: { backend: "android-emulator", airplaneMode: false, wifi: true } });
        expect(fixture.rpc).toEqual(["broker.inventory"]);
    });
    it("retains network consent for the merged option", async () => {
        expect((await call("set_network", { deviceId: "phone", airplaneMode: false })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
        expect((await call("set_network", { deviceId: "phone", airplaneMode: false, confirmDestructive: true })).isError).not.toBe(true);
        expect(fixture.calls.at(-1)).toMatchObject({ name: "mobile_set_network", args: { airplaneMode: false } });
    });
    it("keeps file container identity and clone sources explicit", () => {
        expect(normalizePublicToolArgs("upload", { deviceId: "ios", appId: "app", localPath: "in", remotePath: "out" })).toMatchObject({ bundleId: "app" });
        expect(toolInputError("create_macos_vm", { name: "copy", image: "base", sourceDeviceId: "source" })).toBeTruthy();
        expect(normalizePublicToolArgs("create_macos_vm", { name: "copy", image: "base", ssh: { user: "custom" } })).toMatchObject({ image: "base", sshUser: "custom" });
        expect(normalizePublicToolArgs("create_macos_vm", { name: "copy", sourceDeviceId: "source" })).toMatchObject({ sourceDeviceId: "source" });
    });
    it("preserves optional custom guest setup without exposing fixed Windows provider", () => {
        const args = { name: "vm", provider: "container-qemu", baseImageId: "base", ssh: { host: "localhost", user: "ccc", port: 2222 }, agent: { healthCommand: "true", autoProvision: false } };
        expect(toolInputError("create_linux_vm", args)).toBeNull();
        expect(normalizePublicToolArgs("create_linux_vm", args)).toMatchObject({ guestSshHost: "localhost", guestSshUser: "ccc", guestSshPort: 2222, guestAgentHealthCommand: "true", guestAgentAutoProvision: false });
        expect(normalizePublicToolArgs("create_windows_vm", { name: "vm" })).toMatchObject({ provider: "hyper-v" });
        expect(toolInputError("create_windows_vm", { name: "vm", provider: "hyper-v" })).toBeTruthy();
        for (const bad of [{ ssh: { host: "localhost" } }, { ssh: { host: "host", user: "ccc", other: true } }, { guestSshHost: "legacy" }, { agent: { healthCommand: "true" } }]) {
            expect(toolInputError("create_linux_vm", { name: "vm", ...bad })).toBeTruthy();
        }
    });
    it("advertises the reduced unique catalog without removed aliases", () => {
        const names = TOOLS.map(tool => tool.name);
        expect(names).toHaveLength(59);
        expect(new Set(names).size).toBe(59);
        for (const name of ["list_devices", "inventory", "backends", "base_image_create", "base_image_clone", "image_list", "image_import", "toggle_airplane_mode"]) {
            expect(names).not.toContain(name);
            expect(toolInputError(name, {})).toContain("Unknown tool");
        }
    });
});
