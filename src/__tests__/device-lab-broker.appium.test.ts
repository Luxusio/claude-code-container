import { createHash } from "crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createServer } from "http";
import { AddressInfo } from "net";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appiumWebDriverRequestTimeoutMs, createDeviceBrokerServer, DEVICE_BROKER_APPIUM_LOCK_MANIFEST_LIMIT_BYTES, DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES, managedAppiumCommandLine, registerDeviceBrokerOwner } from "../device-lab-broker.js";
import { deviceLabOwnerId } from "../device-lab-owner.js";
import { readDeviceRuntimeProcessIdentity } from "../device-lab-process-identity.js";
import { cleanupOwner, close, listen, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";

async function createFakeAppiumServer(sessionId = "BROKER-SESSION-1", options: { deleteStatus?: number; readyAfterStatusRequests?: number; sessionCreateFailures?: number; onSessionCreated?: () => void } = {}) {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let statusRequests = 0;
    let sessionCreateRequests = 0;
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ method: req.method || "GET", url: req.url || "/", body });
            const sessionCreateFailure = req.method === "POST"
                && req.url === "/session"
                && ++sessionCreateRequests <= (options.sessionCreateFailures || 0);
            const status = sessionCreateFailure
                ? 500
                : req.method === "DELETE" && req.url === `/session/${sessionId}` ? options.deleteStatus || 200 : 200;
            res.writeHead(status, { "content-type": "application/json" });
            if (req.method === "GET" && req.url === "/status") {
                statusRequests += 1;
                return res.end(JSON.stringify({ value: { ready: statusRequests >= (options.readyAfterStatusRequests || 1) } }));
            }
            if (sessionCreateFailure) return res.end(JSON.stringify({ value: { error: "unknown error", message: "The instrumentation process cannot be initialized." } }));
            if (req.method === "POST" && req.url === "/session") {
                options.onSessionCreated?.();
                return res.end(JSON.stringify({ value: { sessionId, capabilities: body?.capabilities?.alwaysMatch || {} } }));
            }
            if (req.method === "GET" && req.url === `/session/${sessionId}`) return res.end(JSON.stringify({ value: { sessionId } }));
            if (req.method === "GET" && req.url === `/session/${sessionId}/source`) return res.end(JSON.stringify({ value: "<AppiumAUT />" }));
            if (req.method === "POST" && req.url === `/session/${sessionId}/actions`) return res.end(JSON.stringify({ value: null }));
            if (req.method === "DELETE" && req.url === `/session/${sessionId}`) return res.end(JSON.stringify(status >= 400 ? { value: { error: "delete failed" } } : { value: null }));
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
    const mcpRoot = join(packageRoot, "device-lab-mcp");
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

