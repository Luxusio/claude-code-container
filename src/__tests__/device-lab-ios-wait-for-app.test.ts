import { spawnSync } from "child_process";
import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
    handlers: [] as Array<(request: any) => Promise<any>>,
    observe: (_args: string[]): any => ({ status: 2, stdout: "", stderr: "simulator unavailable" }),
    calls: [] as string[][],
    allowances: [] as number[],
    device: null as any,
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@ccc/device-lab/providers/commands.mjs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    commandPath: (name: string) => name === "xcrun" ? "/fixture/xcrun" : null,
    run: (_cmd: string, args: string[], options?: { timeout?: number }) => {
        if (options?.timeout !== undefined) fixture.allowances.push(options.timeout);
        fixture.calls.push(args);
        if (args[1] === "list") return { status: 0, stdout: JSON.stringify({ devices: { runtime: [
            { udid: fixture.device.udid, name: fixture.device.simulatorName, state: "Booted" },
        ] } }), stderr: "" };
        return fixture.observe(args);
    },
}));
vi.mock("@ccc/device-lab/providers/state/ios-state.mjs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    findIosDevice: (id: string) => fixture.device?.id === id ? fixture.device : null,
}));
import { ownerId } from "@ccc/device-lab/providers/context.mjs";
import { waitForIosApp } from "@ccc/device-lab/providers/backends/ios-simulator.mjs";
import { startServer } from "../../device-lab-mcp/src/server.mjs";

const bundleId = "com.apple.mobilesafari";
const result = (status: number | null, stdout = "", stderr = "", extra = {}) => ({ status, stdout, stderr, ...extra });
const failed = () => result(2, "", "simulator unavailable");
const isPgrep = (args: string[]) => args[3] === "pgrep";
async function finish<T>(pending: Promise<T>) {
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    // waitUntil yields through real timers while native observations can schedule more fake timers.
    await vi.waitUntil(async () => {
        await vi.runAllTimersAsync();
        return settled;
    }, { timeout: 5000, interval: 1 });
    return pending;
}
const wait = (timeoutMs = 1) => finish(waitForIosApp("/fixture/xcrun", "SIM-UDID", bundleId, timeoutMs, 50));
// Exercise native asynchronous completion before the real provider's fake-timer pause on every host.
const call = (name: string, args: Record<string, unknown>) => finish(readFile(new URL(import.meta.url))
    .then(() => fixture.handlers[1]({ params: { name, arguments: args } })));
const args = { deviceId: "ios-observation-fixture", appId: bundleId, timeoutMs: 1, intervalMs: 50, implicitBroker: false };

