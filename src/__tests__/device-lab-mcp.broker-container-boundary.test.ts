import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    inspectLocalLoopbackListenerForTest,
    reusableBrokerProcessVerificationForTest,
    verifyAuthenticatedBrokerGenerationForTest,
} from "../../device-lab-mcp/src/broker.mjs";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { normalizePublicToolArgs } from "../../device-lab-mcp/src/tool-arguments.mjs";

// The runtime a Windows host CLI writes into the shared ~/.ccc/devices mount (trimmed).
const hostRuntime = {
    name: "ccc-device-broker",
    managedBy: "ccc-host",
    pid: 32364,
    host: "127.0.0.1",
    port: 17373,
    platform: "win32",
    startedAt: "2026-09-25T22:26:52.288Z",
    processStartToken: "windows:2026-09-25T22:26:52.1854106Z",
};

const production = { nodeEnv: "production", testEscape: "0" };
const absent = { state: "absent", port: 17373 };
const outsidePidNamespace = { state: "outside-pid-namespace", port: 17373, inodes: ["55555"] };
const visibleOwner = { state: "visible-owner", port: 17373, pid: 77, inodes: ["55555"] };

describe("loopback-forwarded host broker at a container boundary", () => {
    it("accepts a forwarded loopback broker when no listener for the port exists in the container", () => {
        const processVerifier = vi.fn(() => null);
        const localListenerInspector = vi.fn(() => absent);

        expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", {
            ...production,
            containerBoundary: true,
            processVerifier,
            localListenerInspector,
        })).toEqual({
            ok: true,
            source: "loopback-forwarded-container-boundary",
            localListener: absent,
        });
        expect(localListenerInspector).toHaveBeenCalledWith(17373);
        expect(processVerifier).not.toHaveBeenCalled();
    });

    it("accepts a loopback listener that no process in this PID namespace holds when no loopback proxy is in use", () => {
        const processVerifier = vi.fn(() => null);
        for (const host of ["127.0.0.1", "localhost", "::1"]) {
            expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, host, {
                ...production,
                containerBoundary: true,
                loopbackProxyEnabled: false,
                processVerifier,
                localListenerInspector: () => outsidePidNamespace,
            })).toEqual(expect.objectContaining({ ok: true, source: "loopback-forwarded-container-boundary" }));
        }
        expect(processVerifier).not.toHaveBeenCalled();
    });

    it("reads the proxy state from the container environment, including the host opt-out", () => {
        const options = {
            ...production,
            containerBoundary: true,
            processVerifier: () => null,
            localListenerInspector: () => outsidePidNamespace,
        };
        try {
            vi.stubEnv("CCC_CONTAINER_HOST_REMOTE", "1");
            vi.stubEnv("CCC_PROXY_ENABLED", "");
            vi.stubEnv("CCC_DISABLE_PROXY", "");
            expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", options).ok).toBe(false);
            vi.stubEnv("CCC_CONTAINER_HOST_REMOTE", "");
            vi.stubEnv("CCC_PROXY_ENABLED", "1");
            expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", options).ok).toBe(false);
            vi.stubEnv("CCC_PROXY_ENABLED", "");
            vi.stubEnv("CCC_DISABLE_PROXY", "1");
            expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", options).ok).toBe(false);
            vi.stubEnv("CCC_DISABLE_PROXY", "");
            expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", options).ok).toBe(true);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("behind ccc-proxy accepts only an absent listener, since a listener outside the PID namespace is another container", () => {
        const processVerifier = vi.fn(() => null);
        expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", {
            ...production,
            containerBoundary: true,
            loopbackProxyEnabled: true,
            processVerifier,
            localListenerInspector: () => outsidePidNamespace,
        })).toEqual({ ok: false, source: "unverified-broker-port-process", localListener: outsidePidNamespace });
        expect(processVerifier).toHaveBeenCalledOnce();

        expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", {
            ...production,
            containerBoundary: true,
            loopbackProxyEnabled: true,
            processVerifier,
            localListenerInspector: () => absent,
        })).toEqual(expect.objectContaining({ ok: true, source: "loopback-forwarded-container-boundary" }));
    });

    it("rejects a local listener owned by a visible process that fails verification", () => {
        const processVerifier = vi.fn(() => null);

        expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", {
            ...production,
            containerBoundary: true,
            processVerifier,
            localListenerInspector: () => visibleOwner,
        })).toEqual({
            ok: false,
            source: "unverified-broker-port-process",
            localListener: visibleOwner,
        });
        expect(processVerifier).toHaveBeenCalledOnce();
    });

    it("accepts a visible, verified local broker exactly as before", () => {
        const verified = { pid: 77, source: "port-process-plus-runtime-and-status" };
        const processVerifier = vi.fn(() => verified);

        expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", {
            ...production,
            containerBoundary: true,
            processVerifier,
            localListenerInspector: () => visibleOwner,
        })).toEqual({ ok: true, source: verified.source, verified });
    });

    it.each([
        ["an unreadable owner candidate", { state: "indeterminate", port: 17373, inodes: ["55555"], uninspectablePids: [326] }],
        ["procfs that cannot answer", { state: "unavailable", port: 17373, reason: "proc-net-tcp-unreadable" }],
        ["an inspector that returns nothing", null],
    ])("falls back to strict verification for %s", (_label, listener) => {
        const processVerifier = vi.fn(() => null);

        expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", {
            ...production,
            containerBoundary: true,
            processVerifier,
            localListenerInspector: () => listener,
        })).toEqual(expect.objectContaining({ ok: false, source: "unverified-broker-port-process" }));
        expect(processVerifier).toHaveBeenCalledOnce();
    });

    it("never exempts a runtime that the host CLI did not write", () => {
        const processVerifier = vi.fn(() => null);
        const localListenerInspector = vi.fn(() => absent);

        for (const runtime of [{ ...hostRuntime, managedBy: "device-lab-mcp" }, { ...hostRuntime, managedBy: undefined }, null]) {
            expect(reusableBrokerProcessVerificationForTest(runtime, 17373, "127.0.0.1", {
                ...production,
                containerBoundary: true,
                processVerifier,
                localListenerInspector,
            })).toEqual({ ok: false, source: "unverified-broker-port-process" });
        }
        expect(localListenerInspector).not.toHaveBeenCalled();
    });

    it("keeps non-container loopback on strict verification without inspecting listeners", () => {
        const processVerifier = vi.fn(() => null);
        const localListenerInspector = vi.fn(() => absent);

        expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", {
            ...production,
            containerBoundary: false,
            processVerifier,
            localListenerInspector,
        })).toEqual({ ok: false, source: "unverified-broker-port-process" });
        expect(localListenerInspector).not.toHaveBeenCalled();
        expect(processVerifier).toHaveBeenCalledOnce();
    });

    it("leaves the non-loopback trusted-host path unchanged", () => {
        const processVerifier = vi.fn(() => null);
        const localListenerInspector = vi.fn(() => visibleOwner);
        const options = { ...production, containerBoundary: true, processVerifier, localListenerInspector };

        expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "host.docker.internal", options))
            .toEqual({ ok: true, source: "cross-host-container-boundary" });
        expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "evil.example", options))
            .toEqual({ ok: false, source: "unverified-broker-port-process" });
        expect(localListenerInspector).not.toHaveBeenCalled();
    });

    it("keeps the explicit NODE_ENV=test fixture escape ahead of every other rule", () => {
        const localListenerInspector = vi.fn(() => visibleOwner);
        expect(reusableBrokerProcessVerificationForTest(hostRuntime, 17373, "127.0.0.1", {
            nodeEnv: "test",
            testEscape: "1",
            containerBoundary: true,
            localListenerInspector,
        })).toEqual({ ok: true, source: "explicit-test-fixture" });
        expect(localListenerInspector).not.toHaveBeenCalled();
    });
});

