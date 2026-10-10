import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise public request validation, normalization, dispatch and real owner state.
// Native command/process boundaries are simulated; no VM or SSH command executes.
const fixture = vi.hoisted(() => ({
    handlers: [] as Array<(request: any) => Promise<any>>,
    calls: [] as Array<{ command: string; args: string[]; timeout?: number }>,
    cloneTimeout: false,
    stateFailure: false,
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@ccc/device-lab/providers/commands.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    commandPath: (name: string) => ["tart", "ssh", "scp"].includes(name) ? `/fixture/${name}` : null,
    run: (command: string, args: string[]) => {
        fixture.calls.push({ command, args });
        return { status: 0, stdout: "--with-softnet --no-graphics", stderr: "" };
    },
    runWithTimeout: (command: string, args: string[], timeout: number) => {
        fixture.calls.push({ command, args, timeout });
        if (args[0] === "clone" && fixture.cloneTimeout) return { status: null, stdout: "", stderr: "clone timed out", error: { code: "ETIMEDOUT" } };
        return { status: 0, stdout: "ok", stderr: "" };
    },
}));
vi.mock("child_process", async original => ({
    ...await original<Record<string, unknown>>(),
    spawn: (command: string, args: string[]) => {
        fixture.calls.push({ command, args });
        return Object.assign(new EventEmitter(), { pid: undefined, unref() {} });
    },
}));
vi.mock("@ccc/device-lab/providers/state/macos-state.mjs", async original => {
    const state = await original<Record<string, any>>();
    return { ...state, claimMacosDevice: (device: unknown) => {
        if (fixture.stateFailure) throw new Error("simulated state write failure");
        return state.claimMacosDevice(device);
    } };
});
import { startServer } from "../../device-lab-mcp/src/server.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { normalizePublicToolArgs } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { readMacosDevices } from "@ccc/device-lab/providers/state/macos-state.mjs";

const call = (name: string, args: Record<string, unknown>) => fixture.handlers[1]({ params: { name, arguments: { implicitBroker: false, ...args } } });
const create = (extra: Record<string, unknown> = {}) => call("create_macos_vm", { name: "Managed Mac", deviceId: "managed-mac", image: "custom-base", ...extra });
const mutations = () => fixture.calls.filter(call => ["clone", "delete", "run"].includes(call.args[0]) && call.args[1] !== "--help");
let home: string;
beforeAll(async () => { await startServer(); });
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ccc-stabilization-macos-"));
    for (const key of Object.keys(process.env)) if (/^(CCC_|ANDROID_)/i.test(key)) vi.stubEnv(key, undefined);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    fixture.calls.length = 0;
    fixture.cloneTimeout = false;
    fixture.stateFailure = false;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("public managed macOS creation", () => {
    it.each([true, false])("clones before start and preserves headless:%s", async headless => {
        expect((await create({ headless })).isError).not.toBe(true);
        const [device] = readMacosDevices();
        expect(device).toMatchObject({ id: "managed-mac", image: "custom-base", status: "stopped", providerResourceManaged: true, headless });
        expect(mutations().map(call => call.args)).toEqual([["clone", "custom-base", device.providerInstance]]);
        // This fixture proves lifecycle arguments; its fake SSH response has no readiness probe.
        expect((await call("start", { deviceId: device.id, waitForBoot: false })).isError).not.toBe(true);
        expect(mutations().map(call => call.args[0])).toEqual(["clone", "run"]);
        expect(mutations()[1].args.includes("--no-graphics")).toBe(headless);
    });

    it.each([{}, { image: "" }, { image: "  " }, { image: "base", provider: "vz" }, { image: "base", provider: "utmctl" }])("rejects unusable creation before effects: %j", async options => {
        const result = await call("create_macos_vm", { name: "Rejected", ...options });
        expect(result.isError).toBe(true);
        expect(fixture.calls).toEqual([]);
        expect(readMacosDevices()).toEqual([]);
    });

    it("retains the owned source clone path", async () => {
        expect((await create()).isError).not.toBe(true);
        const source = readMacosDevices()[0];
        expect((await call("create_macos_vm", { name: "Copy", deviceId: "copy", sourceDeviceId: source.id })).isError).not.toBe(true);
        const copy = readMacosDevices().find((device: any) => device.id === "copy");
        expect(copy).toMatchObject({ providerResourceManaged: true, clonedFrom: { deviceId: source.id, providerInstance: source.providerInstance } });
        expect(mutations().at(-1)?.args).toEqual(["clone", source.providerInstance, copy.providerInstance]);
    });

    it("cleans a timed-out clone without publishing a usable device", async () => {
        fixture.cloneTimeout = true;
        expect((await create()).isError).toBe(true);
        expect(mutations().map(call => call.args[0])).toEqual(["clone", "delete"]);
        expect(mutations()[1].args[1]).toBe(mutations()[0].args[2]);
        expect(readMacosDevices()).toEqual([]);
    });

    it("rolls back a clone if its owner state cannot be persisted", async () => {
        fixture.stateFailure = true;
        expect(await create()).toEqual({
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ error: "Unexpected error: simulated state write failure" }) }],
        });
        expect(mutations().map(call => call.args[0])).toEqual(["clone", "delete"]);
        expect(readMacosDevices()).toEqual([]);
    });

    it("normalizes the image for managed creation and advertises only supported providers", () => {
        expect(normalizePublicToolArgs("create_macos_vm", { name: "Mac", image: "base" })).toMatchObject({ sourceImage: "base" });
        const schema = TOOLS.find((tool: any) => tool.name === "create_macos_vm")!.inputSchema;
        expect(schema.properties.provider.enum).toEqual(["auto", "tart"]);
        expect(schema.oneOf[1].required).toEqual(["image"]);
    });

    it("passes the maximum public exec timeout through to SSH", async () => {
        expect((await create({ ssh: { host: "guest", user: "test" } })).isError).not.toBe(true);
        fixture.calls.length = 0;
        expect((await call("exec", { deviceId: "managed-mac", command: "echo ready", timeoutMs: 600000 })).isError).not.toBe(true);
        expect(fixture.calls).toContainEqual(expect.objectContaining({ command: "/fixture/ssh", timeout: 600000, args: expect.arrayContaining(["echo ready"]) }));
    });
});