beforeAll(async () => { await startServer(); });
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    fixture.calls.length = 0;
    fixture.allowances.length = 0;
    fixture.observe = failed;
    fixture.device = { id: args.deviceId, udid: "SIM-UDID", simulatorName: `ccc-${ownerId()}-observation` };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("iOS Simulator app observation", () => {
    it("rejects a native PID observed at the deadline and starts no further command", async () => {
        fixture.observe = () => { vi.setSystemTime(Date.now() + 10); return result(0, "123\n"); };
        expect(await wait(10)).toMatchObject({ running: false, timeoutMs: 10 });
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.allowances).toEqual([10]);
    });

    it("preserves the native minimum allowance for a zero requested timeout", async () => {
        fixture.observe = () => { vi.setSystemTime(Date.now() + 1); return failed(); };
        expect(await wait(0)).toHaveProperty("error");
        expect(fixture.allowances).toEqual([1]);
        expect(fixture.calls).toHaveLength(1);
    });

    it("reduces subprocess allowance across fallbacks and skips work after exhaustion", async () => {
        fixture.observe = () => { vi.setSystemTime(Date.now() + 30); return failed(); };
        const observed = await wait(100);
        expect(observed).toHaveProperty("error");
        expect(fixture.allowances).toEqual([100, 70, 40, 10]);
        expect(fixture.calls).toHaveLength(4);
    });

    it("caps the final pause and does not begin a new sweep at the deadline", async () => {
        fixture.observe = () => { vi.setSystemTime(Date.now() + 2); return result(1); };
        const timer = vi.spyOn(globalThis, "setTimeout");
        expect(await wait(20)).toMatchObject({ running: false });
        expect(fixture.calls).toHaveLength(5);
        expect(timer).toHaveBeenCalledWith(expect.any(Function), 10);
    });

    it("retains pgrep positive observations and stops querying immediately", async () => {
        fixture.observe = () => result(0, "123\n", "warning");
        expect(await wait()).toMatchObject({ running: true, pid: "123", status: 0, stderr: "warning" });
        expect(fixture.calls).toHaveLength(1);
    });

    it("falls back in domain order when the guest has no pgrep", async () => {
        fixture.observe = (argv) => argv.at(-1) === "gui/501"
            ? result(0, `UIKitApplication:${bundleId}[1234]`) : result(2, "", "No such file or directory");
        expect(await wait()).toMatchObject({ running: true, observedBy: "launchctl-gui/501", status: 0 });
        expect(fixture.calls.map((argv) => argv.slice(3))).toEqual([
            ["pgrep", "-f", bundleId], ["pgrep", "-i", "-f", "mobilesafari"],
            ["launchctl", "print", "user/501"], ["launchctl", "print", "gui/501"],
        ]);
    });

    it("uses clean pgrep absence metadata despite failed fallback commands", async () => {
        fixture.observe = (argv) => isPgrep(argv) ? result(1) : failed();
        expect(await wait()).toEqual({ running: false, timeoutMs: 1, stdout: "", stderr: "", status: 0, nativeStatus: 1,
            observedBy: "pgrep-and-launchctl" });
    });

    it("accepts a clean launchctl absence even if pgrep and other domains fail", async () => {
        fixture.observe = (argv) => argv.at(-1) === "user/501" ? result(0, "other.app", "warning") : failed();
        expect(await wait()).toMatchObject({ running: false, status: 0, stdout: "other.app", stderr: "warning" });
    });

    it.each([result(1, "unexpected"), result(1, "", "permission denied")])("does not mistake pgrep exit 1 diagnostics for absence: %j", async (observation) => {
        fixture.observe = (argv) => isPgrep(argv) ? observation : failed();
        expect(await wait()).toHaveProperty("error");
    });

    it("reports total command failure instead of clean absence", async () => {
        const observed = await wait();
        expect(observed).not.toHaveProperty("running");
        expect(observed.error.stderr).toContain("simulator unavailable");
    });

    it("retains a real ENOENT spawn diagnostic when stderr is empty", async () => {
        const missing = spawnSync("/definitely-missing-ccc-ios-observation/xcrun", [], { encoding: "utf8" });
        expect(missing.error).toHaveProperty("code", "ENOENT");
        fixture.observe = () => missing;
        expect((await wait()).error.stderr).toContain("ENOENT");
    });

    it.each([
        { error: Object.assign(new Error("spawn failed"), { code: "EACCES" }) },
        { signal: "SIGTERM" },
    ])("rejects apparently positive exit 0 accompanied by %j", async (extra) => {
        fixture.observe = () => result(0, `123 ${bundleId}`, "", extra);
        const observed = await wait();
        expect(observed).not.toHaveProperty("running");
        expect(observed.error.stderr).toContain("signal" in extra ? "SIGTERM" : "spawn failed");
    });

    it.each([true, false])("uses only the final sweep's trust (first clean=%s)", async (firstClean) => {
        fixture.observe = (argv) => {
            const clean = Date.now() === 0 ? firstClean : !firstClean;
            return clean && isPgrep(argv) ? result(1) : failed();
        };
        const observed = await wait(51);
        expect(fixture.calls).toHaveLength(10);
        if (firstClean) expect(observed.error.stderr).toContain("simulator unavailable");
        else expect(observed).toMatchObject({ running: false, status: 0, nativeStatus: 1, stderr: "" });
    });

    it("bounds long multibyte failure details and marks truncation", async () => {
        fixture.observe = () => result(2, "", "simulator unavailable " + "界".repeat(100000));
        const observed = await wait();
        expect(observed.error.stderr).toContain("simulator unavailable");
        expect(observed.error.stderr).toContain("truncated");
        expect(Buffer.byteLength(observed.error.stderr)).toBeLessThanOrEqual(64 * 1024);
    });
});

describe("public iOS wait and flow errors", () => {
    it.each([false, true])("returns an MCP observation error with the cause (detail=%s)", async (detail) => {
        const observed = await call("wait_for_app", { ...args, detail });
        expect(observed.isError).toBe(true);
        expect(observed.content[0].text).toContain("simulator unavailable");
        expect(observed.content[0].text).not.toContain('"running":false');
        expect(fixture.calls.some((argv) => argv[1] === "list")).toBe(true);
    });

    it("keeps standalone clean absence successful and includes provider and bundle in detail mode", async () => {
        fixture.observe = (argv) => isPgrep(argv) ? result(1) : failed();
        const observed = await call("wait_for_app", { ...args, detail: true });
        expect(observed.isError).toBe(false);
        expect(JSON.parse(observed.content[0].text)).toMatchObject({ running: false, matched: false, appId: bundleId, provider: "simctl", status: 0, nativeStatus: 1 });
    });

    it.each(["run_flow"])("%s stops with the original observation error before the next action", async (name) => {
        const observed = await call(name, { steps: [
            { tool: "wait_for_app", arguments: args },
            { tool: "wait_for_app", arguments: args },
        ] });
        const body = JSON.parse(observed.content[0].text);
        expect(body).toMatchObject({ ok: false, stoppedAt: 0 });
        expect(body.results).toHaveLength(1);
        expect(body.results[0].isError).toBe(true);
        expect(body.results[0].error).toBeUndefined();
        expect(JSON.stringify(body.results[0].content)).toContain("simulator unavailable");
        expect(fixture.calls.filter((argv) => argv[0] === "simctl" && argv[1] === "list")).toHaveLength(1);
    });
});