describe("authenticated RPC generation check for a loopback-forwarded broker", () => {
    let server: Server;
    let port: number;
    let originalNodeEnv: string | undefined;
    let originalEscape: string | undefined;
    let statusDelayMs: number;
    let statusRequests: number;
    let statusIdentity = { pid: hostRuntime.pid, startToken: hostRuntime.processStartToken, startedAt: hostRuntime.startedAt };

    beforeEach(async () => {
        originalNodeEnv = process.env.NODE_ENV;
        originalEscape = process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
        process.env.NODE_ENV = "production";
        delete process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
        statusDelayMs = 0;
        statusRequests = 0;
        statusIdentity = { pid: hostRuntime.pid, startToken: hostRuntime.processStartToken, startedAt: hostRuntime.startedAt };
        server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/status") {
                statusRequests += 1;
                const status = JSON.stringify({
                    ok: true,
                    broker: {
                        name: "ccc-device-broker",
                        mode: "host-broker-daemon",
                        port,
                        process: { pid: statusIdentity.pid, startToken: statusIdentity.startToken },
                        startedAt: statusIdentity.startedAt,
                        protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
                    },
                });
                if (statusDelayMs) setTimeout(() => res.end(status), statusDelayMs);
                else res.end(status);
                return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
        try {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        } finally {
            if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = originalNodeEnv;
            if (originalEscape === undefined) delete process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
            else process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER = originalEscape;
        }
    });

    it.each([
        { nodeEnv: "test", escape: undefined },
        { nodeEnv: "test", escape: "0" },
        { nodeEnv: "production", escape: "1" },
    ])("attests matching and changed generations with autolaunch disabled in $nodeEnv mode and fixture flag $escape", async ({ nodeEnv, escape }) => {
        process.env.NODE_ENV = nodeEnv;
        if (escape === undefined) delete process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
        else process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER = escape;
        const runtime = { ...hostRuntime, port };
        const options = { autolaunch: false };
        const boundary = { containerBoundary: true, localListenerInspector: () => absent };

        await expect(verifyAuthenticatedBrokerGenerationForTest("127.0.0.1", port, { runtime }, options, boundary))
            .resolves.toEqual(runtime);
        expect(statusRequests).toBe(1);

        statusIdentity = { ...statusIdentity, startToken: "replacement-broker-generation" };
        await expect(verifyAuthenticatedBrokerGenerationForTest("127.0.0.1", port, { runtime }, options, boundary))
            .resolves.toBeNull();
        expect(statusRequests).toBe(2);
    });

    it("binds the forwarded broker to the host runtime identity without local port verification", async () => {
        const runtime = { ...hostRuntime, port };
        const processVerifier = vi.fn(() => null);

        await expect(verifyAuthenticatedBrokerGenerationForTest("127.0.0.1", port, { runtime }, {}, {
            containerBoundary: true,
            localListenerInspector: () => absent,
            processVerifier,
        })).resolves.toEqual(runtime);
        expect(processVerifier).not.toHaveBeenCalled();
    });

    it("still refuses a forwarded broker whose attested generation differs from the host runtime", async () => {
        statusIdentity = { ...statusIdentity, pid: hostRuntime.pid + 1 };
        await expect(verifyAuthenticatedBrokerGenerationForTest("127.0.0.1", port, { runtime: { ...hostRuntime, port } }, {}, {
            containerBoundary: true,
            localListenerInspector: () => absent,
        })).resolves.toBeNull();
    });
    it("keeps a short public operation deadline separate from authenticated generation checks", async () => {
        statusDelayMs = 30;
        const runtime = { ...hostRuntime, port };
        const boundary = { containerBoundary: true, localListenerInspector: () => absent };
        await expect(verifyAuthenticatedBrokerGenerationForTest("127.0.0.1", port, { runtime },
            normalizePublicToolArgs("exec", { deviceId: "vm", timeoutMs: 1 }), boundary)).resolves.toEqual(runtime);
        await expect(verifyAuthenticatedBrokerGenerationForTest("127.0.0.1", port, { runtime },
            { timeoutMs: 1 }, boundary)).resolves.toBeNull();
    });

    it("requires local port verification when a visible local process holds the port", async () => {
        const processVerifier = vi.fn(() => null);
        await expect(verifyAuthenticatedBrokerGenerationForTest("127.0.0.1", port, { runtime: { ...hostRuntime, port } }, {}, {
            containerBoundary: true,
            localListenerInspector: () => visibleOwner,
            processVerifier,
        })).resolves.toBeNull();
        expect(processVerifier).toHaveBeenCalledOnce();
    });

    it("does not let RPC options assert a container boundary", async () => {
        const localListenerInspector = vi.fn(() => absent);
        const processVerifier = vi.fn(() => null);
        await expect(verifyAuthenticatedBrokerGenerationForTest("127.0.0.1", port, { runtime: { ...hostRuntime, port } }, {
            containerBoundary: true,
            localListenerInspector,
        }, {
            containerBoundary: false,
            processVerifier,
        })).resolves.toBeNull();
        expect(localListenerInspector).not.toHaveBeenCalled();
        expect(processVerifier).toHaveBeenCalledOnce();
    });
});

