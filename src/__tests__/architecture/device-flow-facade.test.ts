import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const fixture = vi.hoisted(() => ({
    handlers: [] as Array<(request: any) => Promise<any>>,
    calls: [] as Array<{ name: string; args: Record<string, any>; scope: number }>,
    trace: [] as unknown[],
    results: [] as Array<Record<string, any>>,
    effects: [] as Array<(() => void) | undefined>,
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
        const scope = fixture.scope;
        fixture.trace.push(["scope-enter", scope]);
        try { return await actual.withBrokerOperation(fn); } finally {
            fixture.trace.push(["scope-exit", scope]); fixture.scope = previous;
        }
    }, brokerAppium: deniedCapability, brokerDeviceTool: deniedCapability,
    brokerCommand: deniedCapability, brokerPhysical: deniedCapability,
    brokerRpc: deniedCapability, brokerStatus: deniedCapability };
}
function deniedCapability(): never { throw new Error("unused native capability crossed fixture fence"); }
function fencedProvider(actual: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(actual).map(([name, value]) => [name,
        typeof value !== "function" ? value : name.startsWith("list") ? () => { fixture.trace.push(["inventory", name]); return []; } : deniedCapability]));
}
vi.mock("../../../device-lab-mcp/src/broker.mjs", async importOriginal => scopedBroker(await importOriginal<Record<string, any>>()));
vi.mock("@ccc/device-lab/providers/backends/android.mjs", async importOriginal => ({
    ...fencedProvider(await importOriginal<Record<string, unknown>>()),
    listAndroidDevices: () => { fixture.trace.push(["inventory", "android"]); return [{ id: "target-a" }, { id: "target-b" }]; },
    handleAndroidTool: async (name: string, args: Record<string, any>) => {
        const index = fixture.calls.length;
        fixture.trace.push(["provider-enter", index, name, fixture.scope]);
        fixture.calls.push({ name, args, scope: fixture.scope });
        // Each graph receives fresh scripts and closure state. Effects happen
        // across a real async boundary, while the application is awaiting dispatch.
        await Promise.resolve();
        fixture.trace.push(["provider-awaited", index]);
        if (fixture.effects[index]) {
            fixture.trace.push(["provider-effect", index]); fixture.effects[index]!();
        }
        if (fixture.failure) throw new Error("provider-failed");
        if (fixture.results[index]) return fixture.results[index];
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, status: 0, stdout: "", stderr: "", provider: "fixture" }) }], isError: false };
    },
}));
vi.mock("@ccc/device-lab/providers/backends/linux-vm.mjs", async importOriginal => ({
    ...fencedProvider(await importOriginal<Record<string, unknown>>()), handleLinuxVmManagementTool: async () => null, handleLinuxVmTool: async () => null,
}));
vi.mock("@ccc/device-lab/providers/backends/android-device.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/backends/ios-simulator.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/backends/ios-device.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/backends/macos-vm.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/backends/windows-sandbox.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/backends/windows-vm.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/display/x11.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/state/device-store.mjs", async original => ({
    ...fencedProvider(await original<Record<string, unknown>>()), readOwnerDevices: () => [],
}));
vi.mock("child_process", async original => {
    const actual = await original<Record<string, any>>();
    return { ...actual, spawn: deniedCapability, spawnSync: deniedCapability,
        exec: deniedCapability, execSync: deniedCapability, execFile: deniedCapability,
        execFileSync: (file: string, args: string[], options: Record<string, unknown>) => {
            // Only immutable baseline materialization is allowed in this test.
            if ((file === "git" && args[0] === "archive" && args[1] === revision)
                || (file === "tar" && args[0] === "-x" && args[1] === "-C" && args[2] === frozenRoot)) {
                return actual.execFileSync(file, args, options);
            }
            return deniedCapability();
        } };
});
vi.mock("http", async original => ({ ...await original<Record<string, unknown>>(), request: deniedCapability, get: deniedCapability, createServer: deniedCapability }));
vi.mock("https", async original => ({ ...await original<Record<string, unknown>>(), request: deniedCapability, get: deniedCapability, createServer: deniedCapability }));
vi.mock("net", async original => ({ ...await original<Record<string, unknown>>(), connect: deniedCapability, createConnection: deniedCapability, createServer: deniedCapability }));

