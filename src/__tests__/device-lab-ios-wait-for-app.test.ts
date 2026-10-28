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
const isBootstrapList = (args: string[]) => args[3] === "launchctl" && args[4] === "list";
const launchctlList = (...rows: string[]) => ["PID\tStatus\tLabel", ...rows].join("\n") + "\n";
const runningSafariRow = "30323\t0\tUIKitApplication:com.apple.mobilesafari[244c][rb-legacy]";
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
        fixture.observe = () => { vi.setSystemTime(Date.now() + 10); return result(0, launchctlList(runningSafariRow)); };
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
        expect(fixture.calls).toHaveLength(6);
        expect(timer).toHaveBeenCalledWith(expect.any(Function), 8);
    });

    it("retains pgrep positive observations and stops querying immediately", async () => {
        fixture.observe = (argv) => isBootstrapList(argv) ? failed() : result(0, "123\n", "warning");
        expect(await wait()).toMatchObject({ running: true, pid: "123", status: 0, stderr: "warning" });
        expect(fixture.calls.map((argv) => argv.slice(3))).toEqual([
            ["launchctl", "list"], ["pgrep", "-f", bundleId],
        ]);
    });

    it("treats clean bootstrap absence as authoritative despite legacy bundle matches", async () => {
        fixture.observe = (argv) => isBootstrapList(argv)
            ? result(0, launchctlList("45\t0\tUIKitApplication:com.other.app[other][rb-legacy]"))
            : result(0, `123 ${bundleId}`);
        expect(await wait()).toMatchObject({ running: false, status: 0, stdout: "", stderr: "", observedBy: "launchctl-list" });
        expect(fixture.calls).toEqual([["simctl", "spawn", "SIM-UDID", "launchctl", "list"]]);
    });

    it("continues polling authoritative bootstrap absence until the app appears", async () => {
        fixture.observe = (argv) => {
            if (!isBootstrapList(argv)) throw new Error("clean bootstrap list must not query legacy observations");
            return result(0, fixture.calls.length === 1 ? launchctlList() : launchctlList(runningSafariRow));
        };
        expect(await wait(51)).toMatchObject({ running: true, pid: "30323", observedBy: "launchctl-list", stdout: "", stderr: "" });
        expect(fixture.calls).toEqual([
            ["simctl", "spawn", "SIM-UDID", "launchctl", "list"],
            ["simctl", "spawn", "SIM-UDID", "launchctl", "list"],
        ]);
    });

    it.each(["-", "0"])("does not treat the bootstrap job PID %s as a running app", async (pid) => {
        fixture.observe = () => result(0, launchctlList(`${pid}\t0\tUIKitApplication:${bundleId}[244c][rb-legacy]`));
        expect(await wait()).toMatchObject({ running: false, observedBy: "launchctl-list", stdout: "", stderr: "" });
        expect(fixture.calls).toHaveLength(1);
    });

    it.each([
        "UIKitApplication:com.apple.mobilesafari.extension[244c][rb-legacy]",
        "UIKitApplication:prefix.com.apple.mobilesafari[244c][rb-legacy]",
        "UIKitApplication:comXappleXmobilesafari[244c][rb-legacy]",
        "UIKitApplication:com.apple.mobilesafari",
    ])("does not match a neighboring bootstrap label %s", async (label) => {
        fixture.observe = () => result(0, launchctlList(`30323\t0\t${label}`));
        expect(await wait()).toMatchObject({ running: false, observedBy: "launchctl-list" });
        expect(fixture.calls).toHaveLength(1);
    });

    it.each([
        { name: "wrong header", stdout: `PID\tExit\tLabel\n${runningSafariRow}\n` },
        { name: "overflow PID", stdout: launchctlList(`9007199254740992\t0\tUIKitApplication:${bundleId}[244c][rb-legacy]`) },
        { name: "missing label column", stdout: launchctlList("30323\t0") },
        { name: "malformed row after a matching app", stdout: launchctlList(runningSafariRow, "malformed native row") },
    ])("falls back when the bootstrap list has a $name", async ({ stdout }) => {
        fixture.observe = (argv) => isBootstrapList(argv) ? result(0, stdout) : result(0, "321\n");
        expect(await wait()).toMatchObject({ running: true, pid: "321" });
        expect(fixture.calls.map((argv) => argv.slice(3))).toEqual([
            ["launchctl", "list"], ["pgrep", "-f", bundleId],
        ]);
    });

    it("falls back in domain order when the guest has no pgrep", async () => {
        fixture.observe = (argv) => argv.at(-1) === "gui/501"
            ? result(0, `UIKitApplication:${bundleId}[1234]`) : result(2, "", "No such file or directory");
        expect(await wait()).toMatchObject({ running: true, observedBy: "launchctl-gui/501", status: 0 });
        expect(fixture.calls.map((argv) => argv.slice(3))).toEqual([
            ["launchctl", "list"],
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
            const clean = fixture.calls.length <= 6 ? firstClean : !firstClean;
            return clean && isPgrep(argv) ? result(1) : failed();
        };
        const observed = await wait(51);
        expect(fixture.calls).toHaveLength(12);
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
    it("recognizes the captured Safari bootstrap row through public MCP without exporting the service table", async () => {
        const nativeTable = launchctlList("-\t0\tcom.private.fixture-service", runningSafariRow);
        fixture.observe = (argv) => {
            if (!isBootstrapList(argv)) throw new Error("captured bootstrap row must not need pgrep or fixed user domains");
            return result(0, nativeTable);
        };
        for (const detail of [true, false]) {
            fixture.calls.length = 0;
            const observed = await call("wait_for_app", { ...args, detail });
            expect(observed.isError).toBe(false);
            const body = JSON.parse(observed.content[0].text);
            expect(body).toMatchObject({ matched: true, appId: bundleId, provider: "simctl", pid: "30323", observedBy: "launchctl-list" });
            expect(body.stdout || "").toBe("");
            expect(body.stderr || "").toBe("");
            expect(JSON.stringify(observed)).not.toContain("com.private.fixture-service");
            expect(JSON.stringify(observed)).not.toContain("UIKitApplication:");
            expect(fixture.calls.filter((argv) => argv[1] === "spawn"))
                .toEqual([["simctl", "spawn", "SIM-UDID", "launchctl", "list"]]);
        }
    });

    it.each([false, true])("returns an MCP observation error with the cause (detail=%s)", async (detail) => {
        const observed = await call("wait_for_app", { ...args, detail });
        expect(observed.isError).toBe(true);
        expect(observed.content[0].text).toContain("simulator unavailable");
        expect(observed.content[0].text).not.toContain('"running":false');
        expect(fixture.calls.some((argv) => argv[1] === "list")).toBe(true);
    });

    it.each([
        { name: "native timeout errno", errorCode: "ETIMEDOUT", timedOut: false, selectedCode: "ETIMEDOUT" },
        { name: "explicit native timeout", errorCode: "PRIVATE_SECRET", timedOut: true, selectedCode: null },
    ])("retains the final observation's $name through public MCP presentation", async ({ errorCode, timedOut, selectedCode }) => {
        const privateOutput = "private native output /Users/private/secret token=fixture-secret";
        const privateMessage = "private spawn message fixture-message-secret";
        const privateArgs = ["private-spawn-argument"];
        const finalReceipt = result(null, privateOutput, privateOutput, {
            signal: "SIGTERM", timedOut,
            error: { code: errorCode, message: privateMessage, path: "/Users/private/executable", spawnargs: privateArgs },
        });
        fixture.observe = (argv) => fixture.calls.filter((call) => call[1] === "spawn").length === 12 && argv.at(-1) === "system"
            ? finalReceipt : result(7, "earlier native output", "earlier observation failed", {
                signal: "SIGINT", error: { code: "EACCES" },
            });
        const expected = {
            ok: false, error: "provider-command-failed",
            execution: {
                status: null, signal: "SIGTERM", timedOut: true, errorCode: selectedCode,
                diagnosticCode: "native-timeout",
            },
        };
        for (const detail of [true, false]) {
            vi.setSystemTime(0);
            fixture.calls.length = 0;
            const observed = await call("wait_for_app", { ...args, timeoutMs: 51, detail });
            expect(fixture.calls.filter((argv) => argv[1] === "spawn")).toHaveLength(12);
            expect(observed.isError).toBe(true);
            expect(observed.structuredContent).toEqual(expected);
            const evidence = JSON.stringify(observed.structuredContent);
            for (const privateValue of [privateOutput, privateMessage, privateArgs[0], "/Users/private/executable"]) {
                expect(evidence).not.toContain(privateValue);
            }
            expect(evidence).not.toContain("EACCES");
            expect(evidence).not.toContain("SIGINT");
        }
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
