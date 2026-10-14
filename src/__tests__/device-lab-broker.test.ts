import { directorySymlink } from "./helpers/file-symlink-fixture.js";
import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { createHash, createHmac } from "crypto";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import * as nativeFs from "fs";
import { chmodSync, existsSync, linkSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { createServer } from "http";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    boundedBrokerErrorPayload,
    boundedProviderCommandRunnerScript,
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
} from "@ccc/device-lab/device-lab-broker.js";
import { deviceLabOwnerFromProjectMountPath, deviceLabOwnerId, deviceLabProjectMountPath } from "@ccc/device-lab/device-lab-owner.js";
import { HYPER_V_IMAGE_CATALOG } from "@ccc/device-lab/device-lab/hyper-v-images.js";
import { readDeviceRuntimeProcessStartToken } from "@ccc/device-lab/device-lab-process-identity.js";
import { DEVICE_LAB_VERSION } from "@ccc/device-lab/version.js";
import { cleanupOwner, close, listen, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";
import { TOOLS as DEVICE_LAB_MCP_TOOLS } from "../../device-lab-mcp/src/operation-tools.mjs";
import { createHostBackendDiscovery } from "@ccc/device-lab/device-lab/application/broker-observation-discovery.js";
import type { HostBackendDiscoveryConfiguration } from "@ccc/device-lab/device-lab/domain/broker-observation.js";
import type { HostBackendDiscoveryPorts } from "@ccc/device-lab/device-lab/ports/broker-observation.js";

const discoveryConfiguration: HostBackendDiscoveryConfiguration = {
    macosProviders: ["tart", "vz", "utmctl"],
    capabilities: {
        androidEmulator: [], androidDevice: [], iosSimulator: [], iosDevice: [],
        windowsSandbox: [], windowsVm: [], linuxVm: [], macosVm: [],
    },
};
function discoveryCapabilityContracts(ports: HostBackendDiscoveryPorts): void {
    createHostBackendDiscovery(ports, discoveryConfiguration);
    const { hyperVReadiness: _readiness, ...withoutReadiness } = ports;
    // @ts-expect-error Windows discovery requires a bounded readiness observation.
    createHostBackendDiscovery(withoutReadiness, discoveryConfiguration);
    // @ts-expect-error Readiness settles asynchronously through the native command boundary.
    createHostBackendDiscovery({ ...ports, hyperVReadiness: () => null }, discoveryConfiguration);
    // @ts-expect-error Cache metadata inspection must return a settled synchronous observation.
    createHostBackendDiscovery({ ...ports, ubuntuImageCache: async () => ({ state: "acquisition-required" }) }, discoveryConfiguration);
    void _readiness;
}
void discoveryCapabilityContracts;

describe("host discovery platform and budget admission", () => {
    it("does not inspect Windows readiness or the image cache on a non-Windows host", async () => {
        const discover = createHostBackendDiscovery({
            executable: () => "/controlled/tool", hostId: () => "controlled-host",
            hyperVReadiness: () => { throw new Error("unexpected Windows command"); },
            ubuntuImageCache: () => { throw new Error("unexpected Windows cache read"); },
        }, discoveryConfiguration);
        const result = await discover({ ownerId: "owner", platform: "linux", commandTimeoutMs: 5000 });
        expect(result.backends.find((backend) => backend.name === "windows-vm")).toMatchObject({ available: false });
        expect(result.hostId).toBe("controlled-host");
    });

    it.each([[5000, 5000], [30000, 15000]])("bounds Hyper-V readiness to the caller and discovery budgets (%i ms)", async (requested, expected) => {
        let observed = false;
        let cacheOwner: string | null = null;
        const discover = createHostBackendDiscovery({
            executable: (name) => name === "powershell.exe" ? "/controlled/powershell" : null,
            hostId: () => "controlled-host",
            hyperVReadiness: async (executable, timeoutMs) => {
                observed = true;
                expect(executable).toBe("/controlled/powershell");
                expect(timeoutMs).toBe(expected);
                return null;
            },
            ubuntuImageCache: (ownerId) => {
                cacheOwner = ownerId;
                expect(ownerId).toBe("authenticated-owner");
                return { state: "acquisition-required" };
            },
        }, discoveryConfiguration);
        const result = await discover({ ownerId: "authenticated-owner", platform: "win32", commandTimeoutMs: requested });
        expect(observed).toBe(true);
        expect(cacheOwner).toBe("authenticated-owner");
        expect(result.backends.find((backend) => backend.name === "windows-vm")).toMatchObject({ available: false });
    });
});

// Synthetic broker PIDs must never reach native CIM/taskkill on a Windows test host.
function terminateSyntheticBroker(pid: number) {
    if (!vi.isMockFunction(process.kill)) throw new Error("synthetic broker termination requires a signal mock");
    process.kill(pid, "SIGTERM");
    return { ok: true };
}

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

vi.mock("fs", async original => ({ ...await original<typeof import("fs")>() }));

type AuthIdentityFault = "none" | "volume" | "missing-primary-volume" | "missing-volume" | "inode" | "missing-inode" | "zero-inode" | "linked-handle" | "pathname-link" | "pathname-hardlink" | "pathname-swap" | "pathname-volume" | "open-refused";

// Keep real files and descriptors; only reproduce Windows' missing pathname volume
// and hostile identity observations at the fs boundary used by the public broker.
async function windowsAuthIdentityFixture(file: string, fault: AuthIdentityFault = "none") {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const opened: number[] = [], closed: number[] = [], live = new Map<number, number>();
    const reads: number[] = [], openFlags: Array<string | number> = [];
    let readOpens = 0;
    const inode = 9007199254740992n;
    const volume = 574283787n;
    const metadata = (stat: nativeFs.Stats | nativeFs.BigIntStats, changes: Record<string, unknown>) =>
        Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes) as nativeFs.BigIntStats;
    Object.defineProperty(process, "platform", { configurable: true, get: () => "win32" });
    vi.spyOn(nativeFs, "openSync").mockImplementation((path, flags, mode) => {
        const readingAuth = String(path) === file && (flags === "r" || typeof flags === "number" && (flags & (actual.constants.O_WRONLY | actual.constants.O_RDWR)) === actual.constants.O_RDONLY);
        if (readingAuth && ++readOpens % 2 === 0 && fault === "open-refused") {
            throw Object.assign(new Error("fresh auth handle refused"), { code: "EACCES" });
        }
        const fd = actual.openSync(path, flags, mode);
        if (readingAuth) { opened.push(fd); openFlags.push(flags); live.set(fd, readOpens % 2); }
        return fd;
    });
    vi.spyOn(nativeFs, "fstatSync").mockImplementation(((fd: number, options?: { bigint?: boolean }) => {
        const stat = actual.fstatSync(fd, options as { bigint: true });
        if (!live.has(fd)) return stat;
        const second = live.get(fd) === 0;
        return metadata(stat, {
            dev: fault === "missing-primary-volume" ? 0n : second && fault === "volume" ? volume + 1n : second && fault === "missing-volume" ? 0n : volume,
            ino: second && fault === "inode" ? inode + 1n : second && fault === "missing-inode" ? undefined : fault === "zero-inode" ? 0n : inode,
            nlink: second && fault === "linked-handle" ? 2n : 1n,
        });
    }) as typeof nativeFs.fstatSync);
    vi.spyOn(nativeFs, "lstatSync").mockImplementation(((path: nativeFs.PathLike, options?: { bigint?: boolean }) => {
        const stat = actual.lstatSync(path, options as { bigint: true });
        if (String(path) !== file) return stat;
        const fresh = [...live.values()].includes(0);
        return metadata(stat, {
            dev: fresh && fault === "pathname-volume" ? volume + 1n : 0n,
            ino: fresh && fault === "pathname-swap" ? inode + 1n : fault === "zero-inode" ? 0n : inode,
            nlink: fresh && fault === "pathname-hardlink" ? 2n : 1n,
            ...(fresh && fault === "pathname-link" ? { isSymbolicLink: () => true } : {}),
        });
    }) as typeof nativeFs.lstatSync);
    vi.spyOn(nativeFs, "closeSync").mockImplementation(fd => {
        if (live.has(fd)) { closed.push(fd); live.delete(fd); }
        actual.closeSync(fd);
    });
    vi.spyOn(nativeFs, "readSync").mockImplementation(((...args: Parameters<typeof nativeFs.readSync>) => {
        if (live.has(args[0])) reads.push(live.get(args[0])!);
        return actual.readSync(...args);
    }) as typeof nativeFs.readSync);
    return {
        opened, closed, live, reads, openFlags,
        restore: () => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platformDescriptor); },
    };
}

