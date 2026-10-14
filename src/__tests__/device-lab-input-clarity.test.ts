import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext } from "./helpers/device-lab-mcp-fixture.js";

// Exercise actual server normalization and dispatch, observing the provider boundary.
const fixture = vi.hoisted(() => ({ handlers: [] as any[], calls: [] as Array<{ provider: string; name: string; args: any }> }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: any) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@ccc/device-lab/providers/backends/linux-vm.mjs", async (original) => ({
    ...await original<Record<string, any>>(),
    handleLinuxVmManagementTool: async (name: string, args: any) => {
        fixture.calls.push({ provider: "linux-management", name, args });
        return name.startsWith("device_image_") ? { content: [{ type: "text", text: '{"ok":true,"images":[]}' }] } : undefined;
    },
    handleLinuxVmTool: async (name: string, args: any) => {
        fixture.calls.push({ provider: "linux", name, args });
        return args.backend === "linux-vm" ? { content: [{ type: "text", text: '{"ok":true}' }] } : undefined;
    },
}));
vi.mock("@ccc/device-lab/providers/backends/macos-vm.mjs", async (original) => ({
    ...await original<Record<string, any>>(),
    handleMacosTool: async (name: string, args: any) => {
        fixture.calls.push({ provider: "macos", name, args });
        return { content: [{ type: "text", text: '{"ok":true}' }] };
    },
}));
vi.mock("../../device-lab-mcp/src/broker.mjs", async (original) => ({
    ...await original<Record<string, any>>(),
    brokerDeviceTool: async () => { throw new Error("single-backend action reached host broker"); },
}));
import { startServer } from "../../device-lab-mcp/src/server.mjs";
import { TOOLS, SINGLE_BACKEND_TOOL_DEFAULTS } from "../../device-lab-mcp/src/tools.mjs";
import { normalizeToolArgs, flowStepArguments } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { createLab, ownerId } from "@ccc/device-lab/providers/backends/linux-vm.mjs";

const defaults = {
    list_images: "linux-vm", import_image: "linux-vm",
};
const entries = Object.entries(defaults);
const ownedActions = ["workspace_sync", "artifacts_export"];
const parse = (result: any) => JSON.parse(result.content[0].text);
const call = (name: string, args: any) => fixture.handlers[1]({ params: { name, arguments: args } });

describe("bounded single-backend argument contract", () => {
    beforeAll(async () => { await startServer(); });
    beforeEach(() => { fixture.calls.length = 0; });
    it("uses exactly the two public intentional defaults", () => { expect(SINGLE_BACKEND_TOOL_DEFAULTS).toEqual(defaults); });
    it.each(entries)("%s exposes no redundant backend selector", (name) => {
        const schema = TOOLS.find((tool: any) => tool.name === name)!.inputSchema;
        expect(schema.properties).not.toHaveProperty("backend");
        expect(schema.required).not.toContain("backend");
    });
    it.each(entries)("%s derives its internal backend when omitted", async (name, backend) => {
        const input = { implicitBroker: false,
            ...(name === "import_image" ? { name: "Image", sourcePath: "test.qcow2" } : {}),
        };
        const original = structuredClone(input);
        await call(name, input);
        expect(fixture.calls.length).toBeGreaterThan(0);
        expect(fixture.calls.every((entry) => entry.args.backend === backend)).toBe(true);
        expect(fixture.calls.at(-1)?.provider).toBe(backend === "macos-vm" ? "macos" : "linux-management");
        expect(input).toEqual(original);
    });
    it.each(entries)("%s rejects every explicit backend before any provider", async (name, backend) => {
        for (const selector of [backend, "wrong", "", null, false, 7, [], {}, undefined]) {
            const result = await call(name, { deviceId: "owned-target", backend: selector, confirmDestructive: true });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toMatch(/omit backend|does not support backend/);
            expect(fixture.calls).toEqual([]);
        }
    });
    it.each([{}, null, false, { backend: "linux-vm", name: "Old", cpus: 4 }])("rejects options %j before creation", async (options) => {
        const result = await call("create_linux_vm", {  name: "Flat", options });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Use flat tool arguments");
        expect(fixture.calls).toEqual([]);
    });
    it("keeps normalization flat and derives defaults only for relevant tools", () => {
        expect(normalizeToolArgs({ deviceId: "a", detail: true }, "status")).toEqual({ deviceId: "a" });
        expect(normalizeToolArgs({}, "unknown")).toEqual({});
        expect(TOOLS.find((tool: any) => tool.name === "create_linux_vm")!.inputSchema.properties).not.toHaveProperty("options");
    });
    it("inherits only declared target fields before deriving the selected backend", () => {
        const shared = { deviceId: "a", backend: "macos-vm", incarnationId: "a".repeat(32) };
        expect(flowStepArguments("clear_app_data", shared, {})).toEqual({ deviceId: "a" });
        expect(flowStepArguments("clear_app_data", shared, { deviceId: "b" })).toEqual({ deviceId: "b" });
    });
});

