import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const fixture = vi.hoisted(() => ({
    handlers: [] as Array<(request: any) => Promise<any>>,
    calls: [] as Array<{ name: string; args: Record<string, any>; scope: number }>,
    trace: [] as unknown[],
    results: [] as Array<Record<string, any>>,
    effects: [] as Array<(() => void) | undefined>,
    scope: 0, nextScope: 0, failure: false, denials: 0,
    capabilities: new Set<Function>(),
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
function registerCapability<Capability extends Function>(capability: Capability): Capability {
    fixture.capabilities.add(capability);
    return capability;
}
function deniedCapability(): never {
    fixture.denials += 1;
    throw new Error("unused native capability crossed fixture fence");
}
function assertNoDenials() { expect(fixture.denials, "caught or uncaught fixture capability denial").toBe(0); }

function fencedProvider(actual: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(actual).map(([name, value]) => [name,
        typeof value !== "function" ? value : name.startsWith("list") ? registerCapability(() => { fixture.trace.push(["inventory", name]); return []; }) : registerCapability(deniedCapability)]));
}
vi.mock("../../../device-lab-mcp/src/broker.mjs", async importOriginal => scopedBroker(await importOriginal<Record<string, any>>()));
vi.mock("@ccc/device-lab/providers/backends/android.mjs", async importOriginal => ({
    ...fencedProvider(await importOriginal<Record<string, unknown>>()),
    listAndroidDevices: registerCapability(() => { fixture.trace.push(["inventory", "android"]); return [{ id: "target-a" }, { id: "target-b" }]; }),
    handleAndroidTool: registerCapability(async (name: string, args: Record<string, any>) => {
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
    }),
}));
vi.mock("@ccc/device-lab/providers/backends/linux-vm.mjs", async importOriginal => ({
    ...fencedProvider(await importOriginal<Record<string, unknown>>()), handleLinuxVmManagementTool: registerCapability(async () => null), handleLinuxVmTool: registerCapability(async () => null),
}));
vi.mock("@ccc/device-lab/providers/backends/android-device.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/backends/ios-simulator.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/backends/ios-device.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/backends/macos-vm.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/backends/windows-sandbox.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/backends/windows-vm.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/display/x11.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("@ccc/device-lab/providers/state/device-store.mjs", async original => ({
    ...fencedProvider(await original<Record<string, unknown>>()), readOwnerDevices: registerCapability(() => []),
}));
// Independently admitted port-allocation extraction; exports remain inert capabilities.
vi.mock("@ccc/device-lab/providers/state/android-emulator-port-allocation.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
// Both flow graphs use this same inert namespace; no native state function survives.
vi.mock("@ccc/device-lab/providers/state/state-file.mjs", async original => fencedProvider(await original<Record<string, unknown>>()));
vi.mock("child_process", async original => ({ ...await original<Record<string, unknown>>(),
    spawn:deniedCapability,spawnSync:deniedCapability,exec:deniedCapability,execSync:deniedCapability,execFile:deniedCapability,execFileSync:deniedCapability }));
vi.mock("http", async original => ({ ...await original<Record<string, unknown>>(), request: deniedCapability, get: deniedCapability, createServer: deniedCapability }));
vi.mock("https", async original => ({ ...await original<Record<string, unknown>>(), request: deniedCapability, get: deniedCapability, createServer: deniedCapability }));
vi.mock("net", async original => ({ ...await original<Record<string, unknown>>(), connect: deniedCapability, createConnection: deniedCapability, createServer: deniedCapability }));

const checkoutRoot = resolve(".");
let privateContext: string;
let cwdSpy: { mockRestore(): void };
let killSpy: { mockRestore(): void };
let currentCall: (request: any) => Promise<any>;
type StepArguments = (tool: string, flow: Record<string, any>, step: Record<string, any>) => Record<string, any>;
let flowStepArguments: StepArguments;
let TOOLS: Array<{ name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }>;
beforeAll(async () => {
    // Establish private identity/state before any native facade/provider import.
    privateContext = mkdtempSync(join(tmpdir(), "ccc-flow-current-"));
    const home = join(privateContext, "home"), cwd = join(privateContext, "project");
    for (const directory of [home, cwd, join(home, ".ccc", "devices"), join(privateContext, "appdata"), join(privateContext, "localappdata")]) mkdirSync(directory, { recursive: true });
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("APPDATA", join(privateContext, "appdata")); vi.stubEnv("LOCALAPPDATA", join(privateContext, "localappdata"));
    vi.stubEnv("CCC_PROFILE", "flow-private");
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.stubGlobal("fetch", deniedCapability);
    killSpy = vi.spyOn(process, "kill").mockImplementation(deniedCapability);
    const currentServer = await import(resolve(checkoutRoot, "device-lab-mcp/src/server.mjs"));
    assertNoDenials();
    const currentArgs = await import(resolve(checkoutRoot, "device-lab-mcp/src/tool-arguments.mjs"));
    assertNoDenials();
    const currentTools = await import(resolve(checkoutRoot, "device-lab-mcp/src/tools.mjs"));
    assertNoDenials();
    await currentServer.startServer(); assertNoDenials(); currentCall = fixture.handlers[1];
    flowStepArguments = currentArgs.flowStepArguments; TOOLS = currentTools.TOOLS;
});
afterAll(() => {
    killSpy?.mockRestore(); cwdSpy?.mockRestore(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    if (privateContext) rmSync(privateContext, { recursive: true, force: true });
});
function reset(failure = false) {
    assertNoDenials();
    fixture.calls.length = 0; fixture.trace.length = 0;
    fixture.results.length = 0; fixture.effects.length = 0;
    fixture.scope = 0; fixture.nextScope = 0; fixture.failure = failure;
}
beforeEach(() => reset());
const shared = { deviceId: "target-a", incarnationId: "a".repeat(32) };
const step = (args: Record<string, unknown> = {}, tool = "click") => ({ tool, arguments: { implicitBroker: false, ...(tool === "click" ? { x: 1, y: 2 } : {}), ...args } });
async function observeFlow(make: () => Record<string, unknown>) {
    const failure = fixture.failure; reset(failure);
    try {
        const response = await currentCall({ params:{name:"run_flow",arguments:make()} });
        return {response,calls:structuredClone(fixture.calls),trace:structuredClone(fixture.trace),scopes:fixture.nextScope};
    } finally { assertNoDenials(); }
}
describe("current public flow behavior", () => {
    it.each([false, true])("retains public rendering and per-step fresh scope (detail=%s)", async detail => {
        await observeFlow(() => ({ ...shared, detail, steps: [step(), step({ deviceId: "target-b" }), step({}, "home")] }));
        expect(new Set(fixture.calls.map(call => call.scope)).size).toBe(3);
    });
    it.each([false, true])("retains stop/continue admission and raw failure (stop=%s)", async stopOnError => {
        await observeFlow(() => ({ ...shared, stopOnError, steps: [step({ appId: "example" }, "uninstall_app"), step()] }));
        fixture.failure = true;
        const observed = await observeFlow(() => ({ ...shared, stopOnError, steps: [step(), step()] }));
        expect(observed.calls).toHaveLength(stopOnError ? 1 : 2);
    });
    it.each([0, 1, 50, 51])("retains actual public bounds %s", async length => {
        const observed = await observeFlow(() => ({ ...shared, steps: Array.from({ length }, () => step()) }));
        expect(observed.calls).toHaveLength(length >= 1 && length <= 50 ? length : 0);
    });
    it.each([false, true])("preserves public boolean stopOnError %s", async stopOnError => {
        const result = await observeFlow(() => ({ ...shared, stopOnError, steps: [{ ...step(), name: undefined }, step()] }));
        expect(result.calls).toHaveLength(stopOnError ? 0 : 1);
    });
    it("defaults to stopping when the public stopOnError property is omitted", async () => {
        const result = await observeFlow(() => ({ ...shared, steps: [{ ...step(), name: undefined }, step()] }));
        expect(result.calls).toHaveLength(0);
        expect(JSON.parse(result.response.content[0].text)).toMatchObject({ ok: false, stoppedAt: 0 });
    });
    it.each([undefined, null, 0, "", 1, "stop"])("rejects own public nonboolean stopOnError %j before dispatch", async stopOnError => {
        const result = await observeFlow(() => ({ ...shared, stopOnError, steps: [step()] }));
        expect(result.calls).toHaveLength(0);
        expect(result.scopes).toBe(0);
        expect(JSON.parse(result.response.content[0].text)).toEqual({ ok: false, error: "run_flow stopOnError must be a boolean" });
    });
    it.each([[false, false], [false, true], [true, false], [true, true]] as const)("retains raw failure and ordered native/binary content (detail=%s stop=%s)", async (detail, stopOnError) => {
        const result = await observeFlow(() => {
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
        const observed = await observeFlow(() => ({ ...shared, stopOnError: false, steps: [{ ...step(), name: undefined }, { tool: "click", arguments: null }, step()] }));
        expect(observed.calls).toHaveLength(1);
    });
    it("uses required-deviceId schema eligibility before property sharing", () => {
        const flow = { ...shared, confirmDestructive: true, backend: "android" };
        for (const tool of TOOLS) {
            const stepArgs = {};
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