describe("device-lab host broker Appium session authority", () => {
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = mkdtempSync(join(tmpdir(), "ccc-device-broker-appium-test-home-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    it("gives proxied WebDriver commands enough time for device-side clipboard work", () => {
        expect(appiumWebDriverRequestTimeoutMs(5000)).toBe(30000);
        expect(appiumWebDriverRequestTimeoutMs(60000)).toBe(60000);
        expect(appiumWebDriverRequestTimeoutMs(600000)).toBe(300000);
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

    it("starts and stops host-broker owned Appium server metadata without creating a WebDriver session", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-process-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            pid: 45678,
            stdout: "",
            stderr: "",
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
            expect(await start.json()).toEqual(expect.objectContaining({
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

    it("provisions an isolated broker Appium runtime and hides all Windows child processes", async () => {
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
        mkdirSync(join(packageRoot, "device-lab-mcp"), { recursive: true });
        mkdirSync(join(packageRoot, "android-sdk", "platform-tools"), { recursive: true });
        mkdirSync(join(javaHome, "bin"), { recursive: true });
        writeFileSync(join(packageRoot, "device-lab-mcp", "package.json"), packageBytes);
        writeFileSync(join(packageRoot, "device-lab-mcp", "package-lock.json"), lockBytes);
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
                stdout: "",
                stderr: "",
            };
        });
        const server = createDeviceBrokerServer({
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
            expect(response.status).toBe(200);
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
        const server = createDeviceBrokerServer({
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
        symlinkSync(externalRuntime, runtimeRoot);
        const commandRunner = vi.fn(() => ({ mode: "exec" as const, provider: "unexpected", status: 0, stdout: "", stderr: "" }));
        const server = createDeviceBrokerServer({ cwd: packageRoot, host: "127.0.0.1", port: 0, commandRunner });
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
        symlinkSync(externalModules, nodeModules);
        const commandRunner = vi.fn(() => ({ mode: "exec" as const, provider: "unexpected", status: 0, stdout: "", stderr: "" }));
        const server = createDeviceBrokerServer({ cwd: packageRoot, host: "127.0.0.1", port: 0, commandRunner });
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
        vi.spyOn(Date, "now").mockImplementation(() => (syntheticNow += 400000));
        const commandRunner = vi.fn(() => ({ mode: "exec" as const, provider: "unexpected", status: 0, stdout: "", stderr: "" }));
        const server = createDeviceBrokerServer({ cwd: packageRoot, host: "127.0.0.1", port: 0, commandRunner });
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
        const server = createDeviceBrokerServer({ cwd: packageRoot, host: "127.0.0.1", port: 0, commandRunner });
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
        const server = createDeviceBrokerServer({ cwd: packageRoot, host: "127.0.0.1", port: 0, commandRunner });
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

    it("reports Appium start failures and simulates injected-runner cleanup without signaling fake pids", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-appium-process-failure-test");
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: null,
            error: "missing executable",
            stdout: "",
            stderr: "",
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
            expect(await start.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-server-start-failed",
            }));

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
            const stop = await fetch(endpoint, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.appium.stop", params: { backend: "android-emulator", deviceId: "pixel-mismatch" } }),
            });
            expect(stop.status).toBe(502);
            expect(await stop.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-stop-failed",
                signal: expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-mismatch" }),
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
                signal: expect.objectContaining({ attempted: false, ok: false, reason: "runtime-process-identity-unavailable" }),
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
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "appium-runtime-state-conflict",
                currentAppium: expect.objectContaining({ runtimeId: successor.runtimeId, serverPid: 90001 }),
                rollback: expect.objectContaining({ attempted: false, ok: true, simulated: true }),
            }));
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
        const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
            if (pid === process.pid && signal === "SIGTERM") {
                writeFileSync(join(root, "devices.json"), JSON.stringify({
                    devices: [{ id: "pixel-raced", status: "running", backend: "android-emulator", appium: successor }],
                }));
                terminated = true;
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
            expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
            const persisted = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<Record<string, unknown>> };
            expect(persisted.devices[0]?.appium).toEqual(successor);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
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
            expect(await ensure.json()).toEqual(expect.objectContaining({
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
            expect(await reuse.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ created: false, reused: true }),
            }));

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
                    response: expect.objectContaining({ body: { value: "<AppiumAUT />" } }),
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
                result: expect.objectContaining({ method: "POST", path: "/actions" }),
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
                result: expect.objectContaining({ deleted: true }),
            }));
            const devicesFile = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: Array<{ id: string; appium: { sessionId?: unknown } }> };
            expect(devicesFile.devices.find((device) => device.id === "pixel-owned")?.appium.sessionId).toBeUndefined();
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
                rollback: expect.objectContaining({ ok: true, status: 200 }),
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
        const commands: unknown[] = [];
        const commandRunner = vi.fn((command) => {
            commands.push(command);
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                stdout: command.provider === "xcrun" && command.args?.join(" ") === "simctl list devices -j"
                    ? JSON.stringify({ devices: { runtime: [{ name: iosSimulatorName, udid: "SIM-UDID-1", state: "Booted" }] } })
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
                appium: { authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start", serverPid: 11111, serverUrl: "http://127.0.0.1:4723" },
                recording: { active: true, pid: 22222, provider: "adb-screenrecord", authority: "host-broker", processOwner: "host-broker", startedBy: "broker.device.recording.start" },
            },
            {
                id: "pixel-stopped",
                status: "stopped",
                backend: "android-emulator",
                appium: { authority: "host-broker", serverPid: 99999, serverUrl: "http://127.0.0.1:4999" },
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
            expect(await cleanup.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId: ownerA,
                    cleaned: true,
                    changedDevices: 5,
                    failed: 0,
                }),
            }));
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

    it("runs provider cleanup outside the state mutation lock and preserves a concurrent successor record", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-owner-cleanup-race-test");
        let androidRoot = "";
        const commandRunner = vi.fn((command) => {
            expect(existsSync(join(androidRoot, "devices.mutation.lock"))).toBe(false);
            writeFileSync(join(androidRoot, "devices.json"), JSON.stringify({
                devices: [{
                    id: "pixel-cleanup-race",
                    status: "running",
                    backend: "android-emulator",
                    port: 5582,
                    successorGeneration: 2,
                }],
            }));
            return {
                mode: command.mode,
                provider: command.provider,
                executable: command.executable,
                args: command.args,
                status: 0,
                stdout: "",
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
            expect(commandRunner).toHaveBeenCalledTimes(1);
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
        try {
            chmodSync(phoneRoot, 0o500);
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

            chmodSync(phoneRoot, 0o700);
            const recovered = await cleanup();
            expect(recovered.status).toBe(200);
            expect(await recovered.json()).toEqual(expect.objectContaining({ ok: true }));
            expect(existsSync(leaseFile)).toBe(false);
        } finally {
            chmodSync(phoneRoot, 0o700);
            await close(server);
            cleanupOwner(ownerId);
            rmSync(leaseFile, { force: true });
        }
    });

    it("reports cleanup backend failures while preserving physical attachment on lease conflict", async () => {
        const ownerId = deviceLabOwnerId("/project/broker-owner-cleanup-partial-test");
        const recordingIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!recordingIdentity) throw new Error("current process identity unavailable");
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
                    pid: process.pid,
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
            expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
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
