import * as fixtureFs from "fs";
import * as windowsProcesses from "@ccc/device-lab/windows-system-powershell.js";
import { directorySymlink } from "./helpers/file-symlink-fixture.js";
import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { isolatedDeviceLabPackage } from "./helpers/isolated-device-lab-package.js";
import { createHash } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createServer } from "http";
import { AddressInfo } from "net";
import { homedir, hostname, tmpdir, uptime } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { appiumWebDriverRequestTimeoutMs, createDeviceBrokerServer, DEVICE_BROKER_APPIUM_LOCK_MANIFEST_LIMIT_BYTES, DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT, managedAppiumCommandLine, registerDeviceBrokerOwner } from "@ccc/device-lab/device-lab-broker.js";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { readDeviceRuntimeProcessIdentity } from "@ccc/device-lab/device-lab-process-identity.js";
import { cleanupOwner, close, listen, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";
import { renderBrokerAppium } from "@ccc/device-lab/device-lab/broker/broker-outcomes-codec.js";

vi.mock("fs", async (importOriginal) => ({ ...await importOriginal<typeof import("fs")>() }));

async function createFakeAppiumServer(sessionId = "BROKER-SESSION-1", options: {
    deleteStatus?: number; readyAfterStatusRequests?: number; sessionCreateFailures?: number; onSessionCreated?: () => void;
    statusBody?: unknown; statusStatus?: number; onStatus?: () => void;
    sessionBody?: unknown; sessionRaw?: string; sessionFailureMessage?: string; onSessionCreate?: () => void;
    inspectStatus?: number; onSessionInspected?: () => void;
    commandStatus?: number; commandBody?: unknown; commandRaw?: string;
} = {}) {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
    let statusRequests = 0;
    let sessionCreateRequests = 0;
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method || "GET", url: req.url || "/", body });
            if (req.method === "POST" && req.url === "/session") options.onSessionCreate?.();
            const sessionCreateFailure = req.method === "POST"
                && req.url === "/session"
                && ++sessionCreateRequests <= (options.sessionCreateFailures || 0);
            const status = sessionCreateFailure
                ? 500
                : req.method === "DELETE" && req.url === sessionPath ? options.deleteStatus || 200
                : req.method === "GET" && req.url === "/status" ? options.statusStatus || 200
                : req.method === "GET" && req.url === sessionPath ? options.inspectStatus || 200
                : req.url === `${sessionPath}/source` ? options.commandStatus || 200 : 200;
            res.writeHead(status, { "content-type": "application/json" });
            if (req.method === "GET" && req.url === "/status") {
                statusRequests += 1;
                options.onStatus?.();
                return res.end(JSON.stringify("statusBody" in options ? options.statusBody
                    : { value: { ready: statusRequests >= (options.readyAfterStatusRequests || 1) } }));
            }
            if (sessionCreateFailure) return res.end(JSON.stringify({ value: { error: "unknown error", message: options.sessionFailureMessage || "The instrumentation process cannot be initialized." } }));
            if (req.method === "POST" && req.url === "/session") {
                options.onSessionCreated?.();
                return res.end(options.sessionRaw ?? JSON.stringify("sessionBody" in options ? options.sessionBody
                    : { value: { sessionId, capabilities: body?.capabilities?.alwaysMatch || {} } }));
            }
            if (req.method === "GET" && req.url === sessionPath) {
                options.onSessionInspected?.();
                return res.end(JSON.stringify(status >= 400 ? { value: { error: "inspection failed" } } : { value: { sessionId } }));
            }
            if (req.method === "GET" && req.url === `${sessionPath}/source`) return res.end(options.commandRaw
                ?? JSON.stringify("commandBody" in options ? options.commandBody : { value: "<AppiumAUT />" }));
            if (req.method === "POST" && req.url === `${sessionPath}/actions`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "DELETE" && req.url === sessionPath) return res.end(JSON.stringify(status >= 400 ? { value: { error: "delete failed" } } : { value: null }));
            res.end(JSON.stringify({ value: null }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requests,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

function writePackagedAppiumManifests(packageRoot: string) {
    const packageText = JSON.stringify({ name: "@ccc/device-lab-mcp", version: "0.1.0", dependencies: { appium: "3.5.0" } });
    const lockText = JSON.stringify({ name: "@ccc/device-lab-mcp", version: "0.1.0", lockfileVersion: 3, packages: {} });
    const mcpRoot = join(packageRoot, "appium-runtime");
    mkdirSync(mcpRoot, { recursive: true });
    writeFileSync(join(mcpRoot, "package.json"), packageText);
    writeFileSync(join(mcpRoot, "package-lock.json"), lockText);
    return { packageText, lockText, mcpRoot };
}

function brokerAppiumTestPaths() {
    const runtimeRoot = join(homedir(), ".ccc", "devices", "broker", "appium-runtime");
    return {
        runtimeRoot,
        nodeModules: join(runtimeRoot, "node_modules"),
        entry: join(runtimeRoot, "node_modules", "appium", "index.js"),
        marker: join(runtimeRoot, ".ccc-runtime.json"),
        runtimePackage: join(runtimeRoot, "package.json"),
        runtimeLock: join(runtimeRoot, "package-lock.json"),
    };
}

function currentProcessAppiumRuntime(serverUrl: string, port: number, runtimeId: string, extra: Record<string, unknown> = {}) {
    const processIdentity = readDeviceRuntimeProcessIdentity(process.pid);
    if (!processIdentity) throw new Error("current process identity unavailable");
    return {
        authority: "host-broker",
        processOwner: "host-broker",
        startedBy: "broker.appium.start",
        runtimeId,
        launchPolicy: "node-direct-hidden-v1",
        serverPid: process.pid,
        processIdentity,
        serverUrl,
        port,
        ...extra,
    };
}

function iosSimulatorInventoryRunner(simulatorName: string, udid: string) {
    return vi.fn((command) => ({
        mode: command.mode,
        provider: command.provider,
        executable: command.executable,
        args: command.args,
        status: 0,
        stdout: command.provider === "xcrun" && command.args?.join(" ") === "simctl list devices -j"
            ? JSON.stringify({ devices: { runtime: [{ name: simulatorName, udid, state: "Booted" }] } })
            : "",
        stderr: "",
    }));
}

function writePhysicalLease(ownerId: string, backend: "android-device" | "ios-device", hardwareId: string, deviceId: string, claimId: string, claimNonce: string) {
    const leaseDir = join(homedir(), ".ccc", "devices", "physical-leases", backend, "locks");
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(join(leaseDir, `${encodeURIComponent(hardwareId)}.json`), JSON.stringify({
        backend,
        hardwareId,
        ownerId,
        deviceId,
        claimId,
        claimNonce,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
}

async function ownedCleanupChild(script: string, args: string[] = []) {
    const child = spawn(process.execPath, ["-e", `${script}\nprocess.stdout.write('ready\\n'); setInterval(() => {}, 1000);`, ...args], {
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    onTestFinished(() => reapCleanupChild(child));
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("owned cleanup child did not become ready")), 5000);
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("exit", code => { clearTimeout(timeout); reject(new Error(`owned cleanup child exited before ready: ${code}`)); });
        child.stdout!.once("data", () => { clearTimeout(timeout); resolve(); });
    });
    const identity = readDeviceRuntimeProcessIdentity(child.pid!);
    if (!identity) { child.kill("SIGKILL"); throw new Error("owned cleanup child identity unavailable"); }
    return { child, identity };
}

async function reapCleanupChild(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const reaped = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await reaped;
}

describe("device-lab host broker Appium session authority", () => {
    let originalHomeRestore: (() => void) | undefined;
    let fixtureHome: string | undefined;

    beforeEach(() => {
        fixtureHome = mkdtempSync(join(tmpdir(), "ccc-device-broker-appium-test-home-"));
        originalHomeRestore = isolateDeviceLabTestEnvironment(fixtureHome);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
        originalHomeRestore?.();
    });

    it("gives proxied WebDriver commands enough time for device-side clipboard work", () => {
        expect(appiumWebDriverRequestTimeoutMs(5000)).toBe(30000);
        expect(appiumWebDriverRequestTimeoutMs(60000)).toBe(60000);
        expect(appiumWebDriverRequestTimeoutMs(600000)).toBe(300000);
    });

    it("retains null readiness evidence without inventing response or compensation fields", () => {
        expect(renderBrokerAppium({ kind: "refused", reason: "provider-failed", error: "appium-server-not-ready",
            readiness: { ok: false, response: null } })).toEqual({ status: 502, payload: {
            ok: false, error: "appium-server-not-ready", readiness: { ok: false, response: null },
        } });
    });

    it.each(["headers", "body"])("aborts a stalled Appium %s within the explicit observation allowance", async (stall) => {
        const cwd = "/project/broker-appium-wait-stall-test";
        const ownerId = deviceLabOwnerId(cwd);
        let requests = 0;
        let upstreamClosed = false;
        const appium = createServer((_req, res) => {
            requests += 1;
            res.on("close", () => { upstreamClosed = true; });
            if (stall === "body") {
                res.writeHead(200, { "content-type": "application/json" });
                res.write('{"value":"<App>matching text</App>');
            }
        });
        const appiumUrl = await listen(appium);
        const port = (appium.address() as AddressInfo).port;
        // This tests the HTTP deadline, with process effects simulated through the
        // existing command-runner seam; native ownership has separate coverage.
        const commandRunner = vi.fn(() => { throw new Error("unexpected provider command"); });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(broker);
        writeBrokerDevices(ownerId, "android", [{
            id: "pixel-wait", status: "running", backend: "android-emulator",
            appium: currentProcessAppiumRuntime(appiumUrl, port, "wait-runtime", { sessionId: "WAIT" }),
        }]);
        try {
            const started = performance.now();
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.request", params: {
                    backend: "android-emulator", deviceId: "pixel-wait", method: "GET", path: "/source", requestTimeoutMs: 350,
                } }),
            });
            const payload = await response.json();
            expect(requests, JSON.stringify(payload)).toBe(1);
            expect(commandRunner).not.toHaveBeenCalled();
            expect(performance.now() - started).toBeLessThan(1800);
            expect(response.status).toBe(504);
            expect(payload).toMatchObject({ ok: false, error: "appium-request-timeout" });
            expect(JSON.stringify(payload)).not.toContain("matching text");
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(upstreamClosed).toBe(true);
        } finally {
            appium.closeAllConnections();
            await close(appium);
            await close(broker);
        }
    });

    it.each([0, -1, 600001, "100", null, true])("rejects invalid wire observation allowance %s before Appium access", async (requestTimeoutMs) => {
        const cwd = "/project/broker-invalid-wait-test";
        const ownerId = deviceLabOwnerId(cwd);
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(broker);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.request", params: {
                    backend: "android-emulator", deviceId: "missing", method: "GET", path: "/source", requestTimeoutMs,
                } }),
            });
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ ok: false, error: "invalid-appium-request-timeout" });
        } finally { await close(broker); }
    });

    it.each(["owner", "lease"])("never fetches after the observation budget expires in the %s lock", async (lockKind) => {
        const cwd = "/project/broker-wait-lock-test";
        const ownerId = deviceLabOwnerId(cwd);
        let requests = 0;
        const appium = createServer((_req, res) => { requests += 1; res.end('{"value":"match"}'); });
        const appiumUrl = await listen(appium);
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(broker);
        const deviceId = "physical-wait";
        writeBrokerDevices(ownerId, "ios-device", [{
            id: deviceId, status: "attached", backend: "ios-device", udid: "WAIT-UDID",
            leaseClaimId: "claim", leaseClaimNonce: "nonce",
            appium: currentProcessAppiumRuntime(appiumUrl, (appium.address() as AddressInfo).port, "lock-runtime", { sessionId: "WAIT" }),
        }]);
        writePhysicalLease(ownerId, "ios-device", "WAIT-UDID", deviceId, "claim", "nonce");
        const lockDir = lockKind === "owner"
            ? join(homedir(), ".ccc", "devices", "owners", ownerId, "ios-device", "operations")
            : join(homedir(), ".ccc", "devices", "physical-leases", "ios-device", "locks");
        mkdirSync(lockDir, { recursive: true });
        const lockFile = join(lockDir, lockKind === "owner"
            ? createHash("sha256").update(deviceId).digest("hex").slice(0, 32) + ".lock"
            : "WAIT-UDID.mutation.lock");
        writeFileSync(lockFile, JSON.stringify({ token: "held", pid: process.pid, createdAt: new Date().toISOString() }));
        try {
            const started = performance.now();
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.request", params: {
                    backend: "ios-device", deviceId, method: "GET", path: "/source", requestTimeoutMs: 120,
                } }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toMatchObject({ ok: false, error: "device-operation-lock-failed" });
            expect(performance.now() - started).toBeLessThan(1200);
            rmSync(lockFile);
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(requests).toBe(0);
        } finally { await close(appium); await close(broker); }
    });

    it("rejects forged iOS Simulator identities before reusing or creating Appium sessions", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-ios-owner-fence-test");
        const simulatorName = `ccc-${ownerId}-forged-alias`;
        const commandRunner = iosSimulatorInventoryRunner("foreign-simulator", "FOREIGN-UDID");
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-ios-owner-fence-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { xcrun: "/fake/xcrun", appium: "/fake/appium" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "ios", [{
            id: "ios-forged",
            status: "booted",
            backend: "ios-simulator",
            simulatorName,
            udid: "FOREIGN-UDID",
            appium: {
                authority: "host-broker",
                processOwner: "host-broker",
                serverUrl: "http://127.0.0.1:65534",
                sessionId: "FOREIGN-SESSION",
            },
        }]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.appium.session.ensure",
                    params: { backend: "ios-simulator", deviceId: "ios-forged", force: true },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "ios-simulator-owner-identity-mismatch",
                backend: "ios-simulator",
                deviceId: "ios-forged",
            }));
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "xcrun",
                args: ["simctl", "list", "devices", "-j"],
            }), expect.any(Object));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("rejects physical Appium effects without the attachment's exact lease", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-physical-lease-fence-test");
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-physical-lease-fence-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "ios-device", [{
            id: "iphone-forged",
            status: "attached",
            backend: "ios-device",
            udid: "FOREIGN-PHYSICAL-UDID",
            leaseClaimId: "forged-claim",
            leaseClaimNonce: "forged-nonce",
            appium: { serverUrl: "http://127.0.0.1:65534", sessionId: "FOREIGN-SESSION" },
        }]);

        try {
            for (const [method, params] of [
                ["broker.appium.session.ensure", { backend: "ios-device", deviceId: "iphone-forged" }],
                ["broker.appium.session.delete", { backend: "ios-device", deviceId: "iphone-forged" }],
                ["broker.appium.request", { backend: "ios-device", deviceId: "iphone-forged", method: "GET", path: "/source" }],
            ] as const) {
                const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                    method: "POST",
                    headers: ownerRpcHeaders(ownerId),
                    body: JSON.stringify({ method, params }),
                });
                expect(response.status).toBe(409);
                expect(await response.json()).toEqual(expect.objectContaining({
                    ok: false,
                    error: "physical-device-not-attached",
                    ownerId,
                    deviceId: "iphone-forged",
                }));
            }
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("recognizes only CCC-managed Appium listener command lines", () => {
        const packageRoot = "C:\\Users\\TestUser\\Project\\claude-code-container";
        const runtimeRoot = "C:\\Users\\TestUser\\.ccc\\devices\\broker\\appium-runtime";
        expect(managedAppiumCommandLine(
            '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\TestUser\\.ccc\\devices\\broker\\appium-runtime\\node_modules\\appium\\index.js server',
            packageRoot,
            runtimeRoot,
        )).toBe(true);
        expect(managedAppiumCommandLine(
            'node.exe C:\\Users\\TestUser\\Project\\claude-code-container\\node_modules\\appium\\index.js server',
            packageRoot,
            runtimeRoot,
        )).toBe(true);
        expect(managedAppiumCommandLine(
            'node.exe D:\\other\\node_modules\\appium\\index.js server',
            packageRoot,
            runtimeRoot,
        )).toBe(false);
        expect(managedAppiumCommandLine(
            'node.exe D:\\other\\node_modules\\appium\\index.js server',
            packageRoot,
            runtimeRoot,
            true,
        )).toBe(false);
        expect(managedAppiumCommandLine("node.exe unrelated-server.js", packageRoot, runtimeRoot, true)).toBe(false);
    });

    it.each([
        { name: "absent error", native: {} },
        { name: "empty error", native: { error: "" } },
    ])("starts and stops host-broker owned Appium server metadata without creating a WebDriver session ($name)", async ({ native }) => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-process-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            pid: 45678,
            stdout: "native launch output",
            stderr: "native launch diagnostic",
            ...native,
        }));
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-process-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { appium: "/fake/appium" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        writeBrokerDevices(ownerId, "ios-device", [
            { id: "iphone-owned", status: "attached", backend: "ios-device", udid: "REAL-UDID-1", appium: null },
        ]);

        try {
            const start = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "ios-device", deviceId: "iphone-owned", port: 8100 },
                }),
            });
            expect(start.status).toBe(200);
            const started = await start.json();
            expect(started.result.execution).toEqual({
                mode: "detached", provider: "appium", executable: "/fake/appium",
                args: ["server", "--port", "8100", "--base-path", "/"], status: 0, pid: 45678,
                stdout: "native launch output", stderr: "native launch diagnostic", ...native,
            });
            expect(started.result.execution).not.toHaveProperty("ok");
            expect(started.result.execution).not.toHaveProperty("receipt");
            expect(started).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    started: true,
                    reused: false,
                    session: null,
                    appium: expect.objectContaining({
                        authority: "host-broker",
                        processOwner: "host-broker",
                        startedBy: "broker.appium.start",
                        launchPolicy: "node-direct-hidden-v1",
                        serverUrl: "http://127.0.0.1:8100",
                        serverPid: 45678,
                        port: 8100,
                        automationName: "XCUITest",
                        provider: "appium-xcuitest",
                        physical: true,
                    }),
                    execution: expect.objectContaining({
                        mode: "detached",
                        provider: "appium",
                        executable: "/fake/appium",
                        args: ["server", "--port", "8100", "--base-path", "/"],
                    }),
                }),
            }));
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(killSpy).not.toHaveBeenCalled();

            const reused = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "ios-device", deviceId: "iphone-owned", port: 8100 },
                }),
            });
            expect(reused.status).toBe(200);
            expect(await reused.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ started: false, reused: true }),
            }));
            expect(commandRunner).toHaveBeenCalledTimes(1);

            const stop = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.stop",
                    params: { backend: "ios-device", deviceId: "iphone-owned" },
                }),
            });
            expect(stop.status).toBe(200);
            expect(await stop.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    stopped: true,
                    stalePid: false,
                    signal: expect.objectContaining({ attempted: false, ok: true, simulated: true }),
                }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it.each([undefined, "native install error"])("provisions an isolated broker Appium runtime and hides all Windows child processes (install error=%s)", async (installError) => {
        const packageRoot = mkdtempSync(join(tmpdir(), "ccc-device-broker-packaged-appium-"));
        const ownerId = deviceLabOwnerId(packageRoot);
        const originalJavaHome = process.env.JAVA_HOME;
        const originalNodeOptions = process.env.NODE_OPTIONS;
        const appiumShim = join(homedir(), ".ccc", "devices", "broker", "appium-runtime", "node_modules", ".bin", "appium.cmd");
        const appiumEntry = join(homedir(), ".ccc", "devices", "broker", "appium-runtime", "node_modules", "appium", "index.js");
        const appiumMarker = join(homedir(), ".ccc", "devices", "broker", "appium-runtime", ".ccc-runtime.json");
        const adb = join(packageRoot, "android-sdk", "platform-tools", "adb.exe");
        const javaHome = join(packageRoot, "android-studio", "jbr");
        const packageBytes = JSON.stringify({ name: "@ccc/device-lab-mcp", version: "0.1.0", dependencies: { appium: "3.5.0" } });
        const lockBytes = JSON.stringify({ name: "@ccc/device-lab-mcp", version: "0.1.0", lockfileVersion: 3, packages: {} });
        mkdirSync(join(packageRoot, "appium-runtime"), { recursive: true });
        mkdirSync(join(packageRoot, "android-sdk", "platform-tools"), { recursive: true });
        mkdirSync(join(javaHome, "bin"), { recursive: true });
        writeFileSync(join(packageRoot, "appium-runtime", "package.json"), packageBytes);
        writeFileSync(join(packageRoot, "appium-runtime", "package-lock.json"), lockBytes);
        writeFileSync(adb, "");
        writeFileSync(join(javaHome, "bin", "java.exe"), "");
        let externalMarker: string | null = null;
        let externalMarkerBytes: string | null = null;
        if (process.platform !== "win32") {
            externalMarker = join(packageRoot, "external-appium-runtime-marker.json");
            externalMarkerBytes = JSON.stringify({
                manifestHash: createHash("sha256").update(packageBytes).update(lockBytes).digest("hex"),
            });
            mkdirSync(join(appiumShim, ".."), { recursive: true });
            mkdirSync(join(appiumEntry, ".."), { recursive: true });
            writeFileSync(appiumShim, "");
            writeFileSync(appiumEntry, "");
            writeFileSync(externalMarker, externalMarkerBytes);
            symlinkSync(externalMarker, appiumMarker);
        }
        process.env.JAVA_HOME = javaHome;
        process.env.NODE_OPTIONS = "--trace-warnings";
        const commandRunner = vi.fn((command) => {
            if (command.provider === "npm-appium-runtime") {
                mkdirSync(join(appiumShim, ".."), { recursive: true });
                mkdirSync(join(appiumEntry, ".."), { recursive: true });
                writeFileSync(appiumShim, "");
                writeFileSync(appiumEntry, "");
            }
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                pid: command.provider === "appium" ? 45679 : undefined,
                stdout: "native installation output",
                stderr: "native installation diagnostic",
                ...(command.provider === "npm-appium-runtime" && installError ? { error: installError } : {}),
            };
        });
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(packageRoot);
        const server = createIsolatedBrokerServer({
            cwd: packageRoot,
            cliPath: join(packageRoot, "dist", "index.js"),
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { adb },
            commandRunner,
        });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "android", [
            { id: "pixel-packaged-appium", status: "running", backend: "android-emulator", appium: null },
        ]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "android-emulator", deviceId: "pixel-packaged-appium" },
                }),
            });
            const payload = await response.json();
            if (installError) {
                expect(response.status).toBe(502);
                expect(payload).toMatchObject({ ok: false, error: "appium-runtime-install-failed" });
                expect(payload.runtime.execution).toEqual({
                    mode: "exec", provider: "npm-appium-runtime", executable: commandRunner.mock.calls[0][0].executable,
                    args: ["ci", "--prefix", join(homedir(), ".ccc", "devices", "broker", "appium-runtime"), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
                    status: 0, stdout: "native installation output", stderr: "native installation diagnostic", error: installError,
                });
                expect(payload.runtime.execution).not.toHaveProperty("ok");
                expect(payload.runtime.execution).not.toHaveProperty("receipt");
                expect(commandRunner.mock.calls.map(([command]) => command.provider)).toEqual(["npm-appium-runtime"]);
                expect(existsSync(appiumMarker)).toBe(false);
                return;
            }
            expect(response.status).toBe(200);
            expect(payload.result.execution).toEqual(commandRunner.mock.results[1].value);
            expect(payload.result.execution).not.toHaveProperty("ok");
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                mode: "exec",
                provider: "npm-appium-runtime",
                args: expect.arrayContaining(["ci", "--omit=dev", "--ignore-scripts"]),
            }), expect.objectContaining({ timeoutMs: 300000 }));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "appium",
                executable: process.execPath,
                args: [appiumEntry, "server", "--port", expect.any(String), "--base-path", "/", "--allow-insecure", "uiautomator2:adb_shell"],
                cwd: join(homedir(), ".ccc", "devices", "broker", "appium-runtime"),
                env: expect.objectContaining({
                    ANDROID_HOME: join(packageRoot, "android-sdk"),
                    ANDROID_SDK_ROOT: join(packageRoot, "android-sdk"),
                    JAVA_HOME: javaHome,
                    NODE_OPTIONS: expect.stringMatching(/^--trace-warnings --require=".*hidden-child-processes-[a-f0-9]{32}\.cjs"$/),
                }),
            }), expect.anything());
            const command = commandRunner.mock.calls.find(([candidate]) => candidate.provider === "appium")?.[0];
            const preloadMatch = String(command?.env?.NODE_OPTIONS || "").match(/--require="([^"]+)"/);
            expect(preloadMatch?.[1]).toBeTruthy();
            const preload = readFileSync(String(preloadMatch?.[1]), "utf8");
            for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
                expect(preload).toContain(`childProcess.${method} = function`);
            }
            expect(preload).toContain("windowsHide: true");
            if (externalMarker && externalMarkerBytes) {
                expect(readFileSync(externalMarker, "utf8")).toBe(externalMarkerBytes);
                expect(lstatSync(appiumMarker).isSymbolicLink()).toBe(false);
            }
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(packageRoot, { recursive: true, force: true });
            if (originalJavaHome === undefined) delete process.env.JAVA_HOME;
            else process.env.JAVA_HOME = originalJavaHome;
            if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
            else process.env.NODE_OPTIONS = originalNodeOptions;
        }
    });

    it("rejects linked and oversized packaged Appium manifests before installation", async () => {
        const packageRoot = mkdtempSync(join(tmpdir(), "ccc-device-broker-appium-manifest-fence-"));
        const ownerId = deviceLabOwnerId(packageRoot);
        const { mcpRoot } = writePackagedAppiumManifests(packageRoot);
        const externalPackage = join(packageRoot, "external-package.json");
        writeFileSync(externalPackage, JSON.stringify({ name: "external" }));
        const commandRunner = vi.fn(() => ({ mode: "exec" as const, provider: "unexpected", status: 0, stdout: "", stderr: "" }));
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(packageRoot);
        const server = createIsolatedBrokerServer({
            cwd: packageRoot,
            host: "127.0.0.1",
            port: 0,
            commandRunner,
        });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "android", [
            { id: "pixel-manifest-fence", status: "running", backend: "android-emulator", appium: null },
        ]);

        try {
            if (process.platform !== "win32") {
                rmSync(join(mcpRoot, "package.json"));
                symlinkSync(externalPackage, join(mcpRoot, "package.json"));
                const linked = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                    method: "POST",
                    headers: ownerRpcHeaders(ownerId),
                    body: JSON.stringify({
                        method: "broker.appium.start",
                        params: { backend: "android-emulator", deviceId: "pixel-manifest-fence" },
                    }),
                });
                expect(linked.status).toBe(502);
                expect(await linked.json()).toEqual(expect.objectContaining({
                    error: "appium-runtime-manifest-invalid",
                    runtime: expect.objectContaining({ detail: "appium-runtime-package-state-invalid" }),
                }));
                rmSync(join(mcpRoot, "package.json"));
                writeFileSync(join(mcpRoot, "package.json"), JSON.stringify({ name: "@ccc/device-lab-mcp" }));
            }

            const externalLock = join(packageRoot, "external-package-lock.json");
            writeFileSync(externalLock, JSON.stringify({ lockfileVersion: 3, packages: {} }));
            rmSync(join(mcpRoot, "package-lock.json"));
            linkSync(externalLock, join(mcpRoot, "package-lock.json"));
            const linkedLock = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "android-emulator", deviceId: "pixel-manifest-fence" },
                }),
            });
            expect(linkedLock.status).toBe(502);
            expect(await linkedLock.json()).toEqual(expect.objectContaining({
                error: "appium-runtime-manifest-invalid",
                runtime: expect.objectContaining({ detail: "appium-runtime-lock-state-invalid" }),
            }));

            rmSync(join(mcpRoot, "package-lock.json"));
            writeFileSync(join(mcpRoot, "package-lock.json"), Buffer.alloc(DEVICE_BROKER_APPIUM_LOCK_MANIFEST_LIMIT_BYTES + 1, 0x20));
            const oversized = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "android-emulator", deviceId: "pixel-manifest-fence" },
                }),
            });
            expect(oversized.status).toBe(502);
            expect(await oversized.json()).toEqual(expect.objectContaining({
                error: "appium-runtime-manifest-invalid",
                runtime: expect.objectContaining({ detail: "appium-runtime-lock-file-too-large" }),
            }));
            expect(commandRunner).not.toHaveBeenCalled();
            expect(readFileSync(externalPackage, "utf8")).toBe(JSON.stringify({ name: "external" }));
            expect(readFileSync(externalLock, "utf8")).toBe(JSON.stringify({ lockfileVersion: 3, packages: {} }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(packageRoot, { recursive: true, force: true });
        }
    });

    it("rejects linked Appium runtime directories without touching their targets", async () => {
        if (process.platform === "win32") return;
        const packageRoot = mkdtempSync(join(tmpdir(), "ccc-device-broker-appium-runtime-fence-"));
        const ownerId = deviceLabOwnerId(packageRoot);
        const externalRuntime = join(packageRoot, "external-runtime");
        writePackagedAppiumManifests(packageRoot);
        mkdirSync(externalRuntime);
        writeFileSync(join(externalRuntime, "sentinel.txt"), "unchanged");
        const headers = ownerRpcHeaders(ownerId);
        const { runtimeRoot } = brokerAppiumTestPaths();
        directorySymlink(externalRuntime, runtimeRoot);
        const commandRunner = vi.fn(() => ({ mode: "exec" as const, provider: "unexpected", status: 0, stdout: "", stderr: "" }));
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(packageRoot);
        const server = createIsolatedBrokerServer({ cwd: packageRoot, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "android", [
            { id: "pixel-runtime-fence", status: "running", backend: "android-emulator", appium: null },
        ]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "android-emulator", deviceId: "pixel-runtime-fence" },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({ error: "appium-runtime-directory-invalid" }));
            expect(commandRunner).not.toHaveBeenCalled();
            expect(readFileSync(join(externalRuntime, "sentinel.txt"), "utf8")).toBe("unchanged");
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(runtimeRoot, { force: true });
            rmSync(packageRoot, { recursive: true, force: true });
        }
    });

    it("rejects a linked Appium node_modules directory before npm runs", async () => {
        if (process.platform === "win32") return;
        const packageRoot = mkdtempSync(join(tmpdir(), "ccc-device-broker-appium-modules-fence-"));
        const ownerId = deviceLabOwnerId(packageRoot);
        const externalModules = join(packageRoot, "external-node-modules");
        writePackagedAppiumManifests(packageRoot);
        mkdirSync(externalModules);
        writeFileSync(join(externalModules, "sentinel.txt"), "unchanged");
        const headers = ownerRpcHeaders(ownerId);
        const { runtimeRoot, nodeModules } = brokerAppiumTestPaths();
        mkdirSync(runtimeRoot);
        directorySymlink(externalModules, nodeModules);
        const commandRunner = vi.fn(() => ({ mode: "exec" as const, provider: "unexpected", status: 0, stdout: "", stderr: "" }));
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(packageRoot);
        const server = createIsolatedBrokerServer({ cwd: packageRoot, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "android", [
            { id: "pixel-modules-fence", status: "running", backend: "android-emulator", appium: null },
        ]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "android-emulator", deviceId: "pixel-modules-fence" },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({ error: "appium-runtime-directory-invalid" }));
            expect(commandRunner).not.toHaveBeenCalled();
            expect(readFileSync(join(externalModules, "sentinel.txt"), "utf8")).toBe("unchanged");
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(packageRoot, { recursive: true, force: true });
        }
    });

    it("fails closed when another process holds the shared Appium installation lock", async () => {
        const packageRoot = mkdtempSync(join(tmpdir(), "ccc-device-broker-appium-install-lock-"));
        const ownerId = deviceLabOwnerId(packageRoot);
        writePackagedAppiumManifests(packageRoot);
        const headers = ownerRpcHeaders(ownerId);
        const { runtimeRoot } = brokerAppiumTestPaths();
        mkdirSync(runtimeRoot);
        const installLock = join(runtimeRoot, "..", "appium-runtime.install.lock");
        const lockBytes = JSON.stringify({
            token: "f".repeat(32),
            pid: process.pid,
            host: "other-host",
            createdAt: new Date().toISOString(),
        });
        writeFileSync(installLock, lockBytes);
        let syntheticNow = 0;
        vi.spyOn(performance, "now").mockImplementation(() => syntheticNow);
        vi.spyOn(Atomics, "wait").mockImplementation(() => {
            syntheticNow += 400000;
            return "timed-out";
        });
        const commandRunner = vi.fn(() => ({ mode: "exec" as const, provider: "unexpected", status: 0, stdout: "", stderr: "" }));
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(packageRoot);
        const server = createIsolatedBrokerServer({ cwd: packageRoot, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "android", [
            { id: "pixel-install-lock", status: "running", backend: "android-emulator", appium: null },
        ]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "android-emulator", deviceId: "pixel-install-lock" },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({ error: "appium-runtime-install-lock-timeout" }));
            expect(commandRunner).not.toHaveBeenCalled();
            expect(readFileSync(installLock, "utf8")).toBe(lockBytes);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(packageRoot, { recursive: true, force: true });
        }
    });

    it("does not reuse a linked Appium entry even when its marker hash matches", async () => {
        if (process.platform === "win32") return;
        const packageRoot = mkdtempSync(join(tmpdir(), "ccc-device-broker-appium-entry-fence-"));
        const ownerId = deviceLabOwnerId(packageRoot);
        const { packageText, lockText } = writePackagedAppiumManifests(packageRoot);
        const externalEntry = join(packageRoot, "external-appium-entry.js");
        writeFileSync(externalEntry, "throw new Error('must not execute');\n");
        const headers = ownerRpcHeaders(ownerId);
        const { runtimeRoot, entry, marker } = brokerAppiumTestPaths();
        mkdirSync(join(entry, ".."), { recursive: true });
        symlinkSync(externalEntry, entry);
        writeFileSync(marker, JSON.stringify({
            manifestHash: createHash("sha256").update(packageText).update(lockText).digest("hex"),
        }));
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            stdout: "",
            stderr: "",
        }));
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(packageRoot);
        const server = createIsolatedBrokerServer({ cwd: packageRoot, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "android", [
            { id: "pixel-entry-fence", status: "running", backend: "android-emulator", appium: null },
        ]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "android-emulator", deviceId: "pixel-entry-fence" },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({ error: "appium-runtime-install-failed" }));
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({ provider: "npm-appium-runtime" }), expect.anything());
            expect(readFileSync(externalEntry, "utf8")).toBe("throw new Error('must not execute');\n");
            expect(lstatSync(entry).isSymbolicLink()).toBe(true);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(runtimeRoot, { recursive: true, force: true });
            rmSync(packageRoot, { recursive: true, force: true });
        }
    });

    it("atomically replaces linked runtime manifests without changing external files", async () => {
        if (process.platform === "win32") return;
        const packageRoot = mkdtempSync(join(tmpdir(), "ccc-device-broker-appium-destination-fence-"));
        const ownerId = deviceLabOwnerId(packageRoot);
        writePackagedAppiumManifests(packageRoot);
        const externalPackage = join(packageRoot, "external-runtime-package.json");
        const externalLock = join(packageRoot, "external-runtime-lock.json");
        writeFileSync(externalPackage, "external-package");
        writeFileSync(externalLock, "external-lock");
        const headers = ownerRpcHeaders(ownerId);
        const { runtimeRoot, nodeModules, entry, runtimePackage, runtimeLock } = brokerAppiumTestPaths();
        mkdirSync(nodeModules, { recursive: true });
        symlinkSync(externalPackage, runtimePackage);
        symlinkSync(externalLock, runtimeLock);
        const commandRunner = vi.fn((command) => {
            if (command.provider === "npm-appium-runtime") {
                mkdirSync(join(entry, ".."), { recursive: true });
                writeFileSync(entry, "export {};\n");
            }
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                pid: command.provider === "appium" ? 45681 : undefined,
                stdout: "",
                stderr: "",
            };
        });
        const { createDeviceBrokerServer: createIsolatedBrokerServer } = await isolatedDeviceLabPackage(packageRoot);
        const server = createIsolatedBrokerServer({ cwd: packageRoot, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "android", [
            { id: "pixel-destination-fence", status: "running", backend: "android-emulator", appium: null },
        ]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "android-emulator", deviceId: "pixel-destination-fence" },
                }),
            });
            expect(response.status).toBe(200);
            expect(lstatSync(runtimePackage).isSymbolicLink()).toBe(false);
            expect(lstatSync(runtimeLock).isSymbolicLink()).toBe(false);
            expect(readFileSync(externalPackage, "utf8")).toBe("external-package");
            expect(readFileSync(externalLock, "utf8")).toBe("external-lock");
            expect(commandRunner.mock.calls.map(([command]) => command.provider)).toEqual(["npm-appium-runtime", "appium"]);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
            rmSync(runtimeRoot, { recursive: true, force: true });
            rmSync(packageRoot, { recursive: true, force: true });
        }
    });

    it("replaces Appium processes created before the hidden direct-Node launch policy", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-policy-upgrade-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            pid: 45680,
            stdout: "",
            stderr: "",
        }));
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-policy-upgrade-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { appium: "/fake/appium" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "android", [{
            id: "pixel-old-appium-policy",
            status: "running",
            backend: "android-emulator",
            appium: {
                authority: "host-broker",
                processOwner: "host-broker",
                startedBy: "broker.appium.start",
                serverPid: 34567,
                serverUrl: "http://127.0.0.1:4723",
            },
        }]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "android-emulator", deviceId: "pixel-old-appium-policy" },
                }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    started: true,
                    reused: false,
                    replaced: expect.objectContaining({ attempted: false, ok: true, simulated: true }),
                    appium: expect.objectContaining({
                        serverPid: 45680,
                        runtimeId: expect.stringMatching(/^[a-f0-9]{32}$/),
                        launchPolicy: "node-direct-hidden-v1",
                    }),
                }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
            expect(commandRunner).toHaveBeenCalledTimes(1);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it.each([
        { name: "nonzero status", native: { status: 1 } },
        { name: "null status", native: { status: null, error: "missing executable" } },
        { name: "missing status", native: {} },
        { name: "zero status with error", native: { status: 0, error: "native launch error" } },
    ])("reports Appium start failures and simulates injected-runner cleanup without signaling fake pids ($name)", async ({ native }) => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-process-failure-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            stdout: "native failed launch output",
            stderr: "native failed launch diagnostic",
            ...native,
        }));
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
            throw new Error("stale pid");
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-process-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { appium: "/missing/appium" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const root = writeBrokerDevices(ownerId, "android-device", [
            { id: "phone-owned", status: "attached", backend: "android-device", appium: { authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start", serverPid: 56789, serverUrl: "http://127.0.0.1:8200" } },
        ]);
        const originalState = readFileSync(join(root, "devices.json"), "utf8");

        try {
            const start = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "android-device", deviceId: "phone-owned", force: true, port: 8200 },
                }),
            });
            expect(start.status).toBe(502);
            const failed = await start.json();
            expect(failed).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-server-start-failed",
            }));
            expect(failed.execution).toEqual({
                mode: "detached", provider: "appium", executable: "/missing/appium",
                args: ["server", "--port", "8200", "--base-path", "/", "--allow-insecure", "uiautomator2:adb_shell"],
                stdout: "native failed launch output", stderr: "native failed launch diagnostic", ...native,
            });
            expect(failed.execution).not.toHaveProperty("ok");
            expect(failed.execution).not.toHaveProperty("receipt");
            expect(readFileSync(join(root, "devices.json"), "utf8")).toBe(originalState);

            const stop = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.stop",
                    params: { backend: "android-device", deviceId: "phone-owned" },
                }),
            });
            expect(stop.status).toBe(200);
            expect(await stop.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    stopped: true,
                    signal: expect.objectContaining({ attempted: false, ok: true, simulated: true }),
                }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
            const devicesFile = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<{ id: string; appium: unknown }> };
            expect(devicesFile.devices.find((device) => device.id === "phone-owned")?.appium).toBeNull();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("does not signal caller-recorded Appium pids without broker process provenance", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-provenance-test");
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-provenance-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        writeBrokerDevices(ownerId, "android", [
            { id: "pixel-owned", status: "running", backend: "android-emulator", appium: { authority: "host-broker", serverPid: 67890, serverUrl: "http://127.0.0.1:8300" } },
        ]);

        try {
            const stop = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.stop",
                    params: { backend: "android-emulator", deviceId: "pixel-owned" },
                }),
            });
            expect(stop.status).toBe(200);
            expect(await stop.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    stopped: true,
                    stalePid: false,
                    signal: expect.objectContaining({ attempted: false, ok: true }),
                }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("requires complete broker provenance before an Appium pid can be signaled", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-partial-provenance-test");
        const processIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!processIdentity) throw new Error("current process identity unavailable");
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-partial-provenance-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        writeBrokerDevices(ownerId, "android", [
            {
                id: "owner-only",
                status: "running",
                backend: "android-emulator",
                appium: { processOwner: "host-broker", runtimeId: "owner-only-runtime", serverPid: process.pid, processIdentity },
            },
            {
                id: "starter-only",
                status: "running",
                backend: "android-emulator",
                appium: { startedBy: "broker.appium.start", runtimeId: "starter-only-runtime", serverPid: process.pid, processIdentity },
            },
            {
                id: "authority-missing",
                status: "running",
                backend: "android-emulator",
                appium: { processOwner: "host-broker", startedBy: "broker.appium.start", runtimeId: "authority-missing-runtime", serverPid: process.pid, processIdentity },
            },
        ]);

        try {
            for (const deviceId of ["owner-only", "starter-only", "authority-missing"]) {
                const stop = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ method: "broker.appium.stop", params: { backend: "android-emulator", deviceId } }),
                });
                expect(stop.status).toBe(200);
                expect(await stop.json()).toEqual(expect.objectContaining({
                    ok: true,
                    result: expect.objectContaining({ signal: expect.objectContaining({ attempted: false, ok: true }) }),
                }));
            }
            expect(killSpy).not.toHaveBeenCalled();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("refuses to signal and preserves Appium metadata when the persisted process identity mismatches", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-identity-mismatch-test");
        const processIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!processIdentity) throw new Error("current process identity unavailable");
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-identity-mismatch-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const root = writeBrokerDevices(ownerId, "android", [{
            id: "pixel-mismatch",
            status: "running",
            backend: "android-emulator",
            appium: {
                authority: "host-broker",
                processOwner: "host-broker",
                startedBy: "broker.appium.start",
                runtimeId: "mismatched-runtime",
                serverPid: process.pid,
                processIdentity: { ...processIdentity, commandHash: "0".repeat(64) },
            },
        }]);

        try {
            const replacement = await fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.start", params: { backend: "android-emulator", deviceId: "pixel-mismatch", force: true } }),
            });
            expect(replacement.status).toBe(502);
            expect(await replacement.json()).toMatchObject({ ok: false, error: "appium-existing-process-stop-failed" });
            expect(existsSync(brokerAppiumTestPaths().runtimeRoot)).toBe(false);

            const stop = await fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.stop", params: { backend: "android-emulator", deviceId: "pixel-mismatch" } }),
            });
            expect(stop.status).toBe(502);
            expect(await stop.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-stop-failed",
                signal: expect.objectContaining({ attempted: false, ok: false, [process.platform === "win32" ? "error" : "reason"]: "runtime-process-identity-mismatch" }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
            const state = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(state.devices[0]?.appium).toEqual(expect.objectContaining({ runtimeId: "mismatched-runtime" }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("refuses to signal and preserves Appium metadata when identity lookup is unavailable for a live pid", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-identity-unavailable-test");
        const fakePid = 2147483000;
        const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
            if (pid === fakePid && signal === 0) return true;
            return true;
        });
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-identity-unavailable-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const root = writeBrokerDevices(ownerId, "android", [{
            id: "pixel-unavailable",
            status: "running",
            backend: "android-emulator",
            appium: {
                authority: "host-broker",
                processOwner: "host-broker",
                startedBy: "broker.appium.start",
                runtimeId: "unavailable-runtime",
                serverPid: fakePid,
                processIdentity: { pid: fakePid, startToken: "unknown", commandHash: "1".repeat(64) },
            },
        }]);

        try {
            const stop = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.stop", params: { backend: "android-emulator", deviceId: "pixel-unavailable" } }),
            });
            expect(stop.status).toBe(502);
            expect(await stop.json()).toEqual(expect.objectContaining({
                ok: false,
                signal: expect.objectContaining({ attempted: false, ok: false, [process.platform === "win32" ? "error" : "reason"]: "runtime-process-identity-unavailable" }),
            }));
            expect(killSpy).toHaveBeenCalledWith(fakePid, 0);
            expect(killSpy).not.toHaveBeenCalledWith(fakePid, "SIGTERM");
            const state = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(state.devices[0]?.appium).toEqual(expect.objectContaining({ runtimeId: "unavailable-runtime" }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it.runIf(process.platform !== "win32")("persists exact process identity for a real default-runner Appium child", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-real-child-identity-test");
        const executable = join(process.env.HOME!, "fake-appium-server");
        writeFileSync(executable, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n");
        chmodSync(executable, 0o755);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-real-child-identity-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { appium: executable },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        writeBrokerDevices(ownerId, "android", [{ id: "pixel-real-child", status: "running", backend: "android-emulator", appium: null }]);

        try {
            const start = await fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.start", params: { backend: "android-emulator", deviceId: "pixel-real-child" } }),
            });
            const started = await start.json() as { result: { appium: Record<string, unknown> } };
            expect(start.status, JSON.stringify(started)).toBe(200);
            expect(started.result.appium).toEqual(expect.objectContaining({
                runtimeId: expect.stringMatching(/^[a-f0-9]{32}$/),
                serverPid: expect.any(Number),
                processIdentity: expect.objectContaining({
                    pid: expect.any(Number),
                    startToken: expect.any(String),
                    commandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                }),
            }));
            expect(JSON.stringify(started.result.appium)).not.toContain("commandLine");

            const stop = await fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.stop", params: { backend: "android-emulator", deviceId: "pixel-real-child" } }),
            });
            expect(stop.status).toBe(200);
            expect(await stop.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ signal: expect.objectContaining({ attempted: true, ok: true, exited: true }) }),
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("force-starts Appium by first stopping the previous broker-owned pid", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-force-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            pid: 77777,
            stdout: "",
            stderr: "",
        }));
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-force-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { appium: "/fake/appium" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        writeBrokerDevices(ownerId, "ios", [
            { id: "ios-owned", status: "booted", backend: "ios-simulator", appiumPort: 8400, appium: { authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start", serverPid: 11111, serverUrl: "http://127.0.0.1:8400" } },
        ]);

        try {
            const start = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "ios-simulator", deviceId: "ios-owned", force: true },
                }),
            });
            expect(start.status).toBe(200);
            expect(await start.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    started: true,
                    reused: false,
                    replaced: expect.objectContaining({ attempted: false, ok: true, simulated: true }),
                    appium: expect.objectContaining({ serverPid: 77777, port: 8400 }),
                }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
            expect(commandRunner).toHaveBeenCalledTimes(1);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("fails closed when an explicitly requested Appium port is occupied", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-explicit-port-collision-test");
        const commandRunner = vi.fn(() => ({ mode: "detached", provider: "appium", status: 0, pid: 70001, stdout: "", stderr: "" }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-explicit-port-collision-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { appium: "/fake/appium" },
            commandRunner,
            portProcessResolver: (port) => port === 8450 ? { pid: 99991, commandLine: "foreign-listener" } : null,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        writeBrokerDevices(ownerId, "android", [{ id: "pixel-port-collision", status: "running", backend: "android-emulator", appium: null }]);

        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.start", params: { backend: "android-emulator", deviceId: "pixel-port-collision", port: 8450 } }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-port-occupied",
                portSelection: expect.objectContaining({ port: 8450, listener: expect.objectContaining({ pid: 99991 }) }),
            }));
            expect(commandRunner).not.toHaveBeenCalled();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("allocates a different bounded Appium port when the automatic port is occupied", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-auto-port-collision-test");
        const deviceId = "pixel-auto-port-collision";
        const digest = createHash("sha256").update(`${ownerId}:android-emulator:${deviceId}:appium`).digest();
        const occupiedPort = 20000 + digest.readUInt16BE(0) % 20000;
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            pid: 70002,
            stdout: "",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-auto-port-collision-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { appium: "/fake/appium" },
            commandRunner,
            portProcessResolver: (port) => port === occupiedPort ? { pid: 99992, commandLine: "foreign-listener" } : null,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        writeBrokerDevices(ownerId, "android", [{ id: deviceId, status: "running", backend: "android-emulator", appium: null }]);

        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.start", params: { backend: "android-emulator", deviceId } }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    appium: expect.objectContaining({ port: occupiedPort + 1 }),
                    portSelection: expect.objectContaining({
                        attempts: [
                            { port: occupiedPort, occupied: true },
                            { port: occupiedPort + 1, occupied: false },
                        ],
                    }),
                }),
            }));
            expect(commandRunner).toHaveBeenCalledTimes(1);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("never sends WebDriver requests to a listener that does not own the recorded Appium runtime", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-foreign-listener-test");
        const fake = await createFakeAppiumServer("FOREIGN-SESSION");
        const processIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!processIdentity) throw new Error("current process identity unavailable");
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-foreign-listener-test",
            host: "127.0.0.1",
            port: 0,
            commandRunner: vi.fn(),
            portProcessResolver: (port) => port === fake.port ? { pid: process.pid + 100000, commandLine: "foreign-appium" } : null,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        writeBrokerDevices(ownerId, "android", [{
            id: "pixel-foreign-listener",
            status: "running",
            backend: "android-emulator",
            appium: {
                authority: "host-broker",
                processOwner: "host-broker",
                startedBy: "broker.appium.start",
                runtimeId: "recorded-runtime",
                launchPolicy: "node-direct-hidden-v1",
                serverPid: process.pid,
                processIdentity,
                serverUrl: fake.url,
                port: fake.port,
                sessionId: "FOREIGN-SESSION",
            },
        }]);

        try {
            for (const rpc of [
                { method: "broker.appium.session.ensure", params: { backend: "android-emulator", deviceId: "pixel-foreign-listener" } },
                { method: "broker.appium.session.delete", params: { backend: "android-emulator", deviceId: "pixel-foreign-listener" } },
                { method: "broker.appium.request", params: { backend: "android-emulator", deviceId: "pixel-foreign-listener", method: "GET", path: "/source" } },
            ]) {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: ownerRpcHeaders(ownerId),
                    body: JSON.stringify(rpc),
                });
                expect(response.status).toBe(409);
                expect(await response.json()).toEqual(expect.objectContaining({
                    ok: false,
                    error: "appium-listener-ownership-unverified",
                    verification: expect.objectContaining({ error: "appium-port-listener-identity-mismatch" }),
                }));
            }
            writeBrokerDevices(ownerId, "android", [{
                id: "pixel-stale-runtime",
                status: "running",
                backend: "android-emulator",
                appium: {
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.appium.start",
                    runtimeId: "stale-recorded-runtime",
                    launchPolicy: "node-direct-hidden-v1",
                    serverPid: process.pid,
                    processIdentity: { ...processIdentity, commandHash: "0".repeat(64) },
                    serverUrl: fake.url,
                    port: fake.port,
                    sessionId: "FOREIGN-SESSION",
                },
            }]);
            const staleResponse = await fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.appium.session.ensure",
                    params: { backend: "android-emulator", deviceId: "pixel-stale-runtime" },
                }),
            });
            expect(staleResponse.status).toBe(409);
            expect(await staleResponse.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-listener-ownership-unverified",
                verification: expect.objectContaining({ error: "appium-runtime-process-identity-mismatch" }),
            }));
            expect(fake.requests).toEqual([]);
        } finally {
            await close(server);
            await fake.close();
            cleanupOwner(ownerId);
        }
    });

    it("rejects mismatched Appium port and serverUrl metadata without contacting either endpoint", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-endpoint-mismatch-test");
        const verified = await createFakeAppiumServer("VERIFIED-SESSION");
        const redirected = await createFakeAppiumServer("REDIRECTED-SESSION");
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-endpoint-mismatch-test",
            host: "127.0.0.1",
            port: 0,
            commandRunner: vi.fn(),
            portProcessResolver: (port) => port === verified.port
                ? { pid: process.pid, commandLine: "broker-owned-appium" }
                : null,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        writeBrokerDevices(ownerId, "android", [{
            id: "pixel-mismatched-endpoint",
            status: "running",
            backend: "android-emulator",
            appium: currentProcessAppiumRuntime(
                redirected.url,
                verified.port,
                "mismatched-endpoint-runtime",
                { sessionId: "REDIRECTED-SESSION" },
            ),
        }]);

        try {
            for (const rpc of [
                { method: "broker.appium.session.ensure", params: { backend: "android-emulator", deviceId: "pixel-mismatched-endpoint" } },
                { method: "broker.appium.session.delete", params: { backend: "android-emulator", deviceId: "pixel-mismatched-endpoint" } },
                { method: "broker.appium.request", params: { backend: "android-emulator", deviceId: "pixel-mismatched-endpoint", method: "GET", path: "/source" } },
            ]) {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: ownerRpcHeaders(ownerId),
                    body: JSON.stringify(rpc),
                });
                expect(response.status).toBe(409);
                expect(await response.json()).toEqual(expect.objectContaining({
                    ok: false,
                    error: "appium-listener-ownership-unverified",
                    verification: expect.objectContaining({
                        error: "appium-server-url-port-mismatch",
                        port: verified.port,
                        urlPort: redirected.port,
                    }),
                }));
            }
            expect(verified.requests).toEqual([]);
            expect(redirected.requests).toEqual([]);
        } finally {
            await close(server);
            await verified.close();
            await redirected.close();
            cleanupOwner(ownerId);
        }
    });

    it("rejects unsafe broker-owned Appium URL forms before proxying", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-unsafe-endpoint-test");
        const fake = await createFakeAppiumServer("UNSAFE-SESSION");
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-unsafe-endpoint-test",
            host: "127.0.0.1",
            port: 0,
            commandRunner: vi.fn(),
            portProcessResolver: () => ({ pid: process.pid, commandLine: "broker-owned-appium" }),
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const unsafeUrls = [
            `http://localhost:${fake.port}`,
            `http://127.0.0.1:${fake.port}/wd/hub`,
            `http://127.0.0.1:${fake.port}?redirect=true`,
            `http://127.0.0.1:${fake.port}#fragment`,
            `http://user:password@127.0.0.1:${fake.port}`,
            `http://2130706433:${fake.port}`,
        ];

        try {
            for (const serverUrl of unsafeUrls) {
                writeBrokerDevices(ownerId, "android", [{
                    id: "pixel-unsafe-endpoint",
                    status: "running",
                    backend: "android-emulator",
                    appium: currentProcessAppiumRuntime(serverUrl, fake.port, "unsafe-endpoint-runtime", { sessionId: "UNSAFE-SESSION" }),
                }]);
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: ownerRpcHeaders(ownerId),
                    body: JSON.stringify({
                        method: "broker.appium.request",
                        params: { backend: "android-emulator", deviceId: "pixel-unsafe-endpoint", method: "GET", path: "/source" },
                    }),
                });
                expect(response.status, serverUrl).toBe(409);
                expect(await response.json(), serverUrl).toEqual(expect.objectContaining({
                    ok: false,
                    error: "appium-listener-ownership-unverified",
                    verification: expect.objectContaining({ error: "appium-server-url-unsafe" }),
                }));
            }
            expect(fake.requests).toEqual([]);
        } finally {
            await close(server);
            await fake.close();
            cleanupOwner(ownerId);
        }
    });

    it("rolls back a newly launched Appium process instead of overwriting a concurrent successor", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-start-generation-race-test");
        const successor = {
            authority: "host-broker",
            processOwner: "host-broker",
            startedBy: "broker.appium.start",
            runtimeId: "successor-runtime-generation",
            serverPid: 90001,
            serverUrl: "http://127.0.0.1:8501",
            updatedAt: "2026-07-14T00:00:00.000Z",
        };
        let root = "";
        const commandRunner = vi.fn((command) => {
            writeFileSync(join(root, "devices.json"), JSON.stringify({
                devices: [{ id: "pixel-raced", status: "running", backend: "android-emulator", appium: successor }],
            }));
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                pid: 90002,
                stdout: "",
                stderr: "",
            };
        });
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-start-generation-race-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { appium: "/fake/appium" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        root = writeBrokerDevices(ownerId, "android", [
            { id: "pixel-raced", status: "running", backend: "android-emulator", appium: null },
        ]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "android-emulator", deviceId: "pixel-raced", port: 8502 },
                }),
            });
            expect(response.status).toBe(409);
            const payload = await response.json();
            expect(payload).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-runtime-state-conflict",
                currentAppium: expect.objectContaining({ runtimeId: successor.runtimeId, serverPid: 90001 }),
                rollback: expect.objectContaining({ attempted: false, ok: true, simulated: true }),
            }));
            expect(payload.rollback).not.toHaveProperty("receipt");
            expect(payload.rollback).not.toHaveProperty("body");
            expect(killSpy).not.toHaveBeenCalled();
            const persisted = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(persisted.devices[0]?.appium).toEqual(successor);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("preserves a concurrent Appium successor recorded while the previous process stops", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-stop-generation-race-test");
        const previousProcessIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!previousProcessIdentity) throw new Error("current process identity unavailable");
        const previous = {
            authority: "host-broker",
            processOwner: "host-broker",
            startedBy: "broker.appium.start",
            runtimeId: "previous-runtime-generation",
            serverPid: process.pid,
            processIdentity: previousProcessIdentity,
            serverUrl: "http://127.0.0.1:8601",
            updatedAt: "2026-07-14T00:00:00.000Z",
        };
        const successor = {
            ...previous,
            runtimeId: "successor-runtime-generation",
            serverPid: 91002,
            serverUrl: "http://127.0.0.1:8602",
            updatedAt: "2026-07-14T00:00:01.000Z",
        };
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-stop-generation-race-test",
            host: "127.0.0.1",
            port: 0,
        });
        const baseUrl = await listen(server);
        const root = writeBrokerDevices(ownerId, "android", [
            { id: "pixel-raced", status: "running", backend: "android-emulator", appium: previous },
        ]);
        let terminated = false;
        const recordSuccessor = () => {
            writeFileSync(join(root, "devices.json"), JSON.stringify({
                devices: [{ id: "pixel-raced", status: "running", backend: "android-emulator", appium: successor }],
            }));
            terminated = true;
        };
        // Model the termination boundary on both hosts; never terminate this test worker.
        // Identity inspection before that boundary still uses the real process identity.
        const windowsStop = vi.spyOn(windowsProcesses, "terminateWindowsProcessByStartToken").mockImplementation((pid, token) => {
            expect(pid).toBe(process.pid);
            expect(token).toBe(previousProcessIdentity.startToken);
            recordSuccessor();
            return { ok: true, pid, status: 0 };
        });
        const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
            if (pid === process.pid && signal === "SIGTERM") {
                recordSuccessor();
                return true;
            }
            if (pid === process.pid && signal === 0 && terminated) {
                const stale = new Error("no such process") as Error & { code: string };
                stale.code = "ESRCH";
                throw stale;
            }
            return true;
        });

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.appium.stop",
                    params: { backend: "android-emulator", deviceId: "pixel-raced" },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-runtime-state-conflict",
                currentAppium: expect.objectContaining({ runtimeId: successor.runtimeId, serverPid: 91002 }),
                signal: expect.objectContaining({ attempted: true, ok: true, pid: process.pid }),
            }));
            if (process.platform === "win32") {
                expect(windowsStop).toHaveBeenCalledWith(process.pid, previousProcessIdentity.startToken);
            } else {
                expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
                expect(windowsStop).not.toHaveBeenCalled();
            }
            const persisted = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(persisted.devices[0]?.appium).toEqual(successor);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("leaves server metadata untouched when deleting an absent WebDriver session", async () => {
        const cwd = "/project/broker-appium-session-delete-noop";
        const ownerId = deviceLabOwnerId(cwd);
        const fakeAppium = await createFakeAppiumServer();
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const appium = { serverUrl: fakeAppium.url, port: fakeAppium.port, updatedAt: "2026-10-10T00:00:00.000Z" };
        const root = writeBrokerDevices(ownerId, "android", [{
            id: "pixel-no-session", backend: "android-emulator", status: "running", appium,
        }]);
        const statePath = join(root, "devices.json");
        const before = readFileSync(statePath, "utf8");

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.session.delete", params: {
                    backend: "android-emulator", deviceId: "pixel-no-session",
                } }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ ok: true, result: { deleted: false, authority: "host-broker" } });
            expect(readFileSync(statePath, "utf8")).toBe(before);
            expect(fakeAppium.requests).toEqual([]);
        } finally {
            await close(server);
            await fakeAppium.close();
            cleanupOwner(ownerId);
        }
    });

    it.each([
        { name: "nested ID wins", body: { sessionId: "LEGACY", value: { sessionId: "NESTED" } }, sessionId: "NESTED" },
        { name: "legacy ID fallback", body: { sessionId: "LEGACY", value: {} }, sessionId: "LEGACY" },
        { name: "nonstring nested ID falls back", body: { sessionId: "LEGACY", value: { sessionId: 42 } }, sessionId: "LEGACY" },
        { name: "empty nested ID shadows legacy", body: { sessionId: "LEGACY", value: { sessionId: "" } }, sessionId: null },
        { name: "missing ID", body: { value: {} }, sessionId: null },
    ])("decodes $name without requiring a ready property or changing native evidence", async ({ body, sessionId }) => {
        const cwd = "/project/broker-appium-session-id-decoding";
        const ownerId = deviceLabOwnerId(cwd);
        const upstream = await createFakeAppiumServer("NESTED", { sessionBody: body, statusBody: { value: {} } });
        const commandRunner = vi.fn(() => { throw new Error("unexpected process effect"); });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(broker);
        const previous = currentProcessAppiumRuntime(upstream.url, upstream.port, "session-decoding-runtime");
        const root = writeBrokerDevices(ownerId, "android", [{ id: "pixel", name: "Pixel", port: 5580,
            backend: "android-emulator", status: "running", appium: previous }]);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.session.ensure", params: { backend: "android-emulator", deviceId: "pixel" } }) });
            const payload = await response.json();
            expect(response.status).toBe(sessionId ? 200 : 502);
            if (sessionId) {
                expect(payload.result.appium.sessionId).toBe(sessionId);
                expect(payload.result.response).toEqual({ ok: true, status: 200, body });
            } else {
                expect(payload).toMatchObject({ ok: false, error: "appium-session-id-missing" });
                expect(payload.response).toEqual({ ok: true, status: 200, body });
            }
            const persisted = JSON.parse(readFileSync(join(root, "devices.json"), "utf8"));
            expect(persisted.devices[0].appium).toEqual(sessionId ? expect.objectContaining({ sessionId }) : previous);
            expect(upstream.requests.map(request => `${request.method} ${request.url}`)).toEqual(["GET /status", "POST /session"]);
            expect(upstream.requests[1].body).toEqual({ capabilities: { alwaysMatch: expect.objectContaining({
                platformName: "Android", "appium:automationName": "UiAutomator2", "appium:udid": "emulator-5580",
            }) } });
            expect(commandRunner).not.toHaveBeenCalled();
        } finally { await close(broker); await upstream.close(); cleanupOwner(ownerId); }
    });

    it.each([false, true])("tracks or compensates a session from deep raw creation evidence (CAS loss=%s)", async (generationConflict) => {
        const cwd = "/project/broker-appium-deep-creation-evidence";
        const ownerId = deviceLabOwnerId(cwd);
        const sessionId = "DEEP-SUCCESS";
        const sessionRaw = '{"value":{"sessionId":"DEEP-SUCCESS"},"extra":' + "[".repeat(20000) + "0" + "]".repeat(20000) + "}";
        let root = "";
        const successor = { authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start",
            runtimeId: "deep-creation-successor", serverUrl: "http://127.0.0.1:8702", sessionId: "SUCCESSOR" };
        const upstream = await createFakeAppiumServer(sessionId, { sessionRaw,
            ...(generationConflict ? { onSessionCreated: () => writeFileSync(join(root, "devices.json"), JSON.stringify({ devices: [
                { id: "pixel", backend: "android-emulator", status: "running", appium: successor },
            ] })) } : {}) });
        const commandRunner = vi.fn(() => { throw new Error("unexpected process effect"); });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(broker);
        const previous = currentProcessAppiumRuntime(upstream.url, upstream.port, "deep-creation-runtime");
        root = writeBrokerDevices(ownerId, "android", [{ id: "pixel", backend: "android-emulator", status: "running", appium: previous }]);
        const invoke = (method: string) => fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({ method, params: { backend: "android-emulator", deviceId: "pixel" } }) });
        try {
            const creation = await invoke("broker.appium.session.ensure");
            // Deep native evidence may fail outward serialization; lifecycle authority must still hold.
            await creation.text();
            const published = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")).devices[0].appium;
            if (generationConflict) {
                expect(published).toEqual(successor);
            } else {
                expect(published).toMatchObject({ runtimeId: previous.runtimeId, sessionId });
                const deletion = await invoke("broker.appium.session.delete");
                expect(deletion.status).toBe(200);
                expect(await deletion.json()).toMatchObject({ ok: true, result: { deleted: true,
                    response: { ok: true, status: 200, body: { value: null } } } });
                const retained = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")).devices[0].appium;
                expect(retained).not.toHaveProperty("sessionId");
                expect(retained).toMatchObject({ runtimeId: previous.runtimeId, serverUrl: previous.serverUrl, serverPid: previous.serverPid });
            }
            expect(upstream.requests.map(request => `${request.method} ${request.url}`)).toEqual([
                "GET /status", "POST /session", "DELETE /session/DEEP-SUCCESS",
            ]);
            expect(commandRunner).not.toHaveBeenCalled();
        } finally { await close(broker); await upstream.close(); cleanupOwner(ownerId); }
    });

    it("creates a session when native status reports ready:null", async () => {
        const cwd = "/project/broker-appium-null-readiness";
        const ownerId = deviceLabOwnerId(cwd);
        const statusBody = { value: { ready: null } };
        const sessionBody = { value: { sessionId: "NULL-READY-SESSION", capabilities: { platformName: "Android" } } };
        const upstream = await createFakeAppiumServer("NULL-READY-SESSION", { statusBody, sessionBody });
        const commandRunner = vi.fn(() => { throw new Error("unexpected process effect"); });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(broker);
        const root = writeBrokerDevices(ownerId, "android", [{ id: "pixel", backend: "android-emulator", status: "running",
            appium: currentProcessAppiumRuntime(upstream.url, upstream.port, "null-readiness-runtime") }]);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.session.ensure", params: { backend: "android-emulator", deviceId: "pixel" } }) });
            const payload = await response.json();
            expect(response.status).toBe(200);
            expect(payload).toMatchObject({ ok: true, result: { created: true, reused: false,
                appium: { sessionId: "NULL-READY-SESSION" }, response: { ok: true, status: 200, body: sessionBody } } });
            expect(upstream.requests.map(request => `${request.method} ${request.url}`)).toEqual(["GET /status", "POST /session"]);
            expect(upstream.requests[0].body).toBeNull();
            expect(JSON.parse(readFileSync(join(root, "devices.json"), "utf8")).devices[0].appium.sessionId).toBe("NULL-READY-SESSION");
            expect(commandRunner).not.toHaveBeenCalled();
        } finally { await close(broker); await upstream.close(); cleanupOwner(ownerId); }
    });

    it("encodes reserved characters in exact session IDs for inspection, commands, and deletion", async () => {
        const cwd = "/project/broker-appium-reserved-session-id";
        const ownerId = deviceLabOwnerId(cwd);
        const sessionId = "SESSION/space ?#%&+=ü";
        const sessionPath = "/session/SESSION%2Fspace%20%3F%23%25%26%2B%3D%C3%BC";
        const upstream = await createFakeAppiumServer(sessionId);
        const commandRunner = vi.fn(() => { throw new Error("unexpected process effect"); });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(broker);
        const previous = currentProcessAppiumRuntime(upstream.url, upstream.port, "reserved-session-runtime", { sessionId });
        const root = writeBrokerDevices(ownerId, "android", [{ id: "pixel", backend: "android-emulator", status: "running", appium: previous }]);
        const invoke = (method: string, params: Record<string, unknown> = {}) => fetch(ownerRpcEndpoint(baseUrl, ownerId), {
            method: "POST", headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({ method, params: { backend: "android-emulator", deviceId: "pixel", ...params } }),
        });
        const actionsBody = { actions: [{ type: "pointer", id: "tap", parameters: { pointerType: "touch" }, actions: [
            { type: "pointerMove", duration: 0, x: 10, y: 20 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 },
        ] }] };
        try {
            const reuse = await invoke("broker.appium.session.ensure");
            expect(reuse.status).toBe(200);
            expect(await reuse.json()).toMatchObject({ ok: true, result: { created: false, reused: true, appium: { sessionId } } });
            expect(JSON.parse(readFileSync(join(root, "devices.json"), "utf8")).devices[0].appium).toEqual(previous);

            const source = await invoke("broker.appium.request", { method: "GET", path: "/source" });
            expect(source.status).toBe(200);
            expect(await source.json()).toMatchObject({ ok: true, result: { method: "GET", path: "/source",
                response: { ok: true, status: 200, body: { value: "<AppiumAUT />" } } } });

            const actions = await invoke("broker.appium.request", { method: "POST", path: "/actions", body: actionsBody });
            expect(actions.status).toBe(200);
            expect(await actions.json()).toMatchObject({ ok: true, result: { method: "POST", path: "/actions",
                response: { ok: true, status: 200, body: { value: null } } } });

            const deletion = await invoke("broker.appium.session.delete");
            expect(deletion.status).toBe(200);
            expect(await deletion.json()).toMatchObject({ ok: true, result: { deleted: true,
                response: { ok: true, status: 200, body: { value: null } } } });
            const persisted = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")).devices[0].appium;
            expect(persisted).not.toHaveProperty("sessionId");
            expect(persisted).toMatchObject({ runtimeId: previous.runtimeId, serverUrl: previous.serverUrl, serverPid: previous.serverPid });
            expect(upstream.requests).toEqual([
                { method: "GET", url: "/status", body: null },
                { method: "GET", url: sessionPath, body: null },
                { method: "GET", url: `${sessionPath}/source`, body: null },
                { method: "POST", url: `${sessionPath}/actions`, body: actionsBody },
                { method: "DELETE", url: sessionPath, body: null },
            ]);
            expect(commandRunner).not.toHaveBeenCalled();
        } finally { await close(broker); await upstream.close(); cleanupOwner(ownerId); }
    });

    it.each([false, null])("reuses an existing session while status ready is %s without exposing observations", async (ready) => {
        const cwd = "/project/broker-appium-ready-compatibility-reuse";
        const ownerId = deviceLabOwnerId(cwd);
        const upstream = await createFakeAppiumServer("REUSED", { statusBody: { value: { ready } } });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner: vi.fn() });
        const baseUrl = await listen(broker);
        const previous = currentProcessAppiumRuntime(upstream.url, upstream.port, "reuse-runtime", { sessionId: "REUSED" });
        const root = writeBrokerDevices(ownerId, "android", [{ id: "pixel", backend: "android-emulator", status: "running", appium: previous }]);
        const before = readFileSync(join(root, "devices.json"), "utf8");
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.session.ensure", params: { backend: "android-emulator", deviceId: "pixel" } }) });
            const payload = await response.json();
            expect(response.status).toBe(200);
            expect(payload.result).toMatchObject({ created: false, reused: true, appium: previous });
            expect(payload.result).not.toHaveProperty("response");
            expect(payload).not.toHaveProperty("statusObservation");
            expect(payload).not.toHaveProperty("sessionObservation");
            expect(upstream.requests).toEqual([
                { method: "GET", url: "/status", body: null },
                { method: "GET", url: "/session/REUSED", body: null },
            ]);
            expect(readFileSync(join(root, "devices.json"), "utf8")).toBe(before);
        } finally { await close(broker); await upstream.close(); cleanupOwner(ownerId); }
    });

    it.each(["status", "inspection"])("renders failed reuse %s evidence and preserves a concurrent successor", async (failure) => {
        const cwd = "/project/broker-appium-reuse-probe-conflict";
        const ownerId = deviceLabOwnerId(cwd);
        let root = "";
        const successor = { authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start",
            runtimeId: "successor", serverUrl: "http://127.0.0.1:8702", sessionId: "SUCCESSOR" };
        const recordSuccessor = () => writeFileSync(join(root, "devices.json"), JSON.stringify({ devices: [
            { id: "pixel", backend: "android-emulator", status: "running", appium: successor },
        ] }));
        const statusBody = { value: { ready: false } };
        const upstream = await createFakeAppiumServer("REUSED", { statusBody,
            statusStatus: failure === "status" ? 503 : 200, inspectStatus: 500,
            ...(failure === "status" ? { onStatus: recordSuccessor } : { onSessionInspected: recordSuccessor }) });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner: vi.fn() });
        const baseUrl = await listen(broker);
        root = writeBrokerDevices(ownerId, "android", [{ id: "pixel", backend: "android-emulator", status: "running",
            appium: currentProcessAppiumRuntime(upstream.url, upstream.port, "previous", { sessionId: "REUSED", sessionCapabilities: { platformName: "Android" } }) }]);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.session.ensure", params: { backend: "android-emulator", deviceId: "pixel" } }) });
            const payload = await response.json();
            expect(response.status).toBe(409);
            expect(payload).toMatchObject({ ok: false, error: "appium-runtime-state-conflict", currentAppium: successor });
            expect(payload.status).toEqual({ ok: failure !== "status", status: failure === "status" ? 503 : 200, body: statusBody });
            expect(payload.session).toEqual(failure === "status" ? null : { ok: false, status: 500, body: { value: { error: "inspection failed" } } });
            expect(payload).not.toHaveProperty("statusObservation");
            expect(payload).not.toHaveProperty("sessionObservation");
            expect(upstream.requests.map(request => `${request.method} ${request.url}`)).toEqual(failure === "status"
                ? ["GET /status"] : ["GET /status", "GET /session/REUSED"]);
            expect(JSON.parse(readFileSync(join(root, "devices.json"), "utf8")).devices[0].appium).toEqual(successor);
        } finally { await close(broker); await upstream.close(); cleanupOwner(ownerId); }
    });

    it("returns raw false-readiness evidence and simulated process termination without waiting sixty seconds", async () => {
        const cwd = "/project/broker-appium-permanent-false-readiness";
        const ownerId = deviceLabOwnerId(cwd);
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const statusBody = { value: { ready: false, message: "warming" } };
        const upstream = await createFakeAppiumServer("UNCREATED", { statusBody, onStatus: () => { clock += 60001; } });
        const commandRunner = vi.fn(() => { throw new Error("unexpected provider command"); });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(broker);
        const root = writeBrokerDevices(ownerId, "android", [{ id: "pixel", backend: "android-emulator", status: "running",
            appium: currentProcessAppiumRuntime(upstream.url, upstream.port, "not-ready-runtime") }]);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.session.ensure", params: { backend: "android-emulator", deviceId: "pixel" } }) });
            const payload = await response.json();
            expect(response.status).toBe(502);
            expect(payload).toMatchObject({ ok: false, error: "appium-server-not-ready" });
            expect(payload.readiness).toEqual({ ok: false, response: { ok: true, status: 200, body: statusBody } });
            expect(payload.signal).toEqual(expect.objectContaining({ attempted: false, ok: true, simulated: true }));
            expect(payload.signal).not.toHaveProperty("body");
            expect(payload.signal).not.toHaveProperty("receipt");
            expect(upstream.requests).toEqual([{ method: "GET", url: "/status", body: null }]);
            expect(JSON.parse(readFileSync(join(root, "devices.json"), "utf8")).devices[0].appium).toBeNull();
            expect(commandRunner).not.toHaveBeenCalled();
        } finally { await close(broker); await upstream.close(); cleanupOwner(ownerId); }
    });

    it("refuses late positive HTTP readiness without posting a session or publishing its metadata", async () => {
        const cwd = "/project/broker-appium-late-positive-readiness";
        const ownerId = deviceLabOwnerId(cwd);
        let elapsed = 0, wall = Date.now();
        vi.spyOn(performance, "now").mockImplementation(() => elapsed);
        vi.spyOn(Date, "now").mockImplementation(() => wall);
        const statusBody = { value: { ready: true, message: "late ready evidence" } };
        const upstream = await createFakeAppiumServer("FORBIDDEN-SESSION", {
            statusBody, onStatus: () => { elapsed = 60000; wall -= 1e12; },
        });
        const commandRunner = vi.fn(() => { throw new Error("unexpected provider command"); });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner });
        const baseUrl = await listen(broker);
        const previous = currentProcessAppiumRuntime(upstream.url, upstream.port, "late-ready-runtime");
        const root = writeBrokerDevices(ownerId, "android", [{ id: "pixel", backend: "android-emulator", status: "running", appium: previous }]);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.session.ensure", params: { backend: "android-emulator", deviceId: "pixel" } }) });
            const payload = await response.json();
            expect(response.status).toBe(502);
            expect(payload).toMatchObject({ ok: false, error: "appium-server-not-ready",
                readiness: { ok: false, response: { ok: true, status: 200, body: statusBody } },
                signal: { attempted: false, ok: true, simulated: true } });
            expect(upstream.requests).toEqual([{ method: "GET", url: "/status", body: null }]);
            expect(JSON.parse(readFileSync(join(root, "devices.json"), "utf8")).devices[0].appium).toBeNull();
            expect(commandRunner).not.toHaveBeenCalled();
        } finally { await close(broker); await upstream.close(); cleanupOwner(ownerId); }
    });

    it.each([
        { message: "The instrumentation process cannot be initialized.", failures: 1, serial: true, creates: 2, status: 200 },
        { message: "UiAutomator2 server cannot be started", failures: 1, serial: true, creates: 2, status: 200 },
        { message: "UiAutomator2 server cannot be started", failures: 2, serial: true, creates: 2, status: 502 },
        { message: "UiAutomator2 server cannot be started", failures: 1, serial: false, creates: 1, status: 502 },
        { message: "ordinary session failure", failures: 1, serial: true, creates: 1, status: 502 },
    ])("selects one conditional instrumentation retry for $message (serial=$serial, failures=$failures)", async ({ message, failures, serial, creates, status }) => {
        const cwd = "/project/broker-appium-instrumentation-classification";
        const ownerId = deviceLabOwnerId(cwd);
        const trace: string[] = [];
        const upstream = await createFakeAppiumServer("RECOVERED", { sessionCreateFailures: failures, sessionFailureMessage: message,
            onSessionCreate: () => { trace.push("create-session"); } });
        const recoveryResults = [
            { status: 1, error: "native force-stop error" },
            { status: null, error: "native cleanup unavailable" },
            {},
            { status: 0, error: "native uninstall error" },
            { status: 0, error: "" },
        ];
        let recoveryIndex = 0;
        const commandRunner = vi.fn((command) => {
            trace.push(command.args.join(" "));
            const index = recoveryIndex++;
            return { mode: command.mode, provider: command.provider, executable: command.executable, args: command.args,
                stdout: `native recovery output ${index}`, stderr: `native recovery diagnostic ${index}`, ...recoveryResults[index] };
        });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner,
            providerPaths: { adb: "/fake/adb" } });
        const baseUrl = await listen(broker);
        writeBrokerDevices(ownerId, "android", [{ id: "pixel", ...(serial ? { port: 5580 } : {}), backend: "android-emulator", status: "running",
            appium: currentProcessAppiumRuntime(upstream.url, upstream.port, "instrumentation-runtime") }]);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.session.ensure", params: { backend: "android-emulator", deviceId: "pixel" } }) });
            const payload = await response.json();
            expect(response.status).toBe(status);
            expect(upstream.requests.filter(request => request.method === "POST" && request.url === "/session")).toHaveLength(creates);
            const recovered = creates === 2;
            expect(trace).toEqual(recovered ? [
                "create-session",
                "-s emulator-5580 shell am force-stop io.appium.uiautomator2.server",
                "-s emulator-5580 shell am force-stop io.appium.uiautomator2.server.test",
                "-s emulator-5580 uninstall io.appium.uiautomator2.server",
                "-s emulator-5580 uninstall io.appium.uiautomator2.server.test",
                "-s emulator-5580 uninstall io.appium.settings",
                "create-session",
            ] : ["create-session"]);
            expect(commandRunner.mock.calls.map(([, options]) => options.timeoutMs)).toEqual(recovered ? [30000, 30000, 30000, 30000, 30000] : []);
            if (status === 502) {
                expect(payload.response).toEqual({ ok: false, status: 500, body: { value: { error: "unknown error", message } } });
                if (recovered) {
                    expect(payload.instrumentationRecovery.results).toEqual(recoveryResults.map((native, index) => ({
                        mode: "exec", provider: "adb-appium-recovery", executable: "/fake/adb", args: trace[index + 1].split(" "),
                        stdout: `native recovery output ${index}`, stderr: `native recovery diagnostic ${index}`, ...native,
                    })));
                    for (const execution of payload.instrumentationRecovery.results) {
                        expect(execution).not.toHaveProperty("ok");
                        expect(execution).not.toHaveProperty("receipt");
                    }
                }
            } else expect(payload.result.appium).toMatchObject({ sessionId: "RECOVERED", instrumentationRecovery: { attempted: true, recovered: true } });
        } finally { await close(broker); await upstream.close(); cleanupOwner(ownerId); }
    });

    it.each([
        { status: 200, body: { value: { error: "unknown error", message: "upstream protocol evidence" } } },
        { status: 503, body: { value: { error: "unavailable", detail: "upstream evidence" } } },
    ])("projects native HTTP $status and body without reclassifying WebDriver errors", async ({ status, body }) => {
        const cwd = "/project/broker-appium-public-native-response";
        const ownerId = deviceLabOwnerId(cwd);
        const upstream = await createFakeAppiumServer("COMMAND", { commandStatus: status, commandBody: body });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner: vi.fn() });
        const baseUrl = await listen(broker);
        writeBrokerDevices(ownerId, "android", [{ id: "pixel", backend: "android-emulator", status: "running",
            appium: currentProcessAppiumRuntime(upstream.url, upstream.port, "command-runtime", { sessionId: "COMMAND" }) }]);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.request", params: { backend: "android-emulator", deviceId: "pixel", method: "GET", path: "/source" } }) });
            const payload = await response.json();
            expect(response.status).toBe(status === 200 ? 200 : 502);
            expect(payload.ok).toBe(status === 200);
            expect(payload.result.response).toEqual({ ok: status === 200, status, body });
            expect(upstream.requests).toEqual([{ method: "GET", url: "/session/COMMAND/source", body: null }]);
        } finally { await close(broker); await upstream.close(); cleanupOwner(ownerId); }
    });

    it("preserves bounded non-JSON upstream evidence on the public response", async () => {
        const cwd = "/project/broker-appium-non-json-response";
        const ownerId = deviceLabOwnerId(cwd);
        const raw = "native response: " + "x".repeat(DEVICE_BROKER_COMMAND_OUTPUT_LIMIT + 64);
        const upstream = await createFakeAppiumServer("RAW", { commandRaw: raw });
        const broker = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandRunner: vi.fn() });
        const baseUrl = await listen(broker);
        writeBrokerDevices(ownerId, "android", [{ id: "pixel", backend: "android-emulator", status: "running",
            appium: currentProcessAppiumRuntime(upstream.url, upstream.port, "raw-runtime", { sessionId: "RAW" }) }]);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.request", params: { backend: "android-emulator", deviceId: "pixel", method: "GET", path: "/source" } }) });
            const payload = await response.json();
            expect(response.status).toBe(200);
            expect(payload.result.response).toEqual({ ok: true, status: 200, body: { raw: raw.slice(0, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT) } });
            expect(upstream.requests).toEqual([{ method: "GET", url: "/session/RAW/source", body: null }]);
        } finally { await close(broker); await upstream.close(); cleanupOwner(ownerId); }
    });

    it("creates, reuses, proxies, and deletes broker-owned WebDriver sessions", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-webdriver-test");
        const fakeAppium = await createFakeAppiumServer("ANDROID-BROKER-SESSION-1", { readyAfterStatusRequests: 3, sessionCreateFailures: 1 });
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            pid: 88888,
            stdout: "",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-webdriver-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { appium: "/fake/appium", adb: "/fake/adb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const root = writeBrokerDevices(ownerId, "android", [
            { id: "pixel-owned", name: "Pixel Owned", status: "running", backend: "android-emulator", avdName: "Pixel_API", port: 5580, appium: null },
        ]);

        try {
            const ensure = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.session.ensure",
                    params: { backend: "android-emulator", deviceId: "pixel-owned", port: fakeAppium.port },
                }),
            });
            expect(ensure.status).toBe(200);
            const ensured = await ensure.json();
            expect(ensured).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    created: true,
                    reused: false,
                    appium: expect.objectContaining({
                        serverUrl: fakeAppium.url,
                        serverPid: 88888,
                        sessionId: "ANDROID-BROKER-SESSION-1",
                        sessionCapabilities: expect.objectContaining({
                            platformName: "Android",
                            "appium:automationName": "UiAutomator2",
                            "appium:deviceName": "Pixel Owned",
                            "appium:adbExecTimeout": 120000,
                            "appium:uiautomator2ServerInstallTimeout": 120000,
                            "appium:uiautomator2ServerLaunchTimeout": 120000,
                            "appium:udid": "emulator-5580",
                            "appium:avd": "Pixel_API",
                        }),
                        instrumentationRecovery: expect.objectContaining({ attempted: true, recovered: true }),
                    }),
                }),
            }));
            expect(ensured.result.response).toEqual({ ok: true, status: 200, body: { value: {
                sessionId: "ANDROID-BROKER-SESSION-1", capabilities: ensured.result.appium.sessionCapabilities,
            } } });
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "appium",
                args: ["server", "--port", String(fakeAppium.port), "--base-path", "/", "--allow-insecure", "uiautomator2:adb_shell"],
                cwd: join(homedir(), ".ccc", "devices", "broker", "appium-runtime"),
            }), expect.anything());
            expect(commandRunner.mock.calls.filter(([command]) => command.provider === "adb-appium-recovery")).toHaveLength(5);
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                provider: "adb-appium-recovery",
                args: ["-s", "emulator-5580", "uninstall", "io.appium.uiautomator2.server.test"],
            }), expect.objectContaining({ timeoutMs: 30000 }));
            expect(fakeAppium.requests.filter((request) => request.method === "POST" && request.url === "/session")).toHaveLength(2);
            expect(fakeAppium.requests.find((request) => request.method === "POST" && request.url === "/session")?.body).toEqual({
                capabilities: {
                    alwaysMatch: expect.objectContaining({
                        platformName: "Android",
                        "appium:automationName": "UiAutomator2",
                        "appium:deviceName": "Pixel Owned",
                        "appium:adbExecTimeout": 120000,
                        "appium:uiautomator2ServerInstallTimeout": 120000,
                        "appium:uiautomator2ServerLaunchTimeout": 120000,
                    }),
                },
            });
            const sessionCreateIndex = fakeAppium.requests.findIndex((request) => request.method === "POST" && request.url === "/session");
            expect(fakeAppium.requests.slice(0, sessionCreateIndex).filter((request) => request.method === "GET" && request.url === "/status")).toHaveLength(3);

            const reuse = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.session.ensure",
                    params: { backend: "android-emulator", deviceId: "pixel-owned" },
                }),
            });
            expect(reuse.status).toBe(200);
            const reused = await reuse.json();
            expect(reused).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ created: false, reused: true }),
            }));
            expect(reused.result).not.toHaveProperty("response");

            const source = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: { backend: "android-emulator", deviceId: "pixel-owned", method: "GET", path: "/source" },
                }),
            });
            expect(source.status).toBe(200);
            expect(await source.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    method: "GET",
                    path: "/source",
                    response: { ok: true, status: 200, body: { value: "<AppiumAUT />" } },
                }),
            }));

            const actions = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: {
                        backend: "android-emulator",
                        deviceId: "pixel-owned",
                        method: "POST",
                        path: "/actions",
                        body: {
                            actions: [
                                {
                                    type: "pointer",
                                    id: "tap",
                                    parameters: { pointerType: "touch" },
                                    actions: [
                                        { type: "pointerMove", duration: 0, x: 10, y: 20 },
                                        { type: "pointerDown", button: 0 },
                                        { type: "pointerUp", button: 0 },
                                    ],
                                },
                            ],
                        },
                    },
                }),
            });
            expect(actions.status).toBe(200);
            expect(await actions.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ method: "POST", path: "/actions", response: { ok: true, status: 200, body: { value: null } } }),
            }));

            const deleteSession = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.session.delete",
                    params: { backend: "android-emulator", deviceId: "pixel-owned" },
                }),
            });
            expect(deleteSession.status).toBe(200);
            expect(await deleteSession.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ deleted: true, response: { ok: true, status: 200, body: { value: null } } }),
            }));
            const devicesFile = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<{ id: string; appium: { sessionId?: unknown } }> };
            expect(devicesFile.devices.find((device) => device.id === "pixel-owned")?.appium.sessionId).toBeUndefined();
            expect(devicesFile.devices.find((device) => device.id === "pixel-owned")?.appium).toMatchObject({
                authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start",
                serverUrl: fakeAppium.url, serverPid: 88888,
            });
            expect(fakeAppium.requests.map((request) => `${request.method} ${request.url}`)).toEqual(expect.arrayContaining([
                "POST /session",
                "GET /status",
                "GET /session/ANDROID-BROKER-SESSION-1",
                "GET /session/ANDROID-BROKER-SESSION-1/source",
                "POST /session/ANDROID-BROKER-SESSION-1/actions",
                "DELETE /session/ANDROID-BROKER-SESSION-1",
            ]));
        } finally {
            await close(server);
            await fakeAppium.close();
            cleanupOwner(ownerId);
        }
    });

    it("deletes a newly created WebDriver session when a concurrent Appium generation wins", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-session-generation-race-test");
        let root = "";
        const successor = {
            authority: "host-broker",
            processOwner: "host-broker",
            startedBy: "broker.appium.start",
            runtimeId: "webdriver-successor-generation",
            serverPid: 92002,
            serverUrl: "http://127.0.0.1:8702",
            updatedAt: "2026-07-14T00:00:01.000Z",
        };
        const fakeAppium = await createFakeAppiumServer("RACED-SESSION", {
            onSessionCreated: () => {
                writeFileSync(join(root, "devices.json"), JSON.stringify({
                    devices: [{ id: "pixel-raced", name: "Pixel Raced", status: "running", backend: "android-emulator", port: 5582, appium: successor }],
                }));
            },
        });
        const previous = {
            ...currentProcessAppiumRuntime(fakeAppium.url, fakeAppium.port, "webdriver-previous-generation"),
            updatedAt: "2026-07-14T00:00:00.000Z",
        };
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-session-generation-race-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        root = writeBrokerDevices(ownerId, "android", [
            { id: "pixel-raced", name: "Pixel Raced", status: "running", backend: "android-emulator", port: 5582, appium: previous },
        ]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.appium.session.ensure",
                    params: { backend: "android-emulator", deviceId: "pixel-raced" },
                }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-runtime-state-conflict",
                currentAppium: expect.objectContaining({ runtimeId: successor.runtimeId }),
                rollback: { ok: true, status: 200, body: { value: null } },
            }));
            expect(fakeAppium.requests.map((request) => `${request.method} ${request.url}`)).toEqual(expect.arrayContaining([
                "POST /session",
                "DELETE /session/RACED-SESSION",
            ]));
            const persisted = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(persisted.devices[0]?.appium).toEqual(successor);
        } finally {
            await close(server);
            await fakeAppium.close();
            cleanupOwner(ownerId);
        }
    });

    it("refuses WebDriver session/proxy calls for caller-recorded arbitrary Appium server URLs", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-ssrf-test");
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-ssrf-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        writeBrokerDevices(ownerId, "android", [
            {
                id: "pixel-owned",
                status: "running",
                backend: "android-emulator",
                appium: null,
            },
        ]);

        try {
            const record = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.record",
                    params: {
                        backend: "android-emulator",
                        deviceId: "pixel-owned",
                        serverUrl: "http://169.254.169.254/latest",
                        sessionId: "CALLER-SESSION",
                    },
                }),
            });
            expect(record.status).toBe(200);
            expect(await record.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    appium: expect.objectContaining({
                        authority: "host-broker",
                        serverUrl: "http://169.254.169.254/latest",
                        sessionId: "CALLER-SESSION",
                    }),
                }),
            }));

            const request = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: { backend: "android-emulator", deviceId: "pixel-owned", method: "GET", path: "/source" },
                }),
            });
            expect(request.status).toBe(409);
            expect(await request.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-listener-ownership-unverified",
                verification: expect.objectContaining({ error: "appium-runtime-metadata-incomplete" }),
            }));

            const deleteSession = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.session.delete",
                    params: { backend: "android-emulator", deviceId: "pixel-owned" },
                }),
            });
            expect(deleteSession.status).toBe(409);
            expect(await deleteSession.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-listener-ownership-unverified",
                verification: expect.objectContaining({ error: "appium-runtime-metadata-incomplete" }),
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("does not follow redirects from a broker-owned Appium server", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-redirect-fence-test");
        let redirectTargetRequests = 0;
        const redirectTarget = createServer((_req, res) => {
            redirectTargetRequests += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ value: "unexpected" }));
        });
        await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
        const redirectTargetAddress = redirectTarget.address() as AddressInfo;
        const fakeAppium = createServer((_req, res) => {
            res.writeHead(302, { location: `http://127.0.0.1:${redirectTargetAddress.port}/redirected` });
            res.end();
        });
        await new Promise<void>((resolve) => fakeAppium.listen(0, "127.0.0.1", resolve));
        const fakeAppiumAddress = fakeAppium.address() as AddressInfo;
        const broker = createDeviceBrokerServer({ cwd: "/project/broker-appium-redirect-fence-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(broker);
        writeBrokerDevices(ownerId, "android", [{
            id: "pixel-owned",
            status: "running",
            backend: "android-emulator",
            appium: currentProcessAppiumRuntime(
                `http://127.0.0.1:${fakeAppiumAddress.port}`,
                fakeAppiumAddress.port,
                "redirect-runtime",
                { sessionId: "REDIRECT-SESSION" },
            ),
        }]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: { backend: "android-emulator", deviceId: "pixel-owned", method: "GET", path: "/source" },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-request-failed",
                result: expect.objectContaining({
                    response: expect.objectContaining({
                        ok: false,
                        status: 302,
                        body: { error: "appium-redirect-disallowed" },
                    }),
                }),
            }));
            expect(redirectTargetRequests).toBe(0);
        } finally {
            await close(broker);
            await new Promise<void>((resolve, reject) => fakeAppium.close((error) => error ? reject(error) : resolve()));
            await new Promise<void>((resolve, reject) => redirectTarget.close((error) => error ? reject(error) : resolve()));
            cleanupOwner(ownerId);
        }
    });

    it("bounds chunked Appium responses while streaming", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-response-bound-test");
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        const fakeAppium = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
            for (let sent = 0; sent <= DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES; sent += chunk.length) res.write(chunk);
            res.end();
        });
        await new Promise<void>((resolve) => fakeAppium.listen(0, "127.0.0.1", resolve));
        const fakeAppiumAddress = fakeAppium.address() as AddressInfo;
        const broker = createDeviceBrokerServer({ cwd: "/project/broker-appium-response-bound-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(broker);
        writeBrokerDevices(ownerId, "android", [{
            id: "pixel-owned",
            status: "running",
            backend: "android-emulator",
            appium: currentProcessAppiumRuntime(
                `http://127.0.0.1:${fakeAppiumAddress.port}`,
                fakeAppiumAddress.port,
                "oversized-response-runtime",
                { sessionId: "OVERSIZED-SESSION" },
            ),
        }]);

        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: { backend: "android-emulator", deviceId: "pixel-owned", method: "GET", path: "/source" },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-request-failed",
                result: expect.objectContaining({
                    response: expect.objectContaining({
                        ok: false,
                        status: 200,
                        body: expect.objectContaining({
                            error: "appium-response-too-large",
                            maxBytes: DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES,
                        }),
                    }),
                }),
            }));
        } finally {
            await close(broker);
            await new Promise<void>((resolve, reject) => fakeAppium.close((error) => error ? reject(error) : resolve()));
            cleanupOwner(ownerId);
        }
    });

    it("force-ensures a session by deleting the old broker-owned WebDriver session first", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-force-session-test");
        const simulatorName = `ccc-${ownerId}-ios-owned`;
        const fakeAppium = await createFakeAppiumServer("FORCED-SESSION-2");
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-force-session-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { xcrun: "/fake/xcrun" },
            commandRunner: iosSimulatorInventoryRunner(simulatorName, "SIM-UDID-1"),
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        writeBrokerDevices(ownerId, "ios", [
            {
                id: "ios-owned",
                status: "booted",
                backend: "ios-simulator",
                simulatorName,
                udid: "SIM-UDID-1",
                appium: {
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.appium.start",
                    serverUrl: `http://127.0.0.1:${fakeAppium.port}`,
                    sessionId: "FORCED-SESSION-1",
                },
            },
        ]);

        try {
            const ensure = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.session.ensure",
                    params: { backend: "ios-simulator", deviceId: "ios-owned", force: true },
                }),
            });
            expect(ensure.status).toBe(200);
            expect(await ensure.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    created: true,
                    appium: expect.objectContaining({ sessionId: "FORCED-SESSION-2" }),
                }),
            }));
            expect(fakeAppium.requests.map((request) => `${request.method} ${request.url}`)).toEqual(expect.arrayContaining([
                "DELETE /session/FORCED-SESSION-1",
                "POST /session",
            ]));
        } finally {
            await close(server);
            await fakeAppium.close();
            cleanupOwner(ownerId);
        }
    });

    it("preserves WebDriver session metadata and does not create a replacement when force delete fails", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-force-delete-failure-test");
        const simulatorName = `ccc-${ownerId}-ios-owned`;
        const fakeAppium = await createFakeAppiumServer("FORCE-DELETE-FAIL", { deleteStatus: 500 });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-appium-force-delete-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { xcrun: "/fake/xcrun" },
            commandRunner: iosSimulatorInventoryRunner(simulatorName, "SIM-UDID-2"),
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const root = writeBrokerDevices(ownerId, "ios", [
            {
                id: "ios-owned",
                status: "booted",
                backend: "ios-simulator",
                simulatorName,
                udid: "SIM-UDID-2",
                appium: {
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.appium.start",
                    serverUrl: `http://127.0.0.1:${fakeAppium.port}`,
                    sessionId: "FORCE-DELETE-FAIL",
                    sessionCapabilities: { platformName: "iOS" },
                },
            },
        ]);

        try {
            const ensure = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.session.ensure",
                    params: { backend: "ios-simulator", deviceId: "ios-owned", force: true },
                }),
            });
            expect(ensure.status).toBe(502);
            expect(await ensure.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-session-delete-failed",
                result: expect.objectContaining({
                    created: false,
                    appium: expect.objectContaining({ sessionId: "FORCE-DELETE-FAIL" }),
                    response: { ok: false, status: 500, body: { value: { error: "delete failed" } } },
                }),
            }));
            expect(fakeAppium.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
                "DELETE /session/FORCE-DELETE-FAIL",
            ]);
            const devicesFile = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<{ id: string; appium: { sessionId?: unknown } }> };
            expect(devicesFile.devices.find((device) => device.id === "ios-owned")?.appium.sessionId).toBe("FORCE-DELETE-FAIL");
        } finally {
            await close(server);
            await fakeAppium.close();
            cleanupOwner(ownerId);
        }
    });

    it("preserves WebDriver session metadata when Appium session deletion fails", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-delete-failure-test");
        const fakeAppium = await createFakeAppiumServer("DELETE-FAIL-SESSION", { deleteStatus: 500 });
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-delete-failure-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const claimId = "delete-failure-claim";
        const claimNonce = "delete-failure-nonce";
        const root = writeBrokerDevices(ownerId, "ios-device", [
            {
                id: "iphone-owned",
                status: "attached",
                backend: "ios-device",
                udid: "REAL-UDID-2",
                leaseClaimId: claimId,
                leaseClaimNonce: claimNonce,
                appium: currentProcessAppiumRuntime(fakeAppium.url, fakeAppium.port, "delete-failure-runtime", {
                    sessionId: "DELETE-FAIL-SESSION",
                    sessionCapabilities: { platformName: "iOS" },
                }),
            },
        ]);
        writePhysicalLease(ownerId, "ios-device", "REAL-UDID-2", "iphone-owned", claimId, claimNonce);

        try {
            const deleteSession = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.session.delete",
                    params: { backend: "ios-device", deviceId: "iphone-owned" },
                }),
            });
            expect(deleteSession.status).toBe(502);
            expect(await deleteSession.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-session-delete-failed",
                result: expect.objectContaining({
                    deleted: false,
                    appium: expect.objectContaining({ sessionId: "DELETE-FAIL-SESSION" }),
                    response: { ok: false, status: 500, body: { value: { error: "delete failed" } } },
                }),
            }));
            const devicesFile = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<{ id: string; appium: { sessionId?: unknown } }> };
            expect(devicesFile.devices.find((device) => device.id === "iphone-owned")?.appium.sessionId).toBe("DELETE-FAIL-SESSION");
        } finally {
            await close(server);
            await fakeAppium.close();
            cleanupOwner(ownerId);
        }
    });

    it("preserves live broker-owned Appium runtime metadata until the server is stopped", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-live-metadata-test");
        const processIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!processIdentity) throw new Error("current process identity unavailable");
        const appium = {
            authority: "host-broker",
            processOwner: "host-broker",
            startedBy: "broker.appium.start",
            runtimeId: "live-runtime-metadata",
            launchPolicy: "node-direct-hidden-v1",
            serverPid: process.pid,
            processIdentity,
            serverUrl: "http://127.0.0.1:4723",
            port: 4723,
            updatedAt: "2026-07-14T00:00:00.000Z",
        };
        const root = writeBrokerDevices(ownerId, "android", [
            { id: "pixel-live-runtime", status: "running", backend: "android-emulator", appium },
        ]);
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-live-metadata-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const invoke = (method: string, params: Record<string, unknown>) => fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ method, params: { backend: "android-emulator", deviceId: "pixel-live-runtime", ...params } }),
        });

        try {
            const record = await invoke("broker.appium.record", { serverUrl: "http://127.0.0.1:4810", sessionId: "replacement" });
            expect(record.status).toBe(409);
            expect(await record.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-runtime-active",
                deviceId: "pixel-live-runtime",
            }));

            const clear = await invoke("broker.appium.clear", {});
            expect(clear.status).toBe(409);
            expect(await clear.json()).toEqual(expect.objectContaining({ ok: false, error: "appium-runtime-active" }));
            let state = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<{ appium: Record<string, unknown> | null }> };
            expect(state.devices[0]?.appium).toEqual(appium);

            writeFileSync(join(root, "devices.json"), JSON.stringify({
                devices: [{ id: "pixel-live-runtime", status: "running", backend: "android-emulator", appium: { ...appium, serverPid: process.pid + 1 } }],
            }));
            const clearStale = await invoke("broker.appium.clear", {});
            expect(clearStale.status).toBe(200);
            state = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<{ appium: Record<string, unknown> | null }> };
            expect(state.devices[0]?.appium).toBeNull();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("records, reports, lists, and clears owner-scoped Android Appium metadata", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-test");
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const root = writeBrokerDevices(ownerId, "android", [
            { id: "pixel-owned", status: "running", backend: "android-emulator", appium: null, appiumPort: 4723 },
            { id: "pixel-idle", status: "stopped", backend: "android-emulator", appium: null },
        ]);

        try {
            const record = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.record",
                    params: {
                        backend: "android-emulator",
                        deviceId: "pixel-owned",
                        appium: {
                            serverUrl: "http://127.0.0.1:4723",
                            sessionId: "ANDROID-SESSION-1",
                            serverPid: 12345,
                            port: 4723,
                            automationName: "UiAutomator2",
                            provider: "appium-uiautomator2",
                        },
                    },
                }),
            });
            expect(record.status).toBe(200);
            expect(await record.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId,
                    backend: "android-emulator",
                    stateKey: "android",
                    deviceId: "pixel-owned",
                    authority: "host-broker",
                    appium: expect.objectContaining({
                        authority: "host-broker",
                        serverUrl: "http://127.0.0.1:4723",
                        sessionId: "ANDROID-SESSION-1",
                        serverPid: 12345,
                        port: 4723,
                    }),
                }),
            }));

            const status = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.status",
                    params: { backend: "android-emulator", deviceId: "pixel-owned" },
                }),
            });
            expect(status.status).toBe(200);
            expect(await status.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    appium: expect.objectContaining({ sessionId: "ANDROID-SESSION-1", authority: "host-broker" }),
                    device: expect.objectContaining({ appiumPort: 4723 }),
                }),
            }));

            const list = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.list",
                    params: { backend: "android-emulator" },
                }),
            });
            expect(list.status).toBe(200);
            expect(await list.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    authority: "host-broker",
                    sessions: [
                        expect.objectContaining({ deviceId: "pixel-owned", appium: expect.objectContaining({ sessionId: "ANDROID-SESSION-1" }) }),
                        expect.objectContaining({ deviceId: "pixel-idle", appium: null }),
                    ],
                }),
            }));

            const clear = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.clear",
                    params: { backend: "android-emulator", deviceId: "pixel-owned" },
                }),
            });
            expect(clear.status).toBe(200);
            expect(await clear.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ cleared: true, authority: "host-broker" }),
            }));
            const devicesFile = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<{ id: string; appium: unknown }> };
            expect(devicesFile.devices.find((device) => device.id === "pixel-owned")?.appium).toBeNull();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("keeps Appium metadata isolated by CCC owner", async () => {
        const ownerA = deviceLabOwnerId("/project/broker-appium-owner-test");
        const ownerBPath = "/project/broker-appium-foreign-owner-test";
        const ownerB = deviceLabOwnerId(ownerBPath);
        registerDeviceBrokerOwner(ownerBPath);
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-owner-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpointA = ownerRpcEndpoint(baseUrl, ownerA);
        const endpointB = ownerRpcEndpoint(baseUrl, ownerB);
        const headersA = ownerRpcHeaders(ownerA);
        const headersB = ownerRpcHeaders(ownerB);
        writeBrokerDevices(ownerA, "ios", [{ id: "ios-owned", status: "booted", backend: "ios-simulator", appium: null }]);

        try {
            const foreignStatus = await fetch(endpointB, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({
                    method: "broker.appium.status",
                    params: { backend: "ios-simulator", deviceId: "ios-owned" },
                }),
            });
            expect(foreignStatus.status).toBe(404);
            expect(await foreignStatus.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-device-not-found",
                ownerId: ownerB,
            }));

            const ownerRecord = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.appium.record",
                    params: {
                        backend: "ios-simulator",
                        deviceId: "ios-owned",
                        serverUrl: "http://127.0.0.1:8100",
                        sessionId: "IOS-SESSION-1",
                        serverPid: 23456,
                        automationName: "XCUITest",
                    },
                }),
            });
            expect(ownerRecord.status).toBe(200);

            const foreignStart = await fetch(endpointB, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({
                    method: "broker.appium.start",
                    params: { backend: "ios-simulator", deviceId: "ios-owned", port: 8100 },
                }),
            });
            expect(foreignStart.status).toBe(404);
            expect(await foreignStart.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-device-not-found",
                ownerId: ownerB,
            }));

            const foreignEnsureSession = await fetch(endpointB, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({
                    method: "broker.appium.session.ensure",
                    params: { backend: "ios-simulator", deviceId: "ios-owned", port: 8100 },
                }),
            });
            expect(foreignEnsureSession.status).toBe(404);
            expect(await foreignEnsureSession.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-device-not-found",
                ownerId: ownerB,
            }));

            const foreignClear = await fetch(endpointB, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({
                    method: "broker.appium.clear",
                    params: { backend: "ios-simulator", deviceId: "ios-owned" },
                }),
            });
            expect(foreignClear.status).toBe(404);

            const ownerStatus = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.appium.status",
                    params: { backend: "ios-simulator", deviceId: "ios-owned" },
                }),
            });
            expect(ownerStatus.status).toBe(200);
            expect(await ownerStatus.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    appium: expect.objectContaining({ sessionId: "IOS-SESSION-1", authority: "host-broker" }),
                }),
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerA);
            cleanupOwner(ownerB);
        }
    });

    it("cleans owner runtime helpers, stops virtual devices, detaches physical devices, and preserves other owners", async () => {
        const ownerA = deviceLabOwnerId("/project/broker-owner-cleanup-test");
        const ownerB = "4646464678787878";
        const iosSimulatorName = `ccc-${ownerA}-ios-owned`;
        let androidRunning = true, iosRunning = true, sandboxRunning = true;
        const commands: unknown[] = [];
        const commandRunner = vi.fn((command) => {
            commands.push(command);
            if (command.provider === "adb" && command.args?.at(-1) === "kill") androidRunning = false;
            if (command.provider === "xcrun" && command.args?.[1] === "shutdown") iosRunning = false;
            if (command.provider === "wsb" && command.args?.[0] === "stop") sandboxRunning = false;
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                stdout: command.provider === "xcrun" && command.args?.join(" ") === "simctl list devices -j"
                    ? JSON.stringify({ devices: { runtime: [{ name: iosSimulatorName, udid: "SIM-UDID-1", state: iosRunning ? "Booted" : "Shutdown" }] } })
                    : command.provider === "adb" && command.args?.join(" ") === "devices -l"
                        ? `List of devices attached\n${androidRunning ? "emulator-5580\tdevice\n" : ""}`
                    : command.provider === "wsb" && command.args?.[0] === "list"
                        ? JSON.stringify({ WindowsSandboxEnvironments: sandboxRunning ? [{ Id: "12345678-1234-4234-9234-1234567890ab" }] : [] })
                    : "",
                stderr: "",
            };
        });
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-owner-cleanup-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", xcrun: "/fake/xcrun", wsb: "/fake/wsb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpointA = ownerRpcEndpoint(baseUrl, ownerA);
        const headersA = ownerRpcHeaders(ownerA);
        const androidRoot = writeBrokerDevices(ownerA, "android", [
            {
                id: "pixel-owned",
                status: "running",
                backend: "android-emulator",
                port: 5580,
                avdName: `ccc-${ownerA}-pixel-owned`,
                appium: { authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start", serverPid: 11111, serverUrl: "http://127.0.0.1:4723" },
                recording: { active: true, pid: 22222, provider: "adb-screenrecord", authority: "host-broker", processOwner: "host-broker", startedBy: "broker.device.recording.start" },
            },
            {
                id: "pixel-stopped",
                status: "stopped",
                backend: "android-emulator",
                appium: { authority: "external", serverUrl: "http://127.0.0.1:4999", sessionId: "EXTERNAL-ASSOCIATION" },
            },
        ]);
        const iosRoot = writeBrokerDevices(ownerA, "ios", [
            {
                id: "ios-owned",
                status: "booted",
                backend: "ios-simulator",
                simulatorName: iosSimulatorName,
                udid: "SIM-UDID-1",
                appium: { authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start", serverPid: 33333, serverUrl: "http://127.0.0.1:8100" },
            },
        ]);
        const windowsRoot = writeBrokerDevices(ownerA, "windows", [
            {
                id: "win-owned",
                status: "running",
                backend: "windows-sandbox",
                sandboxId: "12345678-1234-4234-9234-1234567890ab",
            },
        ]);
        const windowsLock = join(homedir(), ".ccc/devices/host-locks/windows-sandbox.json");
        mkdirSync(join(homedir(), ".ccc/devices/host-locks"), { recursive: true });
        writeFileSync(windowsLock, JSON.stringify({
            provider: "windows-sandbox",
            ownerId: ownerA,
            deviceId: "win-owned",
            sandboxId: "12345678-1234-4234-9234-1234567890ab",
        }));
        const phoneRoot = writeBrokerDevices(ownerA, "android-device", [
            {
                id: "phone-owned",
                status: "attached",
                backend: "android-device",
                serial: "USB123",
                appium: { authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start", serverPid: 44444, serverUrl: "http://127.0.0.1:8200" },
                recording: { active: true, pid: 55555, provider: "adb-screenrecord", authority: "host-broker", processOwner: "host-broker", startedBy: "broker.device.recording.start" },
            },
        ]);
        const foreignRoot = writeBrokerDevices(ownerB, "android", [
            {
                id: "foreign-pixel",
                status: "running",
                backend: "android-emulator",
                port: 5590,
                appium: { authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start", serverPid: 66666, serverUrl: "http://127.0.0.1:8300" },
            },
        ]);
        const leaseDir = join(homedir(), ".ccc/devices/physical-leases/android-device/locks");
        mkdirSync(leaseDir, { recursive: true });
        const ownerLease = join(leaseDir, `${encodeURIComponent("USB123")}.json`);
        const foreignLease = join(leaseDir, `${encodeURIComponent("USB999")}.json`);
        writeFileSync(ownerLease, JSON.stringify({ backend: "android-device", hardwareId: "USB123", ownerId: ownerA, deviceId: "phone-owned" }));
        writeFileSync(foreignLease, JSON.stringify({ backend: "android-device", hardwareId: "USB999", ownerId: ownerB, deviceId: "foreign-phone" }));
        const sharedToolchainDir = join(homedir(), ".ccc/devices/broker/toolchains/appium");
        const sharedImageDir = join(homedir(), ".ccc/devices/shared/images/macos");
        mkdirSync(sharedToolchainDir, { recursive: true });
        mkdirSync(sharedImageDir, { recursive: true });
        const sharedToolchainFile = join(sharedToolchainDir, "package.json");
        const sharedImageFile = join(sharedImageDir, "base-image.marker");
        writeFileSync(sharedToolchainFile, JSON.stringify({ name: "appium-cache", version: "test" }));
        writeFileSync(sharedImageFile, "base image marker");

        try {
            const cleanup = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({ method: "broker.cleanup.owner", params: {} }),
            });
            expect(cleanup.status).toBe(200);
            const body = await cleanup.json();
            expect(body).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId: ownerA,
                    cleaned: true,
                    changedDevices: 5,
                    failed: 0,
                }),
            }));
            expect(Object.keys(body).sort()).toEqual(["ok", "result"]);
            expect(Object.keys(body.result).sort()).toEqual(["authority", "changedDevices", "cleaned", "detachPhysical", "failed", "ownerId", "results", "stopDevices"]);
            for (const backend of body.result.results) for (const device of backend.devices || []) {
                for (const signal of [device.appium?.signal, device.recording?.signal]) if (signal) {
                    expect(signal).not.toHaveProperty("ended");
                    expect(signal).not.toHaveProperty("receipt");
                }
                if (device.stop?.attempted) expect(Object.keys(device.stop).sort()).toEqual(["attempted", "execution", "ok"]);
            }
            expect(killSpy).not.toHaveBeenCalledWith(11111, "SIGTERM");
            expect(killSpy).not.toHaveBeenCalledWith(22222, "SIGINT");
            expect(killSpy).not.toHaveBeenCalledWith(33333, "SIGTERM");
            expect(killSpy).not.toHaveBeenCalledWith(44444, "SIGTERM");
            expect(killSpy).not.toHaveBeenCalledWith(55555, "SIGINT");
            expect(killSpy).not.toHaveBeenCalledWith(99999, "SIGTERM");
            expect(killSpy).not.toHaveBeenCalledWith(66666, "SIGTERM");
            expect(commands).toEqual(expect.arrayContaining([
                expect.objectContaining({ provider: "adb", args: ["-s", "emulator-5580", "emu", "kill"] }),
                expect.objectContaining({ provider: "xcrun", args: ["simctl", "shutdown", "SIM-UDID-1"] }),
                expect.objectContaining({ provider: "wsb", args: ["stop", "--id", "12345678-1234-4234-9234-1234567890ab"] }),
            ]));
            const android = JSON.parse(readFileSync(join(androidRoot, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(android.devices.find((device) => device.id === "pixel-owned")).toEqual(expect.objectContaining({
                status: "stopped",
                appium: null,
                recording: null,
            }));
            expect(android.devices.find((device) => device.id === "pixel-stopped")?.appium).toBeNull();
            const ios = JSON.parse(readFileSync(join(iosRoot, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(ios.devices.find((device) => device.id === "ios-owned")).toEqual(expect.objectContaining({
                status: "stopped",
                appium: null,
            }));
            const windows = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(windows.devices.find((device) => device.id === "win-owned")).toEqual(expect.objectContaining({
                status: "stopped",
            }));
            const phone = JSON.parse(readFileSync(join(phoneRoot, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(phone.devices.find((device) => device.id === "phone-owned")).toEqual(expect.objectContaining({
                status: "detached",
                appium: null,
                recording: null,
            }));
            expect(existsSync(windowsLock)).toBe(false);
            expect(existsSync(ownerLease)).toBe(false);
            expect(existsSync(foreignLease)).toBe(true);
            expect(existsSync(sharedToolchainFile)).toBe(true);
            expect(readFileSync(sharedToolchainFile, "utf8")).toContain("appium-cache");
            expect(existsSync(sharedImageFile)).toBe(true);
            expect(readFileSync(sharedImageFile, "utf8")).toBe("base image marker");
            const foreign = JSON.parse(readFileSync(join(foreignRoot, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(foreign.devices.find((device) => device.id === "foreign-pixel")).toEqual(expect.objectContaining({
                status: "running",
                appium: expect.objectContaining({ serverPid: 66666 }),
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerA);
            cleanupOwner(ownerB);
        }
    });

    it.each([true, false])("owner cleanup requires confirmed Android stop and reports unusable provider metadata (metadata available=%s)", async available => {
        const cwd = `/project/broker-owner-cleanup-confirmed-android-${available}`;
        const ownerId = deviceLabOwnerId(cwd), deviceId = "pixel-unconfirmed";
        const original = { id: deviceId, backend: "android-emulator", status: "running", ...(available ? {port: 5580} : {}),
            avdName: `ccc-${ownerId}-${deviceId}`, createdAt: "original", updatedAt: "original" };
        const root = writeBrokerDevices(ownerId, "android", [original]);
        const file = join(root, "devices.json"), before = readFileSync(file, "utf8");
        let now = performance.now();
        const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
        const commandRunner = vi.fn(command => {
            if (command.provider === "process-inventory") now += 11_000;
            return { ...command, status: 0, stderr: "", stdout: command.provider === "adb" && command.args?.join(" ") === "devices -l"
                ? "List of devices attached\nemulator-5580\tdevice\n"
                : command.provider === "process-inventory" ? `emulator -avd ${original.avdName} -port 5580\n` : "" };
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0,
            providerPaths: { adb: "/fake/adb" }, commandRunner });
        const baseUrl = await listen(server);
        try {
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.cleanup.owner", params: { backend: "android" } }) });
            expect(cleanup.status).toBe(200);
            const body = await cleanup.json();
            expect(body).toMatchObject({ ok: false, result: { changedDevices: 0, failed: 1,
                results: [{ stateKey: "android", devices: [{ deviceId, stop: { attempted: available, ok: false } }] }] } });
            expect(readFileSync(file, "utf8")).toBe(before);
            const kills = commandRunner.mock.calls.filter(([command]) => command.provider === "adb" && command.args?.at(-1) === "kill");
            expect(kills).toHaveLength(available ? 1 : 0);
            if (available) {
                expect(commandRunner.mock.calls.some(([command]) => command.provider === "process-inventory")).toBe(true);
                expect(Object.keys(body.result.results[0].devices[0].stop).sort()).toEqual(["attempted", "execution", "ok"]);
            } else {
                expect(commandRunner).not.toHaveBeenCalled();
                expect(body.result.results[0].devices[0].stop).not.toHaveProperty("execution");
            }
        } finally { clock.mockRestore(); await close(server); cleanupOwner(ownerId); }
    });

    it.each([
        {stateKey: "android", backend: "android-emulator", provider: "adb"},
        {stateKey: "ios", backend: "ios-simulator", provider: "xcrun"},
        {stateKey: "macos", backend: "macos-vm", provider: "tart"},
        {stateKey: "windows", backend: "windows-sandbox", provider: "wsb"},
    ])("owner cleanup retains late successful $backend stop receipts without publishing stopped", async ({stateKey, backend, provider}) => {
        const cwd = `/project/broker-owner-cleanup-late-stop-${stateKey}`, ownerId = deviceLabOwnerId(cwd), deviceId = "late-stop";
        const simulatorName = `ccc-${ownerId}-${deviceId}`;
        const sandboxId = "12345678-1234-4234-9234-1234567890ab", singletonClaimId = "1234567890abcdef1234567890abcdef";
        const original = {id: deviceId, backend, status: stateKey === "ios" ? "booted" : "running", createdAt: "original", updatedAt: "original",
            ...(stateKey === "android" ? {port: 5580, avdName: simulatorName} : {}),
            ...(stateKey === "ios" ? {udid: "LATE-SIM-UDID", simulatorName} : {}),
            ...(stateKey === "macos" ? {provider: "tart", providerInstance: simulatorName, headless: true} : {}),
            ...(stateKey === "windows" ? {sandboxId, singletonClaimId} : {})};
        const root = writeBrokerDevices(ownerId, stateKey, [original]), file = join(root, "devices.json");
        const before = readFileSync(file, "utf8");
        const singletonFile = join(homedir(), ".ccc/devices/host-locks/windows-sandbox.json");
        let singletonBefore: string | undefined;
        if (stateKey === "windows") {
            let bootId: string;
            try {bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();}
            catch {bootId = `${hostname()}:${Math.floor((Date.now() - uptime() * 1000) / 1000)}`;}
            mkdirSync(join(homedir(), ".ccc/devices/host-locks"), {recursive: true});
            writeFileSync(singletonFile, JSON.stringify({provider: "windows-sandbox", host: hostname(), bootId, ownerId, deviceId,
                sandboxId, claimId: singletonClaimId, pid: process.pid, acquiredAt: new Date().toISOString(), updatedAt: new Date().toISOString()}));
            singletonBefore = readFileSync(singletonFile, "utf8");
        }
        let now = 0, stopObserved = false;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
        const isStop = (command: {provider: string; args?: string[]}) => command.provider === provider && (
            stateKey === "android" ? command.args?.at(-1) === "kill"
                : stateKey === "ios" ? command.args?.[1] === "shutdown" : command.args?.[0] === "stop");
        const commandRunner = vi.fn((command, options) => {
            if (isStop(command)) {
                expect(options.timeoutMs).toBeLessThanOrEqual(1000);
                stopObserved = true;
                now += 2000;
            }
            return {...command, status: 0, stderr: "", stdout: command.provider === "xcrun" && command.args?.join(" ") === "simctl list devices -j"
                ? JSON.stringify({devices: {runtime: [{name: simulatorName, udid: "LATE-SIM-UDID", state: "Booted"}]}}) : ""};
        });
        const server = createDeviceBrokerServer({cwd, host: "127.0.0.1", port: 0, commandTimeoutMs: 1000,
            ...(stateKey === "windows" ? {platform: "linux" as const} : {}),
            providerPaths: {adb: "/fake/adb", xcrun: "/fake/xcrun", tart: "/fake/tart", wsb: "/fake/wsb"}, commandRunner});
        const baseUrl = await listen(server);
        try {
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({method: "broker.cleanup.owner", params: {backend: stateKey}})});
            expect(cleanup.status).toBe(200);
            const body = await cleanup.json();
            expect(stopObserved).toBe(true);
            expect(body).toMatchObject({ok: false, result: {changedDevices: 0, failed: 1,
                results: [{devices: [{deviceId, stop: {attempted: true, ok: false, execution: {provider, status: 0}}}]}]}});
            expect(readFileSync(file, "utf8")).toBe(before);
            if (stateKey === "windows") expect(readFileSync(singletonFile, "utf8")).toBe(singletonBefore);
            const stopIndex = commandRunner.mock.calls.findIndex(([command]) => isStop(command));
            expect(commandRunner.mock.calls.slice(stopIndex + 1)).toEqual([]);
        } finally {clock.mockRestore(); await close(server); cleanupOwner(ownerId);}
    });

    it.runIf(process.platform === "linux")("owner cleanup rechecks the publication deadline after waiting for the inventory lock", async () => {
        const cwd = "/project/broker-owner-cleanup-publication-contention", ownerId = deviceLabOwnerId(cwd), deviceId = "late-publication";
        const original = {id: deviceId, backend: "macos-vm", status: "running", provider: "tart",
            providerInstance: `ccc-${ownerId}-${deviceId}`, headless: true, createdAt: "original", updatedAt: "original"};
        const root = writeBrokerDevices(ownerId, "macos", [original]), file = join(root, "devices.json");
        const before = readFileSync(file, "utf8"), lock = join(root, "devices.mutation.lock");
        const ready = join(homedir(), "publication-lock-module-ready"), request = join(homedir(), "publication-lock-request");
        const acquired = join(homedir(), "publication-lock-acquired"), released = join(homedir(), "publication-lock-released");
        const sharedStateModule = new URL("../../packages/device-lab/dist/device-lab-shared-state.js", import.meta.url).href;
        const {child} = await ownedCleanupChild(`const fs=require('node:fs');
            import(process.argv[1]).then(({withSharedMutationLock}) => {
                fs.writeFileSync(process.argv[2],'ready');
                const timer=setInterval(() => {
                    if (!fs.existsSync(process.argv[3])) return;
                    clearInterval(timer);
                    withSharedMutationLock(process.argv[4], () => {
                        fs.writeFileSync(process.argv[5],'acquired');
                        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);
                        fs.writeFileSync(process.argv[6],'released');
                    });
                },10);
            }).catch(error => {process.stderr.write(String(error)); process.exit(1);});`,
            [sharedStateModule, ready, request, lock, acquired, released]);
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), {timeout: 5000, interval: 20});
        let providerReturnedAt = 0;
        const commandRunner = vi.fn(command => {
            expect(command.provider).toBe("tart");
            expect(command.args).toEqual(["stop", original.providerInstance]);
            writeFileSync(request, "acquire");
            const waitUntil = performance.now() + 500;
            while (!existsSync(acquired) && performance.now() < waitUntil)
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            expect(existsSync(acquired)).toBe(true);
            expect(existsSync(lock)).toBe(true);
            providerReturnedAt = Date.now();
            return {...command, status: 0, stdout: "", stderr: ""};
        });
        const server = createDeviceBrokerServer({cwd, host: "127.0.0.1", port: 0, commandTimeoutMs: 1000,
            providerPaths: {tart: "/fake/tart"}, commandRunner}), baseUrl = await listen(server);
        try {
            const requestedAt = Date.now();
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({method: "broker.cleanup.owner", params: {backend: "macos"}})});
            expect(cleanup.status).toBe(200);
            expect(providerReturnedAt - requestedAt).toBeLessThan(1000);
            expect(await cleanup.json()).toMatchObject({ok: false, result: {changedDevices: 0, failed: 1,
                results: [{devices: [{deviceId, stop: {attempted: true, ok: false, execution: {provider: "tart", status: 0}}}]}]}});
            expect(existsSync(released)).toBe(true);
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(readFileSync(file, "utf8")).toBe(before);
            expect(existsSync(lock)).toBe(false);
        } finally {await reapCleanupChild(child); await close(server); cleanupOwner(ownerId);}
    });

    it.runIf(process.platform === "linux")("owner Sandbox cleanup retains its exact singleton claim after release-lock contention expires the deadline", async () => {
        const cwd = "/project/broker-owner-cleanup-sandbox-singleton-deadline", ownerId = deviceLabOwnerId(cwd), deviceId = "win-deadline";
        const sandboxId = "12345678-1234-4234-9234-1234567890ab", claimId = "1234567890abcdef1234567890abcdef";
        const original = {id: deviceId, backend: "windows-sandbox", status: "running", sandboxId, singletonClaimId: claimId,
            createdAt: "original", updatedAt: "original"};
        const root = writeBrokerDevices(ownerId, "windows", [original]), file = join(root, "devices.json"), before = readFileSync(file, "utf8");
        const hostLocks = join(homedir(), ".ccc/devices/host-locks"), singletonFile = join(hostLocks, "windows-sandbox.json");
        mkdirSync(hostLocks, {recursive: true});
        writeFileSync(singletonFile, JSON.stringify({provider: "windows-sandbox", host: hostname(),
            bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), ownerId, deviceId, sandboxId, claimId,
            pid: process.pid, acquiredAt: new Date().toISOString(), updatedAt: new Date().toISOString()}));
        const singletonBefore = readFileSync(singletonFile, "utf8"), lock = join(hostLocks, "windows-sandbox.mutation.lock");
        const ready = join(homedir(), "singleton-lock-module-ready"), request = join(homedir(), "singleton-lock-request");
        const acquired = join(homedir(), "singleton-lock-acquired"), elapsed = join(homedir(), "singleton-lock-deadline-elapsed");
        const sharedStateModule = new URL("../../packages/device-lab/dist/device-lab-shared-state.js", import.meta.url).href;
        const {child} = await ownedCleanupChild(`const fs=require('node:fs');
            import(process.argv[1]).then(({withSharedMutationLock}) => {
                fs.writeFileSync(process.argv[2],'ready');
                const timer=setInterval(() => {
                    if (!fs.existsSync(process.argv[3])) return;
                    clearInterval(timer);
                    withSharedMutationLock(process.argv[4], () => {
                        fs.writeFileSync(process.argv[5],'acquired');
                        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);
                        fs.writeFileSync(process.argv[6],'elapsed');
                    });
                },10);
            }).catch(error => {process.stderr.write(String(error)); process.exit(1);});`,
            [sharedStateModule, ready, request, lock, acquired, elapsed]);
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), {timeout: 5000, interval: 20});
        let providerReturnedAt = 0;
        const commandRunner = vi.fn(command => {
            expect(command.provider).toBe("wsb");
            expect(command.args).toEqual(["stop", "--id", sandboxId]);
            writeFileSync(request, "acquire");
            const waitUntil = performance.now() + 500;
            while (!existsSync(acquired) && performance.now() < waitUntil)
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            expect(existsSync(acquired)).toBe(true);
            providerReturnedAt = Date.now();
            return {...command, status: 0, stdout: "", stderr: ""};
        });
        const server = createDeviceBrokerServer({cwd, host: "127.0.0.1", port: 0, platform: "linux", commandTimeoutMs: 1000,
            providerPaths: {wsb: "/fake/wsb"}, commandRunner}), baseUrl = await listen(server);
        try {
            const requestedAt = Date.now();
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({method: "broker.cleanup.owner", params: {backend: "windows"}})});
            expect(cleanup.status).toBe(200);
            expect(providerReturnedAt - requestedAt).toBeLessThan(1000);
            expect(await cleanup.json()).toMatchObject({ok: false, result: {changedDevices: 0, failed: 1,
                results: [{devices: [{deviceId, stop: {attempted: true, ok: false, execution: {provider: "wsb", status: 0}}}]}]}});
            expect(existsSync(elapsed)).toBe(true);
            expect(existsSync(lock)).toBe(false);
            expect(commandRunner).toHaveBeenCalledTimes(1);
            expect(readFileSync(file, "utf8")).toBe(before);
            expect(readFileSync(singletonFile, "utf8")).toBe(singletonBefore);
        } finally {await reapCleanupChild(child); await close(server); cleanupOwner(ownerId);}
    });

    it.runIf(process.platform === "linux").each(["hardware-guard", "publication-rollback"] as const)("owner physical cleanup refuses effects after lock contention exhausts its deadline: %s", async mode => {
        const cwd = `/project/broker-owner-cleanup-physical-deadline-${mode}`, ownerId = deviceLabOwnerId(cwd);
        const deviceId = "phone-owned", serial = "PHYSICAL-DEADLINE", claimId = "physical-deadline-claim", claimNonce = "physical-deadline-nonce";
        const original = {id: deviceId, backend: "android-device", status: "attached", physical: true, serial,
            leaseClaimId: claimId, leaseClaimNonce: claimNonce, createdAt: "original", updatedAt: "original"};
        const root = writeBrokerDevices(ownerId, "android-device", [original]), file = join(root, "devices.json");
        const before = readFileSync(file, "utf8");
        writePhysicalLease(ownerId, "android-device", serial, deviceId, claimId, claimNonce);
        const leaseDirectory = join(homedir(), ".ccc/devices/physical-leases/android-device/locks");
        const leaseFile = join(leaseDirectory, `${serial}.json`), leaseBefore = readFileSync(leaseFile, "utf8");
        const lock = mode === "hardware-guard" ? join(leaseDirectory, `${serial}.mutation.lock`) : join(root, "devices.mutation.lock");
        const ready = join(homedir(), "physical-lock-module-ready"), request = join(homedir(), "physical-lock-request");
        const acquired = join(homedir(), "physical-lock-acquired"), elapsed = join(homedir(), "physical-lock-deadline-elapsed");
        const sharedStateModule = new URL("../../packages/device-lab/dist/device-lab-shared-state.js", import.meta.url).href;
        const {child} = await ownedCleanupChild(`const fs=require('node:fs');
            import(process.argv[1]).then(({withSharedMutationLock}) => {
                fs.writeFileSync(process.argv[2],'ready');
                const hold=() => withSharedMutationLock(process.argv[4], () => {
                    fs.writeFileSync(process.argv[5],'acquired');
                    while (!fs.existsSync(process.argv[3])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);
                    fs.writeFileSync(process.argv[6],'elapsed');
                });
                if (process.argv[7]==='hardware-guard') hold();
                else {
                    const timer=setInterval(() => {
                        if (!fs.existsSync(process.argv[3])) return;
                        clearInterval(timer); hold();
                    },10);
                }
            }).catch(error => {process.stderr.write(String(error)); process.exit(1);});`,
            [sharedStateModule, ready, request, lock, acquired, elapsed, mode]);
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), {timeout: 5000, interval: 20});
        if (mode === "hardware-guard") await vi.waitFor(() => expect(existsSync(acquired)).toBe(true), {timeout: 5000, interval: 20});
        const nativeUnlink = fixtureFs.unlinkSync;
        let exactLeaseReleased = false;
        const releaseBoundary = vi.spyOn(fixtureFs, "unlinkSync").mockImplementation(path => {
            const result = nativeUnlink(path);
            if (String(path) === leaseFile) {
                exactLeaseReleased = true;
                if (mode === "publication-rollback") {
                    expect(existsSync(leaseFile)).toBe(false);
                    writeFileSync(request, "acquire");
                    const waitUntil = performance.now() + 500;
                    while (!existsSync(acquired) && performance.now() < waitUntil)
                        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                    expect(existsSync(acquired)).toBe(true);
                }
            }
            return result;
        });
        const commandRunner = vi.fn(() => {throw new Error("physical cleanup must not run a provider command");});
        const server = createDeviceBrokerServer({cwd, host: "127.0.0.1", port: 0, commandTimeoutMs: 1000, commandRunner});
        const baseUrl = await listen(server);
        try {
            if (mode === "hardware-guard") writeFileSync(request, "start-hold");
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({method: "broker.cleanup.owner", params: {backend: "android-device"}})});
            expect(cleanup.status).toBe(200);
            const body = await cleanup.json();
            expect(body).toMatchObject({ok: false, result: {changedDevices: 0, failed: 1}});
            expect(existsSync(elapsed)).toBe(true);
            expect(existsSync(lock)).toBe(false);
            expect(commandRunner).not.toHaveBeenCalled();
            expect(readFileSync(file, "utf8")).toBe(before);
            if (mode === "hardware-guard") {
                expect(exactLeaseReleased).toBe(false);
                expect(readFileSync(leaseFile, "utf8")).toBe(leaseBefore);
            } else {
                expect(exactLeaseReleased).toBe(true);
                const restored = JSON.parse(readFileSync(leaseFile, "utf8"));
                expect(restored).toMatchObject({backend: "android-device", hardwareId: serial, ownerId, deviceId, claimId, claimNonce});
                expect(Date.parse(restored.expiresAt)).toBeGreaterThanOrEqual(Date.parse(JSON.parse(leaseBefore).expiresAt));
                expect(body.result.results[0].devices[0]).toMatchObject({stateWrite: {ok: false,
                    leaseRollback: {attempted: true, ok: true, lease: restored}}});
            }
        } finally {releaseBoundary.mockRestore(); await reapCleanupChild(child); await close(server); cleanupOwner(ownerId); rmSync(leaseFile, {force: true});}
    });

    it.runIf(process.platform === "linux").each(["recording-ignores-int", "appium-delayed-term"] as const)("owner cleanup observes native child completion before releasing a physical lease: %s", async mode => {
        const cwd = `/project/broker-owner-cleanup-native-${mode}`, ownerId = deviceLabOwnerId(cwd);
        const deviceId = "phone-owned", serial = "NATIVE-CLEANUP", claimId = "native-claim", claimNonce = "native-nonce";
        const { child, identity } = await ownedCleanupChild(mode === "recording-ignores-int"
            ? "process.on('SIGINT', () => {});"
            : "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));");
        const runtime = mode === "recording-ignores-int"
            ? { recording: { active: true, pid: child.pid, runtimeId: "native-recording", processIdentity: identity,
                provider: "adb-screenrecord", authority: "host-broker", processOwner: "host-broker", startedBy: "broker.device.recording.start" } }
            : { appium: { serverPid: child.pid, runtimeId: "native-appium", processIdentity: identity,
                serverUrl: "http://127.0.0.1:4723", authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start" } };
        const original = { id: deviceId, backend: "android-device", status: "attached", physical: true, serial,
            leaseClaimId: claimId, leaseClaimNonce: claimNonce, ...runtime };
        const root = writeBrokerDevices(ownerId, "android-device", [original]);
        writePhysicalLease(ownerId, "android-device", serial, deviceId, claimId, claimNonce);
        const file = join(root, "devices.json"), before = readFileSync(file, "utf8");
        const leaseFile = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${serial}.json`);
        const leaseBefore = readFileSync(leaseFile, "utf8");
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.cleanup.owner", params: { backend: "android-device" } }) });
            expect(cleanup.status).toBe(200);
            const body = await cleanup.json(), ended = mode === "appium-delayed-term";
            expect(body).toMatchObject({ ok: ended, result: { changedDevices: ended ? 1 : 0, failed: ended ? 0 : 1 } });
            const report = body.result.results[0].devices[0], signal = ended ? report.appium.signal : report.recording.signal;
            expect(signal).toMatchObject({ ok: ended });
            expect(signal).not.toHaveProperty("ended");
            expect(signal).not.toHaveProperty("receipt");
            if (ended) {
                expect(readDeviceRuntimeProcessIdentity(child.pid!)).toBeNull();
                expect(existsSync(leaseFile)).toBe(false);
                expect(JSON.parse(readFileSync(file, "utf8")).devices[0]).toMatchObject({ status: "detached", appium: null });
            } else {
                expect(readDeviceRuntimeProcessIdentity(child.pid!)).toEqual(identity);
                expect(readFileSync(file, "utf8")).toBe(before);
                expect(readFileSync(leaseFile, "utf8")).toBe(leaseBefore);
                expect(report.physical?.lease?.payload?.released ?? false).toBe(false);
            }
        } finally { await reapCleanupChild(child); await close(server); cleanupOwner(ownerId); rmSync(leaseFile, { force: true }); }
    });

    it.runIf(process.platform === "linux")("owner cleanup clears a prior process birth without signaling the live PID successor", async () => {
        const cwd = "/project/broker-owner-cleanup-process-birth", ownerId = deviceLabOwnerId(cwd);
        const deviceId = "phone-owned", serial = "PROCESS-BIRTH", claimId = "birth-claim", claimNonce = "birth-nonce";
        const signalMarker = join(homedir(), "successor-signal-unexpected");
        const { child, identity } = await ownedCleanupChild(`const fs=require('node:fs');
            for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => fs.writeFileSync(process.argv[1],signal));`, [signalMarker]);
        const original = {id: deviceId, backend: "android-device", status: "attached", physical: true, serial,
            leaseClaimId: claimId, leaseClaimNonce: claimNonce,
            appium: {serverPid: child.pid, runtimeId: "previous-process-birth", processIdentity: {...identity, startToken: "linux:0"},
                serverUrl: "http://127.0.0.1:4723", authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start"}};
        const root = writeBrokerDevices(ownerId, "android-device", [original]), file = join(root, "devices.json");
        writePhysicalLease(ownerId, "android-device", serial, deviceId, claimId, claimNonce);
        const leaseFile = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${serial}.json`);
        const server = createDeviceBrokerServer({cwd, host: "127.0.0.1", port: 0}), baseUrl = await listen(server);
        try {
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({method: "broker.cleanup.owner", params: {backend: "android-device"}})});
            expect(cleanup.status).toBe(200);
            const body = await cleanup.json();
            expect(body).toMatchObject({ok: true, result: {changedDevices: 1, failed: 0,
                results: [{devices: [{appium: {cleared: true, signal: {attempted: false, ok: true}}}]}]}});
            expect(JSON.parse(readFileSync(file, "utf8")).devices[0]).toMatchObject({status: "detached", appium: null});
            expect(existsSync(leaseFile)).toBe(false);
            expect(readDeviceRuntimeProcessIdentity(child.pid!)).toEqual(identity);
            expect(existsSync(signalMarker)).toBe(false);
        } finally {await reapCleanupChild(child); await close(server); cleanupOwner(ownerId); rmSync(leaseFile, {force: true});}
    });

    it.runIf(process.platform === "linux")("owner cleanup stops issuing runtime effects when its parent deadline expires", async () => {
        const cwd = "/project/broker-owner-cleanup-parent-deadline", ownerId = deviceLabOwnerId(cwd);
        const deviceId = "phone-owned", serial = "PARENT-DEADLINE", claimId = "deadline-claim", claimNonce = "deadline-nonce";
        const termMarker = join(homedir(), "cleanup-term-observed"), intMarker = join(homedir(), "cleanup-int-unexpected");
        const { child, identity } = await ownedCleanupChild(`const fs=require('node:fs');
            process.on('SIGTERM', () => fs.writeFileSync(process.argv[1],'observed'));
            process.on('SIGINT', () => fs.writeFileSync(process.argv[2],'unexpected'));`, [termMarker, intMarker]);
        const original = { id: deviceId, backend: "android-device", status: "attached", physical: true, serial,
            leaseClaimId: claimId, leaseClaimNonce: claimNonce,
            appium: { serverPid: child.pid, runtimeId: "deadline-appium", processIdentity: identity, serverUrl: "http://127.0.0.1:4723",
                authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start" },
            recording: { active: true, pid: child.pid, runtimeId: "deadline-recording", processIdentity: identity,
                authority: "host-broker", processOwner: "host-broker", startedBy: "broker.device.recording.start", provider: "adb-screenrecord" } };
        const root = writeBrokerDevices(ownerId, "android-device", [original]), file = join(root, "devices.json");
        const before = readFileSync(file, "utf8");
        writePhysicalLease(ownerId, "android-device", serial, deviceId, claimId, claimNonce);
        const leaseFile = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${serial}.json`);
        const leaseBefore = readFileSync(leaseFile, "utf8");
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, commandTimeoutMs: 1000 });
        const baseUrl = await listen(server);
        try {
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({method: "broker.cleanup.owner", params: {backend: "android-device"}})});
            expect(cleanup.status).toBe(200);
            const body = await cleanup.json();
            expect(body).toMatchObject({ok: false, result: {changedDevices: 0}});
            expect(body.result.failed).toBeGreaterThan(0);
            expect(readFileSync(termMarker, "utf8")).toBe("observed");
            expect(readDeviceRuntimeProcessIdentity(child.pid!)).toEqual(identity);
            expect(existsSync(intMarker)).toBe(false);
            expect(readFileSync(file, "utf8")).toBe(before);
            expect(readFileSync(leaseFile, "utf8")).toBe(leaseBefore);
        } finally { await reapCleanupChild(child); await close(server); cleanupOwner(ownerId); rmSync(leaseFile, {force: true}); }
    });

    it.runIf(process.platform === "win32")("owner cleanup refuses Windows runtime PID and process identity PID disagreement before termination", async () => {
        const cwd = "/project/broker-owner-cleanup-windows-pid-binding", ownerId = deviceLabOwnerId(cwd);
        const appium = {...currentProcessAppiumRuntime("http://127.0.0.1:4723", 4723, "windows-pid-binding"), serverPid: process.pid + 1};
        const original = {id: "pixel-pid-binding", backend: "android-emulator", status: "stopped", appium};
        const root = writeBrokerDevices(ownerId, "android", [original]), file = join(root, "devices.json");
        const before = readFileSync(file, "utf8");
        const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
        const terminate = vi.spyOn(windowsProcesses, "terminateWindowsProcessByStartToken")
            .mockImplementation(pid => ({ok: true, pid, status: 0}));
        const server = createDeviceBrokerServer({cwd, host: "127.0.0.1", port: 0}), baseUrl = await listen(server);
        try {
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({method: "broker.cleanup.owner", params: {backend: "android", stopDevices: false}})});
            expect(cleanup.status).toBe(200);
            expect(await cleanup.json()).toMatchObject({ok: false, result: {changedDevices: 0, failed: 1}});
            expect(terminate).not.toHaveBeenCalled();
            expect(kill.mock.calls.some(([pid, signal]) => pid === appium.serverPid && signal !== 0)).toBe(false);
            expect(readFileSync(file, "utf8")).toBe(before);
        } finally {await close(server); cleanupOwner(ownerId);}
    });

    it.runIf(process.platform === "win32")("owner cleanup preserves Appium metadata when the Windows liveness probe is denied", async () => {
        const cwd = "/project/broker-owner-cleanup-windows-probe-denied", ownerId = deviceLabOwnerId(cwd);
        const original = {id: "pixel-denied", backend: "android-emulator", status: "stopped",
            appium: currentProcessAppiumRuntime("http://127.0.0.1:4723", 4723, "windows-probe-denied")};
        const root = writeBrokerDevices(ownerId, "android", [original]), file = join(root, "devices.json");
        const before = readFileSync(file, "utf8");
        const denied = Object.assign(new Error("process liveness probe denied"), {code: "EPERM"});
        vi.spyOn(process, "kill").mockImplementation(() => { throw denied; });
        const terminate = vi.spyOn(windowsProcesses, "terminateWindowsProcessByStartToken")
            .mockImplementation(pid => ({ok: false, pid, status: 1, reason: "process-handle-unavailable"}));
        const server = createDeviceBrokerServer({cwd, host: "127.0.0.1", port: 0}), baseUrl = await listen(server);
        try {
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({method: "broker.cleanup.owner", params: {backend: "android", stopDevices: false}})});
            expect(cleanup.status).toBe(200);
            expect(await cleanup.json()).toMatchObject({ok: false, result: {changedDevices: 0, failed: 1}});
            expect(terminate).toHaveBeenCalledWith(process.pid, original.appium.processIdentity.startToken);
            expect(readFileSync(file, "utf8")).toBe(before);
        } finally { await close(server); cleanupOwner(ownerId); }
    });

    it.runIf(process.platform === "linux")("owner cleanup preserves a successor written during Appium wait before later runtime or lease effects", async () => {
        const cwd = "/project/broker-owner-cleanup-native-successor", ownerId = deviceLabOwnerId(cwd);
        const deviceId = "phone-owned", serial = "NATIVE-SUCCESSOR", claimId = "successor-claim", claimNonce = "successor-nonce";
        const control = join(homedir(), "cleanup-successor.json"), laterSignal = join(homedir(), "unexpected-recording-int");
        const { child, identity } = await ownedCleanupChild(`const fs=require('node:fs');
            process.on('SIGTERM', () => { const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); fs.writeFileSync(c.file,JSON.stringify({devices:[c.successor]})); });
            process.on('SIGINT', () => fs.writeFileSync(process.argv[2],'unexpected'));`, [control, laterSignal]);
        const original = { id: deviceId, backend: "android-device", status: "attached", physical: true, serial,
            leaseClaimId: claimId, leaseClaimNonce: claimNonce, createdAt: "predecessor",
            appium: { serverPid: child.pid, runtimeId: "old-appium", processIdentity: identity, serverUrl: "http://127.0.0.1:4723",
                authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start" },
            recording: { active: true, pid: child.pid, runtimeId: "old-recording", processIdentity: identity,
                authority: "host-broker", processOwner: "host-broker", startedBy: "broker.device.recording.start", provider: "adb-screenrecord" },
            minimizeWatchdog: { processOwner: "host-broker", startedBy: "broker.windows-sandbox.minimize-watchdog", pid: 987654 } };
        const successor = { ...original, createdAt: "successor", appium: { ...original.appium, runtimeId: "new-appium" },
            recording: { ...original.recording, runtimeId: "new-recording" } };
        const root = writeBrokerDevices(ownerId, "android-device", [original]), file = join(root, "devices.json");
        writeFileSync(control, JSON.stringify({ file, successor }));
        writePhysicalLease(ownerId, "android-device", serial, deviceId, claimId, claimNonce);
        const leaseFile = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${serial}.json`);
        const leaseBefore = readFileSync(leaseFile, "utf8");
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 }), baseUrl = await listen(server);
        try {
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.cleanup.owner", params: { backend: "android-device" } }) });
            expect(cleanup.status).toBe(200);
            expect(await cleanup.json()).toMatchObject({ ok: false, result: { changedDevices: 0,
                results: [{ devices: [{ stateConflict: true }] }] } });
            expect(JSON.parse(readFileSync(file, "utf8")).devices).toEqual([successor]);
            expect(readDeviceRuntimeProcessIdentity(child.pid!)).toEqual(identity);
            expect(existsSync(laterSignal)).toBe(false);
            expect(existsSync(join(homedir(), ".ccc/devices/owners", ownerId, "windows", deviceId, "downloads/ccc-minimize-watchdog.cancel"))).toBe(false);
            expect(readFileSync(leaseFile, "utf8")).toBe(leaseBefore);
        } finally { await reapCleanupChild(child); await close(server); cleanupOwner(ownerId); rmSync(leaseFile, { force: true }); }
    });

    it("runs provider cleanup outside the state mutation lock and preserves a concurrent successor record", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-owner-cleanup-race-test");
        let androidRoot = "";
        const commandRunner = vi.fn((command) => {
            expect(existsSync(join(androidRoot, "devices.mutation.lock"))).toBe(false);
            if (command.provider === "adb" && command.args?.at(-1) === "kill") writeFileSync(join(androidRoot, "devices.json"), JSON.stringify({
                devices: [{
                    id: "pixel-cleanup-race",
                    status: "running",
                    backend: "android-emulator",
                    port: 5582,
                    avdName: `ccc-${ownerId}-pixel-cleanup-race`,
                    successorGeneration: 2,
                }],
            }));
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                stdout: command.provider === "adb" && command.args?.join(" ") === "devices -l" ? "List of devices attached\n" : "",
                stderr: "",
            };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-owner-cleanup-race-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        androidRoot = writeBrokerDevices(ownerId, "android", [{
            id: "pixel-cleanup-race",
            status: "running",
            backend: "android-emulator",
            port: 5582,
            avdName: `ccc-${ownerId}-pixel-cleanup-race`,
            successorGeneration: 1,
        }]);

        try {
            const cleanup = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.cleanup.owner", params: { backend: "android" } }),
            });
            expect(cleanup.status).toBe(200);
            expect(await cleanup.json()).toEqual(expect.objectContaining({
                ok: false,
                result: expect.objectContaining({
                    changedDevices: 0,
                    failed: 1,
                    results: [expect.objectContaining({
                        stateKey: "android",
                        devices: [expect.objectContaining({ stateConflict: true })],
                    })],
                }),
            }));
            expect(commandRunner.mock.calls.filter(([command]) => command.provider === "adb" && command.args?.at(-1) === "kill")).toHaveLength(1);
            expect(commandRunner.mock.calls.some(([command]) => command.provider === "process-inventory")).toBe(true);
            const state = JSON.parse(readFileSync(join(androidRoot, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(state.devices[0]).toEqual(expect.objectContaining({ status: "running", successorGeneration: 2 }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("restores a physical lease when owner cleanup cannot persist detached state", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-owner-cleanup-write-failure-test");
        const deviceId = "phone-cleanup-write-failure";
        const serial = "USB-CLEANUP-WRITE-FAILURE";
        const claimId = "claim-cleanup-write-failure";
        const claimNonce = "nonce-cleanup-write-failure";
        const phoneRoot = writeBrokerDevices(ownerId, "android-device", [{
            id: deviceId,
            status: "attached",
            backend: "android-device",
            physical: true,
            serial,
            leaseClaimId: claimId,
            leaseClaimNonce: claimNonce,
        }]);
        mkdirSync(join(phoneRoot, "operations"), { recursive: true });
        const leaseDir = join(homedir(), ".ccc/devices/physical-leases/android-device/locks");
        const leaseFile = join(leaseDir, `${encodeURIComponent(serial)}.json`);
        mkdirSync(leaseDir, { recursive: true });
        writeFileSync(leaseFile, JSON.stringify({
            backend: "android-device",
            hardwareId: serial,
            ownerId,
            deviceId,
            claimId,
            claimNonce,
            expiresAt: new Date(Date.now() + 10_000).toISOString(),
        }));
        const server = createDeviceBrokerServer({ cwd: "/project/broker-owner-cleanup-write-failure-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const cleanup = () => fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ method: "broker.cleanup.owner", params: { backend: "android-device" } }),
        });
        const rename = fixtureFs.renameSync;
        const stateWriteFailure = vi.spyOn(fixtureFs, "renameSync").mockImplementation((source, target) => {
            if (String(target) === join(phoneRoot, "devices.json")) {
                throw Object.assign(new Error("injected state write failure"), { code: "EIO" });
            }
            return rename(source, target);
        });
        try {
            const failed = await cleanup();
            expect(failed.status).toBe(200);
            expect(await failed.json()).toEqual(expect.objectContaining({
                ok: false,
                result: expect.objectContaining({
                    changedDevices: 0,
                    failed: 1,
                    results: [expect.objectContaining({
                        stateKey: "android-device",
                        devices: [expect.objectContaining({
                            stateWrite: expect.objectContaining({
                                ok: false,
                                error: "owner-state-write-failed",
                                leaseRollback: expect.objectContaining({ attempted: true, ok: true }),
                            }),
                        })],
                    })],
                }),
            }));
            expect(JSON.parse(readFileSync(leaseFile, "utf8"))).toEqual(expect.objectContaining({
                ownerId,
                deviceId,
                claimId,
                claimNonce,
            }));
            const state = JSON.parse(readFileSync(join(phoneRoot, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(state.devices[0]).toEqual(expect.objectContaining({
                status: "attached",
                leaseClaimId: claimId,
                leaseClaimNonce: claimNonce,
            }));

            stateWriteFailure.mockRestore();
            const recovered = await cleanup();
            expect(recovered.status).toBe(200);
            expect(await recovered.json()).toEqual(expect.objectContaining({ ok: true }));
            expect(existsSync(leaseFile)).toBe(false);
        } finally {
            stateWriteFailure.mockRestore();
            await close(server);
            cleanupOwner(ownerId);
            rmSync(leaseFile, { force: true });
        }
    });

    it("reports cleanup backend failures while preserving physical attachment on lease conflict", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-owner-cleanup-partial-test");
        const recordingIdentity = { pid: 2147483647, startToken: "missing-process", commandHash: "1".repeat(64) };
        const stale = new Error("no such process") as Error & { code: string };
        stale.code = "ESRCH";
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
            throw stale;
        });
        const server = createDeviceBrokerServer({ cwd: "/project/broker-owner-cleanup-partial-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const androidRoot = writeBrokerDevices(ownerId, "android", []);
        writeFileSync(join(androidRoot, "devices.json"), "x".repeat(300 * 1024));
        const iosRoot = writeBrokerDevices(ownerId, "ios", [
            {
                id: "ios-readable",
                status: "stopped",
                backend: "ios-simulator",
                appium: { authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start", serverPid: 88888, serverUrl: "http://127.0.0.1:8100" },
                recording: {
                    active: true,
                    pid: recordingIdentity.pid,
                    runtimeId: "cleanup-stale-recording",
                    processIdentity: recordingIdentity,
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.device.recording.start",
                },
            },
        ]);
        const iosDeviceRoot = writeBrokerDevices(ownerId, "ios-device", [
            {
                id: "iphone-conflict",
                status: "attached",
                backend: "ios-device",
                udid: "REAL-LEASE-CONFLICT",
                appium: {
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.appium.start",
                    serverPid: 77777,
                    processIdentity: recordingIdentity,
                },
                recording: {
                    active: true,
                    pid: 77778,
                    runtimeId: "physical-cleanup-conflict-recording",
                    processIdentity: recordingIdentity,
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.device.recording.start",
                },
            },
        ]);
        const leaseDir = join(homedir(), ".ccc/devices/physical-leases/ios-device/locks");
        mkdirSync(leaseDir, { recursive: true });
        const conflictingLease = join(leaseDir, `${encodeURIComponent("REAL-LEASE-CONFLICT")}.json`);
        writeFileSync(conflictingLease, JSON.stringify({ backend: "ios-device", hardwareId: "REAL-LEASE-CONFLICT", ownerId: "another-owner", deviceId: "iphone-conflict" }));

        try {
            const cleanup = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.cleanup.owner", params: {} }),
            });
            expect(cleanup.status).toBe(200);
            expect(await cleanup.json()).toEqual(expect.objectContaining({
                ok: false,
                result: expect.objectContaining({
                    ownerId,
                    changedDevices: 1,
                    failed: 2,
                    results: expect.arrayContaining([
                        expect.objectContaining({ stateKey: "android", ok: false, error: "owner-devices-file-too-large" }),
                        expect.objectContaining({ stateKey: "ios", ok: true, changed: true }),
                        expect.objectContaining({ stateKey: "ios-device", ok: true, changed: false }),
                    ]),
                }),
            }));
            expect(killSpy).toHaveBeenCalledWith(88888, 0);
            expect(killSpy).not.toHaveBeenCalledWith(88888, "SIGTERM");
            expect(killSpy).not.toHaveBeenCalledWith(recordingIdentity.pid, "SIGINT");
            expect(killSpy).not.toHaveBeenCalledWith(77777, 0);
            expect(killSpy).not.toHaveBeenCalledWith(77778, 0);
            const ios = JSON.parse(readFileSync(join(iosRoot, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(ios.devices.find((device) => device.id === "ios-readable")?.appium).toBeNull();
            expect(ios.devices.find((device) => device.id === "ios-readable")?.recording).toBeNull();
            const iosDevice = JSON.parse(readFileSync(join(iosDeviceRoot, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(iosDevice.devices.find((device) => device.id === "iphone-conflict")).toEqual(expect.objectContaining({
                status: "attached",
                appium: expect.objectContaining({ serverPid: 77777 }),
                recording: expect.objectContaining({ pid: 77778 }),
            }));
            expect(existsSync(conflictingLease)).toBe(true);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("preserves recording metadata when owner cleanup cannot stop the process", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-owner-cleanup-signal-failure-test");
        const recordingIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!recordingIdentity) throw new Error("current process identity unavailable");
        const denied = new Error("operation not permitted") as Error & { code: string };
        denied.code = "EPERM";
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
            throw denied;
        });
        const server = createDeviceBrokerServer({ cwd: "/project/broker-owner-cleanup-signal-failure-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const androidRoot = writeBrokerDevices(ownerId, "android", [
            {
                id: "pixel-recording",
                status: "stopped",
                backend: "android-emulator",
                recording: {
                    active: true,
                    pid: process.pid,
                    runtimeId: "cleanup-denied-recording",
                    processIdentity: recordingIdentity,
                    provider: "adb-screenrecord",
                    authority: "host-broker",
                    processOwner: "host-broker",
                    startedBy: "broker.device.recording.start",
                },
            },
        ]);

        try {
            const cleanup = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.cleanup.owner", params: { stopDevices: false, detachPhysical: false } }),
            });
            expect(cleanup.status).toBe(200);
            expect(await cleanup.json()).toEqual(expect.objectContaining({
                ok: false,
                result: expect.objectContaining({ changedDevices: 0, failed: 1 }),
            }));
            expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
            const android = JSON.parse(readFileSync(join(androidRoot, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(android.devices.find((device) => device.id === "pixel-recording")?.recording).toEqual(expect.objectContaining({
                active: true,
                pid: process.pid,
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("rejects unsupported backends and malformed Appium metadata", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-validation-test");
        const server = createDeviceBrokerServer({ cwd: "/project/broker-appium-validation-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        writeBrokerDevices(ownerId, "android-device", [{
            id: "phone-owned",
            status: "attached",
            backend: "android-device",
            serial: "PHONE-OWNED-SERIAL",
            leaseClaimId: "phone-owned-claim",
            leaseClaimNonce: "phone-owned-nonce",
            appium: null,
        }]);
        writePhysicalLease(ownerId, "android-device", "PHONE-OWNED-SERIAL", "phone-owned", "phone-owned-claim", "phone-owned-nonce");

        try {
            const invalidBackend = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.status",
                    params: { backend: "windows-sandbox", deviceId: "phone-owned" },
                }),
            });
            expect(invalidBackend.status).toBe(400);
            expect(await invalidBackend.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "invalid-appium-backend",
                allowed: ["android-emulator", "android-device", "ios-simulator", "ios-device"],
            }));

            const invalidUrl = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.record",
                    params: { backend: "android-device", deviceId: "phone-owned", serverUrl: "file:///tmp/socket", sessionId: "S1" },
                }),
            });
            expect(invalidUrl.status).toBe(400);
            expect(await invalidUrl.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-appium-server-url" }));

            const missingMetadata = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.record",
                    params: { backend: "android-device", deviceId: "phone-owned", automationName: "UiAutomator2" },
                }),
            });
            expect(missingMetadata.status).toBe(400);
            expect(await missingMetadata.json()).toEqual(expect.objectContaining({ ok: false, error: "missing-appium-metadata" }));

            const invalidId = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.clear",
                    params: { backend: "android-device", deviceId: "../phone-owned" },
                }),
            });
            expect(invalidId.status).toBe(400);
            expect(await invalidId.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-appium-device-id" }));

            const invalidRequestPath = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: { backend: "android-device", deviceId: "phone-owned", method: "GET", path: "http://127.0.0.1:1/status" },
                }),
            });
            expect(invalidRequestPath.status).toBe(400);
            expect(await invalidRequestPath.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-appium-request-path" }));

            const invalidRequestMethod = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: { backend: "android-device", deviceId: "phone-owned", method: "PUT", path: "/source" },
                }),
            });
            expect(invalidRequestMethod.status).toBe(400);
            expect(await invalidRequestMethod.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "invalid-appium-request-method",
                allowed: ["GET", "POST"],
            }));

            const disallowedPath = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: { backend: "android-device", deviceId: "phone-owned", method: "GET", path: "/status" },
                }),
            });
            expect(disallowedPath.status).toBe(403);
            expect(await disallowedPath.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "disallowed-appium-request",
                allowed: expect.arrayContaining(["GET /source", "POST /actions", "POST /execute/sync"]),
            }));

            const disallowedShell = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: {
                        backend: "android-device",
                        deviceId: "phone-owned",
                        method: "POST",
                        path: "/execute/sync",
                        body: { script: "mobile: shell", args: [{ command: "rm", args: ["-rf", "/sdcard"] }] },
                    },
                }),
            });
            expect(disallowedShell.status).toBe(403);
            expect(await disallowedShell.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "disallowed-appium-mobile-shell-command",
                allowed: expect.arrayContaining(["pm clear <package>", "svc wifi|data enable|disable", "settings put global airplane_mode_on"]),
            }));

            const allowedWifiShell = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: {
                        backend: "android-device",
                        deviceId: "phone-owned",
                        method: "POST",
                        path: "/execute/sync",
                        body: { script: "mobile: shell", args: [{ command: "svc", args: ["wifi", "disable"] }] },
                    },
                }),
            });
            expect(allowedWifiShell.status).toBe(400);
            expect(await allowedWifiShell.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "missing-appium-session",
            }));

            const invalidWifiShell = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: {
                        backend: "android-device",
                        deviceId: "phone-owned",
                        method: "POST",
                        path: "/execute/sync",
                        body: { script: "mobile: shell", args: [{ command: "svc", args: ["wifi", "toggle"] }] },
                    },
                }),
            });
            expect(invalidWifiShell.status).toBe(403);
            expect(await invalidWifiShell.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "disallowed-appium-mobile-shell-command",
            }));

            const allowedAirplaneSetting = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: {
                        backend: "android-device",
                        deviceId: "phone-owned",
                        method: "POST",
                        path: "/execute/sync",
                        body: { script: "mobile: shell", args: [{ command: "settings", args: ["put", "global", "airplane_mode_on", "1"] }] },
                    },
                }),
            });
            expect(allowedAirplaneSetting.status).toBe(400);
            expect(await allowedAirplaneSetting.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "missing-appium-session",
            }));

            const invalidAirplaneSetting = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: {
                        backend: "android-device",
                        deviceId: "phone-owned",
                        method: "POST",
                        path: "/execute/sync",
                        body: { script: "mobile: shell", args: [{ command: "settings", args: ["put", "global", "airplane_mode_on", "yes"] }] },
                    },
                }),
            });
            expect(invalidAirplaneSetting.status).toBe(403);
            expect(await invalidAirplaneSetting.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "disallowed-appium-mobile-shell-command",
            }));

            const allowedAirplaneBroadcast = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.appium.request",
                    params: {
                        backend: "android-device",
                        deviceId: "phone-owned",
                        method: "POST",
                        path: "/execute/sync",
                        body: { script: "mobile: shell", args: [{ command: "am", args: ["broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", "true"] }] },
                    },
                }),
            });
            expect(allowedAirplaneBroadcast.status).toBe(400);
            expect(await allowedAirplaneBroadcast.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "missing-appium-session",
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });
});