// Child stdio processes load real providers; parent mocks above cannot affect them.
describe("single-backend QEMU owner isolation through MCP", () => {
    let context: Awaited<ReturnType<typeof createDeviceLabMcpTestContext>>;
    let root: string;
    let ownedId: string;
    let foreignId: string;
    let ownedMetadata: string;
    let foreignMetadata: string;
    beforeAll(async () => {
        context = await createDeviceLabMcpTestContext({ env: { CCC_PROFILE: "input-clarity" } });
        const result = parse(await context.client.callTool({ name: "create_linux_vm", arguments: {  name: "Owned Target" } }));
        expect(result.ok).toBe(true);
        // Read the authoritative root from the real provider instead of assuming its storage layout.
        const inventory = parse(await context.client.callTool({ name: "devices", arguments: { view: "available", backend: "linux-vm", detail: true } }));
        root = inventory.discovery.stateRoot;
        ownedId = result.device.deviceId;
        ownedMetadata = join(root, "owners", result.device.ownerId, "labs", ownedId, "lab.json");
        const foreignEnv = { CCC_PROFILE: "input-clarity-foreign", CCC_DEVICE_LAB_OWNER_BASIS: "foreign-owner" };
        const foreign = createLab({ name: "Foreign Target" }, { env: foreignEnv, stateRoot: root });
        expect(foreign.ok).toBe(true);
        foreignId = foreign.lab.id;
        foreignMetadata = join(root, "owners", ownerId(foreignEnv), "labs", foreignId, "lab.json");
    });
    afterAll(async () => { await cleanupDeviceLabMcpTestContext(context); });
    it("creates from flat inputs and imports an image without backend", async () => {
        const created = parse(await context.client.callTool({ name: "create_linux_vm", arguments: {
             name: "Flat Inputs", cpus: 3, memoryMb: 1024,
        } }));
        expect(created.ok).toBe(true);
        const metadata = JSON.parse(readFileSync(join(root, "owners", created.device.ownerId, "labs", created.device.deviceId, "lab.json"), "utf8"));
        expect(metadata.resources).toMatchObject({ cpus: 3, memoryMb: 1024 });
        mkdirSync(join(root, "incoming"), { recursive: true });
        writeFileSync(join(root, "incoming", "base.qcow2"), "fixture-image");
        const imported = parse(await context.client.callTool({ name: "import_image", arguments: { name: "Input Base", sourcePath: "incoming/base.qcow2" } }));
        expect(imported).toMatchObject({ ok: true, image: { id: "input-base" } });
        const listed = parse(await context.client.callTool({ name: "list_images", arguments: {} }));
        expect(listed).toMatchObject({ ok: true, images: expect.arrayContaining([expect.objectContaining({ id: "input-base" })]) });
    });
    it("rejects removed names and wrapped creation over real stdio without changing device state", async () => {
        const before = readFileSync(ownedMetadata, "utf8");
        for (const [name, args] of [
            ["device_broker_rpc", { method: "owner.cleanup" }],
            ["mobile_install_app", { deviceId: ownedId, path: "/app.apk" }],
            ["create_linux_vm", { options: { name: "Must Not Exist" } }],
        ] as const) {
            const result = await context.client.callTool({ name, arguments: args });
            expect(result.isError).toBe(true);
            expect(readFileSync(ownedMetadata, "utf8")).toBe(before);
        }
        const listed = parse(await context.client.callTool({ name: "devices", arguments: {} }));
        expect(JSON.stringify(listed)).not.toContain("must-not-exist");
    });
    it.each(ownedActions)("%s rejects wrong selectors without changing owned QEMU metadata", async (name) => {
        const before = readFileSync(ownedMetadata, "utf8");
        for (const backend of ["linux-vm", "macos-vm", null, ""]) {
            const result = await context.client.callTool({ name, arguments: { deviceId: ownedId, backend } });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("Unknown tool");
            expect(readFileSync(ownedMetadata, "utf8")).toBe(before);
        }
    });
    it.each(ownedActions)("%s does not find another owner's or missing target when backend is omitted", async (name) => {
        const before = readFileSync(foreignMetadata, "utf8");
        for (const deviceId of [foreignId, "missing-target"]) {
            const result = await context.client.callTool({ name, arguments: { deviceId } });
            expect(result.isError).toBe(true);
            expect(parse(result)).toMatchObject({ ok: false, error: `Unknown tool: ${name}` });
        }
        expect(readFileSync(foreignMetadata, "utf8")).toBe(before);
    });
    it("never consults a host Hyper-V broker for host-only or duplicate target IDs", async () => {
        const requests: string[] = [];
        const server = createServer((req, res) => {
            requests.push(req.url || "");
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, result: { devices: [
                { id: "host-only", backend: "linux-vm", provider: "hyper-v" },
                { id: ownedId, backend: "linux-vm", provider: "hyper-v" },
            ] } }));
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        try {
            const port = (server.address() as { port: number }).port;
            for (const name of ownedActions) {
                const result = await context.client.callTool({ name, arguments: {
                    deviceId: "host-only", broker: true, hostCandidates: ["127.0.0.1"], port,
                } });
                expect(result.isError).toBe(true);
                expect(parse(result)).toMatchObject({ error: `Unknown tool: ${name}` });
            }
            const duplicate = await context.client.callTool({ name: "artifacts_export", arguments: {
                deviceId: ownedId, broker: true, hostCandidates: ["127.0.0.1"], port,
            } });
            expect(JSON.stringify(duplicate)).not.toContain("host-only");
            expect(requests).toEqual([]);
        } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    });
    it("preserves corrupt target failure without rewriting corrupt state", async () => {
        const path = join(root, "owners", JSON.parse(readFileSync(ownedMetadata, "utf8")).ownerId, "labs", "corrupt-target", "lab.json");
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "{broken");
        const refused = await context.client.callTool({ name: "workspace_sync", arguments: { deviceId: "corrupt-target" } });
        expect(parse(refused)).toMatchObject({ error: "Unknown tool: workspace_sync" });
        expect(readFileSync(path, "utf8")).toBe("{broken");
    });
});
