import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const fixture = vi.hoisted(() => ({
    handlers: [] as Array<(request: any) => Promise<any>>,
    calls: [] as Array<{ name: string; args: Record<string, any>; scope: number }>,
    scope: 0, nextScope: 0, failure: false,
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
function scopedBroker(actual: Record<string, any>) {
    return { ...actual, withBrokerOperation: async (fn: () => Promise<any>) => {
        const previous = fixture.scope; fixture.scope = ++fixture.nextScope;
        try { return await actual.withBrokerOperation(fn); } finally { fixture.scope = previous; }
    }, brokerAppium: async () => { throw new Error("unexpected broker route"); },
    brokerDeviceTool: async () => { throw new Error("unexpected broker route"); } };
}
vi.mock("../../../device-lab-mcp/src/broker.mjs", async importOriginal => scopedBroker(await importOriginal<Record<string, any>>()));
vi.mock("@ccc/device-lab/providers/backends/android.mjs", async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    listAndroidDevices: () => [{ id: "target-a" }, { id: "target-b" }],
    handleAndroidTool: async (name: string, args: Record<string, any>) => {
        fixture.calls.push({ name, args, scope: fixture.scope });
        if (fixture.failure) throw new Error("provider-failed");
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, status: 0, stdout: "", stderr: "", provider: "fixture" }) }], isError: false };
    },
}));
vi.mock("@ccc/device-lab/providers/backends/linux-vm.mjs", async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(), handleLinuxVmManagementTool: async () => null, handleLinuxVmTool: async () => null,
}));

const revision = "10c8618383811ced1f24305c35f6098ab858d25d";
const frozenRoot = resolve("proof/device-flow-baseline");
let baselineCall: (request: any) => Promise<any>;
let currentCall: (request: any) => Promise<any>;
type StepArguments = (tool: string, flow: Record<string, any>, step: Record<string, any>) => Record<string, any>;
let frozenArguments: StepArguments;
let flowStepArguments: StepArguments;
let TOOLS: Array<{ name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }>;
function digest(path: string) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function providerFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? providerFiles(path) : entry.name.endsWith(".mjs") ? [path] : [];
    });
}
beforeAll(async () => {
    // The ignored persistent pre-edit archive is also reproducible on integration.
    // Preserve frozen source verbatim; real local schema/normalizer/output modules
    // import within that graph. Package aliases use byte-identical original leaf
    // sources, verified before either graph is started.
    if (!existsSync(join(frozenRoot, "device-lab-mcp/src/server.mjs"))) {
        mkdirSync(frozenRoot, { recursive: true });
        const archive = execFileSync("git", ["archive", revision, "device-lab-mcp/src", "packages/device-lab/providers", "packages/hyper-v/src", "packages/hyper-v/powershell"]);
        execFileSync("tar", ["-x", "-C", frozenRoot], { input: archive });
    }
    for (const file of providerFiles(join(frozenRoot, "packages/device-lab/providers"))) {
        const relative = file.slice(frozenRoot.length + 1);
        expect(digest(resolve(relative)), relative).toBe(digest(file));
    }
    const frozenBroker = join(frozenRoot, "device-lab-mcp/src/broker.mjs");
    vi.doMock(frozenBroker, async importOriginal => scopedBroker(await importOriginal<Record<string, any>>()));
    const frozenServer = await import(join(frozenRoot, "device-lab-mcp/src/server.mjs"));
    const frozenArgs = await import(join(frozenRoot, "device-lab-mcp/src/tool-arguments.mjs"));
    await frozenServer.startServer(); baselineCall = fixture.handlers[1];
    frozenArguments = frozenArgs.flowStepArguments;
    const currentServer = await import(resolve("device-lab-mcp/src/server.mjs"));
    const currentArgs = await import(resolve("device-lab-mcp/src/tool-arguments.mjs"));
    const currentTools = await import(resolve("device-lab-mcp/src/tools.mjs"));
    await currentServer.startServer(); currentCall = fixture.handlers[3];
    flowStepArguments = currentArgs.flowStepArguments; TOOLS = currentTools.TOOLS;
});
beforeEach(() => { fixture.calls.length = 0; fixture.scope = 0; fixture.nextScope = 0; fixture.failure = false; });
const shared = { deviceId: "target-a", incarnationId: "a".repeat(32) };
const step = (args: Record<string, unknown> = {}, tool = "click") => ({ tool, arguments: { implicitBroker: false, ...(tool === "click" ? { x: 1, y: 2 } : {}), ...args } });
async function paired(make: () => Record<string, unknown>) {
    const observed: unknown[] = [];
    for (const call of [baselineCall, currentCall]) {
        fixture.calls.length = 0; fixture.scope = 0; fixture.nextScope = 0;
        try {
            const response = await call({ params: { name: "run_flow", arguments: make() } });
            observed.push({ response, calls: structuredClone(fixture.calls), scopes: fixture.nextScope });
        } catch (error) { observed.push({ thrown: (error as Error).message, calls: structuredClone(fixture.calls), scopes: fixture.nextScope }); }
    }
    expect(observed[1]).toEqual(observed[0]);
}
describe("actual frozen versus current MCP facade", () => {
    it.each([false, true])("retains public rendering and per-step fresh scope (detail=%s)", async detail => {
        await paired(() => ({ ...shared, detail, steps: [step(), step({ deviceId: "target-b" }), step({}, "home")] }));
        expect(new Set(fixture.calls.map(call => call.scope)).size).toBe(3);
    });
    it.each([false, true])("retains stop/continue admission and raw failure (stop=%s)", async stopOnError => {
        await paired(() => ({ ...shared, stopOnError, steps: [step({ appId: "example" }, "uninstall_app"), step()] }));
        fixture.failure = true;
        await paired(() => ({ ...shared, stopOnError, steps: [step(), step()] }));
    });
    it.each([0, 1, 50, 51])("retains actual public bounds %s", async length => {
        await paired(() => ({ ...shared, steps: Array.from({ length }, () => step()) }));
    });
    it("keeps actual changing step argument getter observation", async () => {
        await paired(() => {
            let reads = 0;
            const first = { tool: "click", get arguments() { reads += 1; return { implicitBroker: false, x: reads, y: 2 }; } };
            return { ...shared, steps: [first, step()] };
        });
    });
    it("keeps own legacy name refusal and malformed step args", async () => {
        await paired(() => ({ ...shared, stopOnError: false, steps: [{ ...step(), name: undefined }, { tool: "click", arguments: null }, step()] }));
    });
    it("uses required-deviceId schema eligibility before property sharing", () => {
        const flow = { ...shared, confirmDestructive: true, backend: "android" };
        for (const tool of TOOLS) {
            const stepArgs = {};
            expect(flowStepArguments(tool.name, flow, stepArgs)).toEqual(frozenArguments(tool.name, flow, stepArgs));
            if (!tool.inputSchema.required?.includes("deviceId")) {
                expect(flowStepArguments(tool.name, flow, stepArgs)).not.toHaveProperty("deviceId");
                expect(flowStepArguments(tool.name, flow, stepArgs)).not.toHaveProperty("incarnationId");
            }
        }
        expect(flowStepArguments("click", flow, { deviceId: "target-b" })).toEqual({ deviceId: "target-b" });
        expect(flowStepArguments("click", flow, { backend: "ios" })).toMatchObject(shared);
        expect(flowStepArguments("click", flow, {})).not.toHaveProperty("confirmDestructive");
    });
});
