import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ handlers: [] as any[], calls: [] as any[] }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: unknown) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
function response(name: string, args: any) {
    fixture.calls.push({ name, args });
    const payloads: Record<string, unknown> = {
        device_snapshot_list: { snapshots: [] }, device_snapshot_create: { snapshot: { name: "before" } },
        device_snapshot_restore: { device: { id: "vm" } }, device_snapshot_delete: { deleted: "before" },
        device_record_video_start: { recording: { active: true } }, device_record_video_status: { recording: { active: true } },
        device_record_video_stop: { recording: { active: false }, path: "/recording.mp4" },
        mobile_get_clipboard: { text: "" }, mobile_dump_ui: { source: "<hierarchy/>" },
        device_accessibility_snapshot: { nodes: [{ role: "button", name: "OK" }] },
    };
    return { content: [{ type: "text", text: JSON.stringify(payloads[name] || { ok: true }) }] };
}
vi.mock("@ccc/device-lab/providers/backends/android.mjs", async (original) => ({
    ...await original<Record<string, unknown>>(), listAndroidDevices: () => [{ id: "phone" }],
    handleAndroidTool: (name: string, args: any) => args.deviceId === "phone" ? response(name, args) : null,
}));
vi.mock("@ccc/device-lab/providers/backends/windows-sandbox.mjs", async (original) => ({
    ...await original<Record<string, unknown>>(), listWindowsDevices: () => [{ id: "desktop" }],
    handleWindowsTool: (name: string, args: any) => args.deviceId === "desktop" ? response(name, args) : null,
}));
vi.mock("@ccc/device-lab/providers/backends/linux-vm.mjs", async (original) => ({
    ...await original<Record<string, unknown>>(), handleLinuxVmManagementTool: () => null, handleLinuxVmTool: () => null,
}));
vi.mock("../../device-lab-mcp/src/broker.mjs", async (original) => ({
    ...await original<Record<string, unknown>>(), implicitBrokerProbeOptions: () => ({}),
    observeBrokerInventory: async () => ({ ok: true, backends: [{ stateKey: "windows-vm", devices: [{ id: "vm" }] }], receipt: { ok: true } }),
    brokerDeviceTool: async (args: any) => ({ ok: true, result: { mcpResult: response(args.tool, args) } }),
}));
import { startServer } from "../../device-lab-mcp/src/server.mjs";
import { TOOLS, flowOperationAllowed, toolOperation } from "../../device-lab-mcp/src/tools.mjs";
import { normalizeToolArgs, toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
const call = (name: string, args: any = {}) => fixture.handlers[1]({ params: { name, arguments: args } });
beforeAll(() => startServer());
beforeEach(() => { fixture.calls.length = 0; });

describe("focused management tools", () => {
    it("advertises 59 unique tools without removed preparation or redundant management tools", () => {
        expect(TOOLS).toHaveLength(59);
        expect(new Set(TOOLS.map(t => t.name)).size).toBe(59);
        expect(TOOLS.filter(t => t.name.startsWith("create_")).map(t => t.name).sort()).toEqual([
            "create_android_emulator", "create_ios_simulator", "create_linux_vm",
            "create_macos_vm", "create_windows_sandbox", "create_windows_vm",
        ]);
        for (const old of ["create", "disk_materialize", "session_open", "guest_agent_provision", "readiness_probe", "target_list", "guest_agent_status", "broker_status", "automation_status", "snapshot_list", "record_video_start", "get_clipboard", "dump_ui", "accessibility_snapshot"]) {
            expect(toolInputError(old, {})).toContain("Unknown tool");
        }
    });
    it.each(["constructor", "__proto__", "toString", "unknown", "", null, {}, ["list"], ["restore"], ["start"], ["grant"]].map(action => ({ action })))("rejects invalid action %j before dispatch", async ({ action }) => {
        for (const name of ["snapshot", "record_video", "permission"]) {
            const result = await call(name, { deviceId: "vm", action, snapshotName: "before",
                ...(name === "permission" ? { appId: "app", permission: "camera" } : {}),
            });
            expect(result.isError).toBe(true);
            expect(JSON.stringify(result)).toContain("requires action");
        }
        expect(fixture.calls).toEqual([]);
    });
    it.each(["list", "create", "restore", "delete"])("routes snapshot %s to its exact operation", async (action) => {
        const result = await call("snapshot", { deviceId: "vm", action, ...(action !== "list" ? { snapshotName: "before" } : {}), ...(["restore", "delete"].includes(action) ? { confirmDestructive: true } : {}) });
        expect(result.isError).not.toBe(true);
        expect(fixture.calls.at(-1)?.name).toBe(`device_snapshot_${action}`);
    });
    it.each(["restore", "delete"])("requires confirmation for snapshot %s", async (action) => {
        expect((await call("snapshot", { deviceId: "vm", action, snapshotName: "before" })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
    });
    it.each(["start", "stop", "status"])("preserves recording %s results", async (action) => {
        const result = await call("record_video", { deviceId: "vm", action });
        expect(result.isError).not.toBe(true);
        expect(fixture.calls.at(-1)?.name).toBe(`device_record_video_${action}`);
        expect(result.content[0].text).not.toBe("ok");
        if (action === "stop") expect(JSON.stringify(result)).toContain("/recording.mp4");
    });
    it("distinguishes clipboard read from an empty-string write", async () => {
        const read = await call("clipboard", { deviceId: "phone", implicitBroker: false });
        expect(JSON.parse(read.content[0].text)).toEqual({ text: "" });
        const write = await call("clipboard", { deviceId: "phone", text: "", implicitBroker: false });
        expect(write.content).toEqual([{ type: "text", text: "ok" }]);
        expect(fixture.calls.map(c => c.name)).toEqual(["mobile_get_clipboard", "mobile_set_clipboard"]);
        expect((await call("clipboard", { deviceId: "phone", text: null })).isError).toBe(true);
        expect(fixture.calls).toHaveLength(2);
    });
    it.each(["grant", "revoke"])("routes permission %s and requires an app/permission pair", async (action) => {
        expect((await call("permission", { deviceId: "phone", action, appId: "app" })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
        expect((await call("permission", { deviceId: "phone", action, appId: "app", permission: "camera", implicitBroker: false })).isError).not.toBe(true);
        expect(fixture.calls[0].name).toBe(`mobile_${action}_permission`);
    });
    it("selects mobile or desktop UI from the owned device", async () => {
        for (const [deviceId, operation, content] of [["phone", "mobile_dump_ui", "<hierarchy/>"], ["desktop", "device_accessibility_snapshot", "button"]]) {
            const result = await call("ui", { deviceId, implicitBroker: false });
            expect(result.isError).not.toBe(true);
            expect(fixture.calls.at(-1)?.name).toBe(operation);
            expect(JSON.stringify(result)).toContain(content);
        }
    });
    it("does not expand flow permissions from recording status to start or stop", async () => {
        expect(flowOperationAllowed("record_video", { action: "status" })).toBe(true);
        for (const action of ["start", "stop"]) {
            expect(flowOperationAllowed("record_video", { action })).toBe(false);
            const result = await call("run_flow", { deviceId: "vm", steps: [{ tool: "record_video", arguments: { action } }] });
            expect(result.isError).toBe(true);
        }
        expect(fixture.calls).toEqual([]);
        expect((await call("run_flow", { deviceId: "vm", steps: [{ tool: "record_video", arguments: { action: "status" } }] })).isError).not.toBe(true);
        expect(fixture.calls[0].name).toBe("device_record_video_status");
    });
    it("retains preceding flow observations when later arguments are malformed", async () => {
        const result = await call("run_flow", { deviceId: "vm", steps: [
            { tool: "record_video", arguments: { action: "status" } }, { tool: "clipboard", arguments: null },
        ] });
        expect(result.isError).toBe(true);
        const payload = JSON.parse(result.content[0].text);
        expect(payload.results).toHaveLength(2);
        expect(payload.results[0].isError).toBe(false);
        expect(payload.results[1].isError).toBe(true);
    });
    it("preserves wireless action inputs while removing management discriminators", () => {
        expect(normalizeToolArgs({ action: "pair" }, "device_wireless")).toHaveProperty("action", "pair");
        expect(toolOperation("clipboard", { text: "" })).toBe("mobile_set_clipboard");
    });
});