const revision = "10c8618383811ced1f24305c35f6098ab858d25d";
const checkoutRoot = resolve(".");
const frozenRoot = resolve(checkoutRoot, "proof/device-flow-baseline");
let privateContext: string;
let cwdSpy: { mockRestore(): void };
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
    // Establish private identity/state before any native facade/provider import.
    privateContext = mkdtempSync(join(tmpdir(), "ccc-flow-paired-"));
    const home = join(privateContext, "home"), cwd = join(privateContext, "project");
    for (const directory of [home, cwd, join(home, ".ccc", "devices"), join(privateContext, "appdata"), join(privateContext, "localappdata")]) mkdirSync(directory, { recursive: true });
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("APPDATA", join(privateContext, "appdata")); vi.stubEnv("LOCALAPPDATA", join(privateContext, "localappdata"));
    vi.stubEnv("CCC_PROFILE", "paired-private");
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.stubGlobal("fetch", deniedCapability);
    // The ignored persistent pre-edit archive is also reproducible on integration.
    // Preserve frozen source verbatim; real local schema/normalizer/output modules
    // import within that graph. Package aliases use byte-identical original leaf
    // sources, verified before either graph is started.
    if (!existsSync(join(frozenRoot, "device-lab-mcp/src/server.mjs"))) {
        mkdirSync(frozenRoot, { recursive: true });
        const archive = execFileSync("git", ["archive", revision, "device-lab-mcp/src", "packages/device-lab/providers", "packages/hyper-v/src", "packages/hyper-v/powershell"], { cwd: checkoutRoot });
        execFileSync("tar", ["-x", "-C", frozenRoot], { input: archive });
    }
    for (const file of providerFiles(join(frozenRoot, "packages/device-lab/providers"))) {
        const relative = file.slice(frozenRoot.length + 1);
        expect(digest(resolve(checkoutRoot, relative)), relative).toBe(digest(file));
    }
    const frozenBroker = join(frozenRoot, "device-lab-mcp/src/broker.mjs");
    vi.doMock(frozenBroker, async importOriginal => scopedBroker(await importOriginal<Record<string, any>>()));
    const frozenServer = await import(join(frozenRoot, "device-lab-mcp/src/server.mjs"));
    const frozenArgs = await import(join(frozenRoot, "device-lab-mcp/src/tool-arguments.mjs"));
    await frozenServer.startServer(); baselineCall = fixture.handlers[1];
    frozenArguments = frozenArgs.flowStepArguments;
    const currentServer = await import(resolve(checkoutRoot, "device-lab-mcp/src/server.mjs"));
    const currentArgs = await import(resolve(checkoutRoot, "device-lab-mcp/src/tool-arguments.mjs"));
    const currentTools = await import(resolve(checkoutRoot, "device-lab-mcp/src/tools.mjs"));
    await currentServer.startServer(); currentCall = fixture.handlers[3];
    flowStepArguments = currentArgs.flowStepArguments; TOOLS = currentTools.TOOLS;
});
afterAll(() => {
    cwdSpy?.mockRestore(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    if (privateContext) rmSync(privateContext, { recursive: true, force: true });
});
function reset(failure = false) {
    fixture.calls.length = 0; fixture.trace.length = 0;
    fixture.results.length = 0; fixture.effects.length = 0;
    fixture.scope = 0; fixture.nextScope = 0; fixture.failure = failure;
}
beforeEach(() => reset());
const shared = { deviceId: "target-a", incarnationId: "a".repeat(32) };
const step = (args: Record<string, unknown> = {}, tool = "click") => ({ tool, arguments: { implicitBroker: false, ...(tool === "click" ? { x: 1, y: 2 } : {}), ...args } });
async function paired(make: () => Record<string, unknown>) {
    const observed: Array<{ response?: any; thrown?: { name: string; message: string }; calls: typeof fixture.calls; trace: unknown[]; scopes: number }> = [];
    const failure = fixture.failure;
    for (const call of [baselineCall, currentCall]) {
        reset(failure);
        try {
            const response = await call({ params: { name: "run_flow", arguments: make() } });
            observed.push({ response, calls: structuredClone(fixture.calls), trace: structuredClone(fixture.trace), scopes: fixture.nextScope });
        } catch (error) {
            observed.push({ thrown: { name: (error as Error).name, message: (error as Error).message }, calls: structuredClone(fixture.calls), trace: structuredClone(fixture.trace), scopes: fixture.nextScope });
        }
    }
    expect(observed[1]).toEqual(observed[0]);
    return observed[1];
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
            const first = { tool: "click", get arguments() { reads += 1; fixture.trace.push(["read-arguments", reads]); return { implicitBroker: false, x: reads, y: 2 }; } };
            return { ...shared, steps: [first, step()] };
        });
    });
    it("records repeated changing tool/label reads in both actual graphs", async () => {
        const result = await paired(() => {
            let tools = 0, labels = 0;
            const first = {
                get tool() { fixture.trace.push(["read-tool", ++tools]); return tools === 1 ? "key" : "click"; },
                get label() { fixture.trace.push(["read-label", ++labels]); return labels === 1 ? "first" : "second"; },
                arguments: { implicitBroker: false, x: 1, y: 2 },
            };
            return { ...shared, steps: [first] };
        });
        expect(result.trace).toContainEqual(["read-tool", 2]);
        expect(result.trace).toContainEqual(["read-label", 2]);
        expect(JSON.parse(result.response.content[0].text).results[0].label).toBe("second");
    });
    it.each([false, true])("relooks up changing action after an awaited native dispatch (detail=%s)", async detail => {
        const result = await paired(() => {
            let action = "grant", reads = 0;
            const args = { implicitBroker: false, appId: "example.app", permission: "android.permission.CAMERA", get action() {
                fixture.trace.push(["read-action", ++reads, action]); return action;
            } };
            fixture.effects[0] = () => { fixture.trace.push(["change-action", "revoke"]); action = "revoke"; };
            return { ...shared, detail, steps: [{ tool: "permission", arguments: args }] };
        });
        expect(result.calls[0].name).toBe("mobile_grant_permission");
        const changed = result.trace.findIndex((entry: any) => entry[0] === "change-action");
        expect(changed).toBeGreaterThan(result.trace.findIndex((entry: any) => entry[0] === "provider-awaited"));
        expect(result.trace.slice(changed + 1).some((entry: any) => entry[0] === "read-action" && entry[2] === "revoke")).toBe(true);
    });
    it("observes mutable steps length and validates appended steps after preceding effects", async () => {
        const result = await paired(() => {
            const steps: any[] = [step()];
            fixture.effects[0] = () => {
                fixture.trace.push("append-step");
                steps.push({ tool: "click", get arguments() { fixture.trace.push("read-appended-arguments"); return null; } });
            };
            return { ...shared, stopOnError: false, steps };
        });
        expect(result.trace.indexOf("append-step")).toBeLessThan(result.trace.indexOf("read-appended-arguments"));
        expect(JSON.parse(result.response.content[0].text).results).toHaveLength(2);
        expect(result.calls).toHaveLength(1);
    });
    it.each(["tool", "label", "arguments", "action"])("preserves actual throwing %s getter outcome and read/effect trace", async field => {
        const result = await paired(() => {
            const first: any = step();
            if (field === "action") {
                first.tool = "permission";
                first.arguments = { implicitBroker: false, appId: "example.app", permission: "android.permission.CAMERA" };
                Object.defineProperty(first.arguments, "action", { enumerable: true, get() {
                    fixture.trace.push(["throw-getter", field]); throw new TypeError("getter-" + field);
                } });
            } else Object.defineProperty(first, field, { get() {
                fixture.trace.push(["throw-getter", field]); throw new TypeError("getter-" + field);
            } });
            return { ...shared, steps: [first] };
        });
        expect(result.thrown).toEqual({ name: "TypeError", message: "getter-" + field });
        expect(result.calls).toHaveLength(0);
    });
    it.each([false, true])("keeps late action getter failure outside scoped-dispatch catch (detail=%s)", async detail => {
        const result = await paired(() => {
            let dispatched = false;
            fixture.effects[0] = () => { dispatched = true; fixture.trace.push("dispatch-mutated-action"); };
            const args = { implicitBroker: false, appId: "example.app", permission: "android.permission.CAMERA", get action() {
                fixture.trace.push(["read-action-after-dispatch", dispatched]);
                if (dispatched) throw new RangeError("post-await-lookup");
                return "grant";
            } };
            return { ...shared, detail, steps: [{ tool: "permission", arguments: args }] };
        });
        expect(result.thrown).toEqual({ name: "RangeError", message: "post-await-lookup" });
        expect(result.calls).toHaveLength(1);
    });
    it.each([false, true])("preserves public boolean stopOnError %s", async stopOnError => {
        const result = await paired(() => ({ ...shared, stopOnError, steps: [{ ...step(), name: undefined }, step()] }));
        expect(result.calls).toHaveLength(stopOnError ? 0 : 1);
    });
    it("defaults to stopping when the public stopOnError property is omitted", async () => {
        const result = await paired(() => ({ ...shared, steps: [{ ...step(), name: undefined }, step()] }));
        expect(result.calls).toHaveLength(0);
        expect(JSON.parse(result.response.content[0].text)).toMatchObject({ ok: false, stoppedAt: 0 });
    });
    it.each([undefined, null, 0, "", 1, "stop"])("rejects own public nonboolean stopOnError %j before dispatch", async stopOnError => {
        const result = await paired(() => ({ ...shared, stopOnError, steps: [step()] }));
        expect(result.calls).toHaveLength(0);
        expect(result.scopes).toBe(0);
        expect(JSON.parse(result.response.content[0].text)).toEqual({ ok: false, error: "run_flow stopOnError must be a boolean" });
    });
    it.each([[false, false], [false, true], [true, false], [true, true]] as const)("retains raw failure and ordered native/binary content (detail=%s stop=%s)", async (detail, stopOnError) => {
        const result = await paired(() => {
            const observation = (index: number, failed: boolean) => ({ isError: false, content: [
                { type: "text", text: JSON.stringify({ ok: !failed, status: failed ? 7 : 0, error: failed ? "raw-provider-failure" : undefined }) },
                { type: "image", mimeType: "image/png", data: Buffer.from([index, 1]).toString("base64") },
                { type: "audio", mimeType: "audio/wav", data: Buffer.from([index, 2]).toString("base64") },
                { type: "resource", resource: { uri: "fixture://binary/" + index, mimeType: "application/octet-stream", blob: Buffer.from([index, 3]).toString("base64") } },
            ] });
            // Recreate each raw result independently for each graph; presentation
            // is real and can compact text without losing the raw failure truth.
            fixture.results.push(observation(1, true), observation(2, false));
            return { ...shared, detail, stopOnError, steps: [step(), step()] };
        });
        const value = JSON.parse(result.response.content[0].text);
        expect(value.ok).toBe(false); expect(value.results[0].isError).toBe(true);
        const expectedSteps = stopOnError ? 1 : 2;
        expect(result.calls).toHaveLength(expectedSteps);
        expect(result.response.content.slice(1).map((item: any) => item.type)).toEqual(Array.from({ length: expectedSteps }, () => ["image", "audio", "resource"]).flat());
        expect(result.response.content.slice(1).map((item: any) => item.data ?? item.resource.blob)).toEqual(Array.from({ length: expectedSteps }, (_, index) => [1, 2, 3].map(kind => Buffer.from([index + 1, kind]).toString("base64"))).flat());
        expect(value.results.map((entry: any) => [entry.contentIndex, entry.contentCount])).toEqual(Array.from({ length: expectedSteps }, (_, index) => [1 + index * 3, 3]));
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
