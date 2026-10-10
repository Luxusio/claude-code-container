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
vi.mock("child_process", async original => {
    const actual = await original<Record<string, any>>();
    return { ...actual, spawn: deniedCapability, spawnSync: deniedCapability,
        exec: deniedCapability, execSync: deniedCapability, execFile: deniedCapability,
        execFileSync: (file: string, args: string[], options: Record<string, unknown>) => {
            // Only immutable baseline materialization is allowed in this test.
            if ((file === "git" && args.length === 8 && args[0] === "archive" && args[1] === revision
                && args[2] === "--output=" + archiveFile && args[3] === "device-lab-mcp/src"
                && args[4] === "packages/device-lab/providers" && args[5] === "packages/hyper-v/src"
                && args[6] === "packages/hyper-v/powershell" && args[7] === "packages/device-lab/package.json"
                && options.cwd === checkoutRoot)
                || (file === "tar" && args.length === 4 && args[0] === "-xf" && args[1] === archiveFile
                    && args[2] === "-C" && args[3] === frozenRoot)) {
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
let frozenRoot: string;
let archiveFile: string;
let privateContext: string;
let cwdSpy: { mockRestore(): void };
let killSpy: { mockRestore(): void };
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
    // Always start without a supplied archive: source-worktree checkpoints must
    // not hide the materialization branch used by integration and clean checkouts.
    frozenRoot = join(privateContext, "baseline");
    archiveFile = join(privateContext, "baseline.tar");
    const home = join(privateContext, "home"), cwd = join(privateContext, "project");
    for (const directory of [home, cwd, join(home, ".ccc", "devices"), join(privateContext, "appdata"), join(privateContext, "localappdata")]) mkdirSync(directory, { recursive: true });
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("APPDATA", join(privateContext, "appdata")); vi.stubEnv("LOCALAPPDATA", join(privateContext, "localappdata"));
    vi.stubEnv("CCC_PROFILE", "paired-private");
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.stubGlobal("fetch", deniedCapability);
    killSpy = vi.spyOn(process, "kill").mockImplementation(deniedCapability);
    // Reproduce the exact persistent pre-edit revision in this fresh context.
    // Frozen flow policy/response bytes stay verbatim. Package aliases share
    // controlled providers; this does not prove frozen native-provider equality.
    if (!existsSync(join(frozenRoot, "device-lab-mcp/src/server.mjs"))) {
        mkdirSync(frozenRoot, { recursive: true });
        execFileSync("git", ["archive", revision, "--output=" + archiveFile, "device-lab-mcp/src", "packages/device-lab/providers", "packages/hyper-v/src", "packages/hyper-v/powershell", "packages/device-lab/package.json"], { cwd: checkoutRoot });
        execFileSync("tar", ["-xf", archiveFile, "-C", frozenRoot]);
    }
    assertNoDenials();
    // Original manifest enables package self-reference without dependency fallback.
    expect(digest(join(frozenRoot, "packages/device-lab/package.json")), `manifest frozen ${revision}`)
        .toBe("d0afbcdd410f410fae0a73344f84c3669c33c290afea240c697b2b1ca335c3c6");
    const archivedContext = await import(join(frozenRoot, "packages/device-lab/providers/context.mjs"));
    assertNoDenials();
    expect(archivedContext.PACKAGE_ROOT).toBe(join(frozenRoot, "packages/device-lab"));
    const admittedProviders: Record<string, { archived: string; current: string; sourceTip: string }> = {
        // Frozen10c861 originals; independent64df and genuine2b7045 current authorities.
        "backends/android-device.mjs": {
            archived: "b53b89ebcdbdeb8430dc2c739e86e9da196d8cd4a3a844296f06ac00d61de53a",
            current: "f1b1394b550546e51ecfdfb6752dc63ecc1686a48abfcfd5e29e77a45d739252",
            sourceTip: "64df6afbc161e1a706f6dbfdfb27ce5e76e8ec63",
        },
        "backends/android.mjs": {
            archived: "7fe126498d5107dc15d4f018dc4b3cc21e81f70a9ccb7ec8a4bb424e477372ff",
            current: "5d8fa7a8521131016bcaea0ba1f155e7c91d03a904bbaf31923bcc3ca338e96c",
            sourceTip: "2b7045a2d0d9925ed4b237a0ef698e9cb8640367",
        },
        "backends/ios-device.mjs": {
            archived: "9bd17af41b71fc3f13b3a1ce758e74224a3631d431a75a43481f33f56d13eef9",
            current: "56a75969fd6047e0b83c0b19d26c6c2adf44a2be7ecca44783bfc1e106d30d00",
            sourceTip: "64df6afbc161e1a706f6dbfdfb27ce5e76e8ec63",
        },
        "backends/ios-simulator.mjs": {
            archived: "fb09f500e3daccd66e80416656aad162e36f84d191eb5a19c2b8c35ed343dbfd",
            current: "f364cd9c4ae523ade742222e7d629075d21dc1b48ff68d60a7f8b386d87e22a0",
            sourceTip: "2b7045a2d0d9925ed4b237a0ef698e9cb8640367",
        },
        "backends/macos-vm.mjs": {
            archived: "0dc325978de01e8681c9f297f14eda217ea890f1b46eafd25a5b5f59dcdb9abe",
            current: "a206a44894802efae5e511b013782313c0536dd251256ee610f4e724bd3045ee",
            sourceTip: "2f13b63dac281b5f710b737698284022df8f84ed",
        },
        "backends/linux-vm.mjs": {
            archived: "f27fba0d138d2d6390f7076d699a3ec93435a8d9c149a4221cfd3c26bb2a64a9",
            current: "d7dc7669ac6c1201a567fddafb6478aa2b813c0b09688020b3c5ab054f6e54c8",
            sourceTip: "64df6afbc161e1a706f6dbfdfb27ce5e76e8ec63",
        },
        "state/android-emulator-port-allocation.mjs": {
            archived: "209bc23da1da7caa5370998f040d72a6aaa3c1ff2ed594eff47a9452167267ce",
            current: "25f8e67597592eb666ff26aec4bb56ef0824f524ebfb34331115e7dcc8d52611",
            sourceTip: "64df6afbc161e1a706f6dbfdfb27ce5e76e8ec63",
        },
        "backends/windows-sandbox.mjs": {
            archived: "adb87857f40652c7da3906ad3e59ab6677050780b3d8ed81f5b37a733288a178",
            current: "deb025c9c4ac9b019dead292acd54450b3ec3b2ecc15e62f3315f38f6cf5e5d7",
            sourceTip: "2b7045a2d0d9925ed4b237a0ef698e9cb8640367",
        },
        "state/state-file.mjs": {
            archived: "d3a5d5e21ec8d54137b9a7ffce0b9fc83394210cd9668bc91e15b478b7f13883",
            current: "66624376f128b384a8af2ae2c9db9385f8680b10d3504484181ae3f3d1da2e6e",
            sourceTip: "8b74ef39d7987a896962db8224f6ab66d69b1363",
        },
    };
    const providerMismatches: Array<{ path: string; kind: string; expected: string; actual: string; provenance: string }> = [];
    for (const file of providerFiles(join(frozenRoot, "packages/device-lab/providers"))) {
        const relative = file.slice(frozenRoot.length + 1);
        const provider = relative.slice("packages/device-lab/providers/".length);
        const admission = admittedProviders[provider];
        const archivedSha = digest(file);
        const currentSha = digest(resolve(checkoutRoot, relative));
        if (admission) {
            if (archivedSha !== admission.archived) providerMismatches.push({ path: relative, kind: "archived", expected: admission.archived, actual: archivedSha, provenance: revision });
            if (currentSha !== admission.current) providerMismatches.push({ path: relative, kind: "current", expected: admission.current, actual: currentSha, provenance: admission.sourceTip });
        } else if (currentSha !== archivedSha) providerMismatches.push({ path: relative, kind: "unchanged", expected: archivedSha, actual: currentSha, provenance: revision });
    }
    expect(providerMismatches, "all frozen-provider original/current authority mismatches").toEqual([]);

    // Import archived namespaces only for read-only export comparison. Never
    // invoke any archived export, including its error constructor.
    for (const provider of Object.keys(admittedProviders)) {
        const archived = await import(join(frozenRoot, "packages/device-lab/providers", provider));
        assertNoDenials();
        const controlled = await import(join(checkoutRoot, "packages/device-lab/providers", provider));
        assertNoDenials();
        expect(Object.keys(controlled).sort(), provider).toEqual(Object.keys(archived).sort());
        for (const name of Object.keys(archived)) {
            const original = archived[name], replacement = (controlled as Record<string, unknown>)[name];
            expect(typeof replacement, `${provider}:${name}`).toBe(typeof original);
            if (typeof original === "function") {
                expect(fixture.capabilities.has(replacement as Function), `${provider}:${name} fixture identity`).toBe(true);
            } else expect(replacement, `${provider}:${name} exact value`).toStrictEqual(original);
        }
    }
    assertNoDenials();
    const frozenBroker = join(frozenRoot, "device-lab-mcp/src/broker.mjs");
    vi.doMock(frozenBroker, async importOriginal => scopedBroker(await importOriginal<Record<string, any>>()));
    const frozenServer = await import(join(frozenRoot, "device-lab-mcp/src/server.mjs"));
    assertNoDenials();
    const frozenArgs = await import(join(frozenRoot, "device-lab-mcp/src/tool-arguments.mjs"));
    assertNoDenials();
    await frozenServer.startServer(); assertNoDenials(); baselineCall = fixture.handlers[1];
    frozenArguments = frozenArgs.flowStepArguments;
    const currentServer = await import(resolve(checkoutRoot, "device-lab-mcp/src/server.mjs"));
    assertNoDenials();
    const currentArgs = await import(resolve(checkoutRoot, "device-lab-mcp/src/tool-arguments.mjs"));
    assertNoDenials();
    const currentTools = await import(resolve(checkoutRoot, "device-lab-mcp/src/tools.mjs"));
    assertNoDenials();
    await currentServer.startServer(); assertNoDenials(); currentCall = fixture.handlers[3];
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
        } finally {
            // Assert before the next invocation resets any fixture state, even
            // when the flow catches a denial or propagates a getter failure.
            assertNoDenials();
        }
    }
    expect(observed[1]).toEqual(observed[0]);
    return observed[1];
}
describe("frozen versus current flow policy with shared controlled providers", () => {
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
