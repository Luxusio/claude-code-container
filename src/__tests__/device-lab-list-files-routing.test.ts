import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ handlers: [] as any[], calls: [] as any[], stdout: "", status: 0, duplicate: false, inventoryCalls: 0 }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: unknown) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
function execution(name: string, args: any) {
    fixture.calls.push({ name, args });
    return { content: [{ type: "text", text: JSON.stringify({ stdout: fixture.stdout, stderr: fixture.status ? "permission denied" : "", status: fixture.status }) }] };
}
vi.mock("@ccc/device-lab/providers/backends/android.mjs", async original => ({
    ...await original<Record<string, unknown>>(), listAndroidDevices: () => [{ id: "phone" }],
    handleAndroidTool: (name: string, args: any) => args.deviceId === "phone" ? execution(name, args) : null,
}));
vi.mock("@ccc/device-lab/providers/backends/macos-vm.mjs", async original => ({
    ...await original<Record<string, unknown>>(), listMacosDevices: () => [{ id: "mac" }, ...(fixture.duplicate ? [{ id: "phone" }] : [])],
    handleMacosTool: (name: string, args: any) => args.deviceId === "mac" ? execution(name, args) : null,
}));
vi.mock("@ccc/device-lab/providers/backends/windows-sandbox.mjs", async original => ({
    ...await original<Record<string, unknown>>(), listWindowsDevices: () => [{ id: "sandbox" }],
    handleWindowsTool: (name: string, args: any) => args.deviceId === "sandbox" ? execution(name, args) : null,
}));
vi.mock("@ccc/device-lab/providers/backends/linux-vm.mjs", async original => ({
    ...await original<Record<string, unknown>>(), listLinuxVmDevices: () => [{ id: "qemu", backend: "linux-vm", provider: "container-qemu" }],
    handleLinuxVmManagementTool: () => null,
    handleLinuxVmTool: (name: string, args: any) => args.deviceId === "qemu" && name === "device_exec" ? execution(name, args) : null,
}));
vi.mock("../../device-lab-mcp/src/broker.mjs", async original => ({
    ...await original<Record<string, unknown>>(), implicitBrokerProbeOptions: () => ({}),
    brokerRpc: async () => { fixture.inventoryCalls++; return { ok: true, result: { backends: [{ stateKey: "windows-vm", devices: [{ id: "hv" }] }, { stateKey: "ios-device", devices: [{ id: "iphone" }] }, { stateKey: "linux-vm", devices: [{ id: "hv-linux" }] }] } }; },
    brokerDeviceTool: async (args: any) => ({ ok: true, result: { mcpResult: execution(args.tool, args) } }),
}));
import { startServer } from "../../device-lab-mcp/src/server.mjs";
const call = (args: any) => fixture.handlers[1]({ params: { name: "list_files", arguments: args } });
// Routing consumes provider output; command execution is covered by list-files.test.ts.
const output = ["CCC-LIST-V1", "file", "5", "hello.txt", "END", "0", ""].join("\0");
beforeAll(async () => { await startServer(); });
beforeEach(() => { fixture.calls.length = 0; fixture.stdout = output; fixture.status = 0; fixture.duplicate = false; fixture.inventoryCalls = 0; });
describe("public list_files routing", () => {
    it.each(["phone", "mac", "sandbox", "qemu"])("uses owned %s transport and returns only directory data", async deviceId => {
        if (deviceId === "sandbox") fixture.stdout = JSON.stringify({ entries: [{ name: "hello.txt", type: "file", size: 5 }] });
        const result = await call({ deviceId, path: deviceId === "sandbox" ? "C:\\work" : "/work", implicitBroker: false });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(JSON.parse(result.content[0].text)).toEqual({ entries: [{ name: "hello.txt", type: "file", size: 5 }] });
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0]).toMatchObject({ name: "device_exec", args: { deviceId } });
        expect(fixture.calls[0].args.command).toBeTypeOf("string");
        expect(fixture.inventoryCalls).toBe(0);
    });
    it.each(["hv", "hv-linux"])("preserves %s incarnation through the existing broker exec path", async deviceId => {
        const incarnationId = "a".repeat(32);
        const result = await call({ deviceId, path: deviceId === "hv" ? "C:\\work" : "/work", incarnationId });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0]).toMatchObject({ name: "device_exec", args: { deviceId, incarnationId } });
    });
    it("honors an explicit broker route while implicit routing is disabled", async () => {
        fixture.stdout = JSON.stringify({ entries: [{ name: "hello.txt", type: "file", size: 5 }] });
        const incarnationId = "b".repeat(32);
        const result = await call({ deviceId: "hv", path: "C:\\work", incarnationId, broker: true, implicitBroker: false });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(JSON.parse(result.content[0].text)).toEqual({ entries: [{ name: "hello.txt", type: "file", size: 5 }], incarnationId });
        expect(fixture.calls[0]).toMatchObject({ name: "device_exec", args: { deviceId: "hv", backend: "windows-vm", incarnationId } });
    });
    it("refuses a missing or ambiguous owner target before execution", async () => {
        expect((await call({ deviceId: "absent", path: "/" })).isError).toBe(true);
        fixture.duplicate = true;
        expect((await call({ deviceId: "phone", path: "/", implicitBroker: false })).isError).toBe(true);
        expect(fixture.calls).toHaveLength(0);
    });
    it("reports the missing physical iOS adapter without executing a generic host command", async () => {
        const result = await call({ deviceId: "iphone", path: "Documents", appId: "com.example.test" });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toMatch(/unsupported|not.implemented/);
        expect(fixture.calls).toHaveLength(0);
    });
    it.each([{ path: "a\0b" }, { path: "/", limit: 501 }, { path: "/", backend: "android-emulator" }])("validates inputs before transport: %j", async invalid => {
        expect((await call({ deviceId: "phone", ...invalid })).isError).toBe(true);
        expect(fixture.calls).toHaveLength(0);
        expect(fixture.inventoryCalls).toBe(0);
    });
    it("preserves command failures and rejects malformed successful output", async () => {
        fixture.status = 13;
        let result = await call({ deviceId: "phone", path: "/", implicitBroker: false });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("permission denied");
        fixture.status = 0; fixture.stdout = "not a directory protocol";
        result = await call({ deviceId: "phone", path: "/", implicitBroker: false });
        expect(result.isError).toBe(true);
    });
});
