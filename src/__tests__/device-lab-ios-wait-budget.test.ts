import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { createServer } from "http";
import { AddressInfo } from "net";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { withSharedMutationLock } from "@ccc/device-lab/providers/state/shared-mutation-lock.mjs";
import { join } from "path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as waitBudgets from "@ccc/device-lab/providers/wait-budget.mjs";
import * as commands from "@ccc/device-lab/providers/commands.mjs";
import * as simulatorState from "@ccc/device-lab/providers/state/ios-state.mjs";
import { ownerId } from "@ccc/device-lab/providers/context.mjs";
import * as simulator from "@ccc/device-lab/providers/backends/ios-simulator.mjs";
import * as state from "@ccc/device-lab/providers/state/ios-device-state.mjs";
import * as leases from "@ccc/device-lab/providers/state/physical-lease-store.mjs";
import { handleIosRealTool } from "@ccc/device-lab/providers/backends/ios-device.mjs";

let testHome: string;
let restoreEnvironment: () => void;
let device: any;
beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "ccc-ios-wait-budget-"));
    restoreEnvironment = isolateDeviceLabTestEnvironment(testHome);
    device = { id: "physical-budget", udid: "UDID", leaseClaimId: "claim", leaseClaimNonce: "nonce", appium: { runtimeId: "generation", sessionId: "session", serverUrl: "http://fixture" } };
    vi.spyOn(state, "findIosRealDevice").mockImplementation(() => device);
    vi.spyOn(leases, "heartbeatPhysicalLease").mockReturnValue({ ok: true, lease: {} });
    vi.spyOn(simulator, "iosAppiumDiscovery").mockReturnValue({ available: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); restoreEnvironment(); rmSync(testHome, { recursive: true, force: true }); });
const wait = (name = "mobile_wait_for_text", timeoutMs = 100) => handleIosRealTool(name, { deviceId: device.id, text: "needle", bundleId: "app.target", timeoutMs, intervalMs: 10 });

it.each(["mobile_wait_for_text", "mobile_wait_for_app"])("%s bootstraps once and shares shrinking allowance with lease checks", async (name) => {
    let time = 0;
    // Only observation time is synthetic: native lock/process probes must keep
    // their real monotonic clock and timers to remain bounded on Windows.
    vi.spyOn(waitBudgets, "createWaitBudget").mockImplementation((timeoutMs) => {
        const deadline = time + timeoutMs;
        const remaining = () => Math.max(0, deadline - time);
        return { timeoutMs, remaining, requestTimeout: (max = 120000) => Math.min(max, Math.ceil(remaining())), pause: async () => {} };
    });
    const observations: number[] = [];
    // Observe the abort deadline installed by the real HTTP adapter.
    const timers = vi.spyOn(globalThis, "setTimeout");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/status") || url.endsWith("/session/session")) { time += 1000; return Response.json({ value: {} }); }
        observations.push(Number(timers.mock.lastCall![1]));
        time += 30;
        return Response.json({ value: observations.length === 2 ? (name.endsWith("text") ? "needle" : { bundleId: "app.target" }) : "unrelated" });
    });
    const pending = wait(name);
    expect((await pending)?.isError).toBe(false);
    expect(observations).toEqual([100, 70]);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/status"))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/session/session"))).toHaveLength(1);
    const guards = vi.mocked(leases.heartbeatPhysicalLease).mock.calls.filter((call) => call[3]?.waitBudget);
    expect(guards).toHaveLength(2);
    expect(guards[0][3].waitBudget).toBe(guards[1][3].waitBudget);
});

it.each(["lease", "generation", "attachment"])("stops polling after %s changes without repeating bootstrap", async (change) => {
    let observations = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (!url.endsWith("/source")) return Response.json({ value: {} });
        observations++;
        if (change === "lease") vi.mocked(leases.heartbeatPhysicalLease).mockReturnValue({ ok: false, error: "lease stolen" });
        else if (change === "generation") device = { ...device, appium: { ...device.appium, runtimeId: "successor" } };
        else device = { ...device, leaseClaimNonce: "successor" };
        return Response.json({ value: "unrelated" });
    });
    const pending = wait();
    expect((await pending)?.isError).toBe(true);
    expect(observations).toBe(1);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/status"))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/session/session"))).toHaveLength(1);
});