// Linux /proc descriptor-link fixtures require POSIX link targets and permissions.
describe("container loopback listener inspection", () => {
    const LISTEN_17373_V4 = "   1: 0100007F:43DD 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 55555 1 0000000000000000 100 0 0 10 0";
    const ESTABLISHED_17373_V4 = "   2: 0100007F:43DD 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1001        0 66666 1 0000000000000000 100 0 0 10 0";
    const LISTEN_OTHER_V4 = "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 44444 1 0000000000000000 100 0 0 10 0";
    const LISTEN_17373_V6 = "   0: 00000000000000000000000000000000:43DD 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 77777 1 0000000000000000 100 0 0 10 0";
    const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
    let procRoot: string;

    beforeEach(() => {
        procRoot = mkdtempSync(join(tmpdir(), "ccc-fake-proc-"));
        mkdirSync(join(procRoot, "net"));
    });

    afterEach(() => {
        // Restore permissions so an unreadable fd directory does not block cleanup.
        try { chmodSync(join(procRoot, "200", "fd"), 0o755); } catch { /* absent */ }
        try { chmodSync(join(procRoot, "300", "fd"), 0o755); } catch { /* absent */ }
        try { chmodSync(join(procRoot, "310", "fd"), 0o755); } catch { /* absent */ }
        try { chmodSync(join(procRoot, "400", "fd"), 0o755); } catch { /* absent */ }
        rmSync(procRoot, { recursive: true, force: true });
    });

    function writeTable(name: "tcp" | "tcp6", rows: string[]) {
        writeFileSync(join(procRoot, "net", name), `${[HEADER, ...rows].join("\n")}\n`);
    }

    function addProcess(pid: number, sockets: string[], state = "S", tasks: number[] = [pid]) {
        const fdRoot = join(procRoot, String(pid), "fd");
        mkdirSync(fdRoot, { recursive: true });
        for (const task of tasks) mkdirSync(join(procRoot, String(pid), "task", String(task)), { recursive: true });
        writeFileSync(join(procRoot, String(pid), "stat"), `${pid} (node) ${state} 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12345\n`);
        sockets.forEach((inode, index) => symlinkSync(`socket:[${inode}]`, join(fdRoot, String(index + 3))));
        symlinkSync("/dev/null", join(fdRoot, "0"));
    }

    const inspect = (port = 17373) => inspectLocalLoopbackListenerForTest(port, { platform: "linux", procRoot });

    it.skipIf(process.platform === "win32")("reports no listener when only other ports or non-LISTEN sockets use the port", () => {
        writeTable("tcp", [LISTEN_OTHER_V4, ESTABLISHED_17373_V4]);
        addProcess(100, ["44444", "66666"]);
        expect(inspect()).toEqual({ state: "absent", port: 17373 });
    });

    it.skipIf(process.platform === "win32")("finds the visible process that holds the listening socket, over IPv4 or IPv6", () => {
        writeTable("tcp", [LISTEN_17373_V4]);
        addProcess(100, ["12345"]);
        addProcess(101, ["55555"]);
        expect(inspect()).toEqual({ state: "visible-owner", port: 17373, pid: 101, inodes: ["55555"] });

        writeTable("tcp", []);
        writeTable("tcp6", [LISTEN_17373_V6]);
        addProcess(102, ["77777"]);
        expect(inspect()).toEqual(expect.objectContaining({ state: "visible-owner", pid: 102 }));
    });

    it.skipIf(process.platform === "win32")("places a listener nobody here holds outside the PID namespace", () => {
        writeTable("tcp", [LISTEN_17373_V4]);
        addProcess(100, ["12345"]);
        expect(inspect()).toEqual({ state: "outside-pid-namespace", port: 17373, inodes: ["55555"] });
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("stays indeterminate when a live process's descriptors cannot be read", () => {
        writeTable("tcp", [LISTEN_17373_V4]);
        addProcess(100, ["12345"]);
        addProcess(200, []);
        chmodSync(join(procRoot, "200", "fd"), 0);
        expect(inspect()).toEqual({ state: "indeterminate", port: 17373, inodes: ["55555"], uninspectablePids: [200] });
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("ignores zombies, which keep a /proc entry but hold no descriptors", () => {
        writeTable("tcp", [LISTEN_17373_V4]);
        addProcess(300, [], "Z");
        chmodSync(join(procRoot, "300", "fd"), 0);
        expect(inspect()).toEqual({ state: "outside-pid-namespace", port: 17373, inodes: ["55555"] });
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("does not skip a Z leader whose other threads still run and hold its descriptors", () => {
        writeTable("tcp", [LISTEN_17373_V4]);
        addProcess(310, ["55555"], "Z", [310, 311]);
        chmodSync(join(procRoot, "310", "fd"), 0);
        expect(inspect()).toEqual({ state: "indeterminate", port: 17373, inodes: ["55555"], uninspectablePids: [310] });
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("stays indeterminate when a descriptor link cannot be read", () => {
        writeTable("tcp", [LISTEN_17373_V4]);
        addProcess(400, ["55555"]);
        // Listing works without search permission, but resolving a link inside it does not.
        chmodSync(join(procRoot, "400", "fd"), 0o444);
        expect(inspect()).toEqual({ state: "indeterminate", port: 17373, inodes: ["55555"], uninspectablePids: [400] });
    });

    it.skipIf(process.platform === "win32")("finds a socket held only in a non-leader thread's private fd table", () => {
        writeTable("tcp", [LISTEN_17373_V4]);
        addProcess(500, ["12345"], "S", [500, 501]);
        const threadFds = join(procRoot, "500", "task", "501", "fd");
        mkdirSync(threadFds, { recursive: true });
        symlinkSync("socket:[55555]", join(threadFds, "7"));
        expect(inspect()).toEqual({ state: "visible-owner", port: 17373, pid: 500, inodes: ["55555"] });
    });

    it.skipIf(process.platform === "win32")("re-lists /proc so a holder that appears after the first listing is still found", () => {
        writeTable("tcp", [LISTEN_17373_V4]);
        addProcess(100, ["12345"]);
        addProcess(600, ["55555"]);
        const listings = [["100"], ["100", "600"]];
        let call = 0;
        const listPids = () => listings[Math.min(call++, listings.length - 1)];
        expect(inspectLocalLoopbackListenerForTest(17373, { platform: "linux", procRoot, listPids }))
            .toEqual({ state: "visible-owner", port: 17373, pid: 600, inodes: ["55555"] });
    });

    it("stays indeterminate when the process list never settles", () => {
        writeTable("tcp", [LISTEN_17373_V4]);
        let next = 1000;
        const listPids = () => [String(next++)];
        expect(inspectLocalLoopbackListenerForTest(17373, { platform: "linux", procRoot, listPids }))
            .toEqual(expect.objectContaining({ state: "indeterminate", reason: "pid-list-unsettled" }));
    });

    it("declines to answer off Linux or without procfs network tables", () => {
        expect(inspectLocalLoopbackListenerForTest(17373, { platform: "win32", procRoot }))
            .toEqual(expect.objectContaining({ state: "unavailable", reason: "unsupported-platform" }));
        expect(inspect()).toEqual(expect.objectContaining({ state: "unavailable", reason: "proc-net-tcp-missing" }));
        expect(inspect(0)).toEqual(expect.objectContaining({ state: "unavailable", reason: "invalid-port" }));
    });

    it.runIf(process.platform === "linux")("recognizes a real listener in this process through the live procfs", async () => {
        const real = createServer();
        await new Promise<void>((resolve) => real.listen(0, "127.0.0.1", resolve));
        const port = (real.address() as AddressInfo).port;
        try {
            expect(inspectLocalLoopbackListenerForTest(port)).toEqual(expect.objectContaining({
                state: "visible-owner",
                pid: process.pid,
            }));
        } finally {
            await new Promise<void>((resolve) => real.close(() => resolve()));
        }
    });
});
