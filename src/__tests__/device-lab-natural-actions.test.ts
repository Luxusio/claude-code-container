import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ handlers: [] as any[], calls: [] as any[], failure: false }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: unknown) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
function result(name: string, args: any) {
    fixture.calls.push({ name, args });
    const value = fixture.failure ? { ok: false, error: "source-lifecycle-conflict" }
        : name === "device_base_image_clone" ? { device: { id: "clone" }, operation: "base-image-clone" }
        : name === "device_create" ? { device: { id: "created" } }
        : { ok: true, clicked: true, count: name === "mobile_double_tap" ? 2 : 1 };
    return { isError: fixture.failure, content: [{ type: "text", text: JSON.stringify(value) }] };
}
vi.mock("@ccc/device-lab/providers/backends/android.mjs", async original => ({
    ...await original<Record<string, unknown>>(), listAndroidDevices: () => [{ id: "phone", backend: "android-emulator" }],
    handleAndroidTool: (name: string, args: any) => args.deviceId === "phone" ? result(name, args) : null,
}));
vi.mock("@ccc/device-lab/providers/backends/ios-simulator.mjs", async original => ({
    ...await original<Record<string, unknown>>(), handleIosTool: () => null,
}));
vi.mock("@ccc/device-lab/providers/backends/windows-sandbox.mjs", async original => ({
    ...await original<Record<string, unknown>>(), handleWindowsTool: () => null,
}));
vi.mock("@ccc/device-lab/providers/backends/macos-vm.mjs", async original => ({
    ...await original<Record<string, unknown>>(), listMacosDevices: () => [],
    handleMacosTool: (name: string, args: any) => args.backend === "macos-vm" ? result(name, args) : null,
}));
vi.mock("@ccc/device-lab/providers/backends/linux-vm.mjs", async original => ({
    ...await original<Record<string, unknown>>(), handleLinuxVmManagementTool: () => null, handleLinuxVmTool: () => null,
}));
vi.mock("../../device-lab-mcp/src/broker.mjs", async original => ({
    ...await original<Record<string, unknown>>(), implicitBrokerProbeOptions: () => null,
}));
import { startServer } from "../../device-lab-mcp/src/server.mjs";
import { TOOLS, publicToolName } from "../../device-lab-mcp/src/tools.mjs";
import { validateDeviceLabToolOutput } from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
const call = (name: string, args: any = {}) => fixture.handlers[1]({ params: { name, arguments: { implicitBroker: false, ...args } } });
const parse = (response: any) => JSON.parse(response.content[0].text);
beforeAll(() => startServer());
beforeEach(() => { fixture.calls = []; fixture.failure = false; });

describe("natural action variants", () => {
    it("keeps mobile drag routed to the mobile handler", async () => {
        const response = await call("drag", { deviceId: "phone", x1: 0, y1: 0, x2: 20, y2: 30 });
        expect(response.isError).not.toBe(true);
        expect(fixture.calls[0].name).toBe("mobile_drag");
    });
    it.each([undefined, 1, 2])("dispatches click count %s without leaking the selector", async count => {
        const response = await call("click", { deviceId: "phone", x: 10, y: 20, ...(count === undefined ? {} : { count }) });
        expect(response.isError).not.toBe(true);
        expect(response.content[0].text).toBe("ok");
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0].name).toBe(count === 2 ? "mobile_double_tap" : "mobile_tap");
        expect(fixture.calls[0].args).not.toHaveProperty("count");
    });
    it.each([null, "2", true, 0, 3, 1.5, {}, []])("rejects count %j before execution", async count => {
        expect((await call("click", { deviceId: "phone", x: 1, y: 2, count })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
    });
    it("preserves count2 in flows and retains diagnostic output", async () => {
        const response = await call("run_flow", { deviceId: "phone", detail: true, steps: [
            { tool: "click", arguments: { count: 2, x: 1, y: 2, implicitBroker: false } },
        ] });
        expect(response.isError).not.toBe(true);
        expect(fixture.calls[0].name).toBe("mobile_double_tap");
        expect(fixture.calls[0].args).not.toHaveProperty("count");
        const direct = await call("click", { deviceId: "phone", x: 1, y: 2, count: 2, detail: true });
        expect(parse(direct)).toMatchObject({ clicked: true, count: 2 });
        expect(validateDeviceLabToolOutput("click", parse(direct), { count: 2 })).toEqual(parse(direct));
    });
    it("routes image creation and owned-source cloning to their existing handlers", async () => {
        const created = await call("create_macos_vm", { name: "new", image: "image", detail: true });
        expect(created.isError).not.toBe(true);
        expect(fixture.calls.at(-1)).toMatchObject({ name: "device_create", args: { backend: "macos-vm", image: "image" } });
        const cloned = await call("create_macos_vm", { name: "clone", sourceDeviceId: "owned", force: true, ssh: { user: "me", password: "secret" }, detail: true });
        expect(cloned.isError).not.toBe(true);
        expect(fixture.calls.at(-1)).toMatchObject({ name: "device_base_image_clone", args: { backend: "macos-vm", sourceDeviceId: "owned", force: true, sshUser: "me", sshPassword: "secret" } });
        expect(fixture.calls.at(-1).args).not.toHaveProperty("ssh");
        expect(fixture.calls.at(-1).args).not.toHaveProperty("deviceId");
        expect(validateDeviceLabToolOutput("create_macos_vm", parse(cloned), { sourceDeviceId: "owned" })).toEqual(parse(cloned));
    });
    it.each([
        { deviceId: "chosen-id", image: "image" }, { deviceId: "chosen-id", sourceDeviceId: "source", force: true },
        { sourceDeviceId: "source", image: "image" }, { sourceDeviceId: "source", provider: "tart" },
        { sourceDeviceId: "source", memoryMb: 4096 }, { sourceDeviceId: "source", cpus: 2 },
        { sourceDeviceId: "source", headless: false }, { force: false }, { sourceDeviceId: "../other" },
        { sourceDeviceId: "" }, { sourceDeviceId: null }, { sourceDeviceId: "source", force: "true" },
        { sourceDeviceId: "source", ssh: { unknown: true } },
    ])("rejects conflicting or malformed clone input %j", async args => {
        expect((await call("create_macos_vm", { name: "new", ...args })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
    });
    it("preserves failures from the checked source clone handler", async () => {
        fixture.failure = true;
        const response = await call("create_macos_vm", { name: "new", sourceDeviceId: "source" });
        expect(response.isError).toBe(true);
        expect(parse(response).error).toBe("source-lifecycle-conflict");
        expect(fixture.calls[0].name).toBe("device_base_image_clone");
    });
    it("keeps59 unique tools and rejects retired names in direct calls and flows", async () => {
        const names = TOOLS.map(t => t.name);
        expect(names).toHaveLength(59);
        expect(new Set(names).size).toBe(59);
        for (const name of ["long_press", "home", "back", "forward", "recents", "list_images", "import_image"]) expect(names).toContain(name);
        for (const name of ["double_click", "clone_macos_vm"]) {
            expect(names).not.toContain(name);
            expect((await call(name, {})).isError).toBe(true);
            expect((await call("run_flow", { steps: [{ tool: name, arguments: {} }] })).isError).toBe(true);
        }
        expect(fixture.calls).toEqual([]);
        expect(publicToolName("display_double_click")).toBe("click");
    });
});