it("does not fetch after the physical lease guard exhausts the shared allowance", async () => {
    let time = 0;
    // Only observation time is synthetic: native lock/process probes must keep
    // their real monotonic clock and timers to remain bounded on Windows.
    vi.spyOn(waitBudgets, "createWaitBudget").mockImplementation((timeoutMs) => {
        const deadline = time + timeoutMs;
        const remaining = () => Math.max(0, deadline - time);
        return { timeoutMs, remaining, requestTimeout: (max = 120000) => Math.min(max, Math.ceil(remaining())), pause: async () => {} };
    });
    vi.mocked(leases.heartbeatPhysicalLease).mockImplementation((_backend, _udid, _id, options) => {
        if (options.waitBudget) time = 100;
        return { ok: true, lease: {} };
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ value: {} }));
    expect((await wait())?.isError).toBe(true);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["http://fixture/status", "http://fixture/session/session"]);
});

it.each(["headers", "body"])("aborts real stalled Appium %s within observation allowance", async (phase) => {
    const urls: string[] = [];
    const server = createServer((req, res) => {
        urls.push(req.url!);
        if (req.url?.endsWith("/source")) {
            if (phase === "body") { res.writeHead(200, { "content-type": "application/json" }); res.write('{"value":"needle'); }
            return;
        }
        res.end(JSON.stringify({ value: {} }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    device.appium.serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const started = performance.now();
    try {
        expect((await wait("mobile_wait_for_text", 100))?.isError).toBe(true);
        expect(performance.now() - started).toBeLessThan(1500);
        expect(urls).toEqual(["/status", "/session/session", "/session/session/source"]);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it.skipIf(process.platform === "win32")("rejects matching partial output from an actual timed-out simulator child", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-ios-budget-"));
    const exe = join(root, "xcrun");
    writeFileSync(exe, `#!${process.execPath}\nprocess.stdout.write('123 app.target'); setTimeout(() => {}, 3000);\n`);
    chmodSync(exe, 0o755);
    const start = performance.now();
    try {
        const result = await simulator.waitForIosApp(exe, "UDID", "app.target", 300, 500);
        expect(result).toHaveProperty("error");
        expect(result.error.stderr).toContain("123 app.target");
        expect(result).not.toHaveProperty("running", true);
        expect(performance.now() - start).toBeLessThan(1500);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["match", "generation", "body"])("simulator text wait preserves one bootstrap with real HTTP: %s", async (behavior) => {
    device.simulatorName = `ccc-${ownerId()}-budget`;
    vi.spyOn(simulatorState, "findIosDevice").mockImplementation(() => device);
    vi.spyOn(commands, "commandPath").mockImplementation((name) => `/fixture/${name}`);
    vi.spyOn(commands, "run").mockReturnValue({ status: 0, stdout: JSON.stringify({ devices: { runtime: [{ udid: device.udid, name: device.simulatorName, state: "Booted" }] } }), stderr: "" });
    const urls: string[] = [];
    let observations = 0;
    const server = createServer((req, res) => {
        urls.push(req.url!);
        if (req.url?.endsWith("/source")) {
            observations++;
            if (behavior === "body") { res.writeHead(200); res.write('{"value":"needle'); return; }
            if (behavior === "generation") device = { ...device, appium: { ...device.appium, runtimeId: "replacement" } };
            res.end(JSON.stringify({ value: observations > 1 ? "needle" : "unrelated" }));
            return;
        }
        res.end(JSON.stringify({ value: {} }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    device.appium.serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
        const response = await simulator.handleIosTool("mobile_wait_for_text", { deviceId: device.id, text: "needle", timeoutMs: 200, intervalMs: 10 });
        expect(response?.isError).toBe(behavior !== "match");
        expect(urls.filter((url) => url === "/status")).toHaveLength(1);
        expect(urls.filter((url) => url === "/session/session")).toHaveLength(1);
        expect(observations).toBe(behavior === "match" ? 2 : 1);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("real physical heartbeat carries its deadline through the hardware lock into a contended aggregate lock", () => {
    vi.mocked(leases.heartbeatPhysicalLease).mockRestore();
    const root = testHome;
    const aggregate = join(root, ".ccc/devices/physical-leases/ios-device.mutation.lock");
    const hardware = join(root, ".ccc/devices/physical-leases/ios-device/locks/UDID.mutation.lock");
    const start = performance.now();
    try {
        withSharedMutationLock(aggregate, () => {
            const deadline = performance.now() + 40;
            expect(() => leases.heartbeatPhysicalLease("ios-device", "UDID", device.id, {
                waitBudget: { remaining: () => Math.max(0, deadline - performance.now()) },
            })).toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
            expect(existsSync(hardware)).toBe(false);
        });
        expect(performance.now() - start).toBeLessThan(1500);
        expect(existsSync(aggregate)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