describe("device-lab host broker daemon", () => {
    let originalHomeRestore: (() => void) | undefined;
    let fixtureHome: string | undefined;

    it("advertises one shared protocol without feature version lists", () => {
        const status = deviceBrokerStatus({ ownerId: "1111111111111111" });
        expect(status.protocolVersion).toBe(DEVICE_BROKER_PROTOCOL_VERSION);
        expect(status).not.toHaveProperty("implemented");
        expect(status).not.toHaveProperty("deferred");
    });

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

    it.each([
        ["unrelated saved runtime", {}, true],
        ["unrelated MCP runtime", { savedManager: "device-lab-mcp" }, true],
        ["unknown runtime manager", { savedManager: "unknown-manager" }, false],
        ["same port, different process", { savedPort: 17373 }, false],
        ["same process, different port", { savedPid: 5212 }, false],
        ["MCP same port, different process", { savedManager: "device-lab-mcp", savedPort: 17373 }, false],
        ["MCP same process, different port", { savedManager: "device-lab-mcp", savedPid: 5212 }, false],
        ["MCP missing status generation", { savedManager: "device-lab-mcp", statusToken: "" }, false],
        ["MCP missing command line", { savedManager: "device-lab-mcp", commandLine: "" }, false],
        ["invalid saved port", { savedPort: 0 }, false],
        ["different status generation", { statusToken: "windows:successor" }, false],
        ["missing status generation", { statusToken: "" }, false],
        ["different status PID", { statusPid: 50928 }, false],
        ["missing command line", { commandLine: "" }, false],
        ["untrusted entry", { commandLine: "node C:/foreign/broker-entry.js devices broker serve --port 17373" }, false],
    ] as const)("checks port ownership independently of %s", (_label, overrides, accepted) => {
        const changed = overrides as { savedManager?: string; savedPort?: number; savedPid?: number; statusToken?: string; statusPid?: number; commandLine?: string };
        const cliPath = "C:/ccc/packages/device-lab/dist/broker-entry.js";
        const listener = fakeBrokerPortProcess(5212, changed.commandLine ?? `node ${cliPath} devices broker serve --port 17373`);
        const verified = hostBrokerRuntimeFromPortProcessForTest(
            "1111111111111111", 17373, {}, "win32", () => listener,
            {
                name: "ccc-device-broker", managedBy: changed.savedManager ?? "ccc-host",
                pid: changed.savedPid ?? 50928, port: changed.savedPort ?? 64792,
                processStartToken: "windows:stale-other-broker",
            },
            {
                name: "ccc-device-broker", managedBy: "ccc-host-status",
                pid: changed.statusPid ?? listener.pid, port: 17373,
                processStartToken: changed.statusToken ?? listener.processStartToken,
            }, cliPath,
        );
        if (accepted) expect(verified).toMatchObject({ pid: 5212, port: 17373, processIdentity: listener.processIdentity });
        else expect(verified).toBeNull();
    });

    beforeEach(() => {
        fixtureHome = mkdtempSync(join(tmpdir(), "ccc-device-broker-test-home-"));
        originalHomeRestore = isolateDeviceLabTestEnvironment(fixtureHome);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
        originalHomeRestore?.();
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


    // Container mount registration runs inside the Linux container; native Windows resolves /project as a host path.
    it.skipIf(process.platform === "win32")("preserves a registered host path when the same owner registers from its container mount", () => {
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

    it("refuses a mismatched registration identity before publishing registration or auth", () => {
        const cwd = "/project/broker-owner-registration-mismatch";
        const ownerId = deviceLabOwnerId(cwd);
        expect(() => registerDeviceBrokerOwner(cwd, undefined, "ffffffffffffffff")).toThrow("device-broker-owner-registration-mismatch");
        expect(existsSync(deviceBrokerOwnerRegistrationFile(ownerId))).toBe(false);
        expect(existsSync(deviceBrokerAuthSecretFile(ownerId))).toBe(false);
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
            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: false, error: "invalid-broker-json" }));
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
            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: false, error: "host-broker-incompatible" }));
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
            version: DEVICE_LAB_VERSION,
            host: "127.0.0.1",
            port: 17373,
            url: "http://127.0.0.1:17373",
            mode: "host-broker-daemon",
            lazy: true,
            startupPolicy: expect.stringContaining("host ccc auto-starts"),
            protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
        }));
        expect(status.serviceManager).toEqual(expect.objectContaining({
            actions: ["status"],
            command: expect.arrayContaining(["devices", "broker", "serve"]),
            serviceName: expect.any(String),
        }));
        expect(status.persistence).toEqual(expect.objectContaining({
            durableAcrossContainerRecreation: true,
            environmentVariablesRequired: false,
            root: expect.stringContaining(join(".ccc", "devices")),
            ownerScoped: expect.objectContaining({
                ownerRoot: expect.stringContaining(status.ownerId),
                deviceDefinitions: expect.objectContaining({
                    android: expect.stringContaining(join("owners", status.ownerId, "android", "devices.json")),
                    "ios-device": expect.stringContaining(join("owners", status.ownerId, "ios-device", "devices.json")),
                    macos: expect.stringContaining(join("owners", status.ownerId, "macos", "devices.json")),
                }),
                appiumMetadata: expect.stringContaining("owner device records"),
                recordings: expect.objectContaining({
                    android: expect.stringContaining(join("owners", status.ownerId, "android", "<device-id>", "recordings")),
                    windows: expect.stringContaining(join("owners", status.ownerId, "windows", "<device-id>", "recordings")),
                }),
                images: expect.objectContaining({
                    macosVm: expect.stringContaining("provider-owned VM instances"),
                }),
                snapshots: expect.objectContaining({
                    macosVm: expect.stringContaining("provider clones"),
                }),
            }),
            brokerScoped: expect.objectContaining({
                logsRoot: expect.stringContaining(join(".ccc", "devices", "broker", "logs")),
                runtimeFile: expect.stringContaining(join(".ccc", "devices", "broker", "runtime.json")),
            }),
            hostToolchains: expect.objectContaining({
                ownership: "host-owned",
                appium: expect.stringContaining("PATH/providerPaths"),
                androidSdk: expect.stringContaining("not deleted by owner cleanup"),
                xcode: expect.stringContaining("not deleted by owner cleanup"),
            }),
            cleanupBoundary: expect.objectContaining({
                ownerCleanupMayMutate: expect.arrayContaining([expect.stringContaining(join("owners", status.ownerId))]),
                ownerCleanupPreserves: expect.arrayContaining([
                    expect.stringContaining(join("owners", "<foreign-owner-id>")),
                    expect.stringContaining(join(".ccc", "devices", "broker", "auth")),
                    "host SDKs, Appium packages, Xcode, Windows Sandbox, and VM provider installations",
                ]),
                staleMetadataPolicy: expect.stringContaining("without deleting shared toolchain caches"),
            }),
        }));
        expect(status.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(status.state.ownerRoot).toContain(status.ownerId);
        expect(status.state.locksRoot).toContain(join(".ccc", "devices", "broker", "locks"));
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
        if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
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
        if (process.platform !== "win32") expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    });

    it("keeps the owner token and authenticates RPC with a Windows zero-volume pathname qualified by real handles", async () => {
        const cwd = "/project/broker-windows-auth-identity";
        const ownerId = deviceLabOwnerId(cwd);
        const token = deviceBrokerOwnerToken(ownerId);
        const file = deviceBrokerAuthSecretFile(ownerId);
        const bytes = readFileSync(file, "utf8");
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const identity = await windowsAuthIdentityFixture(file);
        try {
            expect(deviceBrokerOwnerToken(ownerId)).toBe(token);
            expect(deviceBrokerOwnerToken(ownerId)).toBe(token);
            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: JSON.stringify({ method: "broker.echo", params: { identity: "qualified" } }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ ok: true, result: { ownerId, params: { identity: "qualified" } } });
            expect(readFileSync(file, "utf8")).toBe(bytes);
            expect(identity.opened.length).toBeGreaterThanOrEqual(6);
            expect(identity.closed).toHaveLength(identity.opened.length);
            expect(identity.live.size).toBe(0);
            expect(identity.reads.length).toBeGreaterThan(0);
            expect(identity.reads.every(handle => handle === 1)).toBe(true);
            for (const flags of identity.openFlags) {
                expect(typeof flags).toBe("number");
                expect(Number(flags) & (nativeFs.constants.O_WRONLY | nativeFs.constants.O_RDWR)).toBe(0);
                if (nativeFs.constants.O_NOFOLLOW) expect(Number(flags) & nativeFs.constants.O_NOFOLLOW).toBe(nativeFs.constants.O_NOFOLLOW);
            }
        } finally {
            identity.restore();
            await close(server);
        }
    });

    it.each<AuthIdentityFault>([
        "volume", "missing-primary-volume", "missing-volume", "inode", "missing-inode", "zero-inode", "linked-handle", "pathname-link", "pathname-hardlink", "pathname-swap", "pathname-volume", "open-refused",
    ])("refuses authenticated RPC and closes every auth descriptor when Windows identity proof fails: %s", async fault => {
        const cwd = "/project/broker-windows-auth-refusal";
        const ownerId = deviceLabOwnerId(cwd);
        const token = deviceBrokerOwnerToken(ownerId);
        const file = deviceBrokerAuthSecretFile(ownerId);
        const bytes = readFileSync(file, "utf8");
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const identity = await windowsAuthIdentityFixture(file, fault);
        try {
            const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-ccc-device-token": token },
                body: JSON.stringify({ method: "broker.echo", params: { forbidden: true } }),
            });
            expect(response.status).toBe(401);
            expect(await response.json()).toMatchObject({ ok: false, error: "invalid-owner-token" });
            expect(readFileSync(file, "utf8")).toBe(bytes);
            expect(identity.opened.length).toBeGreaterThanOrEqual(1);
            expect(identity.closed).toHaveLength(identity.opened.length);
            expect(identity.live.size).toBe(0);
            if (fault === "missing-primary-volume") {
                expect(identity.opened).toHaveLength(1);
                expect(identity.reads).toEqual([]);
            }
        } finally {
            identity.restore();
            await close(server);
        }
    });

    it.runIf(process.platform === "linux")("qualifies healthy Linux auth using one opened descriptor", async () => {
        const ownerId = "0a0b0c0d0e0f1122";
        const token = deviceBrokerOwnerToken(ownerId);
        const file = deviceBrokerAuthSecretFile(ownerId);
        const actual = await vi.importActual<typeof import("fs")>("fs");
        const opened: number[] = [], closed: number[] = [];
        vi.spyOn(nativeFs, "openSync").mockImplementation((path, flags, mode) => {
            const fd = actual.openSync(path, flags, mode);
            if (String(path) === file) opened.push(fd);
            return fd;
        });
        vi.spyOn(nativeFs, "closeSync").mockImplementation(fd => { closed.push(fd); actual.closeSync(fd); });
        expect(deviceBrokerOwnerToken(ownerId)).toBe(token);
        expect(opened).toHaveLength(1);
        expect(closed).toContain(opened[0]);
    });

    it.runIf(process.platform !== "win32").each(["writerless-fifo", "regular-to-fifo"] as const)(
        "promptly refuses authenticated broker RPC with an unreadable special credential: %s", async scenario => {
            const brokerSource = pathToFileURL(resolve("packages/device-lab/src/device-lab-broker.ts")).href;
            const environmentHelper = pathToFileURL(resolve("src/__tests__/helpers/device-lab-test-environment.ts")).href;
            const program = `
import * as fs from 'node:fs';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import {join,dirname} from 'node:path';
import {isolateDeviceLabTestEnvironment} from ${JSON.stringify(environmentHelper)};
const phase = name => console.error(JSON.stringify({phase:name,at:Date.now()}));
phase('before-broker-import');
const {createDeviceBrokerServer,deviceBrokerOwnerToken,deviceBrokerAuthSecretFile} = await import(${JSON.stringify(brokerSource)});
phase('after-broker-import');
const home = ${JSON.stringify(fixtureHome)}, scenario = ${JSON.stringify(scenario)};
const restore = isolateDeviceLabTestEnvironment(home);
const owner = ${JSON.stringify(deviceLabOwnerId(process.cwd()))}, token = deviceBrokerOwnerToken(owner), file = deviceBrokerAuthSecretFile(owner);
const mutableFs = createRequire(import.meta.url)('node:fs');
const originalOpen = mutableFs.openSync, originalClose = mutableFs.closeSync, originalRead = mutableFs.readSync;
const live = new Set();
let opened = 0, closed = 0, reads = 0, providerCalls = 0, swapped = false;
const server = createDeviceBrokerServer({ownerId:owner,host:'127.0.0.1',port:0,commandRunner(){providerCalls++;throw new Error('unexpected provider effect');}});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
phase('after-server-listen');
process.send({ready:true});
function makeFifo() {
 fs.rmSync(file);
 const result = spawnSync('mkfifo', [file], {encoding:'utf8',timeout:1000});
 if (result.status !== 0) throw new Error(result.stderr || 'mkfifo failed');
}
if (scenario === 'writerless-fifo') makeFifo();
mutableFs.openSync = function(path, ...args) {
 if (String(path) === file && scenario === 'regular-to-fifo' && !swapped) {swapped=true;makeFifo();}
 const fd = originalOpen(path, ...args);
 if (String(path) === file) {opened++;live.add(fd);}
 return fd;
};
mutableFs.readSync = function(fd,...args) {if(live.has(fd)) reads++;return originalRead(fd,...args);};
mutableFs.closeSync = function(fd) {if(live.delete(fd)) closed++;return originalClose(fd);};
syncBuiltinESMExports();
const entries = fs.readdirSync(dirname(file)).sort();
try {
 const response = await fetch('http://127.0.0.1:'+server.address().port+'/v1/owners/'+owner+'/rpc', {
  method:'POST',headers:{'content-type':'application/json','x-ccc-device-token':token},
  body:JSON.stringify({method:'broker.echo',params:{mustRefuse:true}})
 });
 const body = await response.json();
 phase('after-http-refusal');
 console.log(JSON.stringify({status:response.status,body,fifo:fs.lstatSync(file).isFIFO(),
  opened,closed,reads,live:live.size,providerCalls,swapped,entriesUnchanged:JSON.stringify(entries)===JSON.stringify(fs.readdirSync(dirname(file)).sort())}));
} finally {
 await new Promise(resolve => server.close(resolve));
 phase('after-server-close');
 restore();
 process.disconnect();
}
`;
            // Importing the full TS broker can take longer than the security
            // deadline. Start the five-second watchdog once the owned child is
            // ready, before it creates or opens either real FIFO scenario.
            const completed = await new Promise<{ code: number | null; output: string; diagnostics: string; timeout: string | null }>((resolveChild, reject) => {
                const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
                    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"],
                });
                let output = "", diagnostics = "", timeout: string | null = null;
                let timer = setTimeout(() => { timeout = "startup"; child.kill("SIGKILL"); }, 20_000);
                child.stdout!.on("data", chunk => { output += chunk.toString(); });
                child.stderr!.on("data", chunk => { diagnostics += chunk.toString(); });
                child.on("message", message => {
                    if (message && typeof message === "object" && "ready" in message && message.ready === true) {
                        clearTimeout(timer);
                        timer = setTimeout(() => { timeout = "FIFO admission"; child.kill("SIGKILL"); }, 5000);
                    }
                });
                child.on("error", error => { clearTimeout(timer); reject(error); });
                child.on("close", code => { clearTimeout(timer); resolveChild({ code, output, diagnostics, timeout }); });
            });
            expect(completed.timeout, completed.diagnostics).toBeNull();
            expect(completed.code, completed.diagnostics).toBe(0);
            const result = JSON.parse(completed.output.trim());
            expect(result).toMatchObject({
                status: 401, body: { ok: false, error: "invalid-owner-token" },
                fifo: true, opened: scenario === "regular-to-fifo" ? 1 : 0,
                closed: scenario === "regular-to-fifo" ? 1 : 0, reads: 0, live: 0,
                providerCalls: 0, swapped: scenario === "regular-to-fifo", entriesUnchanged: true,
            });
        },
    );

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

    it("retains quarantined invalid auth evidence and the primary publication fault", () => {
        const ownerId = "0a0b0c0d0e0f1112", file = deviceBrokerAuthSecretFile(ownerId);
        const invalid = JSON.stringify({ ownerId: "ffffffffffffffff", secret: "a".repeat(64), version: 1 });
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, invalid);
        const fault = Object.assign(new Error("auth publication failed"), { code: "EIO" });
        const nativeRename = nativeFs.renameSync;
        vi.spyOn(nativeFs, "renameSync").mockImplementation((source, destination) => {
            if (String(destination) === file && String(source).endsWith(".tmp")) throw fault;
            return nativeRename(source, destination);
        });
        let caught: unknown;
        try { deviceBrokerOwnerToken(ownerId); } catch (error) { caught = error; }
        expect(caught).toBe(fault);
        expect(existsSync(file)).toBe(false);
        expect(existsSync(`${file}.lock`)).toBe(false);
        const entries = readdirSync(dirname(file));
        const quarantines = entries.filter(name => name.startsWith(`${ownerId}.json.`) && name.endsWith(".invalid"));
        expect(quarantines).toHaveLength(1);
        expect(readFileSync(join(dirname(file), quarantines[0]), "utf8")).toBe(invalid);
        expect(entries.some(name => name.endsWith(".tmp"))).toBe(false);
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
        directorySymlink(externalDirectory, authDirectory);

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
                "powershell.exe": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                "ssh.exe": "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
                "scp.exe": "C:\\Windows\\System32\\OpenSSH\\scp.exe",
            },
            commandRunner: vi.fn((command) => ({
                ...command,
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    available: true,
                    platform: "win32",
                    moduleAvailable: true,
                    hypervisorPresent: true,
                    vmmsRunning: true,
                    rebootPending: false,
                    totalMemoryMb: 32768,
                    freeMemoryMb: 16384,
                    logicalProcessors: 16,
                    missing: [],
                    qemuImgAvailable: false,
                    qemuImgTrusted: false,
                    linuxImageMissing: ["hyper-v-qemu-img-unavailable"],
                }),
                stderr: "",
            })),
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
            // Internal host diagnostics also expose native provider operation names.
            const acceptedToolNames = new Set([...DEVICE_LAB_MCP_TOOLS.map((tool) => tool.name),
                "device_drag", "mobile_install_app", "mobile_launch_app", "mobile_screenshot", "mobile_rotate_left", "mobile_rotate_right"]);
            for (const backend of body.result.backends) {
                expect((backend.capabilities || []).filter((capability) => !acceptedToolNames.has(capability))).toEqual([]);
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
            expect(body.result.backends.find((backend) => backend.name === "windows-vm")).toEqual(expect.objectContaining({
                available: true,
                missing: [],
            }));
            expect(body.result.backends.find((backend) => backend.name === "linux-vm")).toEqual(expect.objectContaining({
                available: false,
                missing: ["hyper-v-qemu-img-unavailable"],
                baseImage: { state: "acquisition-required", source: null },
                imageAcquisition: { available: false, missing: ["hyper-v-qemu-img-unavailable"] },
            }));
            expect(body.result.backends.find((backend) => backend.name === "macos-vm")).toEqual(expect.objectContaining({
                available: false,
                missing: ["macos-host"],
            }));
        } finally {
            await close(server);
        }
    });

    describe("Hyper-V linux-vm readiness against the ubuntu-lts image cache", () => {
        const cachedImage = Buffer.from("cached-ubuntu-lts-image");
        let originalUserProfile: string | undefined;

        // These write a cache under homedir(), and the broker reads its private root from there.
        // os.homedir() follows USERPROFILE rather than HOME on Windows, so point both at the temp
        // home; otherwise a Windows run would overwrite the operator's real ubuntu-lts cache.
        beforeEach(() => {
            originalUserProfile = process.env.USERPROFILE;
            process.env.USERPROFILE = process.env.HOME;
            expect(homedir()).toBe(process.env.HOME);
            expect(homedir()).toContain("ccc-device-broker-test-home-");
        });

        afterEach(() => {
            if (originalUserProfile === undefined) delete process.env.USERPROFILE;
            else process.env.USERPROFILE = originalUserProfile;
        });

        function writeUbuntuCache(profileRoot: string, userProvided = false) {
            const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
            mkdirSync(profileRoot, { recursive: true });
            writeFileSync(join(profileRoot, "base.vhdx"), cachedImage);
            writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
                version: 3,
                profile: "ubuntu-lts",
                catalogId: userProvided ? "user-provided-vhdx" : catalog.catalogId,
                sourceUrl: userProvided ? null : catalog.sourceUrl,
                sourceFormat: userProvided ? "vhdx" : catalog.sourceFormat,
                sourceSha256: userProvided ? null : catalog.sourceSha256,
                licenseId: userProvided ? null : catalog.licenseId,
                generation: catalog.generation,
                secureBootTemplate: catalog.secureBootTemplate,
                preparationVersion: 1,
                imagePath: join(profileRoot, "base.vhdx"),
                sha256: createHash("sha256").update(cachedImage).digest("hex"),
                sizeBytes: cachedImage.length,
                virtualSizeBytes: catalog.virtualSizeBytes,
                vhdType: "Dynamic",
                preparedAt: new Date().toISOString(),
            }));
        }

        async function linuxVmBackend(cwd: string, readiness: Record<string, unknown>) {
            const ownerId = deviceLabOwnerId(cwd);
            const server = createDeviceBrokerServer({
                cwd,
                host: "127.0.0.1",
                port: 0,
                platform: "win32",
                providerPaths: {
                    "powershell.exe": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                    "ssh.exe": "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
                    "scp.exe": "C:\\Windows\\System32\\OpenSSH\\scp.exe",
                },
                commandRunner: vi.fn((command) => ({
                    ...command,
                    status: 0,
                    stdout: JSON.stringify({
                        ok: true,
                        available: true,
                        platform: "win32",
                        moduleAvailable: true,
                        hypervisorPresent: true,
                        vmmsRunning: true,
                        rebootPending: false,
                        totalMemoryMb: 32768,
                        freeMemoryMb: 16384,
                        logicalProcessors: 16,
                        missing: [],
                        ...readiness,
                    }),
                    stderr: "",
                })),
            });
            try {
                const baseUrl = await listen(server);
                const response = await fetch(`${baseUrl}/v1/owners/${ownerId}/rpc`, {
                    method: "POST",
                    headers: ownerRpcHeaders(ownerId),
                    body: JSON.stringify({ ownerId, method: "broker.backends", params: {} }),
                });
                expect(response.status).toBe(200);
                const body = await response.json() as { result: { backends: Array<Record<string, any>> } };
                return body.result.backends.find((backend) => backend.name === "linux-vm");
            } finally {
                await close(server);
            }
        }

        const untrustedQemuImg = {
            qemuImgAvailable: true,
            qemuImgTrusted: false,
            qemuImgSignatureStatus: "NotSigned",
            linuxImageMissing: ["hyper-v-qemu-img-untrusted"],
        };

        it("reports linux-vm available on a cached image with untrusted qemu-img as an acquisition advisory", async () => {
            writeUbuntuCache(join(homedir(), ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts"));

            const linuxVm = await linuxVmBackend("/project/broker-linux-cache-test", untrustedQemuImg);

            expect(linuxVm).toEqual(expect.objectContaining({
                available: true,
                status: "available",
                missing: [],
                baseImage: { state: "valid", source: "global" },
                imageAcquisition: { available: false, missing: ["hyper-v-qemu-img-untrusted"] },
                readiness: expect.objectContaining({
                    qemuImgTrusted: false,
                    qemuImgSignatureStatus: "NotSigned",
                    linuxImageMissing: ["hyper-v-qemu-img-untrusted"],
                }),
            }));
        });

        it("reads the owner cache of the authenticated owner, as create does", async () => {
            const cwd = "/project/broker-linux-owner-cache-test";
            writeUbuntuCache(join(homedir(), ".ccc", "device-broker-private", "owners", deviceLabOwnerId(cwd), "images", "hyper-v", "ubuntu-lts"), true);

            expect(await linuxVmBackend(cwd, { qemuImgAvailable: false, qemuImgTrusted: false, linuxImageMissing: ["hyper-v-qemu-img-unavailable"] })).toEqual(expect.objectContaining({
                available: true,
                missing: [],
                baseImage: { state: "valid", source: "owner" },
                imageAcquisition: { available: false, missing: ["hyper-v-qemu-img-unavailable"] },
            }));
            // Another owner's imported image is not this owner's cache.
            expect(await linuxVmBackend("/project/broker-linux-other-owner-test", untrustedQemuImg)).toEqual(expect.objectContaining({
                available: false,
                missing: ["hyper-v-qemu-img-untrusted"],
                baseImage: { state: "acquisition-required", source: null },
            }));
        });

        it("blocks linux-vm on a cache conflict even when qemu-img is trusted", async () => {
            const profileRoot = join(homedir(), ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
            mkdirSync(profileRoot, { recursive: true });
            writeFileSync(join(profileRoot, "base.vhdx"), cachedImage);

            expect(await linuxVmBackend("/project/broker-linux-conflict-test", {
                qemuImgAvailable: true,
                qemuImgTrusted: true,
                qemuImgSignatureStatus: "Valid",
                linuxImageMissing: [],
            })).toEqual(expect.objectContaining({
                available: false,
                status: "missing-prerequisites",
                missing: ["hyper-v-base-image-unmanaged-existing"],
                baseImage: { state: "conflict", source: null },
                imageAcquisition: { available: true, missing: [] },
            }));
        });
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
            // Android reset remains a private app-data delegate behind public clear_app_data.
            const privateTools = ["android-emulator", "android-device"].includes(backend.backend) ? ["device_reset"] : [];
            expect(backend.supportedTools.filter((tool) => !backend.capabilities.includes(tool))).toEqual(privateTools);
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
            const statusPayload = await status.json() as { ok: boolean; broker: { ownerId: string; version: string; process: { pid: number }; protocolVersion: number } };
            expect(statusPayload.ok).toBe(true);
            expect(statusPayload.broker.ownerId).toMatch(/^[a-f0-9]{16}$/);
            expect(statusPayload.broker.version).toBe(DEVICE_LAB_VERSION);
            expect(statusPayload.broker.process.pid).toBe(process.pid);

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


    // The operator's report was "파워쉘 너무 많이 켜졌다꺼졌다" during
    // `Preparing device broker...`. On Windows each of these two readers is its own
    // synchronous `powershell.exe`, and the old loop called BOTH, every 25ms, twenty times —
    // up to forty processes in half a second, half of them fetching a start token the
    // identity probe had already returned in the same JSON. The assertion is therefore on the
    // COUNT, because the count is the defect; the values were always correct.
    it("does not launch a second identity probe for a value the first already returned", async () => {
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 51515;
        child.unref = vi.fn();
        let identityReads = 0;
        let startTokenReads = 0;

        const result = await ensureHostDeviceBroker({
            ownerId: "cdcdcdcdcdcdcdcd",
            cwd: "/project/broker-probe-count-test",
            port: 0,
            timeoutMs: 1,
            startupTimeoutMs: 1,
            cliPath: "/opt/ccc/dist/index.js",
            spawnImpl: vi.fn(() => child) as any,
            processIdentityReader: (pid) => {
                identityReads += 1;
                return { pid, startToken: "windows:2026-09-11T00:00:00.0000000Z", commandHash: "abc" };
            },
            processStartTokenReader: () => {
                startTokenReads += 1;
                return "windows:2026-09-11T00:00:00.0000000Z";
            },
        });

        expect(result.ok, "this fixture cannot reach a ready broker; the counts are the point")
            .not.toBe(true);
        // One identity read answers both questions, so the standalone token reader is never
        // needed on the startup path. It stays in the code for the case identity cannot be
        // formed at all — a readable start token with an unreadable command line.
        expect(startTokenReads, "the start token comes from the identity it is already in")
            .toBe(0);
        // And identity is read twice for reasons that are both deliberate: once on the startup
        // path to capture what was spawned, once afterwards — because this fixture's broker
        // never becomes ready — to re-read the CURRENT identity and decide whether the pid is
        // still that process. The second is a fresh observation by design and must not be
        // served from the first. What the old loop did instead was read it up to twenty times
        // before either of those.
        expect(identityReads, "one capture plus one deliberate re-read, not a poll").toBe(2);
    });

    // Identity that arrives LATE, which is the only path where the loop's own derivation runs
    // — the pre-loop assignment covers the ordinary case and short-circuits the rest, so a
    // mutation to the loop line survived the test above. Measured, not assumed: I reverted the
    // loop line and that test stayed green.
    it("derives the start token from a late identity too, without a second probe", async () => {
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 51517;
        child.unref = vi.fn();
        let identityReads = 0;
        let startTokenReads = 0;

        await ensureHostDeviceBroker({
            ownerId: "cdcdcdcdcdcdcdcf",
            cwd: "/project/broker-late-identity-test",
            port: 0,
            timeoutMs: 1,
            startupTimeoutMs: 1,
            cliPath: "/opt/ccc/dist/index.js",
            spawnImpl: vi.fn(() => child) as any,
            processIdentityReader: (pid) => {
                identityReads += 1;
                // Nothing on the first look, as when the process has not been registered yet.
                return identityReads === 1
                    ? null
                    : { pid, startToken: "windows:2026-09-11T00:00:00.0000000Z", commandHash: "abc" };
            },
            processStartTokenReader: () => {
                startTokenReads += 1;
                // Null on the first look too, so the pre-loop assignment cannot satisfy the
                // token and short-circuit the loop. This is the ONLY shape that reaches the
                // loop's own derivation: without it a mutation to that line survives, which I
                // measured twice before getting the fixture right.
                return startTokenReads === 1 ? null : "windows:2026-09-11T00:00:00.0000000Z";
            },
        });
        // One read: the pre-loop attempt, which returned null. The loop then found identity
        // and took the token from it rather than asking again.
        expect(startTokenReads, "one failed pre-loop attempt, then identity answered it").toBe(1);
        expect(identityReads, "the loop probed once more and that answered both").toBeGreaterThan(1);
    });

    // The regression this pins, measured by review: bounding the retries by WALL CLOCK charges
    // each probe's own cost against the retry budget, and these probes are synchronous
    // powershell launches. At a 400ms probe the loop body ran zero times — on exactly the
    // loaded Windows host the retries exist for, where WMI fails transiently and losing the
    // retry means no identity, an unverifiable launch, and a healthy broker killed.
    it("keeps retrying when each probe is slow, which is when retries matter", async () => {
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 51518;
        child.unref = vi.fn();
        let identityReads = 0;

        await ensureHostDeviceBroker({
            ownerId: "cdcdcdcdcdcdcdd0",
            cwd: "/project/broker-slow-probe-test",
            port: 0,
            timeoutMs: 1,
            startupTimeoutMs: 1,
            cliPath: "/opt/ccc/dist/index.js",
            spawnImpl: vi.fn(() => child) as any,
            processIdentityReader: () => {
                identityReads += 1;
                // Burn the whole sleep budget in one probe, as a cold powershell.exe running
                // `Get-CimInstance Win32_Process` does on a loaded host.
                const until = Date.now() + 520;
                while (Date.now() < until) { /* deliberate synchronous stall */ }
                return null;
            },
            processStartTokenReader: () => null,
        });

        // One capture, then the loop's own attempts, then the one deliberate re-read on the
        // failure path. The point is that the loop ran at all: with the wall-clock bound this
        // was 2 — the capture and the re-read, with nothing in between.
        expect(identityReads, "a slow probe must not consume the retries").toBeGreaterThan(3);
    }, 20_000);

    // When identity genuinely cannot be formed, the separate reader is still used — the
    // saving must not cost the fallback.
    it("still reads the start token separately when no identity can be formed", async () => {
        const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 51516;
        child.unref = vi.fn();
        let startTokenReads = 0;

        await ensureHostDeviceBroker({
            ownerId: "cdcdcdcdcdcdcdce",
            cwd: "/project/broker-probe-fallback-test",
            port: 0,
            timeoutMs: 1,
            startupTimeoutMs: 1,
            cliPath: "/opt/ccc/dist/index.js",
            spawnImpl: vi.fn(() => child) as any,
            processIdentityReader: () => null,
            processStartTokenReader: () => {
                startTokenReads += 1;
                return "windows:2026-09-11T00:00:00.0000000Z";
            },
        });

        expect(startTokenReads, "the fallback is still there when identity is unavailable")
            .toBeGreaterThan(0);
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
                timeoutMs: 10000,
                cwd: "/project/broker-auto-reuse-test",
                bindHost: "127.0.0.1",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                portProcessResolver: () => fakeBrokerPortProcess(process.pid, `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`),
                spawnImpl: spawnImpl as any,
            });

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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
                timeoutMs: 10000,
                terminateProcess: terminateSyntheticBroker,
                cwd,
                bindHost: "127.0.0.1",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                startupTimeoutMs: 1,
                spawnImpl: vi.fn() as any,
                portProcessResolver: () => fakeBrokerPortProcess(process.pid, `evil.exe node /opt/ccc/dist/index.js devices broker serve --port ${port}`),
            });

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: false, error: "host-broker-incompatible", reused: false }));
            expect(JSON.stringify(result)).toContain("compatible-broker-process-unverified");
            expect(killSpy).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
        } finally {
            killSpy.mockRestore();
            await close(server);
        }
    });

    it("reuses the shared host runtime port across project owners", async () => {
        const cwd = "/project/broker-auto-runtime-port-test";
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
                timeoutMs: 10000,
                cwd,
                bindHost: "127.0.0.1",
                probeHost: "127.0.0.1",
                cliPath: "/opt/ccc/dist/index.js",
                portProcessResolver: () => fakeBrokerPortProcess(process.pid, `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`),
                spawnImpl: spawnImpl as any,
            });

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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
                terminateProcess: terminateSyntheticBroker,
                ownerId,
                cwd,
                bindHost: "0.0.0.0",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                timeoutMs: 10000,
                startupTimeoutMs: 1,
                spawnImpl: spawnImpl as any,
                portProcessResolver: () => fakeBrokerPortProcess(existingPid, `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`),
            });

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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

    it.each([undefined, 0, 1, 4])("replaces an identity-verified broker with stale protocol %s", async (staleProtocol) => {
        const ownerId = "2222222222222222";
        const currentProtocol = DEVICE_BROKER_PROTOCOL_VERSION;
        const stalePid = 43210;
        const staleProcess = fakeBrokerPortProcess(stalePid, `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1`);
        const staleStartedAt = "2026-07-27T00:00:00.000Z";
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
                        version: DEVICE_LAB_VERSION,
                        process: { pid: stalePid, startToken: staleProcess.processStartToken },
                        startedAt: staleStartedAt,
                        protocolVersion: staleProtocol,
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
                        version: DEVICE_LAB_VERSION,
                        process: { pid: 54321, startToken: "test:54321" },
                        startedAt: "2026-07-28T00:00:00.000Z",
                        protocolVersion: currentProtocol,
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
                terminateProcess: terminateSyntheticBroker,
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

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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
                attempt !== null
                && typeof attempt === "object"
                && "compatible" in attempt
                && attempt.compatible === false
                && "protocolVersion" in attempt
            );
            expect(attempts).toContain("runtime-incompatible-contract");
            expect(attempts).toContain('"versionCompatible":false');
            expect(incompatibleStatus).toEqual(expect.objectContaining({
                protocolVersion: staleProtocol ?? null,
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
        const protocolVersion = DEVICE_BROKER_PROTOCOL_VERSION;
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
                        version: DEVICE_LAB_VERSION,
                        process: { pid: stalePid, startToken: staleProcess.processStartToken },
                        startedAt: staleStartedAt,
                        protocolVersion,
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
                        version: DEVICE_LAB_VERSION,
                        process: { pid: 13579, startToken: "test:13579" },
                        startedAt: "2026-07-28T00:00:00.000Z",
                        protocolVersion,
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
                terminateProcess: terminateSyntheticBroker,
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

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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
        const protocolVersion = DEVICE_BROKER_PROTOCOL_VERSION;
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
                        version: DEVICE_LAB_VERSION,
                        process: { pid: stalePid, startToken: staleProcess.processStartToken },
                        startedAt: staleStartedAt,
                        protocolVersion,
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
                        version: DEVICE_LAB_VERSION,
                        process: { pid: 86420, startToken: "test:86420" },
                        startedAt: "2026-07-28T00:00:00.000Z",
                        protocolVersion,
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
                terminateProcess: terminateSyntheticBroker,
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

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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
        const incompatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, broker: { ownerId, version: "1.1.61", protocolVersion: 0 } }));
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

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
                ok: false,
                launched: false,
                reused: false,
                error: "host-broker-incompatible",
                diagnostics: expect.arrayContaining([
                    `existing broker protocol 0 does not match required protocol ${DEVICE_BROKER_PROTOCOL_VERSION}`,
                    "existing broker does not support the current owner-resolve POST contract",
                    "existing broker port owner could not be verified as the current CCC broker process",
                ]),
            }));
            expect(spawnImpl).not.toHaveBeenCalled();
        } finally {
            await new Promise<void>((resolve) => incompatible.listening ? incompatible.close(() => resolve()) : resolve());
        }
    });

    it.each([
        ["trusted legacy entry", "/opt/ccc/dist/index.js", true],
        ["foreign legacy-looking entry", "/foreign/ccc/dist/index.js", false],
    ] as const)("migrates protocol 1 only from an exact allowed path: %s", async (_label, legacyEntry, allowed) => {
        const ownerId = "eeeeeeeeeeeeeeee";
        const stalePid = 22334;
        const protocolVersion = DEVICE_BROKER_PROTOCOL_VERSION;
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
                        protocolVersion: 1,
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
                        version: DEVICE_LAB_VERSION,
                        protocolVersion,
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
        const spawnedProcess = fakeBrokerPortProcess(child.pid, `node /opt/ccc/dist/packages/device-lab/dist/broker-entry.js devices broker serve --host 0.0.0.0 --port ${port}`);
        const portProcessResolver = vi.fn(() => stopped ? spawnedProcess : fakeBrokerPortProcess(
            stalePid,
            `node ${legacyEntry} devices broker serve --host 127.0.0.1 --port ${port}`,
        ));
        try {
            const result = await ensureHostDeviceBroker({
                terminateProcess: terminateSyntheticBroker,
                ownerId,
                cwd: "/project/broker-port-pid-repair-test",
                bindHost: "0.0.0.0",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/packages/device-lab/dist/broker-entry.js",
                trustedCliPaths: ["/opt/ccc/dist/index.js"],
                timeoutMs: 500,
                startupTimeoutMs: 3000,
                spawnImpl: spawnImpl as any,
                portProcessResolver,
                processIdentityReader: (pid) => pid === child.pid ? spawnedProcess.processIdentity : null,
                processStartTokenReader: (pid) => pid === child.pid ? spawnedProcess.processStartToken : null,
            });

            if (!allowed) {
                expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: false, launched: false, error: "host-broker-incompatible" }));
                expect(killSpy.mock.calls.some(([, signal]) => signal === "SIGTERM" || signal === "SIGKILL")).toBe(false);
                expect(spawnImpl).not.toHaveBeenCalled();
                return;
            }
            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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

    it.each(["hidden command line", "unrelated saved runtime", "unrelated MCP runtime"])("repairs an older broker with %s", async (scenario) => {
        const unrelatedRuntime = scenario !== "hidden command line";
        const ownerId = "edededededededed";
        const stalePid = 22335;
        const staleStartedAt = "2026-07-27T00:00:00.000Z";
        const staleProcessStartToken = `test:${stalePid}`;
        const protocolVersion = DEVICE_BROKER_PROTOCOL_VERSION - 1;
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
                        version: DEVICE_LAB_VERSION,
                        protocolVersion,
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
                        version: DEVICE_LAB_VERSION,
                        process: { pid: 44557, startToken: "test:44557" },
                        startedAt: "2026-07-28T00:00:00.000Z",
                        protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
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
            managedBy: scenario === "unrelated MCP runtime" ? "device-lab-mcp" : "ccc-host",
            ownerId,
            pid: stalePid,
            host: "127.0.0.1",
            port,
            startedAt: staleStartedAt,
            processStartToken: staleProcessStartToken,
            ...(unrelatedRuntime ? { pid: 50928, port: port === 64792 ? 64793 : 64792, processStartToken: "test:50928" } : {}),
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
                terminateProcess: terminateSyntheticBroker,
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
                    ...fakeBrokerPortProcess(stalePid, unrelatedRuntime ? `node /opt/ccc/dist/index.js devices broker serve --port ${port}` : null),
                    processStartToken: staleProcessStartToken,
                },
                processIdentityReader: (pid) => pid === child.pid ? spawnedProcess.processIdentity : null,
                processStartTokenReader: (pid) => pid === child.pid
                    ? spawnedProcess.processStartToken
                    : pid === stalePid
                        ? staleProcessStartToken
                        : null,
            });

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: true, launched: true, reused: false, port }));
            expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
            expect(killSpy.mock.calls.filter(([, signal]) => signal === "SIGTERM" || signal === "SIGKILL")).toEqual([[stalePid, "SIGTERM"]]);
            expect(JSON.stringify(result.attempts)).toContain(unrelatedRuntime ? "port-command-line" : "port-pid-plus-runtime-and-status");
            expect(JSON.parse(readFileSync(runtimeFile, "utf8"))).toMatchObject({ pid: child.pid, port });
        } finally {
            killSpy.mockRestore();
            await new Promise<void>((resolve) => incompatible.listening ? incompatible.close(() => resolve()) : resolve());
            await new Promise<void>((resolve) => compatible.listening ? compatible.close(() => resolve()) : resolve());
        }
    });

    it("does not trust status or persisted PIDs when the port process is unrelated", async () => {
        const ownerId = "ffffffffffffffff";
        const incompatible = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                const port = (incompatible.address() as { port: number }).port;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, broker: { name: "ccc-device-broker", mode: "host-broker-daemon", ownerId, port, process: { pid: 77889, startToken: "test:77889" }, version: "1.1.61", protocolVersion: 0 } }));
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
                terminateProcess: terminateSyntheticBroker,
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

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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
        const protocolVersion = DEVICE_BROKER_PROTOCOL_VERSION;
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
                        protocolVersion: 0,
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
                        version: DEVICE_LAB_VERSION,
                        protocolVersion,
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
                terminateProcess: terminateSyntheticBroker,
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

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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

            expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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

        expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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
        expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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

    it("reports provider output-limit termination as an explicit bounded signal", async () => {
        const result = await defaultProviderCommandRunnerAsync({
            mode: "exec",
            provider: "test-output-limit-provider",
            executable: process.execPath,
            args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        }, { timeoutMs: 1000, outputLimit: 128 });

        expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
            outputLimitExceeded: true,
            error: expect.stringContaining("spawn ENOBUFS: device-lab provider output exceeded limit"),
        }));
        expect(Buffer.byteLength(result.stdout || "", "utf8")).toBeLessThanOrEqual(128);
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
            terminateProcess: terminateSyntheticBroker,
            cwd: "/project/broker-unresponsive-port-test",
            platform: "linux",
            port: 65531,
            cliPath: "/opt/ccc/dist/index.js",
            timeoutMs: 1,
            startupTimeoutMs: 1,
            portProcessResolver: () => fakeBrokerPortProcess(stalePid, "node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port 65531"),
            spawnImpl: spawnImpl as any,
        });

        expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: false, launched: true, error: "host-broker-health-timeout" }));
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

        const terminateProcess = vi.fn(terminateSyntheticBroker);
        const result = await ensureHostDeviceBroker({
            terminateProcess,
            cwd: "/project/broker-reused-pid-test",
            platform: "linux",
            port: 65530,
            cliPath: "/opt/ccc/dist/index.js",
            timeoutMs: 1,
            startupTimeoutMs: 1,
            portProcessResolver,
            spawnImpl: vi.fn() as any,
        });

        expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: false, launched: false, error: "host-broker-incompatible" }));
        expect(JSON.stringify(result.attempts)).toContain("runtime-process-identity-mismatch");
        expect(terminateProcess).not.toHaveBeenCalled();
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
        directorySymlink(externalDirectory, logsDirectory);
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

        expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({
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
            const statusBody = await status.json() as { ok: boolean; result: { ownerId: string; state: { ownerRoot: string }; protocolVersion: number } };
            expect(statusBody.ok).toBe(true);
            expect(statusBody.result.ownerId).toBe(ownerId);
            expect(statusBody.result.state.ownerRoot).toContain(ownerId);
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
            if (process.platform !== "win32") expect(statSync(secretFile).mode & 0o777).toBe(0o600);

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
        const foreignCwd = resolve("/host/projects/foreign-project");
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
                    projectId: foreignMountPath.slice("/project/".length),
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
        const foreignCwd = resolve("/host/projects/foreign-project");
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
            expect(translatedLocalPath).toBe(join(foreignCwd, "fixtures", "app.apk"));
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

        // Resolve provisions this initially absent test-owned secret. Do not
        // discover a real container's conventional isolated credential mount.
        env.CCC_DEVICE_BROKER_AUTH_FILE = secretFile;
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
            if (process.platform !== "win32") expect(statSync(secretFile).mode & 0o777).toBe(0o600);
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
