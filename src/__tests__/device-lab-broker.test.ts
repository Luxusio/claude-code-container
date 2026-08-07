import { createHash, createHmac } from "crypto";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { chmodSync, existsSync, linkSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { createServer } from "http";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    boundedBrokerErrorPayload,
    boundedProviderCommandRunnerScript,
    compareBrokerVersionsForTest,
    createDeviceBrokerServer,
    DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES,
    DEVICE_BROKER_ERROR_RESPONSE_LIMIT,
    DEVICE_BROKER_INVENTORY_DEVICE_LIMIT,
    DEVICE_BROKER_INVENTORY_FILE_LIMIT,
    deviceBrokerAuthSecretFile,
    deviceBrokerHostProjectMountPath,
    deviceBrokerOwnerToken,
    deviceBrokerOwnerRegistrationFile,
    registerDeviceBrokerOwner,
    deviceBrokerStatus,
    deviceBrokerToolContractForTest,
    defaultProviderCommandRunnerAsync,
    ensureHostDeviceBroker,
    hostBrokerRuntimeFromPortProcessForTest,
    parseWindowsBrokerNetstatListenerForTest,
    readHostBrokerHttpJson,
    retainRecentBrokerAttemptForTest,
    verifySpawnedHostBrokerListenerForTest,
    verifiedHostBrokerIdentityForTest,
} from "../device-lab-broker.js";
import { deviceLabOwnerFromProjectMountPath, deviceLabOwnerId, deviceLabProjectMountPath } from "../device-lab-owner.js";
import { readDeviceRuntimeProcessStartToken } from "../device-lab-process-identity.js";
import { CLI_VERSION } from "../utils.js";
import { cleanupOwner, close, listen, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";
import { TOOLS as DEVICE_LAB_MCP_TOOLS } from "../../device-lab-mcp/src/tools.mjs";

function fakeBrokerPortProcess(pid: number, commandLine: string | null) {
    const processStartToken = pid === process.pid
        ? readDeviceRuntimeProcessStartToken(pid) || `test:${pid}`
        : `test:${pid}`;
    return {
        pid,
        commandLine,
        processIdentity: {
            pid,
            startToken: processStartToken,
            commandHash: createHash("sha256").update(commandLine || `pid:${pid}`).digest("hex"),
        },
        processStartToken,
    };
}

describe("device-lab host broker daemon", () => {
    let originalHome: string | undefined;

    it("forces hidden windows for provider and broker-inspection PowerShell children", () => {
        const runner = boundedProviderCommandRunnerScript();
        expect(runner).toContain('["-WindowStyle", "Hidden", "-NoProfile", "-NonInteractive", "-Command", script]');
        expect(runner).toContain("windowsHide: true");
    });

    it("bounds retained startup diagnostics while preserving the most recent attempts", () => {
        const attempts: unknown[] = [];
        for (let index = 0; index < 20; index += 1) {
            retainRecentBrokerAttemptForTest(attempts, { index, body: "x".repeat(1024) });
        }

        expect(attempts).toHaveLength(8);
        expect(attempts).toEqual(Array.from({ length: 8 }, (_, offset) => ({
            index: offset + 12,
            body: "x".repeat(1024),
        })));
    });

    it("rejects a compatible listener that won the port race against the spawned broker", () => {
        const port = 17373;
        const cliPath = "/opt/ccc/dist/index.js";
        const spawned = fakeBrokerPortProcess(51001, `node ${cliPath} devices broker serve --host 127.0.0.1 --port ${port}`);
        const competing = fakeBrokerPortProcess(51002, `node ${cliPath} devices broker serve --host 127.0.0.1 --port ${port}`);

        expect(verifySpawnedHostBrokerListenerForTest(
            spawned.pid,
            spawned.processIdentity,
            competing,
            competing.processIdentity,
            port,
            cliPath,
        )).toBe(false);
        expect(verifySpawnedHostBrokerListenerForTest(
            spawned.pid,
            spawned.processIdentity,
            spawned,
            spawned.processIdentity,
            port,
            cliPath,
        )).toBe(true);
        expect(verifySpawnedHostBrokerListenerForTest(
            spawned.pid,
            spawned.processIdentity,
            spawned,
            spawned.processIdentity,
            port,
            cliPath,
            {
                spawned: spawned.processStartToken,
                listener: spawned.processStartToken,
                status: "test:successor",
            },
        )).toBe(false);
    });

    it("rejects current broker status that omits its advertised process generation token", () => {
        const status = {
            body: {
                broker: {
                    process: { pid: 12345 },
                    startedAt: "2026-07-29T00:00:00.000Z",
                    implemented: ["host-broker-process-start-token-v1"],
                },
            },
        };
        expect(verifiedHostBrokerIdentityForTest(status)).toBeNull();
        expect(verifiedHostBrokerIdentityForTest({
            body: {
                broker: {
                    ...status.body.broker,
                    process: { pid: 12345, startToken: "test:12345" },
                },
            },
        })).toEqual({
            pid: 12345,
            startedAt: "2026-07-29T00:00:00.000Z",
            processStartToken: "test:12345",
        });
    });

    it("rejects a broker whose status PID disagrees with the OS port owner", () => {
        const port = 17373;
        const cliPath = "/opt/ccc/dist/index.js";
        const listener = fakeBrokerPortProcess(
            51001,
            `node ${cliPath} devices broker serve --host 127.0.0.1 --port ${port}`,
        );

        expect(hostBrokerRuntimeFromPortProcessForTest(
            "1111111111111111",
            port,
            { body: { broker: { host: "127.0.0.1" } } },
            "linux",
            () => listener,
            null,
            {
                name: "ccc-device-broker",
                managedBy: "ccc-host-status",
                pid: 51002,
                port,
            },
            cliPath,
        )).toBeNull();
    });

    it("parses localized Windows netstat listeners without accepting connected sockets", () => {
        const output = [
            "  TCP    127.0.0.1:17373        0.0.0.0:0              수신 대기 중    51001",
            "  TCP    127.0.0.1:17374        10.0.0.2:443           ESTABLISHED     51002",
        ].join("\r\n");
        expect(parseWindowsBrokerNetstatListenerForTest(output, 17373)).toEqual({
            pid: 51001,
            commandLine: "",
        });
        expect(parseWindowsBrokerNetstatListenerForTest(output, 17374)).toBeNull();
    });

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = mkdtempSync(join(tmpdir(), "ccc-device-broker-test-home-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    it("validates canonical host project paths using their native path flavor", () => {
        const windowsPath = "C:\\Users\\Example\\Project\\ccc";
        const windowsHash = createHash("sha256").update(windowsPath).digest("hex").slice(0, 12);
        expect(deviceBrokerHostProjectMountPath(windowsPath)).toBe(`/project/ccc-${windowsHash}`);
        expect(deviceBrokerHostProjectMountPath("C:\\Users\\Example\\Project\\..\\ccc")).toBeNull();

        const posixPath = "/home/example/project/ccc";
        const posixHash = createHash("sha256").update(posixPath).digest("hex").slice(0, 12);
        expect(deviceBrokerHostProjectMountPath(posixPath)).toBe(`/project/ccc-${posixHash}`);
        expect(deviceBrokerHostProjectMountPath("relative/project")).toBeNull();
    });

    it("never treats a newer broker version as replaceable by an older CLI", () => {
        expect(compareBrokerVersionsForTest("1.2.0", "1.1.75")).toBe(1);
        expect(compareBrokerVersionsForTest("2.0.0-beta.1", "1.99.99")).toBe(1);
        expect(compareBrokerVersionsForTest("1.1.74", "1.1.75")).toBe(-1);
        expect(compareBrokerVersionsForTest("1.1.75", "1.1.75")).toBe(0);
        expect(compareBrokerVersionsForTest("1.1.75-beta.1", "1.1.75")).toBe(-1);
        expect(compareBrokerVersionsForTest("1.1.75", "1.1.75-beta.1")).toBe(1);
        expect(compareBrokerVersionsForTest("1.1.75-beta.2", "1.1.75-beta.10")).toBe(-1);
        expect(compareBrokerVersionsForTest("1.1.75-beta.9007199254740993", "1.1.75-beta.9007199254740992")).toBe(1);
        expect(compareBrokerVersionsForTest("1.1.75+host.2", "1.1.75+cli.1")).toBe(0);
    });

    it("preserves a registered host path when the same owner registers from its container mount", () => {
        const hostProjectPath = "C:\\Users\\Example\\Project\\ccc";
        const projectMountPath = deviceBrokerHostProjectMountPath(hostProjectPath)!;
        const identity = deviceLabOwnerFromProjectMountPath(projectMountPath)!;
        const registrationFile = deviceBrokerOwnerRegistrationFile(identity.ownerId);
        mkdirSync(join(process.env.HOME!, ".ccc", "devices", "broker", "owners"), { recursive: true });
        writeFileSync(registrationFile, JSON.stringify({
            version: 1,
            ownerId: identity.ownerId,
            ownerBasis: identity.ownerBasis,
            projectMountPath,
            hostProjectPath,
            profile: null,
            registeredAt: new Date().toISOString(),
        }));

        expect(registerDeviceBrokerOwner(projectMountPath, undefined, identity.ownerId).hostProjectPath).toBe(hostProjectPath);
        expect(JSON.parse(readFileSync(registrationFile, "utf-8")).hostProjectPath).toBe(hostProjectPath);
    });

    it("bounds chunked host-broker control responses", async () => {
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        const server = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
            for (let sent = 0; sent <= DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES; sent += chunk.length) res.write(chunk);
            res.end();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/status`, { redirect: "manual" });
            await expect(readHostBrokerHttpJson(response, DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES)).resolves.toEqual(expect.objectContaining({
                ok: false,
                error: "broker-response-too-large",
                maxBytes: DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES,
            }));
        } finally {
            await close(server);
        }
    });

    it("keeps malformed host-broker raw diagnostics within 32 KiB", async () => {
        const server = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("가".repeat(20000));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, { redirect: "manual" });
            const result = await readHostBrokerHttpJson(response, DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES);
            expect(result).toEqual(expect.objectContaining({ ok: false, error: "invalid-broker-json" }));
            expect(Buffer.byteLength(String(result.body?.raw || ""), "utf8")).toBeLessThanOrEqual(32 * 1024);
        } finally {
            await close(server);
        }
    });

    it("does not follow redirects while probing host-broker health", async () => {
        let redirectTargetRequests = 0;
        const redirectTarget = createServer((_req, res) => {
            redirectTargetRequests += 1;
            res.end(JSON.stringify({ ok: true, name: "ccc-device-broker" }));
        });
        await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
        const redirectTargetPort = (redirectTarget.address() as { port: number }).port;
        const redirectSource = createServer((_req, res) => {
            res.writeHead(302, { location: `http://127.0.0.1:${redirectTargetPort}/health` });
            res.end();
        });
        await new Promise<void>((resolve) => redirectSource.listen(0, "127.0.0.1", resolve));
        const port = (redirectSource.address() as { port: number }).port;
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 45678;
        child.unref = vi.fn();

        try {
            const result = await ensureHostDeviceBroker({
                ownerId: "abababababababab",
                cwd: "/project/broker-health-redirect-test",
                port,
                timeoutMs: 100,
                startupTimeoutMs: 1,
                cliPath: "/opt/ccc/dist/index.js",
                spawnImpl: vi.fn(() => child) as any,
            });
            expect(result).toEqual(expect.objectContaining({ ok: false, error: "host-broker-incompatible" }));
            expect(JSON.stringify(result.attempts)).toContain("broker-redirect-disallowed");
            expect(JSON.stringify(result.attempts)).toContain("unverified-broker-port-process");
            expect(redirectTargetRequests).toBe(0);
        } finally {
            await close(redirectSource);
            await close(redirectTarget);
        }
    });

    it("bounds oversized and unserializable HTTP error diagnostics", () => {
        const oversized = boundedBrokerErrorPayload(502, {
            ok: false,
            error: "provider-command-failed",
            ownerId: "owner-a",
            backend: "windows-sandbox",
            detail: "x".repeat(DEVICE_BROKER_ERROR_RESPONSE_LIMIT * 2),
        }) as Record<string, unknown>;
        const serialized = JSON.stringify(oversized);
        expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(DEVICE_BROKER_ERROR_RESPONSE_LIMIT);
        expect(oversized).toEqual(expect.objectContaining({
            ok: false,
            error: "provider-command-failed",
            ownerId: "owner-a",
            backend: "windows-sandbox",
            diagnosticTruncated: true,
            maxBytes: DEVICE_BROKER_ERROR_RESPONSE_LIMIT,
        }));
        expect(oversized).not.toHaveProperty("detail");

        const circular: Record<string, unknown> = { ok: false, error: "circular-provider-error" };
        circular.self = circular;
        expect(boundedBrokerErrorPayload(500, circular)).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-response-serialization-failed",
        }));
        expect(boundedBrokerErrorPayload(200, circular)).toBe(circular);
    });

    it("builds zero-config status metadata without side effects", () => {
        const status = deviceBrokerStatus({
            cwd: "/project/broker-status-test",
            host: "127.0.0.1",
            port: 17373,
            startedAt: "2026-01-01T00:00:00.000Z",
        });

        expect(status).toEqual(expect.objectContaining({
            name: "ccc-device-broker",
            version: CLI_VERSION,
            host: "127.0.0.1",
            port: 17373,
            url: "http://127.0.0.1:17373",
            mode: "host-broker-daemon",
            lazy: true,
            startupPolicy: expect.stringContaining("host ccc auto-starts"),
            implemented: expect.arrayContaining([
                "http-health",
                "http-status",
                "owner-state-path-reporting",
                "secret-backed-owner-token-auth",
                "http-appium-process-api",
                "http-appium-webdriver-session-api",
                "bounded-appium-webdriver-request-proxy",
                "high-level-mobile-broker-routing-compatible",
                "http-lifecycle-device-create-command",
                "http-readonly-device-tool-routing",
                "http-recording-device-tool-routing",
                "http-desktop-device-tool-proxy",
                "http-desktop-device-tool-timeouts",
                "http-windows-sandbox-helper-config",
                "http-android-device-tool-proxy",
                "http-broker-version-reporting",
                "windows-hidden-provider-children-v7",
                "windows-sandbox-window-minimize-v4", "windows-sandbox-runtime-snapshot-ownership-v1",
                "appium3-scoped-security-npm-cwd-v1",
                "constant-time-existing-owner-auth-v1",
                "atomic-owner-secret-provisioning-v1",
                "owner-mutation-serialization-v1",
                "atomic-owner-device-state-v1",
                "cross-process-owner-state-serialization-v1",
                "owner-device-identity-fencing-v1",
                "rpc-fault-containment-v1",
                "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1",
                "physical-detach-runtime-cleanup-v1",
                "physical-runtime-cleanup-lease-fencing-v1",
                "physical-lease-state-write-rollback-v1",
                "runtime-cleanup-failure-preservation-v1",
                "appium-runtime-generation-fencing-v1",
                "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "appium-port-process-identity-fencing-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "host-broker-process-start-token-v1", "owner-generation-hmac-auth-v1", "direct-appium-process-identity-v1","owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1","ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v20", "hyper-v-setup-network-v10", "hyper-v-guest-readiness-diagnostics-v2", "hyper-v-azure-ovf-seed-v1", "hyper-v-azure-ovf-seed-v2", "hyper-v-azure-bootstrap-dhcp-v1", "hyper-v-azure-local-ovf-v1", "hyper-v-bootstrap-nic-cleanup-v1", "hyper-v-bootstrap-ssh-finalize-v2", "hyper-v-windows-specialize-seed-v1", "hyper-v-windows-specialize-account-v1", "hyper-v-windows-boot-contract-v1", "hyper-v-boot-disk-generation-v1", "hyper-v-linux-create-response-v1", "hyper-v-image-acquisition-stage-cache-v1", "hyper-v-powershell-stage-propagation-v1", "hyper-v-provider-image-finalization-v22", "hyper-v-network-failure-diagnostics-v9", "windows-sandbox-best-effort-minimize-v1",
                "host-service-manager-diagnostics",
                "host-ccc-auto-start-compatible",
            ]),
            deferred: expect.not.arrayContaining(["mutating-non-lifecycle-device-tool-routing"]),
        }));
        expect(status.serviceManager).toEqual(expect.objectContaining({
            actions: ["status"],
            command: expect.arrayContaining(["devices", "broker", "serve"]),
            serviceName: expect.any(String),
        }));
        expect(status.persistence).toEqual(expect.objectContaining({
            durableAcrossContainerRecreation: true,
            environmentVariablesRequired: false,
            root: expect.stringContaining(".ccc/devices"),
            ownerScoped: expect.objectContaining({
                ownerRoot: expect.stringContaining(status.ownerId),
                deviceDefinitions: expect.objectContaining({
                    android: expect.stringContaining(`/owners/${status.ownerId}/android/devices.json`),
                    "ios-device": expect.stringContaining(`/owners/${status.ownerId}/ios-device/devices.json`),
                    macos: expect.stringContaining(`/owners/${status.ownerId}/macos/devices.json`),
                }),
                appiumMetadata: expect.stringContaining("owner device records"),
                recordings: expect.objectContaining({
                    android: expect.stringContaining(`/owners/${status.ownerId}/android/<device-id>/recordings`),
                    windows: expect.stringContaining(`/owners/${status.ownerId}/windows/<device-id>/recordings`),
                }),
                images: expect.objectContaining({
                    macosVm: expect.stringContaining("provider-owned VM instances"),
                }),
                snapshots: expect.objectContaining({
                    macosVm: expect.stringContaining("provider clones"),
                }),
            }),
            brokerScoped: expect.objectContaining({
                logsRoot: expect.stringContaining(".ccc/devices/broker/logs"),
                runtimeFile: expect.stringContaining(".ccc/devices/broker/runtime.json"),
            }),
            hostToolchains: expect.objectContaining({
                ownership: "host-owned",
                appium: expect.stringContaining("PATH/providerPaths"),
                androidSdk: expect.stringContaining("not deleted by owner cleanup"),
                xcode: expect.stringContaining("not deleted by owner cleanup"),
            }),
            cleanupBoundary: expect.objectContaining({
                ownerCleanupMayMutate: expect.arrayContaining([expect.stringContaining(`/owners/${status.ownerId}`)]),
                ownerCleanupPreserves: expect.arrayContaining([
                    expect.stringContaining("/owners/<foreign-owner-id>"),
                    expect.stringContaining(".ccc/devices/broker/auth"),
                    "host SDKs, Appium packages, Xcode, Windows Sandbox, and VM provider installations",
                ]),
                staleMetadataPolicy: expect.stringContaining("without deleting shared toolchain caches"),
            }),
        }));
        expect(status.deferred).not.toContain("full-provider-routing-parity");
        expect(status.deferred).not.toContain("strong-authentication-token-handshake");
        expect(status.deferred).not.toContain("permanent-service-manager-supervision");
        expect(status.implemented).toContain("host-ccc-auto-start-compatible");
        expect(status.implemented).toContain("broker-owned-owner-secret-provisioning-v1");
        expect(status.implemented).toContain("host-broker-port-process-identity-v1");
        expect(status.implemented).toContain("host-broker-process-start-token-v1");
        expect(status.implemented).toContain("direct-appium-process-identity-v1");
        expect(status.implemented).toContain("owner-device-state-validation-v1");
        expect(status.implemented).toContain("shared-device-ownership-state-validation-v1");
        expect(status.implemented).toContain("android-emulator-port-allocation-fencing-v1");
        expect(status.implemented).toContain("bounded-error-responses-v1");
        expect(status.implemented).toContain("physical-lease-directory-fencing-v1");
        expect(status.implemented).toContain("owner-auth-directory-fencing-v1");
        expect(status.implemented).toContain("appium-runtime-installation-fencing-v1");
        expect(status.implemented).toContain("bounded-no-redirect-appium-http-transport-v1");
        expect(status.implemented).toContain("windows-provider-launcher-path-fencing-v1");
        expect(status.implemented).toContain("stopped-android-status-observation-v1");
        expect(status.implemented).toContain("stopped-android-boot-metadata-v1");
        expect(status.implemented).toContain("windows-sandbox-best-effort-minimize-v1");
        expect(status.implemented).toContain("physical-lifecycle-lease-fencing-v1");
        expect(status.implemented).toContain("physical-attach-detach-operation-serialization-v1");
        expect(status.implemented).toContain("physical-detach-runtime-cleanup-v1");
        expect(status.implemented).toContain("physical-runtime-cleanup-lease-fencing-v1");
        expect(status.implemented).toContain("physical-lease-state-write-rollback-v1");
        expect(status.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(status.state.ownerRoot).toContain(status.ownerId);
        expect(status.state.locksRoot).toContain(".ccc/devices/broker/locks");
    });

    it.runIf(process.platform !== "win32")("rejects linked and oversized broker runtime metadata", () => {
        const initial = deviceBrokerStatus({ cwd: "/project/broker-runtime-state-test" });
        const runtimeFile = initial.state.runtimeFile;
        const external = join(process.env.HOME!, "external-runtime.json");
        const externalBytes = JSON.stringify({ managedBy: "attacker", port: 65535 });
        mkdirSync(join(runtimeFile, ".."), { recursive: true });
        writeFileSync(external, externalBytes);
        symlinkSync(external, runtimeFile);

        expect(deviceBrokerStatus({ cwd: "/project/broker-runtime-state-test" }).runtime).toEqual({
            file: runtimeFile,
            present: false,
            metadata: null,
        });
        expect(readFileSync(external, "utf8")).toBe(externalBytes);

        rmSync(runtimeFile, { force: true });
        writeFileSync(runtimeFile, JSON.stringify({ managedBy: "ccc-host", padding: "x".repeat(64 * 1024) }));
        expect(lstatSync(runtimeFile).size).toBeGreaterThan(64 * 1024);
        expect(deviceBrokerStatus({ cwd: "/project/broker-runtime-state-test" }).runtime.present).toBe(false);
    });

    it("creates and reuses per-owner broker auth secrets with private file permissions", () => {
        const ownerId = "0a0b0c0d0e0f1112";
        const secretFile = deviceBrokerAuthSecretFile(ownerId);
        const token = deviceBrokerOwnerToken(ownerId);
        expect(token).toMatch(/^[a-f0-9]{64}$/);
        expect(existsSync(secretFile)).toBe(true);
        const stat = statSync(secretFile);
        expect(stat.mode & 0o777).toBe(0o600);
        const firstSecret = JSON.parse(readFileSync(secretFile, "utf8")) as { ownerId: string; secret: string; version: number };
        expect(firstSecret).toEqual(expect.objectContaining({
            ownerId,
            version: 1,
            secret: expect.stringMatching(/^[a-f0-9]{64}$/),
        }));
        expect(deviceBrokerOwnerToken(ownerId)).toBe(token);
        expect(JSON.parse(readFileSync(secretFile, "utf8")).secret).toBe(firstSecret.secret);

        chmodSync(secretFile, 0o644);
        expect(deviceBrokerOwnerToken(ownerId)).toBe(token);
        expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    });

    it("atomically replaces owner-mismatched auth metadata", () => {
        const ownerId = "0a0b0c0d0e0f1112";
        const secretFile = deviceBrokerAuthSecretFile(ownerId);
        mkdirSync(join(secretFile, ".."), { recursive: true });
        writeFileSync(secretFile, JSON.stringify({
            ownerId: "ffffffffffffffff",
            secret: "a".repeat(64),
            version: 1,
        }));

        const token = deviceBrokerOwnerToken(ownerId);
        const repaired = JSON.parse(readFileSync(secretFile, "utf8")) as { ownerId: string; secret: string; version: number };
        expect(token).toMatch(/^[a-f0-9]{64}$/);
        expect(repaired).toEqual(expect.objectContaining({
            ownerId,
            secret: expect.stringMatching(/^[a-f0-9]{64}$/),
            version: 1,
        }));
        expect(repaired.secret).not.toBe("a".repeat(64));
        expect(existsSync(`${secretFile}.lock`)).toBe(false);
    });

    it("replaces oversized auth metadata instead of trusting its valid-looking secret", () => {
        const ownerId = "0a0b0c0d0e0f1113";
        const secretFile = deviceBrokerAuthSecretFile(ownerId);
        const attackerSecret = "e".repeat(64);
        mkdirSync(join(secretFile, ".."), { recursive: true });
        writeFileSync(secretFile, JSON.stringify({
            ownerId,
            secret: attackerSecret,
            version: 1,
            padding: "x".repeat(4096),
        }));

        expect(deviceBrokerOwnerToken(ownerId)).toMatch(/^[a-f0-9]{64}$/);
        const repaired = JSON.parse(readFileSync(secretFile, "utf8")) as { ownerId: string; secret: string };
        expect(repaired.ownerId).toBe(ownerId);
        expect(repaired.secret).toMatch(/^[a-f0-9]{64}$/);
        expect(repaired.secret).not.toBe(attackerSecret);
        expect(statSync(secretFile).size).toBeLessThan(4096);
    });

    it.runIf(process.platform !== "win32")("replaces linked auth metadata without mutating link targets", () => {
        const target = join(process.env.HOME!, "external-auth-target.json");
        const attackerSecret = "c".repeat(64);
        writeFileSync(target, JSON.stringify({ ownerId: "1111111111111111", secret: attackerSecret, version: 1 }));

        for (const [ownerId, link] of [
            ["1111111111111111", (file: string) => symlinkSync(target, file)],
            ["2222222222222222", (file: string) => linkSync(target, file)],
        ] as const) {
            const secretFile = deviceBrokerAuthSecretFile(ownerId);
            mkdirSync(join(process.env.HOME!, ".ccc", "devices", "broker", "auth"), { recursive: true });
            const abandonedInvalidLink = `${secretFile}.99999999.abandoned.invalid`;
            symlinkSync(target, abandonedInvalidLink);
            link(secretFile);
            const token = deviceBrokerOwnerToken(ownerId);
            expect(token).toMatch(/^[a-f0-9]{64}$/);
            expect(JSON.parse(readFileSync(secretFile, "utf8"))).toEqual(expect.objectContaining({
                ownerId,
                secret: expect.not.stringMatching(/^c{64}$/),
            }));
            expect(existsSync(`${secretFile}.lock`)).toBe(false);
            expect(existsSync(abandonedInvalidLink)).toBe(false);
        }

        expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
            ownerId: "1111111111111111",
            secret: attackerSecret,
            version: 1,
        });
    });

    it.runIf(process.platform !== "win32")("rejects a linked auth directory without mutating its target", () => {
        const ownerId = "3333333333333333";
        const brokerDirectory = join(process.env.HOME!, ".ccc", "devices", "broker");
        const authDirectory = join(brokerDirectory, "auth");
        const externalDirectory = join(process.env.HOME!, "external-auth-directory");
        mkdirSync(brokerDirectory, { recursive: true });
        mkdirSync(externalDirectory);
        symlinkSync(externalDirectory, authDirectory);

        expect(() => deviceBrokerOwnerToken(ownerId)).toThrow("device-broker-auth-directory-invalid");
        expect(readdirSync(externalDirectory)).toEqual([]);
    });

    it("recovers dead auth locks and abandoned owner artifacts", () => {
        const ownerId = "abcdef0123456789";
        const secretFile = deviceBrokerAuthSecretFile(ownerId);
        mkdirSync(join(secretFile, ".."), { recursive: true });
        writeFileSync(`${secretFile}.lock`, `99999999:${"b".repeat(32)}`);
        writeFileSync(`${secretFile}.1234.deadbeef.tmp`, "partial");
        writeFileSync(`${secretFile}.1234.deadbeef.invalid`, "invalid");

        expect(deviceBrokerOwnerToken(ownerId)).toMatch(/^[a-f0-9]{64}$/);
        expect(existsSync(secretFile)).toBe(true);
        expect(existsSync(`${secretFile}.lock`)).toBe(false);
        expect(existsSync(`${secretFile}.1234.deadbeef.tmp`)).toBe(false);
        expect(existsSync(`${secretFile}.1234.deadbeef.invalid`)).toBe(false);

        const malformedOwnerId = "abcdef0123456788";
        const malformedSecretFile = deviceBrokerAuthSecretFile(malformedOwnerId);
        writeFileSync(`${malformedSecretFile}.lock`, "");
        const staleTime = new Date(Date.now() - 2000);
        utimesSync(`${malformedSecretFile}.lock`, staleTime, staleTime);
        expect(deviceBrokerOwnerToken(malformedOwnerId)).toMatch(/^[a-f0-9]{64}$/);
        expect(existsSync(`${malformedSecretFile}.lock`)).toBe(false);
    });

    it.runIf(process.platform !== "win32")("replaces linked auth locks without mutating link targets", () => {
        const ownerId = "abcdef0123456787";
        const secretFile = deviceBrokerAuthSecretFile(ownerId);
        const lockFile = `${secretFile}.lock`;
        const target = join(process.env.HOME!, "external-auth-lock.json");
        const targetContents = JSON.stringify({ token: "external-lock", pid: process.pid });
        mkdirSync(join(secretFile, ".."), { recursive: true });
        writeFileSync(target, targetContents);
        symlinkSync(target, lockFile);
        const staleTime = new Date(Date.now() - 2000);
        lutimesSync(lockFile, staleTime, staleTime);

        expect(deviceBrokerOwnerToken(ownerId)).toMatch(/^[a-f0-9]{64}$/);
        expect(existsSync(lockFile)).toBe(false);
        expect(readFileSync(target, "utf8")).toBe(targetContents);
    });

    it("exposes service manager diagnostics through authenticated broker RPC", async () => {
        const cwd = "/project/broker-service-rpc-test";
        const ownerId = deviceLabOwnerId(cwd);
        const commandRunner = vi.fn(() => ({
            mode: "exec",
            provider: "systemctl",
            executable: "/usr/bin/systemctl",
            args: ["--user", "is-active", "ccc-device-broker.service"],
            status: 0,
            stdout: "active\n",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "linux",
            providerPaths: { systemctl: "/usr/bin/systemctl" },
            commandRunner,
        });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    ownerId,
                    method: "broker.service.manager",
                    params: { action: "status" },
                }),
            });

            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.ok).toBe(true);
            expect(body.result).toEqual(expect.objectContaining({
                ok: true,
                action: "status",
                running: true,
                service: expect.objectContaining({
                    manager: "systemd-user",
                    serviceName: "ccc-device-broker.service",
                }),
            }));
            expect(commandRunner).toHaveBeenCalledTimes(2);

            const startResponse = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    ownerId,
                    method: "broker.service.manager",
                    params: { action: "start" },
                }),
            });
            expect(startResponse.status).toBe(400);
            const startBody = await startResponse.json();
            expect(startBody).toEqual(expect.objectContaining({
                ok: false,
                error: "service-manager-failed",
                result: expect.objectContaining({
                    ok: false,
                    error: "invalid-service-action",
                    action: "start",
                    allowed: ["status"],
                }),
            }));
            expect(commandRunner).toHaveBeenCalledTimes(2);
        } finally {
            await close(server);
        }
    });

    it("exposes host provider readiness through authenticated broker RPC", async () => {
        const cwd = "/project/broker-backends-rpc-test";
        const ownerId = deviceLabOwnerId(cwd);
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: {
                adb: "C:\\Android\\Sdk\\platform-tools\\adb.exe",
                emulator: "C:\\Android\\Sdk\\emulator\\emulator.exe",
                avdmanager: "C:\\Android\\Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat",
                wsb: "C:\\Users\\TestUser\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe",
            },
        });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    ownerId,
                    method: "broker.backends",
                    params: {},
                }),
            });

            expect(response.status).toBe(200);
            const body = await response.json() as { ok: boolean; result: { source: string; startsDevices: boolean; backends: Array<{ name: string; available: boolean; missing: string[]; capabilities?: string[]; tools?: Record<string, string | null>; provisioning?: { available: boolean; missing: string[] } }> } };
            expect(body.ok).toBe(true);
            expect(body.result).toEqual(expect.objectContaining({
                source: "host-broker-provider-discovery",
                startsDevices: false,
            }));
            const advertisedToolNames = new Set(DEVICE_LAB_MCP_TOOLS.map((tool) => tool.name));
            for (const backend of body.result.backends) {
                expect((backend.capabilities || []).filter((capability) => !advertisedToolNames.has(capability))).toEqual([]);
            }
            const android = body.result.backends.find((backend) => backend.name === "android-emulator");
            expect(android).toEqual(expect.objectContaining({
                available: true,
                missing: [],
                provisioning: { available: true, missing: [] },
            }));
            const androidDevice = body.result.backends.find((backend) => backend.name === "android-device");
            expect(androidDevice?.capabilities).toContain("device_wireless");
            expect(androidDevice?.capabilities).toEqual(expect.arrayContaining([
                "device_record_video_start",
                "device_record_video_stop",
                "device_record_video_status",
            ]));
            expect(androidDevice?.capabilities).not.toEqual(expect.arrayContaining(["mobile_set_location"]));
            const iosSimulator = body.result.backends.find((backend) => backend.name === "ios-simulator");
            expect(iosSimulator?.capabilities).toEqual(expect.arrayContaining(["mobile_set_location", "mobile_set_clipboard", "mobile_get_clipboard"]));
            expect(iosSimulator?.capabilities).not.toEqual(expect.arrayContaining(["mobile_set_battery", "mobile_set_network", "mobile_toggle_airplane_mode"]));
            const iosDevice = body.result.backends.find((backend) => backend.name === "ios-device");
            expect(iosDevice?.capabilities).toContain("device_wireless");
            expect(iosDevice?.capabilities).not.toEqual(expect.arrayContaining(["device_exec", "mobile_open_url", "mobile_set_location", "mobile_set_clipboard", "mobile_get_clipboard", "mobile_set_battery"]));
            expect(android?.tools).toEqual(expect.objectContaining({
                adb: "C:\\Android\\Sdk\\platform-tools\\adb.exe",
                emulator: "C:\\Android\\Sdk\\emulator\\emulator.exe",
                avdmanager: "C:\\Android\\Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat",
            }));
            expect(body.result.backends.find((backend) => backend.name === "windows-sandbox")).toEqual(expect.objectContaining({
                available: true,
                missing: [],
                tools: { wsb: "C:\\Users\\TestUser\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe" },
            }));
            expect(body.result.backends.find((backend) => backend.name === "macos-vm")).toEqual(expect.objectContaining({
                available: false,
                missing: ["macos-host"],
            }));
        } finally {
            await close(server);
        }
    });

    it.runIf(process.platform !== "win32")("keeps health responsive while Hyper-V backend readiness is pending", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "ccc-broker-async-backends-"));
        const ownerId = deviceLabOwnerId(cwd);
        const powershell = join(cwd, "powershell.exe");
        writeFileSync(powershell, `#!/bin/sh\nsleep 0.6\nprintf '%s\\n' '{"available":true,"moduleAvailable":true,"hypervisorPresent":true,"vmmsRunning":true,"rebootPending":false,"missing":[]}'\n`);
        chmodSync(powershell, 0o755);
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": powershell } });
        try {
            const baseUrl = await listen(server);
            const backends = fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ ownerId, method: "broker.backends", params: {} }),
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            const startedAt = Date.now();
            const health = await fetch(`${baseUrl}/health`);
            const healthDurationMs = Date.now() - startedAt;
            expect(health.status).toBe(200);
            expect(healthDurationMs).toBeLessThan(300);
            expect((await backends).status).toBe(200);
        } finally {
            await close(server);
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it("keeps advertised broker backend capabilities aligned with device tool proxy support", () => {
        const contract = deviceBrokerToolContractForTest();
        for (const backend of contract.backends) {
            expect(backend.supportedTools.filter((tool) => !backend.capabilities.includes(tool))).toEqual([]);
        }
        const androidDevice = contract.backends.find((backend) => backend.backend === "android-device");
        expect(androidDevice?.capabilities).toEqual(expect.arrayContaining([
            "device_record_video_status",
            "device_record_video_start",
            "device_record_video_stop",
        ]));
        expect(androidDevice?.supportedTools).toEqual(expect.arrayContaining([
            "device_record_video_status",
            "device_record_video_start",
            "device_record_video_stop",
        ]));
        const iosDevice = contract.backends.find((backend) => backend.backend === "ios-device");
        expect(iosDevice?.capabilities).not.toEqual(expect.arrayContaining([
            "device_exec",
            "device_record_video_status",
            "device_record_video_start",
            "device_record_video_stop",
        ]));
        expect(iosDevice?.supportedTools).not.toEqual(expect.arrayContaining([
            "device_exec",
            "device_record_video_status",
            "device_record_video_start",
            "device_record_video_stop",
        ]));
    });

    it("serves health, status, method errors, and 404 JSON", async () => {
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-http-test",
            host: "127.0.0.1",
            port: 0,
            startedAt: new Date().toISOString(),
        });
        const baseUrl = await listen(server);
        try {
            const health = await fetch(`${baseUrl}/health`);
            expect(health.status).toBe(200);
            expect(await health.json()).toEqual(expect.objectContaining({
                ok: true,
                name: "ccc-device-broker",
                mode: "host-broker-daemon",
            }));

            const status = await fetch(`${baseUrl}/status`);
            expect(status.status).toBe(200);
            const statusPayload = await status.json() as { ok: boolean; broker: { ownerId: string; version: string; process: { pid: number }; implemented: string[]; deferred: string[] } };
            expect(statusPayload.ok).toBe(true);
            expect(statusPayload.broker.ownerId).toMatch(/^[a-f0-9]{16}$/);
            expect(statusPayload.broker.version).toBe(CLI_VERSION);
            expect(statusPayload.broker.process.pid).toBe(process.pid);
            expect(statusPayload.broker.implemented).toContain("http-appium-webdriver-session-api");
            expect(statusPayload.broker.implemented).toContain("http-lifecycle-device-create-command");
            expect(statusPayload.broker.implemented).toContain("http-readonly-device-tool-routing");
            expect(statusPayload.broker.implemented).toContain("http-recording-device-tool-routing");
            expect(statusPayload.broker.implemented).toContain("http-desktop-device-tool-proxy");
            expect(statusPayload.broker.implemented).toContain("http-desktop-device-tool-timeouts");
            expect(statusPayload.broker.implemented).toContain("http-windows-sandbox-helper-config");
            expect(statusPayload.broker.implemented).toContain("http-android-device-tool-proxy");
            expect(statusPayload.broker.implemented).toContain("http-broker-version-reporting");
            expect(statusPayload.broker.implemented).toContain("windows-hidden-provider-children-v7");
            expect(statusPayload.broker.implemented).toContain("windows-sandbox-window-minimize-v4");
            expect(statusPayload.broker.implemented).toContain("appium3-scoped-security-npm-cwd-v1");
            expect(statusPayload.broker.implemented).toContain("constant-time-existing-owner-auth-v1");
            expect(statusPayload.broker.implemented).toContain("atomic-owner-secret-provisioning-v1");
            expect(statusPayload.broker.implemented).toContain("owner-mutation-serialization-v1");
            expect(statusPayload.broker.implemented).toContain("atomic-owner-device-state-v1");
            expect(statusPayload.broker.implemented).toContain("cross-process-owner-state-serialization-v1");
            expect(statusPayload.broker.implemented).toContain("canonical-owner-device-ids-v1");
            expect(statusPayload.broker.implemented).toContain("stopped-android-status-observation-v1");
            expect(statusPayload.broker.implemented).toContain("stopped-android-boot-metadata-v1");
            expect(statusPayload.broker.implemented).toContain("windows-sandbox-best-effort-minimize-v1");
            expect(statusPayload.broker.implemented).toContain("rpc-fault-containment-v1");
            expect(statusPayload.broker.deferred).not.toContain("mutating-non-lifecycle-device-tool-routing");
            expect(statusPayload.broker.deferred).not.toContain("full-provider-routing-parity");

            const post = await fetch(`${baseUrl}/status`, { method: "POST" });
            expect(post.status).toBe(405);
            expect(post.headers.get("allow")).toBe("GET");
            expect(await post.json()).toEqual(expect.objectContaining({ ok: false, error: "method-not-allowed" }));

            const missing = await fetch(`${baseUrl}/missing`);
            expect(missing.status).toBe(404);
            expect(await missing.json()).toEqual(expect.objectContaining({ ok: false, error: "not-found", path: "/missing" }));
        } finally {
            await close(server);
        }
    });

    it("reuses an already-running host broker during auto-start", async () => {
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-auto-reuse-test",
            host: "127.0.0.1",
            port: 0,
        });
        const baseUrl = await listen(server);
        try {
            const port = Number(new URL(baseUrl).port);
            const spawnImpl = vi.fn();
            const result = await ensureHostDeviceBroker({
                cwd: "/project/broker-auto-reuse-test",
                bindHost: "127.0.0.1",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                portProcessResolver: () => fakeBrokerPortProcess(process.pid, `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`),
                spawnImpl: spawnImpl as any,
            });

            expect(result).toEqual(expect.objectContaining({
                ok: true,
                launched: false,
                reused: true,
                port,
                probeHost: "127.0.0.1",
            }));
            expect(spawnImpl).not.toHaveBeenCalled();
        } finally {
            await close(server);
        }
    });

    it("refuses a compatible HTTP lookalike whose listener is not the expected Node CLI", async () => {
        const cwd = "/project/broker-compatible-lookalike-test";
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const port = Number(new URL(baseUrl).port);
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        try {
            const result = await ensureHostDeviceBroker({
                cwd,
                bindHost: "127.0.0.1",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                startupTimeoutMs: 1,
                spawnImpl: vi.fn() as any,
                portProcessResolver: () => fakeBrokerPortProcess(process.pid, `evil.exe node /opt/ccc/dist/index.js devices broker serve --port ${port}`),
            });

            expect(result).toEqual(expect.objectContaining({ ok: false, error: "host-broker-incompatible", reused: false }));
            expect(JSON.stringify(result)).toContain("compatible-broker-process-unverified");
            expect(killSpy).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
        } finally {
            killSpy.mockRestore();
            await close(server);
        }
    });

    it("reuses the shared host runtime port across project owners", async () => {
        const cwd = "/project/broker-auto-runtime-port-test";
        const ownerId = deviceLabOwnerId(cwd);
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const port = Number(new URL(baseUrl).port);
        const status = await fetch(`${baseUrl}/status`).then((response) => response.json()) as {
            broker: { startedAt: string; process: { startToken: string } };
        };
        mkdirSync(join(homedir(), ".ccc/devices/broker"), { recursive: true });
        writeFileSync(join(homedir(), ".ccc/devices/broker/runtime.json"), JSON.stringify({
            name: "ccc-device-broker",
            managedBy: "ccc-host",
            ownerId: "another-project-owner",
            pid: process.pid,
            host: "127.0.0.1",
            probeHost: "127.0.0.1",
            port,
            startedAt: status.broker.startedAt,
            processStartToken: status.broker.process.startToken,
        }));
        try {
            const spawnImpl = vi.fn();
            const result = await ensureHostDeviceBroker({
                cwd,
                bindHost: "127.0.0.1",
                probeHost: "127.0.0.1",
                cliPath: "/opt/ccc/dist/index.js",
                portProcessResolver: () => fakeBrokerPortProcess(process.pid, `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`),
                spawnImpl: spawnImpl as any,
            });

            expect(result).toEqual(expect.objectContaining({
                ok: true,
                launched: false,
                reused: true,
                port,
                verifiedBrokerStartedAt: expect.any(String),
            }));
            expect(JSON.parse(readFileSync(join(homedir(), ".ccc/devices/broker/runtime.json"), "utf8"))).toEqual(
                expect.objectContaining({ startedAt: result.verifiedBrokerStartedAt }),
            );
            expect(spawnImpl).not.toHaveBeenCalled();
        } finally {
            rmSync(join(homedir(), ".ccc/devices/broker/runtime.json"), { force: true });
            await close(server);
        }
    });

    it("replaces a compatible broker when its bind host cannot serve containers", async () => {
        const cwd = "/project/broker-auto-bind-host-test";
        const ownerId = deviceLabOwnerId(cwd);
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
        });
        const baseUrl = await listen(server);
        const port = Number(new URL(baseUrl).port);
        const existingPid = process.pid;
        const status = await fetch(`${baseUrl}/status`).then((response) => response.json()) as {
            broker: { startedAt: string; process: { startToken: string } };
        };
        mkdirSync(join(homedir(), ".ccc/devices/broker"), { recursive: true });
        writeFileSync(join(homedir(), ".ccc/devices/broker/runtime.json"), JSON.stringify({
            name: "ccc-device-broker",
            managedBy: "ccc-host",
            ownerId,
            pid: existingPid,
            host: "127.0.0.1",
            probeHost: "127.0.0.1",
            port,
            startedAt: status.broker.startedAt,
            processStartToken: status.broker.process.startToken,
        }));
        let stopped = false;
        const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
            if (pid !== existingPid) return true;
            if (signal === 0) {
                if (stopped) {
                    const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
                    error.code = "ESRCH";
                    throw error;
                }
                return true;
            }
            stopped = true;
            server.close();
            return true;
        }) as typeof process.kill);
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 45678;
        child.unref = vi.fn();
        const spawnImpl = vi.fn(() => child);

        try {
            const result = await ensureHostDeviceBroker({
                ownerId,
                cwd,
                bindHost: "0.0.0.0",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                timeoutMs: 500,
                startupTimeoutMs: 1,
                spawnImpl: spawnImpl as any,
                portProcessResolver: () => fakeBrokerPortProcess(existingPid, `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`),
            });

            expect(result).toEqual(expect.objectContaining({
                ok: false,
                launched: true,
                reused: false,
                error: "host-broker-health-timeout",
                port,
            }));
            expect(killSpy).toHaveBeenCalledWith(existingPid, "SIGTERM");
            expect(spawnImpl).toHaveBeenCalledWith(
                process.execPath,
                ["/opt/ccc/dist/index.js", "devices", "broker", "serve", "--host", "0.0.0.0", "--port", String(port)],
                expect.objectContaining({ cwd, detached: true }),
            );
            expect(JSON.stringify(result.attempts)).toContain("runtimeBindHostMismatch");
        } finally {
            killSpy.mockRestore();
            await new Promise<void>((resolve) => server.listening ? server.close(() => resolve()) : resolve());
        }
    });

    it.each([
        ["image acquisition", "hyper-v-image-acquisition-stage-cache-v1", null],
        ["PowerShell stage propagation", "hyper-v-powershell-stage-propagation-v1", null],
        ["provider-bound automatic image finalization", "hyper-v-provider-image-finalization-v22", null],
        ["redacted Hyper-V network stage diagnostics", "hyper-v-network-failure-diagnostics-v9", "hyper-v-network-failure-diagnostics-v7"],
        ["persisted Hyper-V network identity repair", "hyper-v-setup-network-v10", "hyper-v-setup-network-v7"],
        ["hidden elevated PowerShell children", "windows-hidden-provider-children-v7", "windows-hidden-provider-children-v6"],
    ])("replaces a same-version broker missing the Hyper-V %s contract", async (_label, missingCapability, previousCapability) => {
        const ownerId = "2222222222222222";
        const currentCapabilities = deviceBrokerStatus({ ownerId }).implemented;
        const stalePid = 43210;
        const staleProcess = fakeBrokerPortProcess(stalePid, `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1`);
        const staleStartedAt = "2026-07-27T00:00:00.000Z";
        const staleHyperVCapabilities = currentCapabilities.filter((capability) =>
            capability !== missingCapability);
        if (previousCapability) staleHyperVCapabilities.push(previousCapability);
        const incompatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        ownerId,
                        version: CLI_VERSION,
                        process: { pid: stalePid, startToken: staleProcess.processStartToken },
                        startedAt: staleStartedAt,
                        implemented: staleHyperVCapabilities,
                    },
                }));
                return;
            }
            if (req.url === "/v1/owner/resolve" && req.method === "POST") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { ownerId, projectMountPath: "/project/broker-hyper-v-capability-test", profile: null } }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        await new Promise<void>((resolve) => incompatible.listen(0, "127.0.0.1", resolve));
        const port = (incompatible.address() as { port: number }).port;
        const compatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        ownerId,
                        version: CLI_VERSION,
                        process: { pid: 54321, startToken: "test:54321" },
                        startedAt: "2026-07-28T00:00:00.000Z",
                        implemented: currentCapabilities,
                    },
                }));
                return;
            }
            if (req.url === "/v1/owner/resolve" && req.method === "POST") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { ownerId, projectMountPath: "/project/broker-auto-upgrade-test", profile: null } }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        mkdirSync(join(homedir(), ".ccc/devices/broker"), { recursive: true });
        writeFileSync(join(homedir(), ".ccc/devices/broker/runtime.json"), JSON.stringify({
            name: "ccc-device-broker",
            managedBy: "ccc-host",
            ownerId,
            pid: stalePid,
            host: "0.0.0.0",
            probeHost: "127.0.0.1",
            port,
            startedAt: staleStartedAt,
            processStartToken: staleProcess.processStartToken,
        }));
        let stopped = false;
        const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
            if (pid !== stalePid) return true;
            if (signal === 0) {
                if (stopped) {
                    const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
                    error.code = "ESRCH";
                    throw error;
                }
                return true;
            }
            stopped = true;
            incompatible.close(() => {
                compatible.listen(port, "127.0.0.1");
            });
            return true;
        }) as typeof process.kill);
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 54321;
        child.unref = vi.fn();
        const spawnImpl = vi.fn(() => child);
        const spawnedProcess = fakeBrokerPortProcess(child.pid, `node /opt/ccc/dist/index.js devices broker serve --host 0.0.0.0 --port ${port}`);
        try {
            const result = await ensureHostDeviceBroker({
                ownerId,
                cwd: "/project/broker-auto-upgrade-test",
                bindHost: "0.0.0.0",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                timeoutMs: 500,
                startupTimeoutMs: 3000,
                spawnImpl: spawnImpl as any,
                portProcessResolver: () => stopped ? spawnedProcess : {
                    ...staleProcess,
                    commandLine: `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`,
                },
                processIdentityReader: (pid) => pid === child.pid
                    ? spawnedProcess.processIdentity
                    : pid === stalePid
                        ? staleProcess.processIdentity
                        : null,
                processStartTokenReader: (pid) => pid === child.pid
                    ? spawnedProcess.processStartToken
                    : pid === stalePid
                        ? staleProcess.processStartToken
                        : null,
            });

            expect(result).toEqual(expect.objectContaining({
                ok: true,
                launched: true,
                reused: false,
                port,
            }));
            expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
            expect(spawnImpl).toHaveBeenCalled();
            expect(child.unref).toHaveBeenCalled();
            const attempts = JSON.stringify(result.attempts);
            const incompatibleStatus = result.attempts?.find((attempt) =>
                "compatible" in attempt
                && attempt.compatible === false
                && "missingCapabilities" in attempt
            );
            expect(attempts).toContain("runtime-incompatible-contract");
            expect(attempts).toContain('"versionCompatible":true');
            expect(incompatibleStatus).toEqual(expect.objectContaining({
                missingCapabilities: [missingCapability],
                ownerResolve: expect.objectContaining({ compatible: true, ownerCompatible: true }),
            }));
        } finally {
            killSpy.mockRestore();
            await new Promise<void>((resolve) => incompatible.listening ? incompatible.close(() => resolve()) : resolve());
            await new Promise<void>((resolve) => compatible.listening ? compatible.close(() => resolve()) : resolve());
        }
    });

    it("replaces a healthy status-compatible broker that lacks owner resolve during auto-start", async () => {
        const ownerId = "1111111111111111";
        const stalePid = 24680;
        const staleStartedAt = "2026-07-27T00:00:00.000Z";
        const staleProcess = fakeBrokerPortProcess(stalePid, "node /opt/ccc/dist/index.js devices broker serve");
        const implemented = [
            "http-host-backend-readiness-api",
            "http-lifecycle-device-create-command",
            "http-desktop-device-tool-proxy",
            "http-desktop-device-tool-timeouts",
            "http-windows-sandbox-helper-config",
            "http-android-device-tool-proxy",
            "http-broker-version-reporting",
            "windows-hidden-provider-children-v7",
            "windows-sandbox-window-minimize-v4", "windows-sandbox-runtime-snapshot-ownership-v1",
            "appium3-scoped-security-npm-cwd-v1",
            "constant-time-existing-owner-auth-v1",
            "atomic-owner-secret-provisioning-v1",
            "owner-mutation-serialization-v1",
            "atomic-owner-device-state-v1",
            "cross-process-owner-state-serialization-v1",
            "owner-device-identity-fencing-v1",
            "rpc-fault-containment-v1",
            "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1",
            "physical-detach-runtime-cleanup-v1",
            "physical-runtime-cleanup-lease-fencing-v1",
            "physical-lease-state-write-rollback-v1",
            "runtime-cleanup-failure-preservation-v1",
            "appium-runtime-generation-fencing-v1",
            "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "appium-port-process-identity-fencing-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "host-broker-process-start-token-v1", "owner-generation-hmac-auth-v1", "direct-appium-process-identity-v1","owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1","ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v20", "hyper-v-setup-network-v10", "hyper-v-guest-readiness-diagnostics-v2", "hyper-v-azure-ovf-seed-v1", "hyper-v-azure-ovf-seed-v2", "hyper-v-azure-bootstrap-dhcp-v1", "hyper-v-azure-local-ovf-v1", "hyper-v-bootstrap-nic-cleanup-v1", "hyper-v-bootstrap-ssh-finalize-v2", "hyper-v-windows-specialize-seed-v1", "hyper-v-windows-specialize-account-v1", "hyper-v-windows-boot-contract-v1", "hyper-v-boot-disk-generation-v1", "hyper-v-linux-create-response-v1", "hyper-v-image-acquisition-stage-cache-v1", "hyper-v-powershell-stage-propagation-v1", "hyper-v-provider-image-finalization-v22", "hyper-v-network-failure-diagnostics-v9",
        ];
        const incompatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        ownerId,
                        version: CLI_VERSION,
                        process: { pid: stalePid, startToken: staleProcess.processStartToken },
                        startedAt: staleStartedAt,
                        implemented,
                    },
                }));
                return;
            }
            if (req.url === "/v1/owner/resolve") {
                res.writeHead(405, { "content-type": "application/json", allow: "GET" });
                res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        await new Promise<void>((resolve) => incompatible.listen(0, "127.0.0.1", resolve));
        const port = (incompatible.address() as { port: number }).port;
        const compatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        ownerId,
                        version: CLI_VERSION,
                        process: { pid: 13579, startToken: "test:13579" },
                        startedAt: "2026-07-28T00:00:00.000Z",
                        implemented,
                    },
                }));
                return;
            }
            if (req.url === "/v1/owner/resolve" && req.method === "POST") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { ownerId, projectMountPath: "/project/broker-auto-owner-resolve-test", profile: null } }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        mkdirSync(join(homedir(), ".ccc/devices/broker"), { recursive: true });
        writeFileSync(join(homedir(), ".ccc/devices/broker/runtime.json"), JSON.stringify({
            name: "ccc-device-broker",
            managedBy: "ccc-host",
            ownerId,
            pid: stalePid,
            host: "0.0.0.0",
            probeHost: "127.0.0.1",
            port,
            startedAt: staleStartedAt,
            processStartToken: staleProcess.processStartToken,
        }));
        let stopped = false;
        const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
            if (pid !== stalePid) return true;
            if (signal === 0) {
                if (stopped) {
                    const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
                    error.code = "ESRCH";
                    throw error;
                }
                return true;
            }
            stopped = true;
            incompatible.close(() => {
                compatible.listen(port, "127.0.0.1");
            });
            return true;
        }) as typeof process.kill);
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 13579;
        child.unref = vi.fn();
        const spawnImpl = vi.fn(() => child);
        const spawnedProcess = fakeBrokerPortProcess(child.pid, `node /opt/ccc/dist/index.js devices broker serve --host 0.0.0.0 --port ${port}`);
        try {
            const result = await ensureHostDeviceBroker({
                ownerId,
                cwd: "/project/broker-auto-owner-resolve-test",
                bindHost: "0.0.0.0",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                timeoutMs: 500,
                startupTimeoutMs: 3000,
                spawnImpl: spawnImpl as any,
                portProcessResolver: () => stopped ? spawnedProcess : {
                    ...staleProcess,
                    commandLine: `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`,
                },
                processIdentityReader: (pid) => pid === child.pid
                    ? spawnedProcess.processIdentity
                    : pid === stalePid
                        ? staleProcess.processIdentity
                        : null,
                processStartTokenReader: (pid) => pid === child.pid
                    ? spawnedProcess.processStartToken
                    : pid === stalePid
                        ? staleProcess.processStartToken
                        : null,
            });

            expect(result).toEqual(expect.objectContaining({
                ok: true,
                launched: true,
                reused: false,
                port,
            }));
            expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
            expect(spawnImpl).toHaveBeenCalled();
            expect(JSON.stringify(result.attempts)).toContain("runtime-incompatible-contract");
            expect(JSON.stringify(result.attempts)).toContain("/v1/owner/resolve");
            expect(JSON.stringify(result.attempts)).toContain("method-not-allowed");
        } finally {
            killSpy.mockRestore();
            await new Promise<void>((resolve) => incompatible.listening ? incompatible.close(() => resolve()) : resolve());
            await new Promise<void>((resolve) => compatible.listening ? compatible.close(() => resolve()) : resolve());
        }
    });

    it("replaces a healthy broker whose owner resolve returns a different owner", async () => {
        const ownerId = "aaaaaaaaaaaaaaaa";
        const wrongOwnerId = "bbbbbbbbbbbbbbbb";
        const stalePid = 97531;
        const staleStartedAt = "2026-07-27T00:00:00.000Z";
        const staleProcess = fakeBrokerPortProcess(stalePid, "node /opt/ccc/dist/index.js devices broker serve");
        const implemented = [
            "http-host-backend-readiness-api",
            "http-lifecycle-device-create-command",
            "http-desktop-device-tool-proxy",
            "http-desktop-device-tool-timeouts",
            "http-windows-sandbox-helper-config",
            "http-android-device-tool-proxy",
            "http-broker-version-reporting",
            "windows-hidden-provider-children-v7",
            "windows-sandbox-window-minimize-v4", "windows-sandbox-runtime-snapshot-ownership-v1",
            "appium3-scoped-security-npm-cwd-v1",
            "constant-time-existing-owner-auth-v1",
            "atomic-owner-secret-provisioning-v1",
            "owner-mutation-serialization-v1",
            "atomic-owner-device-state-v1",
            "cross-process-owner-state-serialization-v1",
            "owner-device-identity-fencing-v1",
            "rpc-fault-containment-v1",
            "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1",
            "physical-detach-runtime-cleanup-v1",
            "physical-runtime-cleanup-lease-fencing-v1",
            "physical-lease-state-write-rollback-v1",
            "runtime-cleanup-failure-preservation-v1",
            "appium-runtime-generation-fencing-v1",
            "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "appium-port-process-identity-fencing-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "host-broker-process-start-token-v1", "owner-generation-hmac-auth-v1", "direct-appium-process-identity-v1","owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1","ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v20", "hyper-v-setup-network-v10", "hyper-v-guest-readiness-diagnostics-v2", "hyper-v-azure-ovf-seed-v1", "hyper-v-azure-ovf-seed-v2", "hyper-v-azure-bootstrap-dhcp-v1", "hyper-v-azure-local-ovf-v1", "hyper-v-bootstrap-nic-cleanup-v1", "hyper-v-bootstrap-ssh-finalize-v2", "hyper-v-windows-specialize-seed-v1", "hyper-v-windows-specialize-account-v1", "hyper-v-windows-boot-contract-v1", "hyper-v-boot-disk-generation-v1", "hyper-v-linux-create-response-v1", "hyper-v-image-acquisition-stage-cache-v1", "hyper-v-powershell-stage-propagation-v1", "hyper-v-provider-image-finalization-v22", "hyper-v-network-failure-diagnostics-v9",
        ];
        const incompatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        ownerId,
                        version: CLI_VERSION,
                        process: { pid: stalePid, startToken: staleProcess.processStartToken },
                        startedAt: staleStartedAt,
                        implemented,
                    },
                }));
                return;
            }
            if (req.url === "/v1/owner/resolve" && req.method === "POST") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { ownerId: wrongOwnerId, projectMountPath: "/project/wrong", profile: null } }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        await new Promise<void>((resolve) => incompatible.listen(0, "127.0.0.1", resolve));
        const port = (incompatible.address() as { port: number }).port;
        const compatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        ownerId,
                        version: CLI_VERSION,
                        process: { pid: 86420, startToken: "test:86420" },
                        startedAt: "2026-07-28T00:00:00.000Z",
                        implemented,
                    },
                }));
                return;
            }
            if (req.url === "/v1/owner/resolve" && req.method === "POST") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { ownerId, projectMountPath: "/project/broker-owner-mismatch-test", profile: null } }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        mkdirSync(join(homedir(), ".ccc/devices/broker"), { recursive: true });
        writeFileSync(join(homedir(), ".ccc/devices/broker/runtime.json"), JSON.stringify({
            name: "ccc-device-broker",
            managedBy: "ccc-host",
            ownerId,
            pid: stalePid,
            host: "0.0.0.0",
            probeHost: "127.0.0.1",
            port,
            startedAt: staleStartedAt,
            processStartToken: staleProcess.processStartToken,
        }));
        let stopped = false;
        const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
            if (pid !== stalePid) return true;
            if (signal === 0) {
                if (stopped) {
                    const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
                    error.code = "ESRCH";
                    throw error;
                }
                return true;
            }
            stopped = true;
            incompatible.close(() => {
                compatible.listen(port, "127.0.0.1");
            });
            return true;
        }) as typeof process.kill);
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 86420;
        child.unref = vi.fn();
        const spawnImpl = vi.fn(() => child);
        const spawnedProcess = fakeBrokerPortProcess(child.pid, `node /opt/ccc/dist/index.js devices broker serve --host 0.0.0.0 --port ${port}`);
        try {
            const result = await ensureHostDeviceBroker({
                ownerId,
                cwd: "/project/broker-owner-mismatch-test",
                bindHost: "0.0.0.0",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                timeoutMs: 500,
                startupTimeoutMs: 3000,
                spawnImpl: spawnImpl as any,
                portProcessResolver: () => stopped ? spawnedProcess : {
                    ...staleProcess,
                    commandLine: `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`,
                },
                processIdentityReader: (pid) => pid === child.pid
                    ? spawnedProcess.processIdentity
                    : pid === stalePid
                        ? staleProcess.processIdentity
                        : null,
                processStartTokenReader: (pid) => pid === child.pid
                    ? spawnedProcess.processStartToken
                    : pid === stalePid
                        ? staleProcess.processStartToken
                        : null,
            });

            expect(result).toEqual(expect.objectContaining({
                ok: true,
                launched: true,
                reused: false,
                port,
            }));
            expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
            expect(spawnImpl).toHaveBeenCalled();
            expect(JSON.stringify(result.attempts)).toContain('"ownerCompatible":false');
            expect(JSON.stringify(result.attempts)).toContain(wrongOwnerId);
        } finally {
            killSpy.mockRestore();
            await new Promise<void>((resolve) => incompatible.listening ? incompatible.close(() => resolve()) : resolve());
            await new Promise<void>((resolve) => compatible.listening ? compatible.close(() => resolve()) : resolve());
        }
    });

    it("diagnoses an unmanaged incompatible broker that cannot be restarted", async () => {
        const ownerId = "cccccccccccccccc";
        const implemented = [
            "http-host-backend-readiness-api",
            "http-lifecycle-device-create-command",
            "http-desktop-device-tool-proxy",
            "http-desktop-device-tool-timeouts",
            "http-windows-sandbox-helper-config",
            "http-android-device-tool-proxy",
            "http-broker-version-reporting",
            "windows-hidden-provider-children-v7",
            "windows-sandbox-window-minimize-v4", "windows-sandbox-runtime-snapshot-ownership-v1",
            "appium3-scoped-security-npm-cwd-v1",
            "constant-time-existing-owner-auth-v1",
            "atomic-owner-secret-provisioning-v1",
            "owner-mutation-serialization-v1",
            "atomic-owner-device-state-v1",
            "cross-process-owner-state-serialization-v1",
            "owner-device-identity-fencing-v1",
            "rpc-fault-containment-v1",
            "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1",
            "physical-detach-runtime-cleanup-v1",
            "physical-runtime-cleanup-lease-fencing-v1",
            "physical-lease-state-write-rollback-v1",
            "runtime-cleanup-failure-preservation-v1",
            "appium-runtime-generation-fencing-v1",
            "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "appium-port-process-identity-fencing-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "host-broker-process-start-token-v1", "owner-generation-hmac-auth-v1", "direct-appium-process-identity-v1","owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1","ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v20", "hyper-v-setup-network-v10", "hyper-v-guest-readiness-diagnostics-v2", "hyper-v-azure-ovf-seed-v1", "hyper-v-azure-ovf-seed-v2", "hyper-v-azure-bootstrap-dhcp-v1", "hyper-v-azure-local-ovf-v1", "hyper-v-bootstrap-nic-cleanup-v1", "hyper-v-bootstrap-ssh-finalize-v2", "hyper-v-windows-specialize-seed-v1", "hyper-v-windows-specialize-account-v1", "hyper-v-windows-boot-contract-v1", "hyper-v-boot-disk-generation-v1", "hyper-v-linux-create-response-v1", "hyper-v-image-acquisition-stage-cache-v1", "hyper-v-powershell-stage-propagation-v1", "hyper-v-provider-image-finalization-v22", "hyper-v-network-failure-diagnostics-v9",
        ];
        const incompatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, broker: { ownerId, version: "1.1.61", implemented } }));
                return;
            }
            if (req.url === "/v1/owner/resolve") {
                res.writeHead(405, { "content-type": "application/json", allow: "GET" });
                res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        await new Promise<void>((resolve) => incompatible.listen(0, "127.0.0.1", resolve));
        const port = (incompatible.address() as { port: number }).port;
        const spawnImpl = vi.fn();
        try {
            const result = await ensureHostDeviceBroker({
                ownerId,
                cwd: "/project/broker-unmanaged-incompatible-test",
                bindHost: "0.0.0.0",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                timeoutMs: 500,
                startupTimeoutMs: 1,
                spawnImpl: spawnImpl as any,
            });

            expect(result).toEqual(expect.objectContaining({
                ok: false,
                launched: false,
                reused: false,
                error: "host-broker-incompatible",
                diagnostics: expect.arrayContaining([
                    `existing broker version 1.1.61 does not match CLI version ${CLI_VERSION}`,
                    "existing broker does not support the current owner-resolve POST contract",
                    "existing broker port owner could not be verified as the current CCC broker process",
                ]),
            }));
            expect(spawnImpl).not.toHaveBeenCalled();
        } finally {
            await new Promise<void>((resolve) => incompatible.listening ? incompatible.close(() => resolve()) : resolve());
        }
    });

    it("repairs a runtime-less stale broker when the listening port belongs to ccc broker serve", async () => {
        const ownerId = "eeeeeeeeeeeeeeee";
        const stalePid = 22334;
        const implemented = [
            "http-host-backend-readiness-api",
            "http-lifecycle-device-create-command",
            "http-desktop-device-tool-proxy",
            "http-desktop-device-tool-timeouts",
            "http-windows-sandbox-helper-config",
            "http-android-device-tool-proxy",
            "http-broker-version-reporting",
            "windows-hidden-provider-children-v7",
            "windows-sandbox-window-minimize-v4", "windows-sandbox-runtime-snapshot-ownership-v1",
            "appium3-scoped-security-npm-cwd-v1",
            "constant-time-existing-owner-auth-v1",
            "atomic-owner-secret-provisioning-v1",
            "owner-mutation-serialization-v1",
            "atomic-owner-device-state-v1",
            "cross-process-owner-state-serialization-v1",
            "owner-device-identity-fencing-v1",
            "rpc-fault-containment-v1",
            "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1",
            "physical-detach-runtime-cleanup-v1",
            "physical-runtime-cleanup-lease-fencing-v1",
            "physical-lease-state-write-rollback-v1",
            "runtime-cleanup-failure-preservation-v1",
            "appium-runtime-generation-fencing-v1",
            "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "appium-port-process-identity-fencing-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "host-broker-process-start-token-v1", "owner-generation-hmac-auth-v1", "direct-appium-process-identity-v1","owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1","ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v20", "hyper-v-setup-network-v10", "hyper-v-guest-readiness-diagnostics-v2", "hyper-v-azure-ovf-seed-v1", "hyper-v-azure-ovf-seed-v2", "hyper-v-azure-bootstrap-dhcp-v1", "hyper-v-azure-local-ovf-v1", "hyper-v-bootstrap-nic-cleanup-v1", "hyper-v-bootstrap-ssh-finalize-v2", "hyper-v-windows-specialize-seed-v1", "hyper-v-windows-specialize-account-v1", "hyper-v-windows-boot-contract-v1", "hyper-v-boot-disk-generation-v1", "hyper-v-linux-create-response-v1", "hyper-v-image-acquisition-stage-cache-v1", "hyper-v-powershell-stage-propagation-v1", "hyper-v-provider-image-finalization-v22", "hyper-v-network-failure-diagnostics-v9",
        ];
        const incompatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        name: "ccc-device-broker",
                        mode: "host-broker-daemon",
                        ownerId: "oldoldoldoldold1",
                        version: "1.1.61",
                        implemented,
                    },
                }));
                return;
            }
            if (req.url === "/v1/owner/resolve") {
                res.writeHead(405, { "content-type": "application/json", allow: "GET" });
                res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        await new Promise<void>((resolve) => incompatible.listen(0, "127.0.0.1", resolve));
        const port = (incompatible.address() as { port: number }).port;
        const compatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        name: "ccc-device-broker",
                        mode: "host-broker-daemon",
                        ownerId,
                        port,
                        process: { pid: 44556, startToken: "test:44556" },
                        startedAt: "2026-07-28T00:00:00.000Z",
                        version: CLI_VERSION,
                        implemented,
                    },
                }));
                return;
            }
            if (req.url === "/v1/owner/resolve" && req.method === "POST") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { ownerId, projectMountPath: "/project/broker-port-pid-repair-test", profile: null } }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        let stopped = false;
        const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
            if (pid !== stalePid) return true;
            if (signal === 0) {
                if (stopped) {
                    const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
                    error.code = "ESRCH";
                    throw error;
                }
                return true;
            }
            stopped = true;
            incompatible.close(() => {
                compatible.listen(port, "127.0.0.1");
            });
            return true;
        }) as typeof process.kill);
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 44556;
        child.unref = vi.fn();
        const spawnImpl = vi.fn(() => child);
        const spawnedProcess = fakeBrokerPortProcess(child.pid, `node /opt/ccc/dist/index.js devices broker serve --host 0.0.0.0 --port ${port}`);
        const portProcessResolver = vi.fn(() => stopped ? spawnedProcess : fakeBrokerPortProcess(
            stalePid,
            `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`,
        ));
        try {
            const result = await ensureHostDeviceBroker({
                ownerId,
                cwd: "/project/broker-port-pid-repair-test",
                bindHost: "0.0.0.0",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                timeoutMs: 500,
                startupTimeoutMs: 3000,
                spawnImpl: spawnImpl as any,
                portProcessResolver,
                processIdentityReader: (pid) => pid === child.pid ? spawnedProcess.processIdentity : null,
                processStartTokenReader: (pid) => pid === child.pid ? spawnedProcess.processStartToken : null,
            });

            expect(result).toEqual(expect.objectContaining({
                ok: true,
                launched: true,
                reused: false,
                port,
            }));
            expect(portProcessResolver).toHaveBeenCalledWith(port, process.platform);
            expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
            expect(spawnImpl).toHaveBeenCalled();
            expect(JSON.stringify(result.attempts)).toContain("port-runtime-incompatible-contract");
            expect(JSON.stringify(result.attempts)).toContain('"managedBy":"ccc-host-port"');
        } finally {
            killSpy.mockRestore();
            await new Promise<void>((resolve) => incompatible.listening ? incompatible.close(() => resolve()) : resolve());
            await new Promise<void>((resolve) => compatible.listening ? compatible.close(() => resolve()) : resolve());
        }
    });

    it("repairs a stale Windows broker when CIM hides its command line but port, runtime, and status PIDs agree", async () => {
        const ownerId = "edededededededed";
        const stalePid = 22335;
        const staleStartedAt = "2026-07-27T00:00:00.000Z";
        const staleProcessStartToken = `test:${stalePid}`;
        const implemented = deviceBrokerStatus({ ownerId }).implemented
            .filter((capability) => capability !== "stopped-android-boot-metadata-v1");
        let port = 0;
        const incompatible = createServer((req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
            } else if (req.url === "/status") {
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        name: "ccc-device-broker",
                        mode: "host-broker-daemon",
                        ownerId,
                        port,
                        process: { pid: stalePid, startToken: staleProcessStartToken },
                        startedAt: staleStartedAt,
                        version: CLI_VERSION,
                        implemented,
                    },
                }));
            } else if (req.url === "/v1/owner/resolve") {
                res.end(JSON.stringify({ ok: true, result: { ownerId } }));
            } else {
                res.statusCode = 404;
                res.end(JSON.stringify({ ok: false }));
            }
        });
        await new Promise<void>((resolve) => incompatible.listen(0, "127.0.0.1", resolve));
        port = (incompatible.address() as { port: number }).port;

        const compatible = createServer((req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
            } else if (req.url === "/status") {
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        version: CLI_VERSION,
                        process: { pid: 44557, startToken: "test:44557" },
                        startedAt: "2026-07-28T00:00:00.000Z",
                        implemented: deviceBrokerStatus({ ownerId }).implemented,
                    },
                }));
            } else if (req.url === "/v1/owner/resolve") {
                res.end(JSON.stringify({ ok: true, result: { ownerId } }));
            } else {
                res.statusCode = 404;
                res.end(JSON.stringify({ ok: false }));
            }
        });
        const runtimeFile = join(homedir(), ".ccc/devices/broker/runtime.json");
        mkdirSync(join(homedir(), ".ccc/devices/broker"), { recursive: true });
        writeFileSync(runtimeFile, JSON.stringify({
            name: "ccc-device-broker",
            managedBy: "ccc-host",
            ownerId,
            pid: stalePid,
            host: "127.0.0.1",
            port,
            startedAt: staleStartedAt,
            processStartToken: staleProcessStartToken,
        }));

        let stopped = false;
        const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
            if (pid !== stalePid) return true;
            if (signal === 0) {
                if (stopped) {
                    const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
                    error.code = "ESRCH";
                    throw error;
                }
                return true;
            }
            stopped = true;
            incompatible.close(() => compatible.listen(port, "127.0.0.1"));
            return true;
        }) as typeof process.kill);
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 44557;
        child.unref = vi.fn();
        const spawnImpl = vi.fn(() => child);
        const spawnedProcess = fakeBrokerPortProcess(child.pid, `node /opt/ccc/dist/index.js devices broker serve --host 0.0.0.0 --port ${port}`);
        try {
            const result = await ensureHostDeviceBroker({
                ownerId,
                cwd: "/project/broker-cim-redacted-repair-test",
                bindHost: "0.0.0.0",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                timeoutMs: 500,
                startupTimeoutMs: 3000,
                spawnImpl: spawnImpl as any,
                portProcessResolver: () => stopped ? spawnedProcess : {
                    ...fakeBrokerPortProcess(stalePid, null),
                    processStartToken: staleProcessStartToken,
                },
                processIdentityReader: (pid) => pid === child.pid ? spawnedProcess.processIdentity : null,
                processStartTokenReader: (pid) => pid === child.pid
                    ? spawnedProcess.processStartToken
                    : pid === stalePid
                        ? staleProcessStartToken
                        : null,
            });

            expect(result).toEqual(expect.objectContaining({ ok: true, launched: true, reused: false, port }));
            expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
            expect(JSON.stringify(result.attempts)).toContain("ccc-host-port-metadata");
            expect(JSON.stringify(result.attempts)).toContain("port-pid-plus-runtime-and-status");
        } finally {
            killSpy.mockRestore();
            await new Promise<void>((resolve) => incompatible.listening ? incompatible.close(() => resolve()) : resolve());
            await new Promise<void>((resolve) => compatible.listening ? compatible.close(() => resolve()) : resolve());
        }
    });

    it("does not trust status or persisted PIDs when the port process is unrelated", async () => {
        const ownerId = "ffffffffffffffff";
        const implemented = [
            "http-host-backend-readiness-api",
            "http-lifecycle-device-create-command",
            "http-desktop-device-tool-proxy",
            "http-desktop-device-tool-timeouts",
            "http-windows-sandbox-helper-config",
            "http-android-device-tool-proxy",
            "http-broker-version-reporting",
            "windows-hidden-provider-children-v7",
            "windows-sandbox-window-minimize-v4", "windows-sandbox-runtime-snapshot-ownership-v1",
            "appium3-scoped-security-npm-cwd-v1",
            "constant-time-existing-owner-auth-v1",
            "atomic-owner-secret-provisioning-v1",
            "owner-mutation-serialization-v1",
            "atomic-owner-device-state-v1",
            "cross-process-owner-state-serialization-v1",
            "owner-device-identity-fencing-v1",
            "rpc-fault-containment-v1",
            "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1",
            "physical-detach-runtime-cleanup-v1",
            "physical-runtime-cleanup-lease-fencing-v1",
            "physical-lease-state-write-rollback-v1",
            "runtime-cleanup-failure-preservation-v1",
            "appium-runtime-generation-fencing-v1",
            "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "appium-port-process-identity-fencing-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "host-broker-process-start-token-v1", "owner-generation-hmac-auth-v1", "direct-appium-process-identity-v1","owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1","ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v20", "hyper-v-setup-network-v10", "hyper-v-guest-readiness-diagnostics-v2", "hyper-v-azure-ovf-seed-v1", "hyper-v-azure-ovf-seed-v2", "hyper-v-azure-bootstrap-dhcp-v1", "hyper-v-azure-local-ovf-v1", "hyper-v-bootstrap-nic-cleanup-v1", "hyper-v-bootstrap-ssh-finalize-v2", "hyper-v-windows-specialize-seed-v1", "hyper-v-windows-specialize-account-v1", "hyper-v-windows-boot-contract-v1", "hyper-v-boot-disk-generation-v1", "hyper-v-linux-create-response-v1", "hyper-v-image-acquisition-stage-cache-v1", "hyper-v-powershell-stage-propagation-v1", "hyper-v-provider-image-finalization-v22", "hyper-v-network-failure-diagnostics-v9",
        ];
        const incompatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                const port = (incompatible.address() as { port: number }).port;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, broker: { name: "ccc-device-broker", mode: "host-broker-daemon", ownerId, port, process: { pid: 77889, startToken: "test:77889" }, version: "1.1.61", implemented } }));
                return;
            }
            if (req.url === "/v1/owner/resolve") {
                res.writeHead(405, { "content-type": "application/json", allow: "GET" });
                res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        await new Promise<void>((resolve) => incompatible.listen(0, "127.0.0.1", resolve));
        const port = (incompatible.address() as { port: number }).port;
        const runtimeFile = join(homedir(), ".ccc/devices/broker/runtime.json");
        const persistedRuntime = { name: "ccc-device-broker", managedBy: "ccc-host", ownerId, pid: 66778, host: "127.0.0.1", port };
        mkdirSync(join(homedir(), ".ccc/devices/broker"), { recursive: true });
        writeFileSync(runtimeFile, JSON.stringify(persistedRuntime));
        const spawnImpl = vi.fn();
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        try {
            const result = await ensureHostDeviceBroker({
                ownerId,
                cwd: "/project/broker-unrelated-port-process-test",
                bindHost: "0.0.0.0",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                timeoutMs: 500,
                startupTimeoutMs: 1,
                spawnImpl: spawnImpl as any,
                portProcessResolver: () => fakeBrokerPortProcess(77889, `evil.exe node /opt/ccc/dist/index.js devices broker serve --port ${port}`),
            });

            expect(result).toEqual(expect.objectContaining({
                ok: false,
                launched: false,
                reused: false,
                error: "host-broker-incompatible",
            }));
            expect(killSpy).not.toHaveBeenCalledWith(77889, expect.anything());
            expect(killSpy).not.toHaveBeenCalledWith(66778, expect.anything());
            expect(JSON.parse(readFileSync(runtimeFile, "utf8"))).toEqual(persistedRuntime);
            expect(spawnImpl).not.toHaveBeenCalled();
        } finally {
            killSpy.mockRestore();
            await new Promise<void>((resolve) => incompatible.listening ? incompatible.close(() => resolve()) : resolve());
        }
    });

    it("repairs a ccc-host broker using status pid when runtime metadata is missing", async () => {
        const ownerId = "dddddddddddddddd";
        const stalePid = 11223;
        const implemented = [
            "http-host-backend-readiness-api",
            "http-lifecycle-device-create-command",
            "http-desktop-device-tool-proxy",
            "http-desktop-device-tool-timeouts",
            "http-windows-sandbox-helper-config",
            "http-android-device-tool-proxy",
            "http-broker-version-reporting",
            "windows-hidden-provider-children-v7",
            "windows-sandbox-window-minimize-v4", "windows-sandbox-runtime-snapshot-ownership-v1",
            "appium3-scoped-security-npm-cwd-v1",
            "constant-time-existing-owner-auth-v1",
            "atomic-owner-secret-provisioning-v1",
            "owner-mutation-serialization-v1",
            "atomic-owner-device-state-v1",
            "cross-process-owner-state-serialization-v1",
            "owner-device-identity-fencing-v1",
            "rpc-fault-containment-v1",
            "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1",
            "physical-detach-runtime-cleanup-v1",
            "physical-runtime-cleanup-lease-fencing-v1",
            "physical-lease-state-write-rollback-v1",
            "runtime-cleanup-failure-preservation-v1",
            "appium-runtime-generation-fencing-v1",
            "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "appium-port-process-identity-fencing-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "host-broker-process-start-token-v1", "owner-generation-hmac-auth-v1", "direct-appium-process-identity-v1","owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1","ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v20", "hyper-v-setup-network-v10", "hyper-v-guest-readiness-diagnostics-v2", "hyper-v-azure-ovf-seed-v1", "hyper-v-azure-ovf-seed-v2", "hyper-v-azure-bootstrap-dhcp-v1", "hyper-v-azure-local-ovf-v1", "hyper-v-bootstrap-nic-cleanup-v1", "hyper-v-bootstrap-ssh-finalize-v2", "hyper-v-windows-specialize-seed-v1", "hyper-v-windows-specialize-account-v1", "hyper-v-windows-boot-contract-v1", "hyper-v-boot-disk-generation-v1", "hyper-v-linux-create-response-v1", "hyper-v-image-acquisition-stage-cache-v1", "hyper-v-powershell-stage-propagation-v1", "hyper-v-provider-image-finalization-v22", "hyper-v-network-failure-diagnostics-v9",
        ];
        const incompatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                const port = (incompatible.address() as { port: number }).port;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        name: "ccc-device-broker",
                        mode: "host-broker-daemon",
                        ownerId,
                        host: "0.0.0.0",
                        port,
                        process: { pid: stalePid },
                        version: "1.1.61",
                        implemented,
                    },
                }));
                return;
            }
            if (req.url === "/v1/owner/resolve") {
                res.writeHead(405, { "content-type": "application/json", allow: "GET" });
                res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        await new Promise<void>((resolve) => incompatible.listen(0, "127.0.0.1", resolve));
        const port = (incompatible.address() as { port: number }).port;
        const compatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        name: "ccc-device-broker",
                        mode: "host-broker-daemon",
                        ownerId,
                        host: "0.0.0.0",
                        port,
                        process: { pid: 55667, startToken: "test:55667" },
                        startedAt: "2026-07-28T00:00:00.000Z",
                        version: CLI_VERSION,
                        implemented,
                    },
                }));
                return;
            }
            if (req.url === "/v1/owner/resolve" && req.method === "POST") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { ownerId, projectMountPath: "/project/broker-status-pid-repair-test", profile: null } }));
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        let stopped = false;
        const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
            if (pid !== stalePid) return true;
            if (signal === 0) {
                if (stopped) {
                    const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
                    error.code = "ESRCH";
                    throw error;
                }
                return true;
            }
            stopped = true;
            incompatible.close(() => {
                compatible.listen(port, "127.0.0.1");
            });
            return true;
        }) as typeof process.kill);
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 55667;
        child.unref = vi.fn();
        const spawnImpl = vi.fn(() => child);
        const spawnedProcess = fakeBrokerPortProcess(child.pid, `node /opt/ccc/dist/index.js devices broker serve --host 0.0.0.0 --port ${port}`);
        try {
            const result = await ensureHostDeviceBroker({
                ownerId,
                cwd: "/project/broker-status-pid-repair-test",
                bindHost: "0.0.0.0",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                timeoutMs: 500,
                startupTimeoutMs: 3000,
                spawnImpl: spawnImpl as any,
                portProcessResolver: () => stopped ? spawnedProcess : fakeBrokerPortProcess(stalePid, `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`),
                processIdentityReader: (pid) => pid === child.pid ? spawnedProcess.processIdentity : null,
                processStartTokenReader: (pid) => pid === child.pid ? spawnedProcess.processStartToken : null,
            });

            expect(result).toEqual(expect.objectContaining({
                ok: true,
                launched: true,
                reused: false,
                port,
            }));
            expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
            expect(spawnImpl).toHaveBeenCalled();
            expect(JSON.stringify(result.attempts)).toContain("status-runtime-incompatible-contract");
            expect(JSON.stringify(result.attempts)).toContain('"managedBy":"ccc-host-port"');
        } finally {
            killSpy.mockRestore();
            await new Promise<void>((resolve) => incompatible.listening ? incompatible.close(() => resolve()) : resolve());
            await new Promise<void>((resolve) => compatible.listening ? compatible.close(() => resolve()) : resolve());
        }
    });

    it("repairs cross-platform runtime metadata without terminating the host broker from a container", async () => {
        const ownerId = "abababababababab";
        const hostPid = 36024;
        const server = createServer((req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                const port = (server.address() as { port: number }).port;
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        name: "ccc-device-broker",
                        mode: "host-broker-daemon",
                        ownerId,
                        host: "127.0.0.1",
                        port,
                        process: { pid: hostPid },
                        version: "1.1.60",
                        implemented: [],
                        startedAt: "2026-07-13T05:09:33.733Z",
                        serviceManager: {
                            platform: "win32",
                            command: ["C:\\node.exe", "C:\\repo\\dist\\index.js", "devices", "broker", "serve"],
                        },
                    },
                }));
                return;
            }
            if (req.url === "/v1/owner/resolve" && req.method === "POST") {
                res.end(JSON.stringify({ ok: true, result: { ownerId, projectMountPath: "/project/cross-platform-runtime-test", profile: null } }));
                return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        const runtimeFile = join(homedir(), ".ccc/devices/broker/runtime.json");
        mkdirSync(join(homedir(), ".ccc/devices/broker"), { recursive: true });
        writeFileSync(runtimeFile, JSON.stringify({
            name: "ccc-device-broker",
            managedBy: "ccc-host",
            ownerId,
            pid: 316170,
            host: "127.0.0.1",
            port,
            command: "/usr/bin/node",
        }));
        const spawnImpl = vi.fn();
        const killSpy = vi.spyOn(process, "kill");

        try {
            const result = await ensureHostDeviceBroker({
                ownerId,
                cwd: "/project/cross-platform-runtime-test",
                host: "127.0.0.1",
                port,
                platform: "linux",
                timeoutMs: 500,
                spawnImpl: spawnImpl as any,
                portProcessResolver: () => fakeBrokerPortProcess(hostPid, `node C:\\repo\\dist\\index.js devices broker serve --host 127.0.0.1 --port ${port}`),
            });

            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "host-broker-incompatible",
                diagnostics: expect.arrayContaining([expect.stringContaining("must be restarted by host CCC")]),
            }));
            expect(JSON.stringify(result.attempts)).toContain("runtime-host-platform-mismatch");
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(killSpy).not.toHaveBeenCalledWith(hostPid, expect.anything());
            expect(JSON.parse(readFileSync(runtimeFile, "utf8"))).toEqual({
                name: "ccc-device-broker",
                managedBy: "ccc-host",
                ownerId,
                pid: 316170,
                host: "127.0.0.1",
                port,
                command: "/usr/bin/node",
            });
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("spawns a detached host broker command when auto-start cannot reuse one", async () => {
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 12345;
        child.unref = vi.fn();
        const spawnImpl = vi.fn(() => child);
        const killSpy = vi.spyOn(process, "kill");
        const result = await ensureHostDeviceBroker({
            cwd: "/project/broker-auto-spawn-test",
            bindHost: "0.0.0.0",
            probeHost: "127.0.0.1",
            port: 65534,
            cliPath: "/opt/ccc/dist/index.js",
            timeoutMs: 1,
            startupTimeoutMs: 1,
            spawnImpl: spawnImpl as any,
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            launched: true,
            error: "host-broker-health-timeout",
            command: process.execPath,
            args: ["/opt/ccc/dist/index.js", "devices", "broker", "serve", "--host", "0.0.0.0", "--port", "65534"],
        }));
        expect(spawnImpl).toHaveBeenCalledWith(
            process.execPath,
            ["/opt/ccc/dist/index.js", "devices", "broker", "serve", "--host", "0.0.0.0", "--port", "65534"],
            expect.objectContaining({
                cwd: "/project/broker-auto-spawn-test",
                detached: true,
                windowsHide: true,
            }),
        );
        expect(child.unref).toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({
            startupCleanup: expect.objectContaining({ attempted: false }),
        }));
        expect(killSpy.mock.calls.some(([pid, signal]) => pid === child.pid && signal === "SIGTERM")).toBe(false);
        const logPath = (result as { logPath?: string; runtime?: { logPath?: string } }).runtime?.logPath
            || (result as { logPath?: string }).logPath;
        expect(logPath).toMatch(/host-broker-\d+-[a-f0-9]{16}\.log$/);
        expect(lstatSync(logPath as string)).toEqual(expect.objectContaining({ nlink: 1 }));
    });

    it("keeps the event loop responsive while an asynchronous provider command runs", async () => {
        let timerObserved = false;
        const command = defaultProviderCommandRunnerAsync({
            mode: "exec",
            provider: "test-async-provider",
            executable: process.execPath,
            args: ["-e", "setTimeout(() => process.stdout.write('done'), 100)"],
        }, { timeoutMs: 1000, outputLimit: 1024 });
        await new Promise<void>((resolve) => setTimeout(() => {
            timerObserved = true;
            resolve();
        }, 10));
        expect(timerObserved).toBe(true);
        await expect(command).resolves.toEqual(expect.objectContaining({ status: 0, stdout: "done" }));
    });

    it("terminates a verified unresponsive broker port owner before relaunching", async () => {
        const stalePid = 654321;
        let staleAlive = true;
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 12345;
        child.unref = vi.fn();
        const spawnImpl = vi.fn(() => child);
        const originalKill = process.kill.bind(process);
        const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
            if (pid !== stalePid) return originalKill(pid, signal as NodeJS.Signals | number);
            if (signal === 0) {
                if (staleAlive) return true;
                const error = new Error("missing") as NodeJS.ErrnoException;
                error.code = "ESRCH";
                throw error;
            }
            if (signal === "SIGTERM" || signal === "SIGKILL") {
                staleAlive = false;
                return true;
            }
            return true;
        }) as typeof process.kill);

        const result = await ensureHostDeviceBroker({
            cwd: "/project/broker-unresponsive-port-test",
            platform: "linux",
            port: 65531,
            cliPath: "/opt/ccc/dist/index.js",
            timeoutMs: 1,
            startupTimeoutMs: 1,
            portProcessResolver: () => fakeBrokerPortProcess(stalePid, "node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port 65531"),
            spawnImpl: spawnImpl as any,
        });

        expect(result).toEqual(expect.objectContaining({ ok: false, launched: true, error: "host-broker-health-timeout" }));
        expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
        expect(spawnImpl).toHaveBeenCalledOnce();
        expect(JSON.stringify(result.attempts)).toContain("unhealthy-broker-port-owner");
    });

    it("refuses to terminate an unresponsive broker after its process identity changes", async () => {
        const stalePid = 654322;
        let resolutions = 0;
        const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
            if (pid === stalePid && signal === 0) return true;
            throw new Error(`unexpected signal ${String(signal)}`);
        }) as typeof process.kill);
        const commandLine = "node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port 65530";
        const portProcessResolver = () => {
            resolutions += 1;
            const process = fakeBrokerPortProcess(stalePid, commandLine);
            if (resolutions >= 3) process.processIdentity.startToken = `reused:${stalePid}`;
            return process;
        };

        const result = await ensureHostDeviceBroker({
            cwd: "/project/broker-reused-pid-test",
            platform: "linux",
            port: 65530,
            cliPath: "/opt/ccc/dist/index.js",
            timeoutMs: 1,
            startupTimeoutMs: 1,
            portProcessResolver,
            spawnImpl: vi.fn() as any,
        });

        expect(result).toEqual(expect.objectContaining({ ok: false, launched: false, error: "host-broker-incompatible" }));
        expect(JSON.stringify(result.attempts)).toContain("runtime-process-identity-mismatch");
        expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    });

    it.runIf(process.platform !== "win32")("refuses host broker autostart through a linked log directory", async () => {
        const brokerDirectory = join(homedir(), ".ccc", "devices", "broker");
        const logsDirectory = join(brokerDirectory, "logs");
        const externalDirectory = join(homedir(), "external-host-broker-logs");
        const marker = join(externalDirectory, "preserve.txt");
        mkdirSync(brokerDirectory, { recursive: true });
        mkdirSync(externalDirectory, { recursive: true });
        writeFileSync(marker, "preserve");
        symlinkSync(externalDirectory, logsDirectory);
        const spawnImpl = vi.fn();

        const result = await ensureHostDeviceBroker({
            cwd: "/project/broker-linked-log-test",
            probeHost: "127.0.0.1",
            port: 65533,
            cliPath: "/opt/ccc/dist/index.js",
            timeoutMs: 1,
            startupTimeoutMs: 1,
            spawnImpl: spawnImpl as any,
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            launched: false,
            error: "host-broker-launch-failed",
            detail: "host-broker-log-directory-invalid",
        }));
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(readFileSync(marker, "utf8")).toBe("preserve");
        expect(readdirSync(externalDirectory)).toEqual(["preserve.txt"]);
    });

    it("serves owner-scoped read-only RPC with secret-backed local owner token", async () => {
        const cwd = "/project/broker-rpc-test";
        const ownerId = deviceLabOwnerId(cwd);
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-ccc-device-token": deviceBrokerOwnerToken(ownerId),
                },
                body: JSON.stringify({ ownerId, method: "broker.echo", params: { hello: "world" } }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                ok: true,
                result: { ownerId, params: { hello: "world" } },
            });

            const status = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-ccc-device-token": deviceBrokerOwnerToken(ownerId),
                },
                body: JSON.stringify({ method: "broker.status" }),
            });
            expect(status.status).toBe(200);
            const statusBody = await status.json() as { ok: boolean; result: { ownerId: string; state: { ownerRoot: string }; implemented: string[]; deferred: string[] } };
            expect(statusBody.ok).toBe(true);
            expect(statusBody.result.ownerId).toBe(ownerId);
            expect(statusBody.result.state.ownerRoot).toContain(ownerId);
            expect(statusBody.result.implemented).toContain("http-owner-rpc");
            expect(statusBody.result.implemented).toContain("bounded-appium-webdriver-request-proxy");
            expect(statusBody.result.implemented).toContain("http-readonly-device-tool-routing");
            expect(statusBody.result.implemented).toContain("http-recording-device-tool-routing");
            expect(statusBody.result.implemented).toContain("http-desktop-device-tool-proxy");
            expect(statusBody.result.implemented).toContain("http-desktop-device-tool-timeouts");
            expect(statusBody.result.implemented).toContain("http-windows-sandbox-helper-config");
            expect(statusBody.result.implemented).toContain("http-android-device-tool-proxy");
            expect(statusBody.result.implemented).toContain("appium3-scoped-security-npm-cwd-v1");
            expect(statusBody.result.implemented).toContain("constant-time-existing-owner-auth-v1");
            expect(statusBody.result.implemented).toContain("atomic-owner-secret-provisioning-v1");
            expect(statusBody.result.implemented).toContain("owner-mutation-serialization-v1");
            expect(statusBody.result.implemented).toContain("atomic-owner-device-state-v1");
            expect(statusBody.result.implemented).toContain("cross-process-owner-state-serialization-v1");
            expect(statusBody.result.implemented).toContain("rpc-fault-containment-v1");
            expect(statusBody.result.deferred).not.toContain("mutating-non-lifecycle-device-tool-routing");
            expect(statusBody.result.deferred).not.toContain("full-provider-routing-parity");
        } finally {
            await close(server);
        }
    });

    it("guards broker RPC auth, owner mismatches, methods, and body parsing", async () => {
        const cwd = "/project/broker-rpc-guard-test";
        const ownerId = deviceLabOwnerId(cwd);
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const token = deviceBrokerOwnerToken(ownerId);
        const oldDeterministicToken = createHash("sha256").update(`ccc-device-broker:owner:${ownerId}`).digest("hex");
        try {
            const status = await (await fetch(`${baseUrl}/status`)).json() as {
                broker: { startedAt: string; process: { startToken: string } };
            };
            const signedHeaders = (body: unknown, startToken = status.broker.process.startToken) => {
                const timestamp = String(Date.now());
                const nonce = createHash("sha256").update(`${timestamp}:${startToken}`).digest("hex").slice(0, 32);
                const bodyHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
                const payload = [
                    "v1",
                    ownerId,
                    timestamp,
                    nonce,
                    status.broker.startedAt,
                    startToken,
                    bodyHash,
                ].join("\n");
                return {
                    "content-type": "application/json",
                    "x-ccc-device-auth": createHmac("sha256", token).update(payload).digest("hex"),
                    "x-ccc-device-auth-timestamp": timestamp,
                    "x-ccc-device-auth-nonce": nonce,
                    "x-ccc-device-broker-started-at": status.broker.startedAt,
                    "x-ccc-device-broker-start-token": startToken,
                };
            };
            const missingToken = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ method: "broker.echo" }),
            });
            expect(missingToken.status).toBe(401);
            expect(await missingToken.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-owner-token" }));

            const oldToken = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": oldDeterministicToken },
                body: JSON.stringify({ method: "broker.echo" }),
            });
            expect(oldToken.status).toBe(401);
            expect(await oldToken.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-owner-token" }));

            const signedBody = { method: "broker.echo", params: { signed: true } };
            const signedRequestHeaders = signedHeaders(signedBody);
            const signed = await fetch(endpoint, {
                method: "POST",
                headers: signedRequestHeaders,
                body: JSON.stringify(signedBody),
            });
            expect(signed.status).toBe(200);
            expect(await signed.json()).toEqual(expect.objectContaining({
                ok: true,
                result: { ownerId, params: { signed: true } },
            }));

            const replay = await fetch(endpoint, {
                method: "POST",
                headers: signedRequestHeaders,
                body: JSON.stringify(signedBody),
            });
            expect(replay.status).toBe(409);
            expect(await replay.json()).toEqual(expect.objectContaining({ ok: false, error: "broker-auth-replay" }));

            const staleGeneration = await fetch(endpoint, {
                method: "POST",
                headers: signedHeaders(signedBody, "linux:successor-generation"),
                body: JSON.stringify(signedBody),
            });
            expect(staleGeneration.status).toBe(401);
            expect(await staleGeneration.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-owner-token" }));

            const ownerMismatch = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: JSON.stringify({ ownerId: "0123456789abcdef", method: "broker.echo" }),
            });
            expect(ownerMismatch.status).toBe(403);
            expect(await ownerMismatch.json()).toEqual(expect.objectContaining({ ok: false, error: "owner-mismatch" }));

            const lifecycle = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: JSON.stringify({ method: "device.start" }),
            });
            expect(lifecycle.status).toBe(501);
            expect(await lifecycle.json()).toEqual(expect.objectContaining({ ok: false, error: "method-not-implemented" }));

            const unknown = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: JSON.stringify({ method: "broker.missing" }),
            });
            expect(unknown.status).toBe(404);
            expect(await unknown.json()).toEqual(expect.objectContaining({ ok: false, error: "unknown-method" }));

            const invalidJson = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: "{not-json",
            });
            expect(invalidJson.status).toBe(400);
            expect(await invalidJson.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-json" }));

            const oversized = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: JSON.stringify({ method: "broker.echo", params: { payload: "x".repeat(70 * 1024) } }),
            });
            expect(oversized.status).toBe(413);
            expect(await oversized.json()).toEqual(expect.objectContaining({ ok: false, error: "request-too-large" }));

            const get = await fetch(endpoint);
            expect(get.status).toBe(405);
            expect(get.headers.get("allow")).toBe("POST");
        } finally {
            await close(server);
        }
    });

    it("does not create owner secrets for unauthenticated owner probes", async () => {
        const ownerId = "0011223344556677";
        const secretFile = deviceBrokerAuthSecretFile(ownerId);
        const server = createDeviceBrokerServer({ cwd: "/project/broker-auth-probe-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            expect(existsSync(secretFile)).toBe(false);
            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": "0".repeat(64) },
                body: JSON.stringify({ method: "broker.echo" }),
            });
            expect(response.status).toBe(401);
            expect(await response.json()).toEqual({ ok: false, error: "invalid-owner-token" });
            expect(existsSync(secretFile)).toBe(false);
        } finally {
            await close(server);
        }
    });

    it("provisions the resolved owner's auth secret inside the broker authority", async () => {
        const cwd = "/project/broker-auth-resolve-test";
        const ownerId = deviceLabOwnerId(cwd);
        const projectMountPath = deviceLabProjectMountPath(cwd);
        const secretFile = deviceBrokerAuthSecretFile(ownerId);
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            expect(existsSync(secretFile)).toBe(false);
            const resolve = await fetch(`${baseUrl}/v1/owner/resolve`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ projectMountPath }),
            });
            expect(resolve.status).toBe(200);
            expect(await resolve.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ ownerId }),
            }));
            expect(JSON.parse(readFileSync(secretFile, "utf8"))).toEqual(expect.objectContaining({
                ownerId,
                secret: expect.stringMatching(/^[a-f0-9]{64}$/),
                version: 1,
            }));
            expect(statSync(secretFile).mode & 0o777).toBe(0o600);

            const rpc = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-ccc-device-token": deviceBrokerOwnerToken(ownerId),
                },
                body: JSON.stringify({ ownerId, method: "broker.echo", params: { recovered: true } }),
            });
            expect(rpc.status).toBe(200);
        } finally {
            await close(server);
        }
    });

    it("resolves multiple canonical project owners through one shared broker", async () => {
        const brokerCwd = "/host/projects/broker-launch-project";
        const foreignCwd = "/host/projects/foreign-project";
        const foreignMountPath = deviceLabProjectMountPath(foreignCwd);
        const foreignOwnerId = deviceLabOwnerId(foreignCwd, "work");
        const secretFile = deviceBrokerAuthSecretFile(foreignOwnerId);
        registerDeviceBrokerOwner(foreignCwd, "work", foreignOwnerId);
        const server = createDeviceBrokerServer({ cwd: brokerCwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(`${baseUrl}/v1/owner/resolve`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ projectMountPath: foreignMountPath, profile: "work" }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                ok: true,
                result: {
                    ownerId: foreignOwnerId,
                    ownerBasis: `ccc-${foreignMountPath.slice("/project/".length)}--p--work:${foreignMountPath}`,
                    projectMountPath: foreignMountPath,
                    profile: "work",
                },
            });
            expect(existsSync(secretFile)).toBe(true);
        } finally {
            await close(server);
        }
    });

    it("rejects canonical but unregistered project owners without provisioning auth", async () => {
        const foreignCwd = "/host/projects/unregistered-project";
        const foreignMountPath = deviceLabProjectMountPath(foreignCwd);
        const foreignOwnerId = deviceLabOwnerId(foreignCwd);
        const secretFile = deviceBrokerAuthSecretFile(foreignOwnerId);
        const server = createDeviceBrokerServer({ cwd: "/host/projects/broker-launch-project", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(`${baseUrl}/v1/owner/resolve`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ projectMountPath: foreignMountPath }),
            });
            expect(response.status).toBe(404);
            expect(await response.json()).toEqual({ ok: false, error: "project-owner-unavailable" });
            expect(existsSync(secretFile)).toBe(false);
            expect(existsSync(deviceBrokerOwnerRegistrationFile(foreignOwnerId))).toBe(false);
        } finally {
            await close(server);
        }
    });

    it("fails closed when a registered project owner mapping is tampered", async () => {
        const foreignCwd = "/host/projects/tampered-project";
        const foreignMountPath = deviceLabProjectMountPath(foreignCwd);
        const foreignOwnerId = deviceLabOwnerId(foreignCwd);
        const registrationFile = deviceBrokerOwnerRegistrationFile(foreignOwnerId);
        registerDeviceBrokerOwner(foreignCwd, undefined, foreignOwnerId);
        writeFileSync(registrationFile, JSON.stringify({
            version: 1,
            ownerId: foreignOwnerId,
            ownerBasis: `ccc-${foreignMountPath.slice("/project/".length)}:${foreignMountPath}`,
            projectMountPath: foreignMountPath,
            hostProjectPath: "/host/projects/redirected-project",
            profile: null,
            registeredAt: new Date().toISOString(),
        }));
        const server = createDeviceBrokerServer({ cwd: "/host/projects/broker-launch-project", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(`${baseUrl}/v1/owner/resolve`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ projectMountPath: foreignMountPath }),
            });
            expect(response.status).toBe(409);
            expect(await response.json()).toEqual({ ok: false, error: "project-owner-registration-invalid" });
        } finally {
            await close(server);
        }
    });

    it("uses each registered owner's host project path for device tool file translation", async () => {
        const brokerCwd = "/host/projects/broker-launch-project";
        const foreignCwd = "/host/projects/foreign-project";
        const foreignMountPath = deviceLabProjectMountPath(foreignCwd);
        const foreignOwnerId = deviceLabOwnerId(foreignCwd);
        registerDeviceBrokerOwner(foreignCwd, undefined, foreignOwnerId);
        let translatedLocalPath: unknown;
        let rpcCwd: unknown;
        const server = createDeviceBrokerServer({
            cwd: brokerCwd,
            host: "127.0.0.1",
            port: 0,
            deviceToolRunner: async (_ownerId, parsed, _match, normalized) => {
                translatedLocalPath = parsed.params.localPath;
                rpcCwd = normalized.cwd;
                return { status: 200, payload: { ok: true } };
            },
        });
        const baseUrl = await listen(server);
        writeBrokerDevices(foreignOwnerId, "android", [{ id: "foreign-android", backend: "android-emulator", status: "running" }]);
        try {
            const resolveResponse = await fetch(`${baseUrl}/v1/owner/resolve`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ projectMountPath: foreignMountPath }),
            });
            expect(resolveResponse.status).toBe(200);
            const response = await fetch(`${baseUrl}/v1/owners/${foreignOwnerId}/rpc`, {
                method: "POST",
                headers: ownerRpcHeaders(foreignOwnerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: {
                        tool: "device_upload",
                        backend: "android-emulator",
                        deviceId: "foreign-android",
                        localPath: `${foreignMountPath}/fixtures/app.apk`,
                        remotePath: "/data/local/tmp/app.apk",
                    },
                }),
            });
            expect(response.status).toBe(200);
            expect(rpcCwd).toBe(foreignCwd);
            expect(translatedLocalPath).toBe(`${foreignCwd}/fixtures/app.apk`);
        } finally {
            await close(server);
            cleanupOwner(foreignOwnerId);
        }
    });

    it("rejects malformed cross-project owner resolve requests without provisioning auth", async () => {
        const server = createDeviceBrokerServer({ cwd: "/host/projects/broker-launch-project", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            for (const payload of [
                { projectMountPath: "/project/../foreign" },
                { projectMountPath: "/project/not-canonical" },
                { projectMountPath: deviceLabProjectMountPath("/host/projects/foreign"), profile: "INVALID PROFILE" },
                { projectMountPath: deviceLabProjectMountPath("/host/projects/foreign"), profile: 42 },
            ]) {
                const response = await fetch(`${baseUrl}/v1/owner/resolve`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(payload),
                });
                expect(response.status).toBe(400);
                expect(await response.json()).toEqual(expect.objectContaining({
                    ok: false,
                    error: "invalid-project-owner-request",
                }));
            }
        } finally {
            await close(server);
        }
    });

    it("provisions one broker-owned secret for concurrent MCP client processes", async () => {
        const cwd = process.cwd();
        const ownerId = deviceLabOwnerId(cwd);
        const secretFile = deviceBrokerAuthSecretFile(ownerId);
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const port = Number(new URL(baseUrl).port);
        const moduleUrl = pathToFileURL(join(cwd, "device-lab-mcp", "src", "broker.mjs")).href;
        const script = [
            `import { brokerRpc } from ${JSON.stringify(moduleUrl)};`,
            `const result = await brokerRpc({ method: "broker.echo", hostCandidates: ["127.0.0.1"], port: ${port}, timeoutMs: 5000, autolaunch: false });`,
            `if (!result.ok) throw new Error(JSON.stringify(result));`,
            `process.stdout.write(result.ownerId);`,
        ].join("\n");
        const env = Object.fromEntries(
            Object.entries(process.env).filter(([key, value]) => value !== undefined
                && key !== "VITEST"
                && !key.startsWith("VITEST_")
                && key !== "CCC_DEVICE_BROKER_AUTH_FILE"),
        ) as NodeJS.ProcessEnv;

        expect(existsSync(secretFile)).toBe(false);
        const clients = Array.from({ length: 12 }, () => new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
                cwd,
                env,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            let stdout = "";
            let stderr = "";
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error("concurrent MCP auth client timed out"));
            }, 15000);
            child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
            child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
            child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once("close", (status) => {
                clearTimeout(timer);
                if (status === 0) resolve(stdout.trim());
                else reject(new Error(`concurrent MCP auth client exited ${status}: ${stderr}`));
            });
        }));

        try {
            expect(new Set(await Promise.all(clients))).toEqual(new Set([ownerId]));
            expect(JSON.parse(readFileSync(secretFile, "utf8"))).toEqual(expect.objectContaining({
                ownerId,
                secret: expect.stringMatching(/^[a-f0-9]{64}$/),
                version: 1,
            }));
            expect(statSync(secretFile).mode & 0o777).toBe(0o600);
            expect(existsSync(`${secretFile}.lock`)).toBe(false);
        } finally {
            await Promise.allSettled(clients);
            await close(server);
        }
    });

    it("contains unexpected RPC failures and keeps serving health checks", async () => {
        const cwd = "/project/broker-fault-containment-test";
        const ownerId = deviceLabOwnerId(cwd);
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            deviceToolRunner: async () => {
                throw new Error("sensitive-provider-detail");
            },
        });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "windows", [{ id: "win-fault", backend: "windows-sandbox", status: "running" }]);
        try {
            const failed = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.device.tool.invoke",
                    params: { tool: "device_screenshot", backend: "windows-sandbox", deviceId: "win-fault" },
                }),
            });
            expect(failed.status).toBe(500);
            const body = await failed.json();
            expect(body).toEqual({ ok: false, error: "broker-internal-error" });
            expect(JSON.stringify(body)).not.toContain("sensitive-provider-detail");

            const health = await fetch(`${baseUrl}/health`);
            expect(health.status).toBe(200);
            expect(await health.json()).toEqual(expect.objectContaining({ ok: true, name: "ccc-device-broker" }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("serializes mutating RPCs for the same owner", async () => {
        const cwd = "/project/broker-owner-mutation-serialization-test";
        const ownerId = deviceLabOwnerId(cwd);
        let active = 0;
        let maxActive = 0;
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            deviceToolRunner: async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 30));
                active -= 1;
                return { status: 200, payload: { ok: true } };
            },
        });
        const baseUrl = await listen(server);
        writeBrokerDevices(ownerId, "windows", [{ id: "win-serialized", backend: "windows-sandbox", status: "running" }]);
        const invoke = () => fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
            method: "POST",
            headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({
                method: "broker.device.tool.invoke",
                params: { tool: "device_click", backend: "windows-sandbox", deviceId: "win-serialized", x: 10, y: 20 },
            }),
        });
        try {
            const responses = await Promise.all([invoke(), invoke()]);
            expect(responses.map((response) => response.status)).toEqual([200, 200]);
            expect(maxActive).toBe(1);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("bounds owner inventory state reads and returned device arrays", async () => {
        const cwd = "/project/broker-inventory-bound-test";
        const ownerId = deviceLabOwnerId(cwd);
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        try {
            writeBrokerDevices(ownerId, "android", Array.from({ length: DEVICE_BROKER_INVENTORY_DEVICE_LIMIT + 5 }, (_, index) => index === 0 ? {
                id: `android-${index}`,
                privateRoot: "/private/owner/device",
                sshPrivateKeyPath: "/private/owner/device/id_ed25519",
                guestCredentialPath: "/private/owner/device/guest.credential.xml",
            } : { id: `android-${index}` }));
            writeBrokerDevices(ownerId, "ios", [{ id: "ios-large", payload: "x".repeat(DEVICE_BROKER_INVENTORY_FILE_LIMIT + 1) }]);

            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.inventory" }),
            });
            expect(response.status).toBe(200);
            const body = await response.json() as {
                ok: boolean;
                result: { backends: Array<{ stateKey: string; devices: unknown[]; truncated?: boolean; error?: string; maxBytes?: number; maxDevices?: number; totalDevices?: number }> };
            };
            expect(body.ok).toBe(true);
            const android = body.result.backends.find((backend) => backend.stateKey === "android");
            expect(android).toEqual(expect.objectContaining({
                truncated: true,
                maxDevices: DEVICE_BROKER_INVENTORY_DEVICE_LIMIT,
                totalDevices: DEVICE_BROKER_INVENTORY_DEVICE_LIMIT + 5,
            }));
            expect(android?.devices).toHaveLength(DEVICE_BROKER_INVENTORY_DEVICE_LIMIT);
            expect(android?.devices[0]).not.toHaveProperty("privateRoot");
            expect(android?.devices[0]).not.toHaveProperty("sshPrivateKeyPath");
            expect(android?.devices[0]).not.toHaveProperty("guestCredentialPath");

            const ios = body.result.backends.find((backend) => backend.stateKey === "ios");
            expect(ios).toEqual(expect.objectContaining({
                truncated: true,
                error: "inventory-file-too-large",
                maxBytes: DEVICE_BROKER_INVENTORY_FILE_LIMIT,
            }));
            expect(ios?.devices).toEqual([]);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

});
