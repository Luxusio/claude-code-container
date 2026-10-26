import { createBrokerSupervision } from "../../device-lab-mcp/src/application/broker-supervision.mjs";
import { build as bundleBrokerApi } from "esbuild-wasm";
import type { BrokerSupervisionPorts } from "../../device-lab-mcp/src/ports/broker-supervision.mjs";
import { pathToFileURL } from "node:url";
import { directorySymlink } from "./helpers/file-symlink-fixture.js";
import { deviceLabTestHomeEnvironment, isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { callInternalBroker } from "./helpers/device-lab-mcp-fixture.js";
import { brokerObservationTracePreloadSource, readBrokerObservationTrace } from "./helpers/broker-observation-trace.js";
import { spawn } from "child_process";
import * as childProcess from "child_process";
import { createHash, createHmac } from "crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createServer } from "http";
import { AddressInfo } from "net";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    cleanupDeviceLabMcpTestContext,
    createDeviceLabMcpTestContext,
    repoRoot,
    TIMEOUT,
    type DeviceLabMcpTestContext,
} from "./helpers/device-lab-mcp-fixture.js";
import { freePort, installFakeCccBroker, installIgnoringCccBroker, pidAlive, waitForHealthUnavailable } from "./helpers/fake-broker-mcp-fixture.js";
import { removeBrokerRuntimeForTest, writeBrokerRuntimeForTest, BROKER_CONTROL_RESPONSE_LIMIT_BYTES, BROKER_RPC_RESPONSE_LIMIT_BYTES, BROKER_RPC_SCREENSHOT_RESPONSE_LIMIT_BYTES, authenticatedBrokerHeadersForTest, brokerCommand, brokerDeviceTool, brokerLaunchInvocation, brokerLogTail, brokerRpc, brokerStatus, implicitBrokerProbeOptions, launchedBrokerProcessVerificationForTest, parseWindowsNetstatListenerForTest, reusableBrokerProcessVerificationForTest, terminateVerifiedBrokerRuntimeForTest, verifiedBrokerProcessForTest, waitForBrokerOwnerResolve } from "../../device-lab-mcp/src/broker.mjs";
import { ownerId as deviceLabMcpOwnerId, projectMountPath } from "@ccc/device-lab/providers/context.mjs";

const TEST_BROKER_OWNER_ID = "1111111111111111";
const HOOK_TIMEOUT = Math.max(TIMEOUT, 60000);

const isolatedAuthFixture = vi.hoisted(() => ({ root: "/__ccc_test_auth_mount_absent__" }));
vi.mock("child_process", async original => ({ ...await original<typeof import("child_process")>() }));
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    function mapped(path: unknown) {
        const normalized = String(path).replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
        const mount = "/run/ccc-device-broker-auth";
        return normalized === mount || normalized.startsWith(`${mount}/`)
            ? isolatedAuthFixture.root + normalized.slice(mount.length) : path;
    }
    return { ...actual,
        existsSync: (path: Parameters<typeof actual.existsSync>[0]) => actual.existsSync(mapped(path) as string),
        lstatSync: (path: Parameters<typeof actual.lstatSync>[0], ...args: unknown[]) => actual.lstatSync(mapped(path) as string, ...args as []),
        openSync: (path: Parameters<typeof actual.openSync>[0], ...args: unknown[]) => actual.openSync(mapped(path) as string, ...args as [number]),
    };
});

function provisionTestOwnerSecret(ownerId = TEST_BROKER_OWNER_ID) {
    const authRoot = join(homedir(), ".ccc", "devices", "broker", "auth");
    const file = join(authRoot, `${ownerId}.json`);
    if (!existsSync(file)) {
        mkdirSync(authRoot, { recursive: true });
        writeFileSync(file, JSON.stringify({ ownerId, secret: "b".repeat(64), version: 1 }), { mode: 0o600 });
    }
}

function sendTestOwnerResolve(req: { method?: string; url?: string }, res: { setHeader(name: string, value: string): void; end(data?: string): void }) {
    if (req.method !== "POST" || req.url !== "/v1/owner/resolve") return false;
    provisionTestOwnerSecret();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { ownerId: TEST_BROKER_OWNER_ID } }));
    return true;
}

function sendCurrentBrokerStatus(req: { url?: string }, res: { setHeader(name: string, value: string): void; end(data?: string): void }) {
    if (req.url !== "/status") return false;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION } }));
    return true;
}

// These allocated fake servers prove credential selection and transport behavior,
// and cannot attest a broker process. Authorize only their individual requests.
async function withUnverifiedBrokerFixture<T>(operation: () => Promise<T>): Promise<T> {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalEscape = process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
    process.env.NODE_ENV = "test";
    process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER = "1";
    try {
        return await operation();
    } finally {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
        if (originalEscape === undefined) delete process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
        else process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER = originalEscape;
    }
}

async function holdRuntimeLockInChild(file: string) {
    const moduleUrl = pathToFileURL(join(repoRoot, "packages/device-lab/providers/state/shared-mutation-lock.mjs")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
import {withSharedMutationLockAsync} from ${JSON.stringify(moduleUrl)};
import {setTimeout as delay} from 'node:timers/promises';
let release;
const requested = new Promise(resolve => { release = resolve; });
process.once('message', value => release(Number(value.releaseAfterMs)));
await withSharedMutationLockAsync(${JSON.stringify(file)}, async () => {
    process.send({held:true});
    const safety = setTimeout(() => release(0), 10000);
    const milliseconds = await requested;
    clearTimeout(safety);
    await delay(Math.max(0, Math.min(5000, milliseconds)));
});
process.disconnect();
`], { env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let diagnostics = "";
    child.stdout!.on("data", chunk => { diagnostics += String(chunk); });
    child.stderr!.on("data", chunk => { diagnostics += String(chunk); });
    const ended = new Promise<void>(resolve => child.once("close", () => resolve()));
    const waitForExit = async (timeoutMs: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([ended.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
        } finally { clearTimeout(timer); }
    };
    const releaseAfter = (milliseconds: number) => {
        if (child.connected) child.send?.({ releaseAfterMs: milliseconds });
    };
    const close = async () => {
        releaseAfter(0);
        if (await waitForExit(3000)) return;
        child.kill("SIGTERM");
        if (await waitForExit(1000)) return;
        child.kill("SIGKILL");
        expect(await waitForExit(1000), `owned runtime-lock child did not exit: ${diagnostics}`).toBe(true);
    };
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`runtime-lock child admission timed out: ${diagnostics}`)), 10000);
            child.once("message", message => {
                clearTimeout(timer);
                if (message && typeof message === "object" && "held" in message && message.held === true) resolve();
                else reject(new Error(`unexpected runtime-lock child reply: ${JSON.stringify(message)}`));
            });
            child.once("error", error => { clearTimeout(timer); reject(error); });
            child.once("exit", () => { clearTimeout(timer); reject(new Error(`runtime-lock child exited before release: ${diagnostics}`)); });
        });
        return { releaseAfter, close };
    } catch (error) {
        await close();
        throw error;
    }
}

describe("device-lab MCP", () => {
    it("requires the current Hyper-V computer-use broker capability and caps screenshot responses separately", () => {
        expect(BROKER_RPC_SCREENSHOT_RESPONSE_LIMIT_BYTES).toBe(8 * 1024 * 1024);
        expect(BROKER_RPC_SCREENSHOT_RESPONSE_LIMIT_BYTES).toBeLessThan(BROKER_RPC_RESPONSE_LIMIT_BYTES);
    });

    it("binds authenticated RPC headers to the broker generation without sending the owner token", () => {
        const token = "a".repeat(64);
        const owner = "1111111111111111";
        const runtime = {
            startedAt: "2026-07-29T00:00:00.000Z",
            processStartToken: "windows:2026-07-29T00:00:00.0000000Z",
        };
        const body = JSON.stringify({ ownerId: owner, method: "broker.echo", params: { value: 1 } });
        const headers = authenticatedBrokerHeadersForTest(token, owner, runtime, body);

        expect(headers).not.toHaveProperty("x-ccc-device-token");
        expect(headers["x-ccc-device-auth-nonce"]).toMatch(/^[a-f0-9]{32}$/);
        const bodyHash = createHash("sha256").update(body).digest("hex");
        const payload = [
            "v1",
            owner,
            headers["x-ccc-device-auth-timestamp"],
            headers["x-ccc-device-auth-nonce"],
            runtime.startedAt,
            runtime.processStartToken,
            bodyHash,
        ].join("\n");
        expect(headers["x-ccc-device-auth"]).toBe(
            createHmac("sha256", token).update(payload).digest("hex"),
        );
        expect(authenticatedBrokerHeadersForTest(token, owner, runtime, body)["x-ccc-device-auth-nonce"])
            .not.toBe(headers["x-ccc-device-auth-nonce"]);
    });

    it.each([
        { nodeEnv: "test", escape: undefined, testOnly: true, legacy: false },
        { nodeEnv: "test", escape: "0", testOnly: true, legacy: false },
        { nodeEnv: "test", escape: "1", testOnly: true, legacy: true },
        { nodeEnv: "test", escape: "1", testOnly: false, legacy: false },
        { nodeEnv: "production", escape: "1", testOnly: true, legacy: false },
    ])("uses legacy headers only for deliberately authorized test-only runtimes: $nodeEnv, flag $escape, testOnly $testOnly", ({ nodeEnv, escape, testOnly, legacy }) => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalEscape = process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
        try {
            process.env.NODE_ENV = nodeEnv;
            if (escape === undefined) delete process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
            else process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER = escape;
            const token = "a".repeat(64);
            const owner = TEST_BROKER_OWNER_ID;
            const runtime = {
                startedAt: "2026-07-29T00:00:00.000Z",
                processStartToken: "windows:2026-07-29T00:00:00.0000000Z",
                ...(testOnly ? { testOnly: true } : {}),
            };
            const body = JSON.stringify({ ownerId: owner, method: "broker.echo", params: { value: 1 } });
            const headers = authenticatedBrokerHeadersForTest(token, owner, runtime, body);
            if (legacy) {
                expect(headers).toEqual({ "x-ccc-device-token": token });
            } else {
                expect(headers).not.toHaveProperty("x-ccc-device-token");
                expect(headers["x-ccc-device-auth-nonce"]).toMatch(/^[a-f0-9]{32}$/);
                expect(headers["x-ccc-device-broker-started-at"]).toBe(runtime.startedAt);
                expect(headers["x-ccc-device-broker-start-token"]).toBe(runtime.processStartToken);
                const payload = [
                    "v1", owner, headers["x-ccc-device-auth-timestamp"], headers["x-ccc-device-auth-nonce"],
                    runtime.startedAt, runtime.processStartToken, createHash("sha256").update(body).digest("hex"),
                ].join("\n");
                expect(headers["x-ccc-device-auth"]).toBe(createHmac("sha256", token).update(payload).digest("hex"));
            }
        } finally {
            if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = originalNodeEnv;
            if (originalEscape === undefined) delete process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
            else process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER = originalEscape;
        }
    });

    it("keeps the unverified broker fixture escape disabled outside explicit test mode", () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalEscape = process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
        try {
            process.env.NODE_ENV = "production";
            process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER = "1";
            expect(reusableBrokerProcessVerificationForTest(null, 17373)).toEqual({
                ok: false,
                source: "unverified-broker-port-process",
            });

            process.env.NODE_ENV = "test";
            expect(reusableBrokerProcessVerificationForTest(null, 17373)).toEqual({
                ok: true,
                source: "explicit-test-fixture",
            });
        } finally {
            if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = originalNodeEnv;
            if (originalEscape === undefined) delete process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
            else process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER = originalEscape;
        }
    });

    it("permits cross-host container brokers without exempting container loopback listeners", () => {
        const runtime = { managedBy: "ccc-host", pid: 4321, port: 17373 };
        const processVerifier = vi.fn(() => null);
        // A process inside this container holds the loopback port, so ccc-proxy would route to it
        // rather than to the host. Forwarded loopback is covered in the container-boundary suite.
        const containerLocalListener = { state: "visible-owner", port: 17373, pid: 77, inodes: ["55555"] };
        const options = {
            nodeEnv: "production",
            testEscape: "0",
            containerBoundary: true,
            processVerifier,
            localListenerInspector: () => containerLocalListener,
        };

        expect(reusableBrokerProcessVerificationForTest(
            runtime,
            17373,
            "host.docker.internal",
            options,
        )).toEqual({
            ok: true,
            source: "cross-host-container-boundary",
        });
        expect(reusableBrokerProcessVerificationForTest(
            runtime,
            17373,
            "127.0.0.1",
            options,
        )).toEqual({
            ok: false,
            source: "unverified-broker-port-process",
            localListener: containerLocalListener,
        });
        expect(processVerifier).toHaveBeenCalledOnce();
    });

    it("accepts a same-host broker only after its port process is verified", () => {
        const runtime = { managedBy: "ccc-host", pid: 4321, port: 17373 };
        const verified = { pid: 4321, source: "port-process" };
        const processVerifier = vi.fn(() => verified);

        expect(reusableBrokerProcessVerificationForTest(
            runtime,
            17373,
            "127.0.0.1",
            {
                nodeEnv: "production",
                testEscape: "0",
                containerBoundary: false,
                processVerifier,
            },
        )).toEqual({
            ok: true,
            source: "port-process",
            verified,
        });
    });

    it("parses IPv4 and IPv6 Windows netstat listeners without trusting unrelated rows", () => {
        const output = [
            "  TCP    0.0.0.0:17372          0.0.0.0:0              LISTENING       4000",
            "  TCP    127.0.0.1:17373        0.0.0.0:0              수신 대기 중    4321",
            "  TCP    [::]:17374             [::]:0                 LISTENING       5000",
            "  TCP    127.0.0.1:17375        10.0.0.2:443           ESTABLISHED     6000",
            "  UDP    0.0.0.0:17373          *:*                                    9999",
        ].join("\r\n");

        expect(parseWindowsNetstatListenerForTest(output, 17373)).toEqual({ pid: 4321, commandLine: "" });
        expect(parseWindowsNetstatListenerForTest(output, 17374)).toEqual({ pid: 5000, commandLine: "" });
        expect(parseWindowsNetstatListenerForTest(output, 17375)).toBeNull();
    });

    it("passes a newly launched broker status identity into process verification", () => {
        const runtime = {
            managedBy: "device-lab-mcp",
            pid: 4321,
            port: 17373,
            startedAt: "stale-pre-spawn-value",
            processStartToken: "windows:launch",
        };
        const statusBroker = {
            name: "ccc-device-broker",
            mode: "host-broker-daemon",
            port: 17373,
            process: { pid: 4321, startToken: "windows:launch" },
            startedAt: "2026-07-29T00:00:00.000Z",
        };
        const processVerifier = vi.fn(() => ({ pid: 4321, source: "port-pid-plus-runtime-and-status" }));

        const result = launchedBrokerProcessVerificationForTest(
            runtime,
            17373,
            "127.0.0.1",
            statusBroker,
            {
                nodeEnv: "production",
                testEscape: "0",
                containerBoundary: false,
                processVerifier,
            },
        );

        expect(result).toEqual({
            verification: {
                ok: true,
                source: "port-pid-plus-runtime-and-status",
                verified: { pid: 4321, source: "port-pid-plus-runtime-and-status" },
            },
            runtime: { ...runtime, startedAt: statusBroker.startedAt, processStartToken: statusBroker.process.startToken },
        });
        expect(processVerifier).toHaveBeenCalledWith(
            { ...runtime, startedAt: statusBroker.startedAt, processStartToken: statusBroker.process.startToken },
            17373,
            statusBroker,
        );
    });

    it("accepts a command-line-redacted Windows listener only when runtime and status identities match", () => {
        const runtime = {
            managedBy: "ccc-host",
            pid: 4321,
            port: 17373,
            command: "C:\\Program Files\\nodejs\\node.exe",
            args: ["C:\\ccc\\dist\\index.js", "devices", "broker", "serve", "--port", "17373"],
            startedAt: "2026-07-29T00:00:00.000Z",
            processStartToken: "windows:2026-07-29T00:00:00.000Z",
        };
        const statusBroker = {
            name: "ccc-device-broker",
            mode: "host-broker-daemon",
            port: 17373,
            process: { pid: 4321, startToken: runtime.processStartToken },
            startedAt: runtime.startedAt,
        };
        const listener = () => ({ pid: 4321, commandLine: "", processStartToken: runtime.processStartToken });

        expect(verifiedBrokerProcessForTest(runtime, 17373, statusBroker, listener)).toEqual({
            pid: 4321,
            commandLine: "",
            processStartToken: runtime.processStartToken,
            source: "port-pid-plus-runtime-and-status",
        });
        expect(verifiedBrokerProcessForTest(
            runtime,
            17373,
            { ...statusBroker, process: { pid: 4322 } },
            listener,
        )).toBeNull();
        expect(verifiedBrokerProcessForTest(
            runtime,
            17373,
            { ...statusBroker, startedAt: "2026-07-29T00:00:01.000Z" },
            listener,
        )).toBeNull();
    });

    it("attests a command-visible broker from OS and status while rejecting token disagreement", () => {
        const runtime = {
            managedBy: "device-lab-mcp",
            pid: 4321,
            port: 17373,
            command: "C:\\Program Files\\nodejs\\node.exe",
            args: ["C:\\ccc\\dist\\index.js", "devices", "broker", "serve", "--port", "17373"],
            startedAt: "2026-07-29T00:00:00.000Z",
            processStartToken: "windows:original",
        };
        const commandLine = "\"C:\\Program Files\\nodejs\\node.exe\" C:\\ccc\\dist\\index.js devices broker serve --port 17373";
        const statusBroker = {
            name: "ccc-device-broker",
            mode: "host-broker-daemon",
            port: 17373,
            process: { pid: runtime.pid, startToken: runtime.processStartToken },
            startedAt: runtime.startedAt,
        };
        expect(verifiedBrokerProcessForTest(
            runtime,
            17373,
            statusBroker,
            () => ({ pid: runtime.pid, commandLine, processStartToken: runtime.processStartToken }),
        )).toEqual(expect.objectContaining({ source: "port-process-plus-runtime-and-status" }));
        expect(verifiedBrokerProcessForTest(
            runtime,
            17373,
            { ...statusBroker, process: { pid: runtime.pid, startToken: "windows:successor" } },
            () => ({ pid: runtime.pid, commandLine, processStartToken: "windows:successor" }),
        )).toBeNull();
        expect(verifiedBrokerProcessForTest(
            runtime,
            17373,
            statusBroker,
            () => ({ pid: runtime.pid, commandLine, processStartToken: "windows:successor" }),
        )).toBeNull();
        expect(verifiedBrokerProcessForTest(
            runtime,
            17373,
            { ...statusBroker, process: { pid: runtime.pid, startToken: "windows:successor" } },
            () => ({ pid: runtime.pid, commandLine, processStartToken: runtime.processStartToken }),
        )).toBeNull();
    });

    describe("Darwin broker native observations", () => {
        const runtime = { managedBy: "device-lab-mcp", pid: 4321, port: 17373,
            command: "/owned/node", args: [`/Users/owned/${"long-checkout-directory/".repeat(8)}dist/packages/device-lab/dist/broker-entry.js`],
            processStartToken: "ps:Wed Oct 21 15:32:43 2026", startedAt: "2026-10-21T15:32:43.000Z" };
        const status = { name: "ccc-device-broker", mode: "host-broker-daemon", port: runtime.port,
            startedAt: runtime.startedAt, process: { pid: runtime.pid, startToken: runtime.processStartToken } };
        const commandLine = `${runtime.command} ${runtime.args[0]} devices broker serve --port ${runtime.port}\n`;
        const startLine = "Wed Oct 21 15:32:43 2026\n";

        it("uses fixed Darwin observation tools with a private PATH and retains PID/start-token proof", () => {
            const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
            const observed: Array<{ executable: string; args: readonly string[]; timeout?: number }> = [];
            let nativeCommandLine = commandLine;
            let nativeStartLine = startLine;
            const native = vi.spyOn(childProcess, "spawnSync").mockImplementation(((executable: string, args: readonly string[], options: { timeout?: number }) => {
                observed.push({ executable, args, timeout: options.timeout });
                const stdout = executable === "/usr/sbin/lsof" ? `p${runtime.pid}\nf12\n`
                    : executable === "/bin/ps" && args.includes("command=") ? nativeCommandLine
                    : executable === "/bin/ps" && args.includes("lstart=") ? nativeStartLine : null;
                if (stdout === null) throw new Error("Unexpected native process probe");
                return { status: 0, stdout, stderr: "", signal: null, pid: 0, output: [null, stdout, ""] };
            }) as typeof childProcess.spawnSync);
            const savedPath = process.env.PATH;
            try {
                Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
                process.env.PATH = "/private/owned-fixture-bin";
                expect(verifiedBrokerProcessForTest(runtime, runtime.port, status)).toMatchObject({
                    pid: runtime.pid, commandLine: commandLine.trim(), processStartToken: runtime.processStartToken,
                });
                expect(observed.map(({ executable, args }) => ({ executable, args }))).toEqual([
                    { executable: "/usr/sbin/lsof", args: ["-nP", "-iTCP:17373", "-sTCP:LISTEN", "-Fp"] },
                    { executable: "/bin/ps", args: ["-ww", "-p", "4321", "-o", "command="] },
                    { executable: "/bin/ps", args: ["-p", "4321", "-o", "lstart="] },
                ]);
                expect(observed.every(probe => Number(probe.timeout) > 0 && Number(probe.timeout) <= 1000)).toBe(true);
                expect(verifiedBrokerProcessForTest(runtime, runtime.port, { ...status, process: { ...status.process, pid: 9876 } })).toBeNull();
                expect(verifiedBrokerProcessForTest(runtime, runtime.port, { ...status, process: { ...status.process, startToken: "ps:successor" } })).toBeNull();
                nativeStartLine = "Wed Oct 21 15:32:44 2026\n";
                expect(verifiedBrokerProcessForTest(runtime, runtime.port, status)).toBeNull();
                nativeStartLine = startLine;
                nativeCommandLine = commandLine.replace(runtime.args[0], "/foreign/broker-entry.js");
                expect(verifiedBrokerProcessForTest(runtime, runtime.port, status)).toBeNull();
            } finally {
                Object.defineProperty(process, "platform", descriptor);
                if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
                native.mockRestore();
            }
        });

        it.each([
            ...(["listener", "command", "start-token"] as const).flatMap(stage => [
                { stage, completion: "nonzero", nativeStatus: 1, nativeSignal: null, errorCode: null, expectedSignal: null, expectedCode: null },
                { stage, completion: "error", nativeStatus: 0, nativeSignal: null, errorCode: "ETIMEDOUT", expectedSignal: null, expectedCode: "ETIMEDOUT" },
                { stage, completion: "signal", nativeStatus: 0, nativeSignal: "SIGTERM", errorCode: null, expectedSignal: "SIGTERM", expectedCode: null },
            ]),
            { stage: "command" as const, completion: "unrecognized diagnostics", nativeStatus: null,
                nativeSignal: "private-observation-secret", errorCode: "private-observation-secret", expectedSignal: null, expectedCode: null },
        ])("refuses partial $stage output after native $completion without leaking command evidence", ({ stage, nativeStatus, nativeSignal, errorCode, expectedSignal, expectedCode }) => {
            const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
            const observed: Array<{ stage: string; timeout?: number }> = [];
            const secret = "private-observation-secret";
            const native = vi.spyOn(childProcess, "spawnSync").mockImplementation(((executable: string, args: readonly string[], options: { timeout?: number }) => {
                const currentStage = executable === "/usr/sbin/lsof" ? "listener"
                    : args.includes("command=") ? "command" : "start-token";
                observed.push({ stage: currentStage, timeout: options.timeout });
                const stdout = currentStage === "listener" ? `p${runtime.pid}\nf12\n`
                    : currentStage === "command" ? commandLine : startLine;
                const failed = currentStage === stage;
                return { status: failed ? nativeStatus : 0, stdout, stderr: secret,
                    signal: failed ? nativeSignal : null, pid: 0, output: [null, stdout, secret],
                    ...(failed && errorCode ? { error: Object.assign(new Error(secret), { code: errorCode }) } : {}) };
            }) as typeof childProcess.spawnSync);
            try {
                Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
                const verification = reusableBrokerProcessVerificationForTest(runtime, runtime.port, "127.0.0.1", {
                    nodeEnv: "production", testEscape: "0", containerBoundary: false, statusBroker: status,
                });
                expect(verification).toEqual({ ok: false, source: "unverified-broker-port-process", observation: {
                    stage, reason: "native-command-failed", status: nativeStatus, signal: expectedSignal, code: expectedCode,
                } });
                expect(observed.at(-1)?.stage).toBe(stage);
                expect(observed.length).toBe((["listener", "command", "start-token"] as const).indexOf(stage) + 1);
                expect(observed.every(probe => Number(probe.timeout) > 0 && Number(probe.timeout) <= 1000)).toBe(true);
                const diagnostic = JSON.stringify(verification);
                expect(diagnostic).not.toContain(secret);
                expect(diagnostic).not.toContain(runtime.args[0]);
                expect(diagnostic).not.toContain(runtime.processStartToken);
            } finally {
                Object.defineProperty(process, "platform", descriptor);
                native.mockRestore();
            }
        });

        it("accepts only a completed empty command for the runtime/status fallback", () => {
            const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
            let commandStatus: number | null = 0;
            const native = vi.spyOn(childProcess, "spawnSync").mockImplementation(((executable: string, args: readonly string[]) => {
                const commandProbe = executable === "/bin/ps" && args.includes("command=");
                const stdout = executable === "/usr/sbin/lsof" ? `p${runtime.pid}\n` : commandProbe ? "" : startLine;
                return { status: commandProbe ? commandStatus : 0, stdout, stderr: "", signal: null, pid: 0, output: [null, stdout, ""] };
            }) as typeof childProcess.spawnSync);
            try {
                Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
                expect(verifiedBrokerProcessForTest(runtime, runtime.port, status)).toMatchObject({
                    pid: runtime.pid, commandLine: "", processStartToken: runtime.processStartToken,
                    source: "port-pid-plus-runtime-and-status",
                });
                expect(verifiedBrokerProcessForTest(runtime, runtime.port, { ...status, startedAt: "2026-10-21T15:32:44.000Z" })).toBeNull();
                expect(verifiedBrokerProcessForTest({ ...runtime, processStartToken: "ps:successor" }, runtime.port, status)).toBeNull();
                expect(verifiedBrokerProcessForTest(runtime, runtime.port, { ...status, process: { ...status.process, pid: 9876 } })).toBeNull();
                commandStatus = 1;
                expect(verifiedBrokerProcessForTest(runtime, runtime.port, status)).toBeNull();
                commandStatus = null;
                expect(verifiedBrokerProcessForTest(runtime, runtime.port, status)).toBeNull();
            } finally {
                Object.defineProperty(process, "platform", descriptor);
                native.mockRestore();
            }
        });
    });

    it("terminates a command-line-redacted broker only after status and OS start-token attestation", async () => {
        const runtime = {
            managedBy: "device-lab-mcp",
            pid: 4321,
            port: 17373,
            startedAt: "2026-07-29T00:00:00.000Z",
            processStartToken: "windows:broker-start",
        };
        const statusBroker = {
            name: "ccc-device-broker",
            mode: "host-broker-daemon",
            port: 17373,
            process: { pid: runtime.pid, startToken: runtime.processStartToken },
            startedAt: runtime.startedAt,
        };
        const terminator = vi.fn(async () => ({ ok: true, pid: runtime.pid }));

        await expect(terminateVerifiedBrokerRuntimeForTest(runtime, 1500, {
            statusBroker,
            portProcessResolver: () => ({
                pid: runtime.pid,
                commandLine: "",
                processStartToken: runtime.processStartToken,
            }),
            terminator,
        })).resolves.toEqual(expect.objectContaining({ ok: true, pid: runtime.pid }));
        expect(terminator).toHaveBeenCalledWith(runtime.pid, 1500, runtime.processStartToken);

        terminator.mockClear();
        await expect(terminateVerifiedBrokerRuntimeForTest(runtime, 1500, {
            statusBroker,
            portProcessResolver: () => ({
                pid: runtime.pid,
                commandLine: "",
                processStartToken: "windows:reused-pid",
            }),
            terminator,
        })).resolves.toEqual(expect.objectContaining({
            ok: false,
            reason: "unverified-broker-port-process",
        }));
        expect(terminator).not.toHaveBeenCalled();
    });

    let context: DeviceLabMcpTestContext;
    let client: DeviceLabMcpTestContext["client"];
    let homeDir: string;
    let pathDir: string;
    let originalBrokerAuthFile: string | undefined;

    beforeAll(async () => {
        originalBrokerAuthFile = process.env.CCC_DEVICE_BROKER_AUTH_FILE;
        delete process.env.CCC_DEVICE_BROKER_AUTH_FILE;
        const mcpEnv: Record<string, string> = {};
        context = await createDeviceLabMcpTestContext({ isolatedLauncher: true, defaultImplicitBroker: true, env: mcpEnv, setupHome: fixtureHome => {
            // The real container's mounted credential must never participate in these
            // synthetic-owner subprocess tests. Preserve ordinary filesystem validation.
            const preload = join(fixtureHome, "isolate-broker-auth.cjs");
            const absentMount = join(fixtureHome, "absent-conventional-mount");
            writeFileSync(preload, `const fs=require('fs');const root=${JSON.stringify(absentMount)};for(const key of ['existsSync','lstatSync','openSync']){const original=fs[key];fs[key]=function(file,...args){const path=String(file).replaceAll('\\\\','/').replace(/^[A-Za-z]:/,'');const mount='/run/ccc-device-broker-auth';return original.call(fs,path===mount||path.startsWith(mount+'/')?root+path.slice(mount.length):file,...args)}}require('module').syncBuiltinESMExports();`);
            mcpEnv.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
        } });
        client = context.client;
        homeDir = context.homeDir;
        pathDir = context.pathDir;
        isolatedAuthFixture.root = join(homeDir, "conventional-auth");
    }, HOOK_TIMEOUT);

    afterAll(async () => {
        await cleanupDeviceLabMcpTestContext(context);
        if (originalBrokerAuthFile === undefined) delete process.env.CCC_DEVICE_BROKER_AUTH_FILE;
        else process.env.CCC_DEVICE_BROKER_AUTH_FILE = originalBrokerAuthFile;
    }, HOOK_TIMEOUT);

    it("launches the core package broker directly for Windows broker recovery", () => {
        const invocation = brokerLaunchInvocation("127.0.0.1", 17373, {
            platform: "win32",
            packageRoot: join(repoRoot, "device-lab-mcp"),
            execPath: "C:\\Program Files\\nodejs\\node.exe",
        });

        expect(invocation.command).toBe("C:\\Program Files\\nodejs\\node.exe");
        expect(invocation.args).toEqual([
            join(repoRoot, "packages", "device-lab", "dist", "broker-entry.js"),
            "devices", "broker", "serve", "--host", "127.0.0.1", "--port", "17373",
            "--runtime-managed-by-parent",
        ]);
    });

    it("bounds owner-resolve readiness diagnostics and preserves the last HTTP failure", async () => {
        const requestBodies: Array<{ projectMountPath?: string }> = [];
        const server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            req.on("end", () => {
                requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                res.statusCode = 503;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: false, error: "owner-auth-provisioning-failed" }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        try {
            const result = await waitForBrokerOwnerResolve("127.0.0.1", port, 250);
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-auth-provisioning-failed",
                selected: expect.objectContaining({ status: 503 }),
            }));
            expect(result.attempts.length).toBeGreaterThan(0);
            expect(result.attempts.length).toBeLessThanOrEqual(8);
            expect(requestBodies.length).toBeGreaterThan(0);
            expect(requestBodies.every((body) => body.projectMountPath === projectMountPath())).toBe(true);
            expect(requestBodies.every((body) => body.projectMountPath?.startsWith("/project/"))).toBe(true);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports persistent device-lab storage boundaries without starting the broker", { timeout: TIMEOUT }, async () => {
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: false, autolaunch: false } });
        expect(status.isError).not.toBe(true);
        const payload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            available: boolean;
            state: { ownerRoot: string; logsRoot: string; runtimeFile: string };
            persistence: {
                durableAcrossContainerRecreation: boolean;
                environmentVariablesRequired: boolean;
                ownerScoped: {
                    ownerRoot: string;
                    deviceDefinitions: Record<string, string>;
                    recordings: Record<string, string>;
                    images: Record<string, string>;
                    snapshots: Record<string, string>;
                };
                brokerScoped: { logsRoot: string; runtimeFile: string };
                packagedDependencies: { mcpPackageRoot: string; nodeModulesRoot: string; appium: string };
                hostToolchains: { ownership: string; discovery: string; preservedByOwnerCleanup: string[] };
                cleanupBoundary: { ownerCleanupMayMutate: string[]; ownerCleanupPreserves: string[]; staleMetadataPolicy: string };
            };
        };

        expect(payload.available).toBe(false);
        const discovery = await client.callTool({ name: "devices", arguments: { view: "backends", implicitBroker: false, detail: true } });
        expect(discovery.isError).not.toBe(true);
        const discovered = JSON.parse((discovery.content as Array<{ text?: string }>)[0].text || "{}");
        expect(discovered.broker.state.ownerRoot).toBe(payload.state.ownerRoot);
        expect(discovered.broker.available).toBe(false);
        expect(payload.persistence).toEqual(expect.objectContaining({
            durableAcrossContainerRecreation: true,
            environmentVariablesRequired: false,
        }));
        expect(payload.persistence.ownerScoped.ownerRoot).toBe(payload.state.ownerRoot);
        expect(payload.persistence.ownerScoped.deviceDefinitions).toEqual(expect.objectContaining({
            android: expect.stringContaining(join("android", "devices.json")),
            "android-device": expect.stringContaining(join("android-device", "devices.json")),
            ios: expect.stringContaining(join("ios", "devices.json")),
            "ios-device": expect.stringContaining(join("ios-device", "devices.json")),
            windows: expect.stringContaining(join("windows", "devices.json")),
            macos: expect.stringContaining(join("macos", "devices.json")),
        }));
        expect(payload.persistence.ownerScoped.recordings).toEqual(expect.objectContaining({
            android: expect.stringContaining(join("android", "<device-id>", "recordings")),
            windows: expect.stringContaining(join("windows", "<device-id>", "recordings")),
            macos: expect.stringContaining(join("macos", "<device-id>", "recordings")),
        }));
        expect(payload.persistence.ownerScoped.images.macosVm).toContain("provider-owned VM instances");
        expect(payload.persistence.ownerScoped.snapshots.macosVm).toContain("provider clones");
        expect(payload.persistence.brokerScoped.logsRoot).toBe(payload.state.logsRoot);
        expect(payload.persistence.brokerScoped.runtimeFile).toBe(payload.state.runtimeFile);
        expect(payload.persistence.packagedDependencies.appium).toContain("appium-uiautomator2-driver");
        expect(payload.persistence.hostToolchains).toEqual(expect.objectContaining({
            ownership: "host-owned",
            discovery: expect.stringContaining("no environment variables"),
            preservedByOwnerCleanup: expect.arrayContaining(["Android SDK/AVDs", "Xcode/CoreSimulator", "Windows Sandbox"]),
        }));
        expect(payload.persistence.cleanupBoundary.ownerCleanupMayMutate).toEqual(expect.arrayContaining([payload.state.ownerRoot]));
        expect(payload.persistence.cleanupBoundary.ownerCleanupPreserves).toEqual(expect.arrayContaining([
            expect.stringContaining(join("owners", "<foreign-owner-id>")),
            "host toolchains and shared/base VM images",
        ]));
        expect(payload.persistence.cleanupBoundary.staleMetadataPolicy).toContain("without deleting shared toolchain caches");
    });

    it("enables default implicit broker probing without runtime metadata", { timeout: TIMEOUT }, async () => {
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: false, autolaunch: false } });
        const payload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            state: { runtimeFile: string };
        };
        rmSync(payload.state.runtimeFile, { force: true });

        expect(implicitBrokerProbeOptions()).toEqual(expect.objectContaining({
            hostCandidates: expect.arrayContaining(["127.0.0.1", "host.docker.internal"]),
            port: 17373,
            timeoutMs: 1000,
            autolaunch: true,
        }));
        expect(implicitBrokerProbeOptions({}, { allowDefault: true })).toEqual(expect.objectContaining({
            hostCandidates: expect.arrayContaining(["127.0.0.1", "host.docker.internal"]),
            port: 17373,
            timeoutMs: 1000,
            autolaunch: true,
        }));
    });

    describe("isolated owner credential discovery", () => {
        const owner = "abababababababab";
        const credential = (secret: string, selectedOwner = owner) => JSON.stringify({ ownerId: selectedOwner, secret: secret.repeat(64), version: 1 });

        async function exercise(kind: string) {
            const originalAuth = process.env.CCC_DEVICE_BROKER_AUTH_FILE;
            delete process.env.CCC_DEVICE_BROKER_AUTH_FILE;
            const root = isolatedAuthFixture.root;
            const isolated = join(root, "owner.json");
            const legacy = join(homeDir, ".ccc", "devices", "broker", "auth", `${owner}.json`);
            const explicit = join(homeDir, "explicit-owner.json");
            const linked = join(homeDir, "linked-owner.json");
            mkdirSync(join(homeDir, ".ccc", "devices", "broker", "auth"), { recursive: true });
            mkdirSync(root, { recursive: true });
            writeFileSync(legacy, credential("a"), { mode: 0o600 });
            writeFileSync(isolated, credential("b"), { mode: 0o600 });
            let expectedSecret: string | null = "b";
            if (kind === "explicit") {
                writeFileSync(explicit, credential("c"), { mode: 0o600 });
                process.env.CCC_DEVICE_BROKER_AUTH_FILE = explicit;
                expectedSecret = "c";
            } else if (kind === "absent") {
                rmSync(isolated);
                expectedSecret = "a";
            } else if (kind !== "conventional") {
                expectedSecret = null;
                if (kind === "wrong-owner") writeFileSync(isolated, credential("b", "cdcdcdcdcdcdcdcd"));
                if (kind === "invalid") writeFileSync(isolated, "{bad JSON");
                if (kind === "oversize") writeFileSync(isolated, " ".repeat(4097));
                if (kind === "explicit-missing") process.env.CCC_DEVICE_BROKER_AUTH_FILE = explicit;
                if (kind === "symlink") {
                    writeFileSync(linked, credential("b"));
                    rmSync(isolated);
                    directorySymlink(linked, isolated);
                }
                if (kind === "hardlink") linkSync(isolated, linked);
                if (kind === "missing-all") { rmSync(isolated); rmSync(legacy); }
            }
            const requests: { method: string; token: string | undefined }[] = [];
            const server = createServer((req, res) => {
                res.setHeader("content-type", "application/json");
                if (req.url === "/health") { res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" })); return; }
                if (sendCurrentBrokerStatus(req, res)) return;
                if (req.url === "/v1/owner/resolve") { res.end(JSON.stringify({ ok: true, result: { ownerId: owner } })); return; }
                const chunks: Buffer[] = [];
                req.on("data", chunk => chunks.push(chunk));
                req.on("end", () => {
                    const body = JSON.parse(Buffer.concat(chunks).toString());
                    requests.push({ method: body.method, token: req.headers["x-ccc-device-token"] as string | undefined });
                    res.end(JSON.stringify({ ok: true, result: { devices: [], backends: [] } }));
                });
            });
            await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
            const options = { hostCandidates: ["127.0.0.1"], port: (server.address() as AddressInfo).port, timeoutMs: 1000, autolaunch: false };
            try {
                const status = await withUnverifiedBrokerFixture(() => brokerStatus(options));
                expect(status.available).toBe(true);
                expect(status.rpcReady).toBe(expectedSecret !== null);
                for (const method of ["broker.inventory", "broker.backends"]) {
                    const result = await withUnverifiedBrokerFixture(() => brokerRpc({ ...options, method }));
                    expect(result.ok).toBe(expectedSecret !== null);
                    if (!expectedSecret) expect(result.error).toBe("broker-owner-auth-unavailable");
                }
                if (expectedSecret) {
                    const token = createHash("sha256").update(`ccc-device-broker:owner:${owner}:secret:${expectedSecret.repeat(64)}`).digest("hex");
                    expect(requests).toEqual([
                        { method: "broker.inventory", token }, { method: "broker.backends", token },
                    ]);
                } else expect(requests).toEqual([]);
            } finally {
                await new Promise<void>(resolve => server.close(() => resolve()));
                rmSync(root, { recursive: true, force: true });
                for (const path of [legacy, explicit, linked]) rmSync(path, { force: true });
                if (originalAuth === undefined) delete process.env.CCC_DEVICE_BROKER_AUTH_FILE;
                else process.env.CCC_DEVICE_BROKER_AUTH_FILE = originalAuth;
            }
        }

        it.each(["explicit", "conventional", "absent"])("authenticates inventory and backends with %s credential precedence", exercise);
        it.each(["wrong-owner", "invalid", "oversize", "explicit-missing", "missing-all"])("fails closed with truthful readiness for %s credentials", exercise);
        it.runIf(process.platform !== "win32").each(["symlink", "hardlink"])("refuses %s isolated credentials without falling back to valid legacy auth", exercise);
    });

    it("never creates or replaces owner auth secrets from the MCP client", async () => {
        const ownerId = "eeeeeeeeeeeeeeee";
        const authRoot = join(homeDir, ".ccc", "devices", "broker", "auth");
        const authFile = join(authRoot, `${ownerId}.json`);
        mkdirSync(authRoot, { recursive: true });
        const invalidAuth = JSON.stringify({ ownerId: "ffffffffffffffff", secret: "a".repeat(64), version: 1 });
        writeFileSync(authFile, invalidAuth);
        let rpcRequests = 0;
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/v1/owner/resolve" && req.method === "POST") {
                res.end(JSON.stringify({ ok: true, result: { ownerId } }));
                return;
            }
            rpcRequests += 1;
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: "unexpected-rpc" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;

        try {
            const result = await withUnverifiedBrokerFixture(() => brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 1000,
                autolaunch: false,
            }));
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                ownerId,
                error: "broker-owner-auth-unavailable",
            }));
            expect(rpcRequests).toBe(0);
            expect(readFileSync(authFile, "utf8")).toBe(invalidAuth);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it.runIf(process.platform !== "win32")("refuses symlinked owner auth secrets without issuing RPC", async () => {
        const ownerId = "dddddddddddddddd";
        const authRoot = join(homeDir, ".ccc", "devices", "broker", "auth");
        const authFile = join(authRoot, `${ownerId}.json`);
        const target = join(homeDir, "external-owner-auth.json");
        mkdirSync(authRoot, { recursive: true });
        writeFileSync(target, JSON.stringify({ ownerId, secret: "d".repeat(64), version: 1 }));
        symlinkSync(target, authFile);
        let rpcRequests = 0;
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/v1/owner/resolve" && req.method === "POST") {
                res.end(JSON.stringify({ ok: true, result: { ownerId } }));
                return;
            }
            rpcRequests += 1;
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: "unexpected-rpc" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;

        try {
            const result = await withUnverifiedBrokerFixture(() => brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 1000,
                autolaunch: false,
            }));
            expect(result).toEqual(expect.objectContaining({ ok: false, ownerId, error: "broker-owner-auth-unavailable" }));
            expect(rpcRequests).toBe(0);
            expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ ownerId, secret: "d".repeat(64), version: 1 }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it.runIf(process.platform !== "win32")("refuses owner auth secrets below a linked directory", async () => {
        const ownerId = "eeeeeeeeeeeeeeee";
        const brokerRoot = join(homeDir, ".ccc", "devices", "broker");
        const authRoot = join(brokerRoot, "auth");
        const externalRoot = join(homeDir, "external-owner-auth-directory");
        mkdirSync(brokerRoot, { recursive: true });
        mkdirSync(externalRoot);
        writeFileSync(join(externalRoot, `${ownerId}.json`), JSON.stringify({ ownerId, secret: "e".repeat(64), version: 1 }));
        rmSync(authRoot, { recursive: true, force: true });
        directorySymlink(externalRoot, authRoot);
        let rpcRequests = 0;
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/v1/owner/resolve" && req.method === "POST") {
                res.end(JSON.stringify({ ok: true, result: { ownerId } }));
                return;
            }
            rpcRequests += 1;
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: "unexpected-rpc" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;

        try {
            const result = await withUnverifiedBrokerFixture(() => brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 1000,
                autolaunch: false,
            }));
            expect(result).toEqual(expect.objectContaining({ ok: false, ownerId, error: "broker-owner-auth-unavailable" }));
            expect(rpcRequests).toBe(0);
            expect(JSON.parse(readFileSync(join(externalRoot, `${ownerId}.json`), "utf8"))).toEqual({
                ownerId,
                secret: "e".repeat(64),
                version: 1,
            });
        } finally {
            try {
                await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            } finally {
                rmSync(authRoot, { recursive: true, force: true });
                mkdirSync(authRoot, { recursive: true });
            }
        }
    });

    it("does not follow redirects while probing broker health", async () => {
        let redirectTargetRequests = 0;
        const redirectTarget = createServer((_req, res) => {
            redirectTargetRequests += 1;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
        });
        await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
        const redirectTargetPort = (redirectTarget.address() as AddressInfo).port;
        const server = createServer((_req, res) => {
            res.writeHead(302, { location: `http://127.0.0.1:${redirectTargetPort}/health` });
            res.end();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;

        try {
            const result = await brokerStatus({
                probe: true,
                autolaunch: false,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 1000,
            });
            expect(result).toEqual(expect.objectContaining({ available: false, rpcReady: false }));
            expect(result.probe.attempts).toEqual([
                expect.objectContaining({ ok: false, status: 302, error: "broker-redirect-disallowed" }),
            ]);
            expect(redirectTargetRequests).toBe(0);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await new Promise<void>((resolve, reject) => redirectTarget.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("keeps malformed broker raw diagnostics within 32 KiB", async () => {
        const server = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("가".repeat(20000));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;

        try {
            const result = await brokerStatus({
                probe: true,
                autolaunch: false,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 1000,
            });
            const raw = result.probe.attempts[0]?.body?.raw;
            expect(result.probe.attempts[0]).toEqual(expect.objectContaining({ error: "invalid-broker-json" }));
            expect(Buffer.byteLength(String(raw || ""), "utf8")).toBeLessThanOrEqual(32 * 1024);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("bounds chunked owner-resolve responses", async () => {
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        const server = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
            for (let sent = 0; sent <= BROKER_CONTROL_RESPONSE_LIMIT_BYTES; sent += chunk.length) res.write(chunk);
            res.end();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;

        try {
            const result = await withUnverifiedBrokerFixture(() => brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 3000,
                autolaunch: false,
            }));
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-response-too-large",
                ownerResolve: expect.objectContaining({ error: "broker-response-too-large" }),
                selected: expect.objectContaining({ status: 200, maxBytes: BROKER_CONTROL_RESPONSE_LIMIT_BYTES }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("rejects an oversized authenticated RPC response before body accumulation", async () => {
        const ownerId = "abababababababab";
        provisionTestOwnerSecret(ownerId);
        const server = createServer((req, res) => {
            if (req.method === "POST" && req.url === "/v1/owner/resolve") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, result: { ownerId } }));
                return;
            }
            res.writeHead(200, {
                "content-type": "application/json",
                "content-length": String(BROKER_RPC_RESPONSE_LIMIT_BYTES + 1),
            });
            res.end("{}");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;

        try {
            const result = await withUnverifiedBrokerFixture(() => brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 3000,
                autolaunch: false,
            }));
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                ownerId,
                error: "broker-response-too-large",
                status: 200,
                selected: expect.objectContaining({ status: 200, maxBytes: BROKER_RPC_RESPONSE_LIMIT_BYTES }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("rejects a screenshot RPC above its image-specific response limit", async () => {
        const ownerId = "bcbcbcbcbcbcbcbc";
        provisionTestOwnerSecret(ownerId);
        const server = createServer((req, res) => {
            if (req.method === "POST" && req.url === "/v1/owner/resolve") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, result: { ownerId } }));
                return;
            }
            res.writeHead(200, {
                "content-type": "application/json",
                "content-length": String(BROKER_RPC_SCREENSHOT_RESPONSE_LIMIT_BYTES + 1),
            });
            res.end("{}");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        try {
            const result = await withUnverifiedBrokerFixture(() => brokerDeviceTool({
                backend: "windows-vm", deviceId: "test-screenshot", tool: "device_screenshot",
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 3000,
                autolaunch: false,
            }));
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-response-too-large",
                selected: expect.objectContaining({ maxBytes: BROKER_RPC_SCREENSHOT_RESPONSE_LIMIT_BYTES }),
            }));
            // Other desktop providers keep the general RPC limit for their screenshots.
            const sandbox = await withUnverifiedBrokerFixture(() => brokerDeviceTool({
                backend: "windows-sandbox", deviceId: "test-screenshot", tool: "device_screenshot",
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 3000,
                autolaunch: false,
            }));
            expect(sandbox).not.toEqual(expect.objectContaining({ error: "broker-response-too-large" }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("uses the bounded Node HTTP transport for authenticated RPC instead of fetch", async () => {
        const ownerId = "acacacacacacacac";
        provisionTestOwnerSecret(ownerId);
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.method === "POST" && req.url === "/v1/owner/resolve") {
                res.end(JSON.stringify({ ok: true, result: { ownerId } }));
                return;
            }
            if (req.method === "POST" && req.url === `/v1/owners/${ownerId}/rpc`) {
                setTimeout(() => {
                    res.end(JSON.stringify({ ok: true, result: { value: "long-rpc-ok" } }));
                }, 100);
                return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: "not-found" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        const nativeFetch = globalThis.fetch.bind(globalThis);
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes(`/v1/owners/${ownerId}/rpc`)) {
                return Promise.reject(new Error("authenticated RPC must not use fetch"));
            }
            return nativeFetch(input, init);
        });

        try {
            const result = await withUnverifiedBrokerFixture(() => brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                rpcTimeoutMs: 1000,
                timeoutMs: 1000,
                autolaunch: false,
            }));
            expect(result).toEqual(expect.objectContaining({
                ok: true,
                ownerId,
                result: { value: "long-rpc-ok" },
                selected: expect.objectContaining({
                    status: 200,
                    timeoutMs: 1000,
                }),
            }));
            expect(fetchSpy.mock.calls.some(([input]) => {
                const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
                return url.includes(`/v1/owners/${ownerId}/rpc`);
            })).toBe(false);
        } finally {
            fetchSpy.mockRestore();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("destroys an indefinitely streaming authenticated RPC redirect without following it", async () => {
        const ownerId = TEST_BROKER_OWNER_ID;
        provisionTestOwnerSecret(ownerId);
        let redirectTargetRequests = 0;
        let redirectResponseClosed = false;
        const redirectTarget = createServer((_req, res) => {
            redirectTargetRequests += 1;
            res.end("unexpected");
        });
        await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
        const redirectTargetPort = (redirectTarget.address() as AddressInfo).port;
        const server = createServer((req, res) => {
            if (sendTestOwnerResolve(req, res)) return;
            res.writeHead(302, {
                location: `http://127.0.0.1:${redirectTargetPort}/token`,
                "transfer-encoding": "chunked",
            });
            const interval = setInterval(() => res.write("x".repeat(1024)), 5);
            res.once("close", () => {
                redirectResponseClosed = true;
                clearInterval(interval);
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;

        try {
            const result = await withUnverifiedBrokerFixture(() => brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                rpcTimeoutMs: 1000,
                timeoutMs: 1000,
                autolaunch: false,
            }));
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                ownerId,
                error: "broker-redirect-disallowed",
                status: 302,
            }));
            await vi.waitFor(() => expect(redirectResponseClosed).toBe(true));
            expect(redirectTargetRequests).toBe(0);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await new Promise<void>((resolve, reject) => redirectTarget.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("applies the absolute timeout while authenticated RPC response headers are pending", async () => {
        const ownerId = TEST_BROKER_OWNER_ID;
        provisionTestOwnerSecret(ownerId);
        const server = createServer((req, res) => {
            if (sendTestOwnerResolve(req, res)) return;
            setTimeout(() => {
                if (!res.destroyed) res.end(JSON.stringify({ ok: true, result: {} }));
            }, 500);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;

        try {
            const startedAt = Date.now();
            const result = await withUnverifiedBrokerFixture(() => brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                rpcTimeoutMs: 50,
                timeoutMs: 1000,
                autolaunch: false,
            }));
            expect(Date.now() - startedAt).toBeLessThan(500);
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                ownerId,
                error: "broker-rpc-unavailable",
                attempts: [
                    expect.objectContaining({
                        status: null,
                        error: "timeout",
                        timeoutMs: 50,
                    }),
                ],
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports an authenticated RPC response aborted after headers", async () => {
        const ownerId = TEST_BROKER_OWNER_ID;
        provisionTestOwnerSecret(ownerId);
        const server = createServer((req, res) => {
            if (sendTestOwnerResolve(req, res)) return;
            res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
            res.write('{"ok":true,"result":');
            res.destroy();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;

        try {
            const result = await withUnverifiedBrokerFixture(() => brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                rpcTimeoutMs: 1000,
                timeoutMs: 1000,
                autolaunch: false,
            }));
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                ownerId,
                error: "broker-rpc-unavailable",
                attempts: [
                    expect.objectContaining({
                        status: null,
                        error: expect.stringMatching(/aborted|socket hang up/),
                    }),
                ],
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    async function startCandidateDisconnectFixture(disconnect: "rpc" | "owner-resolve") {
        provisionTestOwnerSecret();
        const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
        let ownerResolveRequests = 0;
        let providerCreates = 0;
        const server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            req.on("end", () => {
                if (req.method === "POST" && req.url === "/v1/owner/resolve") {
                    ownerResolveRequests += 1;
                    if (disconnect === "owner-resolve" && ownerResolveRequests === 1) {
                        req.socket.destroy();
                        return;
                    }
                    sendTestOwnerResolve(req, res);
                    return;
                }
                if (req.method !== "POST" || req.url !== `/v1/owners/${TEST_BROKER_OWNER_ID}/rpc`) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ ok: false, error: "unexpected-fixture-request" }));
                    return;
                }
                const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof requests[number];
                requests.push(request);
                if (request.method === "broker.command.invoke" && request.params.command === "device_create"
                    && request.params.dryRun !== true) providerCreates += 1;
                if (disconnect === "rpc" && requests.length === 1) {
                    // The full POST was accepted and the birth completed before its response was lost.
                    req.socket.destroy();
                    return;
                }
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, result: { device: { id: `fixture-birth-${providerCreates}` }, completed: true } }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        return {
            requests,
            counts: () => ({ ownerResolveRequests, providerCreates }),
            // The production normalizer preserves both trusted candidate slots. Both reach this
            // controlled endpoint; the second would return success if the controller replayed.
            options: { hostCandidates: ["127.0.0.1", "127.0.0.1"], port, rpcTimeoutMs: 1000, timeoutMs: 1000, autolaunch: false },
            close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
        };
    }

    it.each([
        { label: "default clone", elapsed: 2500, limits: {}, expected: 627500 },
        { label: "shorter operation limit", elapsed: 1500, limits: { timeoutMs: 4000, rpcTimeoutMs: 9000 }, expected: 2500 },
        { label: "shorter RPC limit", elapsed: 1500, limits: { timeoutMs: 9000, rpcTimeoutMs: 4000 }, expected: 2500 },
        { label: "expired preflight", elapsed: 4001, limits: { timeoutMs: 4000, rpcTimeoutMs: 9000 }, expected: 0 },
    ])("regression: Tart $label spends owner preflight from the duration sent to the host", async ({ elapsed, limits, expected }) => {
        let clock = 1000;
        const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
        const server = createServer((req, res) => {
            if (req.method === "POST" && req.url === "/v1/owner/resolve") {
                clock += elapsed;
                sendTestOwnerResolve(req, res);
                return;
            }
            if (sendCurrentBrokerStatus(req, res)) return;
            const chunks: Buffer[] = [];
            req.on("data", chunk => chunks.push(Buffer.from(chunk)));
            req.on("end", () => {
                requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, result: { completed: true, device: { id: "macos-budget-fixture" } } }));
            });
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const monotonic = vi.spyOn(performance, "now").mockImplementation(() => clock);
        try {
            const result = await withUnverifiedBrokerFixture(() => brokerCommand({
                action: "invoke", backend: "macos-vm", command: "device_create", provider: "tart", image: "base-image", name: "Budget fixture",
                hostCandidates: ["127.0.0.1"], port: (server.address() as AddressInfo).port, autolaunch: false, ...limits,
            }));
            if (expected === 0) {
                expect(result.ok).toBe(false);
                expect(requests).toEqual([]);
            } else {
                expect(result.ok, JSON.stringify(result)).toBe(true);
                expect(requests).toHaveLength(1);
                expect(requests[0]).toMatchObject({ method: "broker.command.invoke", params: {
                    backend: "macos-vm", command: "device_create", image: "base-image", requestTimeoutMs: expected,
                } });
                expect(Number.isFinite(requests[0].params.requestTimeoutMs)).toBe(true);
                expect(Number(requests[0].params.requestTimeoutMs)).toBeGreaterThan(0);
                expect(Number(requests[0].params.requestTimeoutMs)).toBeLessThanOrEqual(630000);
                if (!("selected" in result) || !result.selected) throw new Error("successful-clone-response-missing-selected-transport");
                expect(result.selected.timeoutMs).toBeGreaterThan(0);
                expect(result.selected.timeoutMs).toBeLessThanOrEqual(expected);
            }
        } finally {
            monotonic.mockRestore();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    it.each([
        { operation: "write", provisioning: true }, { operation: "remove", provisioning: true },
        { operation: "write", provisioning: false }, { operation: "remove", provisioning: false },
    ])("regression: $operation runtime metadata lock spends active provisioning allowance=$provisioning", async ({ operation, provisioning }) => {
        const privateHome = mkdtempSync(join(tmpdir(), "ccc-tart-runtime-lock-"));
        const restoreEnvironment = isolateDeviceLabTestEnvironment(privateHome);
        const originalAuthRoot = isolatedAuthFixture.root;
        isolatedAuthFixture.root = join(privateHome, "absent-conventional-auth");
        const runtimeFile = join(privateHome, ".ccc", "devices", "broker", "runtime.json");
        const lockFile = `${runtimeFile}.lock`;
        let holder: Awaited<ReturnType<typeof holdRuntimeLockInChild>> | undefined;
        let rpcRequests = 0;
        const server = createServer((req, res) => {
            if (sendTestOwnerResolve(req, res) || sendCurrentBrokerStatus(req, res)) return;
            rpcRequests += 1;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, result: { completed: true } }));
        });
        try {
            await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
            const port = (server.address() as AddressInfo).port;
            const original = { ownerId: TEST_BROKER_OWNER_ID, managedBy: "ccc-host", pid: process.pid, host: "127.0.0.1", port,
                startedAt: "2026-10-21T00:00:00.000Z", processStartToken: "fixture-runtime-lock-generation" };
            const replacement = { ...original, startedAt: "2026-10-21T00:00:01.000Z" };
            mkdirSync(join(privateHome, ".ccc", "devices", "broker"), { recursive: true });
            writeFileSync(runtimeFile, JSON.stringify(original), { mode: 0o600 });
            const before = readFileSync(runtimeFile);
            holder = await holdRuntimeLockInChild(lockFile);
            const mutateRuntime = () => operation === "write" ? writeBrokerRuntimeForTest(replacement, original) : removeBrokerRuntimeForTest(original);
            if (provisioning) {
                let observedPreflight = false, mutation: boolean | undefined, failure: unknown;
                const result = await withUnverifiedBrokerFixture(() => brokerCommand({
                    action: "invoke", backend: "macos-vm", command: "device_create", provider: "tart", image: "base-image", name: "Contended runtime clone",
                    hostCandidates: ["127.0.0.1"], port, autolaunch: false, timeoutMs: 1000, rpcTimeoutMs: 1000,
                    verifyBeforeAuthenticatedRequest: () => {
                        observedPreflight = true;
                        expect(existsSync(lockFile)).toBe(true);
                        // Only this independent child can release while the synchronous lock waits.
                        holder!.releaseAfter(2500);
                        try { mutation = mutateRuntime(); } catch (error) { failure = error; }
                        return true;
                    },
                }));
                expect(observedPreflight, JSON.stringify(result)).toBe(true);
                expect(mutation === false || failure !== undefined).toBe(true);
                expect(readFileSync(runtimeFile)).toEqual(before);
                expect(result.ok).toBe(false);
                expect(rpcRequests).toBe(0);
            } else {
                holder.releaseAfter(100);
                expect(mutateRuntime()).toBe(true);
                if (operation === "write") expect(JSON.parse(readFileSync(runtimeFile, "utf8"))).toEqual(replacement);
                else expect(existsSync(runtimeFile)).toBe(false);
            }
        } finally {
            try { await holder?.close(); }
            finally {
                try { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
                finally { isolatedAuthFixture.root = originalAuthRoot; restoreEnvironment(); rmSync(privateHome, { recursive: true, force: true }); }
            }
        }
    });

    it.each(["windows-vm", "linux-vm", "macos-vm"])("does not replay a generated-ID %s birth across broker candidates after an accepted POST disconnects", async (backend) => {
        const fixture = await startCandidateDisconnectFixture("rpc");
        try {
            const result = await withUnverifiedBrokerFixture(() => brokerCommand({
                ...fixture.options,
                action: "invoke",
                backend,
                command: "device_create",
                name: "同じ VM display label",
                ...(backend === "macos-vm" ? { provider: "tart", image: "base-image" } : {}),
            }));
            expect(fixture.requests, JSON.stringify(result)).toHaveLength(1);
            expect(fixture.counts().providerCreates, JSON.stringify(result)).toBe(1);
            expect(fixture.requests[0]).toMatchObject({
                method: "broker.command.invoke",
                params: { backend, command: "device_create", name: "同じ VM display label" },
            });
            expect(fixture.requests[0].params).not.toHaveProperty("deviceId");
            expect(result).toMatchObject({
                ok: false,
                error: "broker-rpc-unavailable",
                attempts: [expect.objectContaining({
                    host: "127.0.0.1",
                    status: null,
                    error: expect.stringMatching(/aborted|socket hang up/),
                    transportCode: "connection-reset",
                    transportRetryable: true,
                })],
            });
            expect(result.attempts).toHaveLength(1);
            expect(result).not.toHaveProperty("transportRecovery");
        } finally {
            await fixture.close();
        }
    });

    it("allows broker candidate fallback before a VM birth POST is submitted", async () => {
        const fixture = await startCandidateDisconnectFixture("owner-resolve");
        try {
            const result = await withUnverifiedBrokerFixture(() => brokerCommand({
                ...fixture.options,
                action: "invoke",
                backend: "linux-vm",
                command: "device_create",
                name: "Linux discovery fallback",
            }));
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { completed: true } });
            expect(fixture.counts()).toEqual({ ownerResolveRequests: 2, providerCreates: 1 });
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0]).toMatchObject({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create" } });
            expect(result.attempts).toEqual([expect.objectContaining({ host: "127.0.0.1", status: 200, ok: true })]);
        } finally {
            await fixture.close();
        }
    });

    it.each([
        { label: "VM status", options: { action: "invoke", backend: "windows-vm", command: "device_status", deviceId: "win-existing" } },
        { label: "VM create dry run", options: { action: "invoke", backend: "linux-vm", command: "device_create", name: "Linux dry run", dryRun: true } },
        { label: "VM create plan", options: { action: "plan", backend: "macos-vm", command: "device_create", name: "Mac plan" } },
        { label: "non-VM creation", options: { action: "invoke", backend: "android-emulator", command: "device_create", deviceId: "android-existing-contract" } },
        { label: "read-only inventory", options: { method: "broker.inventory", params: {} } },
    ])("retains broker candidate fallback for $label after a disconnected RPC response", async ({ options }) => {
        const fixture = await startCandidateDisconnectFixture("rpc");
        try {
            const result = await withUnverifiedBrokerFixture(() => "method" in options
                ? brokerRpc({ ...fixture.options, ...options })
                : brokerCommand({ ...fixture.options, ...options }));
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { completed: true } });
            expect(fixture.requests).toHaveLength(2);
            expect(fixture.requests[1]).toEqual(fixture.requests[0]);
            expect(result.attempts).toEqual([
                expect.objectContaining({ host: "127.0.0.1", status: null, transportRetryable: true }),
                expect.objectContaining({ host: "127.0.0.1", status: 200, ok: true }),
            ]);
            expect(fixture.counts().providerCreates).toBe("backend" in options && options.backend === "android-emulator" ? 2 : 0);
        } finally {
            await fixture.close();
        }
    });

    it("does not replay a non-Hyper-V RPC after a transport disconnect", async () => {
        const ownerId = TEST_BROKER_OWNER_ID;
        provisionTestOwnerSecret(ownerId);
        let rpcRequests = 0;
        const server = createServer((req, res) => {
            if (sendTestOwnerResolve(req, res)) return;
            rpcRequests += 1;
            req.socket.destroy();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;

        try {
            const result = await withUnverifiedBrokerFixture(() => brokerCommand({
                action: "invoke",
                backend: "android-emulator",
                command: "device_create",
                deviceId: "no-retry",
                hostCandidates: ["127.0.0.1"],
                port,
                rpcTimeoutMs: 1000,
                timeoutMs: 1000,
                autolaunch: false,
            }));
            expect(rpcRequests).toBe(1);
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-rpc-unavailable",
            }));
            expect(result).not.toHaveProperty("transportRecovery");
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports disconnected generated-ID Windows creation without a blind second birth", async () => {
        const ownerId = TEST_BROKER_OWNER_ID;
        provisionTestOwnerSecret(ownerId);
        let rpcRequests = 0;
        const server = createServer((req, res) => {
            if (sendTestOwnerResolve(req, res)) return;
            rpcRequests += 1;
            req.socket.destroy();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;

        try {
            const result = await withUnverifiedBrokerFixture(() => brokerCommand({
                action: "invoke",
                backend: "windows-vm",
                command: "device_create",
                name: "Windows retry display label",
                hostCandidates: ["127.0.0.1"],
                port,
                rpcTimeoutMs: 1000,
                timeoutMs: 1000,
                autolaunch: false,
            }));
            expect(rpcRequests).toBe(1);
            expect(result).toMatchObject({ ok: false, error: "broker-rpc-unavailable" });
            expect(result).not.toHaveProperty("transportRecovery");
            expect(result.attempts).toHaveLength(1);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("uses shared ccc-host runtime metadata for zero-config broker status", { timeout: TIMEOUT }, async () => {
        const initial = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: false, autolaunch: false } });
        const initialPayload = JSON.parse(((initial.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            state: { runtimeFile: string };
        };
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION } }));
                return;
            }
            if (sendTestOwnerResolve(req, res)) return;
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: "not-found" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(initialPayload.state.runtimeFile, JSON.stringify({
            ownerId: "0000000000000000",
            pid: process.pid,
            host: "0.0.0.0",
            probeHost: "127.0.0.1",
            hostCandidates: ["127.0.0.1"],
            port: address.port,
            managedBy: "ccc-host",
            version: "1.1.61",
        }));

        try {
            const result = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: true } });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                mode: string;
                available: boolean;
                rpcReady: boolean;
                transport: { defaultPort: number };
                ownerResolve: { ok: boolean; ownerId: string };
                launch: { ok: boolean; reused: boolean; port: number };
            };
            expect(payload).toEqual(expect.objectContaining({
                mode: "host-broker-detected",
                available: true,
                rpcReady: true,
            }));
            expect(payload.transport.defaultPort).toBe(address.port);
            expect(payload.ownerResolve).toEqual(expect.objectContaining({ ok: true, ownerId: TEST_BROKER_OWNER_ID }));
            expect(payload.launch).toEqual(expect.objectContaining({ ok: true, reused: true, port: address.port }));
        } finally {
            rmSync(initialPayload.state.runtimeFile, { force: true });
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reuses the current protocol host broker regardless of package version", { timeout: TIMEOUT }, async () => {
        const initial = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: false, autolaunch: false } });
        const initialPayload = JSON.parse(((initial.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            state: { runtimeFile: string };
        };
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.end(JSON.stringify({ ok: true, broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION, version: "999.0.0" } }));
                return;
            }
            if (sendTestOwnerResolve(req, res)) return;
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: "not-found" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(initialPayload.state.runtimeFile, JSON.stringify({
            ownerId: "0000000000000000",
            pid: process.pid,
            host: "0.0.0.0",
            probeHost: "127.0.0.1",
            hostCandidates: ["127.0.0.1"],
            port: address.port,
            managedBy: "ccc-host",
        }));

        try {
            const result = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: true } });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                mode: string;
                rpcReady: boolean;
                launch: { ok: boolean; reused: boolean; port: number };
                warnings: string[];
            };
            expect(payload).toEqual(expect.objectContaining({ mode: "host-broker-detected", rpcReady: true }));
            expect(payload.launch).toEqual(expect.objectContaining({ ok: true, reused: true, port: address.port }));
            expect(payload.warnings.join(" ")).not.toContain("missing required capabilities");
        } finally {
            rmSync(initialPayload.state.runtimeFile, { force: true });
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it.each([undefined, 4, 5, 6, 7])("rejects an older ccc-host runtime with protocol %s through actual compatibility verification", { timeout: TIMEOUT }, async protocolVersion => {
        const initial = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: false, autolaunch: false } });
        const initialPayload = JSON.parse(((initial.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            state: { runtimeFile: string };
        };
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.end(JSON.stringify({ ok: true, broker: { protocolVersion, implemented: [] } }));
                return;
            }
            if (sendTestOwnerResolve(req, res)) return;
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: "not-found" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(initialPayload.state.runtimeFile, JSON.stringify({
            ownerId: "0000000000000000",
            pid: process.pid,
            host: "127.0.0.1",
            hostCandidates: ["127.0.0.1"],
            port: address.port,
            managedBy: "ccc-host",
        }));

        try {
            const result = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: true } });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                mode: string;
                available: boolean;
                rpcReady: boolean;
                launch: { ok: boolean; error: string; compatibility: { missingCapabilities: string[] } };
                warnings: string[];
            };
            expect(payload).toEqual(expect.objectContaining({
                mode: "broker-incompatible",
                available: false,
                rpcReady: false,
                launch: expect.objectContaining({
                    ok: false,
                    error: "host-broker-incompatible",
                    compatibility: expect.objectContaining({
                        protocolVersion: protocolVersion ?? null, expectedProtocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
                    }),
                }),
            }));
            expect(payload.warnings.join(" ")).toContain("protocol mismatch");
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(initialPayload.state.runtimeFile, { force: true });
        }
    });

    it("does not signal a PID claimed by incompatible MCP runtime metadata", { timeout: TIMEOUT }, async () => {
        const initial = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: false, autolaunch: false } });
        const initialPayload = JSON.parse(((initial.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            state: { runtimeFile: string };
        };
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (sendCurrentBrokerStatus(req, res)) return;
            if (req.method === "POST" && req.url === "/v1/owner/resolve") {
                res.statusCode = 409;
                res.end(JSON.stringify({ ok: false, error: "owner-resolve-incompatible" }));
                return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: "not-found" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        const forgedRuntime = {
            ownerId: initialPayload.ownerId,
            pid: process.pid,
            host: "127.0.0.1",
            port,
            managedBy: "device-lab-mcp",
        };
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(initialPayload.state.runtimeFile, JSON.stringify(forgedRuntime));

        try {
            const result = await callInternalBroker(client, { operation: "brokerStatus",
                arguments: { probe: true, autolaunch: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
            });
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                launch: { ok: boolean; error: string; attempts: Array<{ termination?: { reason?: string } }> };
            };
            expect(payload.launch).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-runtime-process-unverified",
            }));
            expect(JSON.stringify(payload.launch.attempts)).toContain("unverified-broker-port-process");
            expect(JSON.parse(readFileSync(initialPayload.state.runtimeFile, "utf8"))).toEqual(forgedRuntime);
        } finally {
            rmSync(initialPayload.state.runtimeFile, { force: true });
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it.runIf(process.platform !== "win32")("refuses to overwrite unreadable linked MCP runtime evidence", { timeout: TIMEOUT }, async () => {
        const initial = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: false, autolaunch: false } });
        const initialPayload = JSON.parse(((initial.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            state: { runtimeFile: string };
        };
        const runtimeFile = initialPayload.state.runtimeFile;
        const external = join(homeDir, "external-linked-runtime.json");
        const externalBytes = JSON.stringify({ preserve: true });
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(external, externalBytes);
        rmSync(runtimeFile, { force: true });
        symlinkSync(external, runtimeFile);

        const port = await freePort();
        const logPath = join(homeDir, "fake-linked-runtime-broker.log");
        installFakeCccBroker(pathDir, logPath);
        let launchedPid: number | null = null;
        try {
            const result = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    params: { linkedRuntime: true },
                    autolaunch: true,
                    hostCandidates: ["127.0.0.1"],
                    port,
                    timeoutMs: 300,
                    launchTimeoutMs: 3000,
                },
            });
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                launch: { runtime: { pid: number } };
            };
            expect(payload.ok).toBe(false);
            launchedPid = payload.launch.runtime?.pid ?? null;
            expect(readFileSync(external, "utf8")).toBe(externalBytes);
            expect(lstatSync(runtimeFile).isSymbolicLink()).toBe(true);
        } finally {
            if (launchedPid && pidAlive(launchedPid)) process.kill(launchedPid, "SIGTERM");
            rmSync(runtimeFile, { force: true });
        }
    });

    it.runIf(process.platform !== "win32")("refuses MCP broker autolaunch through a linked log directory", { timeout: TIMEOUT }, async () => {
        const initial = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: false, autolaunch: false } });
        const initialPayload = JSON.parse(((initial.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            state: { runtimeFile: string; logsRoot: string };
        };
        const externalDirectory = join(homeDir, "external-mcp-broker-logs");
        const marker = join(externalDirectory, "preserve.txt");
        rmSync(initialPayload.state.runtimeFile, { force: true });
        rmSync(initialPayload.state.logsRoot, { recursive: true, force: true });
        mkdirSync(externalDirectory, { recursive: true });
        writeFileSync(marker, "preserve");
        directorySymlink(externalDirectory, initialPayload.state.logsRoot);
        const port = await freePort();
        const launchLog = join(homeDir, "linked-log-launch-attempt.log");
        installFakeCccBroker(pathDir, launchLog);

        try {
            const result = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    params: { linkedLogs: true },
                    autolaunch: true,
                    hostCandidates: ["127.0.0.1"],
                    port,
                    timeoutMs: 300,
                    launchTimeoutMs: 1000,
                },
            });
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                launch: { ok: boolean; error: string; detail: string };
            };
            expect(payload.ok).toBe(false);
            expect(payload.launch).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-launch-failed",
                detail: "broker-log-directory-invalid",
            }));
            expect(existsSync(launchLog)).toBe(false);
            expect(readFileSync(marker, "utf8")).toBe("preserve");
        } finally {
            rmSync(initialPayload.state.logsRoot, { force: true });
            mkdirSync(initialPayload.state.logsRoot, { recursive: true });
        }
    });

    it("reads only a bounded regular MCP broker log tail", () => {
        const logsRoot = join(homeDir, ".ccc", "devices", "broker", "logs");
        const logPath = join(logsRoot, "bounded-tail.log");
        mkdirSync(logsRoot, { recursive: true });
        writeFileSync(logPath, `${"a".repeat(2 * 1024 * 1024)}broker-tail-marker`);

        const tail = brokerLogTail(logPath);

        expect(tail).toHaveLength(1000);
        expect(tail).toMatch(/broker-tail-marker$/);
    });

    it.runIf(process.platform !== "win32")("does not read an MCP broker log through a linked file", () => {
        const logsRoot = join(homeDir, ".ccc", "devices", "broker", "logs");
        const external = join(homeDir, "external-broker-log.txt");
        const linkedLog = join(logsRoot, "linked.log");
        mkdirSync(logsRoot, { recursive: true });
        writeFileSync(external, "external-secret-diagnostic");
        symlinkSync(external, linkedLog);

        expect(brokerLogTail(linkedLog)).toBe("");
        expect(brokerLogTail(external)).toBe("");
        expect(readFileSync(external, "utf8")).toBe("external-secret-diagnostic");
    });

    it.each(["source", "built"] as const)("%s MCP autolaunches and reuses the actual broker entry with parent-owned metadata", { timeout: TIMEOUT }, async entry => {
        const port = await freePort();
        const expectedOwner = deviceLabMcpOwnerId({}, repoRoot);
        let internalBrokerModuleUrl: string | undefined;
        if (entry === "built") {
            const apiRoot = join(homeDir, `built-owner-lifecycle-${port}`);
            const apiFile = join(apiRoot, "broker-api.mjs");
            mkdirSync(apiRoot, { recursive: true });
            // Preserve native import.meta.resolve dependencies of the bundled
            // owner lifecycle; only generated fixture output goes in this home.
            symlinkSync(join(repoRoot, "node_modules"), join(apiRoot, "node_modules"), "junction");
            await bundleBrokerApi({
                absWorkingDir: join(repoRoot, "device-lab-mcp"), entryPoints: ["src/broker.mjs"],
                outfile: apiFile, bundle: true, platform: "node", format: "esm",
                banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
            });
            internalBrokerModuleUrl = pathToFileURL(apiFile).href;
        }
        const isolated = await createDeviceLabMcpTestContext({
            rawPublicCalls: true,
            serverPath: entry === "source" ? join(repoRoot, "device-lab-mcp", "server.mjs") : join(repoRoot, "dist", "device-lab-mcp", "server.mjs"),
            internalBrokerModuleUrl,
            env: { CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER: "0" },
            setupHome: home => {
                // Route the public, argument-free discovery to this private port.
                // A dead prior generation is replaced by the actual MCP launcher;
                // this context has no fake ccc or substitute broker-entry file.
                const root = join(home, ".ccc", "devices", "broker");
                mkdirSync(root, { recursive: true });
                writeFileSync(join(root, "runtime.json"), JSON.stringify({
                    name: "ccc-device-broker", managedBy: "ccc-host", ownerId: expectedOwner,
                    pid: 987654321, host: "127.0.0.1", port,
                }), { mode: 0o600 });
                const traceFile = join(home, "broker-observation-trace.jsonl");
                writeFileSync(traceFile, "", { mode: 0o600 });
                appendFileSync(join(home, "isolate-broker-auth.cjs"), brokerObservationTracePreloadSource({
                    port, runtimeFile: join(root, "runtime.json"), traceFile,
                }));
            },
        });
        const runtimeFile = join(isolated.homeDir, ".ccc", "devices", "broker", "runtime.json");
        const traceFile = join(isolated.homeDir, "broker-observation-trace.jsonl");
        let brokerPid: number | undefined;
        try {
            const first = await isolated.client.callTool({ name: "devices", arguments: { view: "owned", detail: true } });
            expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
            const value = JSON.parse((first.content as Array<{ text?: string }>)[0].text || "{}");
            expect(value).toEqual(expect.objectContaining({ ownerId: expectedOwner, routedBy: "device-list-broker-implicit" }));
            const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
            brokerPid = runtime.pid;
            expect(runtime).toEqual(expect.objectContaining({
                managedBy: "device-lab-mcp", ownerId: expectedOwner, port,
                pid: expect.any(Number), processStartToken: expect.any(String),
                args: [expect.stringContaining("broker-entry.js"), "devices", "broker", "serve", "--host", "127.0.0.1", "--port", String(port), "--runtime-managed-by-parent"],
            }));
            expect(runtime.pid).not.toBe(987654321);
            expect(pidAlive(runtime.pid)).toBe(true);

            const second = await isolated.client.callTool({ name: "devices", arguments: { view: "owned", detail: true } });
            expect(second.isError, JSON.stringify(second.content)).not.toBe(true);
            expect(JSON.parse(readFileSync(runtimeFile, "utf8"))).toEqual(expect.objectContaining({
                managedBy: "device-lab-mcp", pid: brokerPid, processStartToken: runtime.processStartToken,
            }));
            const status = await callInternalBroker(isolated.client, { operation: "brokerStatus", arguments: {
                hostCandidates: ["127.0.0.1"], port, timeoutMs: 1000,
            } });
            expect(JSON.parse((status.content as Array<{ text?: string }>)[0].text || "{}")).toEqual(expect.objectContaining({
                rpcReady: true, launch: expect.objectContaining({ launched: false, reused: true }),
                runtime: expect.objectContaining({ managedBy: "device-lab-mcp", pid: brokerPid }),
            }));

            expect(pidAlive(brokerPid!)).toBe(true);
            writeFileSync(traceFile, "", { mode: 0o600 });
            const shutdown = await callInternalBroker(isolated.client, { operation: "brokerShutdown", arguments: {
                confirmDestructive: true, stopDevices: false, detachPhysical: false,
            } });
            try {
                expect(JSON.parse((shutdown.content as Array<{ text?: string }>)[0].text || "{}")).toEqual(expect.objectContaining({
                    ok: true, stopped: true, runtime: expect.objectContaining({ managedBy: "device-lab-mcp", pid: brokerPid }),
                    cleanup: expect.objectContaining({ ok: true, method: "broker.cleanup.owner" }),
                }));
            } catch (error) {
                if (error instanceof Error) error.message += `\n${readBrokerObservationTrace(traceFile)}`;
                throw error;
            }
            expect(existsSync(runtimeFile)).toBe(false);
            // Shutdown and the parent's process reaping can finish on separate turns.
            await vi.waitFor(() => expect(pidAlive(brokerPid!)).toBe(false), { timeout: 3000 });
        } finally {
            await cleanupDeviceLabMcpTestContext(isolated);
            if (brokerPid) expect(await waitForHealthUnavailable(port)).toBe(true);
        }
    });

    it("autolaunches, reuses, routes RPC/lease/command, and shuts down an MCP-owned broker", { timeout: TIMEOUT }, async () => {
        const port = await freePort();
        const logPath = join(homeDir, "fake-ccc-broker.log");
        installFakeCccBroker(pathDir, logPath);

        const first = await callInternalBroker(client, { operation: "brokerRpc",
            arguments: {
                method: "broker.echo",
                params: { hello: "broker" },
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
                launchTimeoutMs: 3000,
            },
        });
        expect(first.isError).not.toBe(true);
        const firstPayload = JSON.parse(((first.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            result: { echo: { hello: string } };
            launch: { launched: boolean; reused: boolean; runtime: { pid: number; ownerId: string; logPath: string; command: string; args: string[] } };
        };
        expect(firstPayload.ok).toBe(true);
        expect(firstPayload.result.echo).toEqual({ hello: "broker" });
        expect(firstPayload.launch).toEqual(expect.objectContaining({ launched: true, reused: false }));
        expect(firstPayload.launch.runtime).toEqual(expect.objectContaining({
            pid: expect.any(Number),
            ownerId: expect.stringMatching(/^[a-f0-9]{16}$/),
            logPath: expect.stringContaining("broker-"),
            command: process.execPath,
            args: [expect.stringContaining("broker-entry.js"), "devices", "broker", "serve", "--host", "127.0.0.1", "--port", String(port), "--runtime-managed-by-parent"],
        }));

        const status = await callInternalBroker(client, { operation: "brokerStatus",
            arguments: { probe: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            available: boolean;
            runtime: { pid: number; port: number; managedBy: string };
            state: { runtimeFile: string };
        };
        expect(statusPayload.available).toBe(true);
        expect(statusPayload.runtime).toEqual(expect.objectContaining({
            pid: firstPayload.launch.runtime.pid,
            port,
            managedBy: "device-lab-mcp",
        }));
        expect(existsSync(statusPayload.state.runtimeFile)).toBe(true);

        const second = await callInternalBroker(client, { operation: "brokerRpc",
            arguments: {
                method: "broker.echo",
                params: { reuse: true },
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
                launchTimeoutMs: 3000,
            },
        });
        const secondPayload = JSON.parse(((second.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            launch: { launched: boolean; reused: boolean };
        };
        expect(secondPayload.ok).toBe(true);
        expect(secondPayload.launch).toEqual(expect.objectContaining({ launched: false, reused: true }));
        let brokerLog = readFileSync(logPath, "utf8");
        expect(brokerLog.trim().split("\n").filter((line) => line.startsWith("[\"devices\",\"broker\",\"serve\""))).toHaveLength(1);
        expect(brokerLog).toContain(`auth-ok ${firstPayload.launch.runtime.ownerId}`);

        const lease = await callInternalBroker(client, { operation: "brokerLease",
            arguments: { action: "list", backend: "android-device", autolaunch: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        expect(JSON.parse(((lease.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({ backend: "android-device", leases: [] }),
        }));

        const attach = await callInternalBroker(client, { operation: "brokerPhysical",
            arguments: {
                action: "attach",
                backend: "android-device",
                deviceId: "android-broker-real",
                serial: "USB123",
                connection: "usb",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
            },
        });
        expect(JSON.parse(((attach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({
                device: expect.objectContaining({ id: "android-broker-real", backend: "android-device", serial: "USB123" }),
            }),
        }));

        const attachList = await callInternalBroker(client, { operation: "brokerPhysical",
            arguments: { action: "list", backend: "android-device", autolaunch: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        expect(JSON.parse(((attachList.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({ backend: "android-device", devices: [], leases: [] }),
        }));

        const detach = await callInternalBroker(client, { operation: "brokerPhysical",
            arguments: { action: "detach", backend: "android-device", deviceId: "android-broker-real", autolaunch: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        expect(JSON.parse(((detach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({ detached: "android-broker-real", physicalDevicePoweredOff: false }),
        }));

        const command = await callInternalBroker(client, { operation: "brokerCommand",
            arguments: {
                action: "plan",
                backend: "windows-sandbox",
                command: "device_start",
                deviceId: "win-autolaunch",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
            },
        });
        expect(JSON.parse(((command.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({
                backend: "windows-sandbox",
                deviceId: "win-autolaunch",
                execution: expect.objectContaining({ mode: "planned" }),
            }),
        }));

        mkdirSync(join(homeDir, ".ccc/devices/owners", firstPayload.launch.runtime.ownerId, "windows"), { recursive: true });
        writeFileSync(join(homeDir, ".ccc/devices/owners", firstPayload.launch.runtime.ownerId, "windows", "devices.json"), JSON.stringify({
            devices: [{ id: "win-autolaunch", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/win-autolaunch.wsb" }],
        }));
        const brokerFlagCommand = await client.callTool({
            name: "status",
            arguments: {
                broker: true,
                deviceId: "win-autolaunch",
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
            },
        });
        expect(JSON.parse(((brokerFlagCommand.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                backend: "windows-sandbox",
                command: "device_status",
                deviceId: "win-autolaunch",
                invoked: true,
            routedBy: "device-lifecycle-broker-implicit",
        }));

        // This fixture verifies transport routing; its static inventory never boots a guest.
        const lifecycleStart = await client.callTool({
            name: "start",
            arguments: {
                deviceId: "win-autolaunch",
                waitForBoot: false,
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
            },
        });
        expect(JSON.parse(((lifecycleStart.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                backend: "windows-sandbox",
                command: "device_start",
                deviceId: "win-autolaunch",
                invoked: true,
                execution: expect.objectContaining({ mode: "exec", providerExecution: "fake" }),
        }));

        const shutdown = await callInternalBroker(client, { operation: "brokerShutdown", arguments: { confirmDestructive: true } });
        expect(JSON.parse(((shutdown.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            stopped: true,
            runtime: expect.objectContaining({ pid: firstPayload.launch.runtime.pid }),
            cleanup: expect.objectContaining({
                ok: true,
                method: "broker.cleanup.owner",
                result: expect.objectContaining({ cleaned: true, ownerId: firstPayload.launch.runtime.ownerId }),
            }),
        }));
        expect(existsSync(statusPayload.state.runtimeFile)).toBe(false);
        brokerLog = readFileSync(logPath, "utf8");
        expect(brokerLog).toContain(`auth-ok ${firstPayload.launch.runtime.ownerId}`);
        expect(brokerLog).toContain(`cleanup-owner ${firstPayload.launch.runtime.ownerId}`);
        rmSync(join(homeDir, ".ccc/devices/owners", firstPayload.launch.runtime.ownerId, "windows"), { recursive: true, force: true });
    });

    it.skipIf(process.platform === "win32")("preserves runtime metadata when explicit broker shutdown times out", { timeout: TIMEOUT }, async () => {
        const port = await freePort();
        const logPath = join(homeDir, "fake-ccc-broker-ignore.log");
        installIgnoringCccBroker(pathDir, logPath);
        const launched = await callInternalBroker(client, { operation: "brokerRpc",
            arguments: {
                method: "broker.echo",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
                launchTimeoutMs: 3000,
            },
        });
        const launchedPayload = JSON.parse(((launched.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            launch: { runtime: { pid: number } };
        };
        expect(launchedPayload.ok).toBe(true);
        const status = await callInternalBroker(client, { operation: "brokerStatus",
            arguments: { probe: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as { state: { runtimeFile: string } };

        const shutdown = await callInternalBroker(client, { operation: "brokerShutdown", arguments: { confirmDestructive: true } });
        expect(JSON.parse(((shutdown.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-shutdown-timeout",
            stopped: false,
            runtime: expect.objectContaining({ pid: launchedPayload.launch.runtime.pid }),
        }));
        expect(existsSync(statusPayload.state.runtimeFile)).toBe(true);
        process.kill(launchedPayload.launch.runtime.pid, "SIGKILL");
        rmSync(statusPayload.state.runtimeFile, { force: true });
    });

    it("reports owner cleanup failure during broker shutdown while still stopping the MCP-owned broker", { timeout: TIMEOUT }, async () => {
        const port = await freePort();
        const logPath = join(homeDir, "fake-ccc-broker-cleanup-fail.log");
        installFakeCccBroker(pathDir, logPath, { cleanupOk: false });
        const launched = await callInternalBroker(client, { operation: "brokerRpc",
            arguments: {
                method: "broker.echo",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
                launchTimeoutMs: 3000,
            },
        });
        const launchedPayload = JSON.parse(((launched.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            launch: { runtime: { pid: number; ownerId: string } };
        };
        expect(launchedPayload.ok).toBe(true);
        const status = await callInternalBroker(client, { operation: "brokerStatus",
            arguments: { probe: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as { state: { runtimeFile: string } };

        const shutdown = await callInternalBroker(client, { operation: "brokerShutdown", arguments: { confirmDestructive: true } });
        expect(JSON.parse(((shutdown.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-owner-cleanup-failed",
            stopped: true,
            cleanup: expect.objectContaining({
                ok: true,
                method: "broker.cleanup.owner",
                result: expect.objectContaining({ failed: 1 }),
            }),
        }));
        expect(existsSync(statusPayload.state.runtimeFile)).toBe(false);
        const brokerLog = readFileSync(logPath, "utf8");
        expect(brokerLog).toContain(`cleanup-owner ${launchedPayload.launch.runtime.ownerId}`);
    });

    it("reports owner cleanup timeout during broker shutdown while still stopping the MCP-owned broker", { timeout: TIMEOUT }, async () => {
        const port = await freePort();
        const logPath = join(homeDir, "fake-ccc-broker-cleanup-timeout.log");
        installFakeCccBroker(pathDir, logPath, { cleanupMode: "hang" });
        const launched = await callInternalBroker(client, { operation: "brokerRpc",
            arguments: {
                method: "broker.echo",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
                launchTimeoutMs: 3000,
            },
        });
        const launchedPayload = JSON.parse(((launched.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            launch: { runtime: { pid: number; ownerId: string } };
        };
        expect(launchedPayload.ok).toBe(true);
        const status = await callInternalBroker(client, { operation: "brokerStatus",
            arguments: { probe: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as { state: { runtimeFile: string } };

        const shutdown = await callInternalBroker(client, { operation: "brokerShutdown", arguments: { cleanupTimeoutMs: 200, confirmDestructive: true } });
        expect(JSON.parse(((shutdown.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-owner-cleanup-failed",
            stopped: true,
            cleanup: expect.objectContaining({
                ok: false,
                method: "broker.cleanup.owner",
                error: "broker-rpc-unavailable",
                attempts: [expect.objectContaining({ error: "timeout" })],
            }),
        }));
        expect(existsSync(statusPayload.state.runtimeFile)).toBe(false);
        expect(await waitForHealthUnavailable(port)).toBe(true);
        const brokerLog = readFileSync(logPath, "utf8");
        expect(brokerLog).toContain(`cleanup-owner ${launchedPayload.launch.runtime.ownerId}`);
    });

    it.skipIf(process.platform === "win32")("cleans an MCP-owned broker child on MCP process SIGTERM", { timeout: TIMEOUT }, async () => {
        const signalHome = mkdtempSync(join(tmpdir(), "ccc-device-lab-signal-"));
        const signalBin = join(signalHome, "bin");
        mkdirSync(signalBin, { recursive: true });
        const port = await freePort();
        const fakeCcc = join(signalBin, "ccc");
        writeFileSync(fakeCcc, `#!${process.execPath}
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const args = process.argv.slice(2);
const host = args[args.indexOf("--host") + 1] || "127.0.0.1";
const port = Number(args[args.indexOf("--port") + 1] || 17373);
const startedAt = new Date().toISOString();
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function provisionOwnerSecret(ownerId) {
  const file = path.join(os.homedir(), ".ccc/devices/broker/auth", ownerId + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ ownerId, secret: crypto.randomBytes(32).toString("hex"), version: 1 }), { mode: 0o600 });
}
const server = http.createServer((req, res) => {
  if (req.url === "/health") return send(res, 200, { ok: true, name: "ccc-device-broker" });
  if (req.url === "/status") return send(res, 200, { ok: true, broker: { name: "ccc-device-broker", mode: "host-broker-daemon", host, port, process: { pid: process.pid }, startedAt, protocolVersion: ${JSON.stringify(DEVICE_BROKER_PROTOCOL_VERSION)} } });
  if (req.url === "/v1/owner/resolve" && req.method === "POST") {
    const ownerId = ${JSON.stringify(TEST_BROKER_OWNER_ID)};
    provisionOwnerSecret(ownerId);
    return send(res, 200, { ok: true, result: { ownerId } });
  }
  return send(res, 200, { ok: true, result: {} });
});
server.listen(port, host);
process.on("SIGTERM", () => {});
`);
        chmodSync(fakeCcc, 0o755);
        const adapterRoot = join(signalHome, "adapter");
        cpSync(join(homeDir, "adapter"), adapterRoot, { recursive: true });
        const entry = join(adapterRoot, "node_modules", "@ccc", "device-lab", "dist", "broker-entry.js");
        writeFileSync(entry, readFileSync(entry, "utf8").replace(JSON.stringify(join(pathDir, "ccc")), JSON.stringify(fakeCcc)));
        const script = join(signalHome, "launch-broker.mjs");
        writeFileSync(script, `
import { brokerRpc } from ${JSON.stringify(pathToFileURL(join(adapterRoot, "src/broker.mjs")).href)};
const result = await brokerRpc({ method: "broker.echo", autolaunch: true, hostCandidates: ["127.0.0.1"], port: ${port}, timeoutMs: 300, launchTimeoutMs: 3000 });
process.stdout.write(JSON.stringify(result.launch.runtime) + "\\n");
setInterval(() => {}, 1000);
`);
        const child = spawn(process.execPath, [script], {
            cwd: repoRoot,
            env: { ...process.env, ...deviceLabTestHomeEnvironment(signalHome), PATH: signalBin },
            stdio: ["ignore", "pipe", "pipe"],
        });
        try {
            let stdout = "";
            const runtime = await new Promise<{ pid: number }>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`timeout waiting for signal child stdout: ${stdout}`)), 5000);
                child.stdout?.on("data", (chunk) => {
                    stdout += chunk.toString();
                    const line = stdout.trim().split("\n").find(Boolean);
                    if (line) {
                        clearTimeout(timer);
                        resolve(JSON.parse(line));
                    }
                });
                child.once("error", reject);
                child.once("exit", (code) => {
                    if (!stdout.trim()) {
                        clearTimeout(timer);
                        reject(new Error(`signal child exited before reporting runtime: ${code}`));
                    }
                });
            });
            expect(pidAlive(runtime.pid)).toBe(true);
            child.kill("SIGTERM");
            await new Promise<void>((resolve) => child.once("exit", () => resolve()));
            expect(await waitForHealthUnavailable(port)).toBe(true);
            expect(existsSync(join(signalHome, ".ccc/devices/broker/runtime.json"))).toBe(false);
        } finally {
            if (child.exitCode === null) child.kill("SIGKILL");
            rmSync(signalHome, { recursive: true, force: true });
        }
    });

    it("cleans stale broker runtime metadata and reports launch failures", { timeout: TIMEOUT }, async () => {
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: {} });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            state: { runtimeFile: string };
        };
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify({
            ownerId: statusPayload.ownerId,
            pid: 99999999,
            host: "127.0.0.1",
            port: 65530,
            managedBy: "device-lab-mcp",
        }));
        writeFileSync(join(pathDir, "ccc"), "throw new Error('fixture-broker-start-failed');\n");
        const result = await callInternalBroker(client, { operation: "brokerRpc",
            arguments: {
                method: "broker.echo",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port: 65530,
                timeoutMs: 20,
                launchTimeoutMs: 1000,
            },
        });
        expect(result.isError).toBe(true);
        const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            error: string;
            launch: { error: string; detail: string; attempts: Array<{ reason?: string }> };
        };
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe("broker-launch-health-timeout");
        expect(payload.launch.error).toBe("broker-launch-health-timeout");
        expect(payload.launch.detail).toContain("fixture-broker-start-failed");
        expect(payload.launch.attempts).toEqual(expect.arrayContaining([
            expect.objectContaining({ reason: "runtime-pid-not-alive" }),
        ]));
        expect(existsSync(statusPayload.state.runtimeFile)).toBe(false);
    });

    it("relaunches an MCP-owned broker when runtime metadata points at a dead process", { timeout: TIMEOUT }, async () => {
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: false, autolaunch: false } });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            state: { runtimeFile: string };
        };
        const port = await freePort();
        const logPath = join(homeDir, "fake-ccc-broker-relaunch.log");
        installFakeCccBroker(pathDir, logPath);
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify({
            ownerId: statusPayload.ownerId,
            pid: 99999999,
            host: "127.0.0.1",
            port,
            managedBy: "device-lab-mcp",
        }));

        try {
            const result = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    params: { revived: true },
                    autolaunch: true,
                    hostCandidates: ["127.0.0.1"],
                    port,
                    timeoutMs: 300,
                    launchTimeoutMs: 3000,
                },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                result: { echo: { revived: boolean } };
                launch: { launched: boolean; reused: boolean; runtime: { pid: number; port: number }; attempts: Array<{ reason?: string }> };
            };
            expect(payload.ok).toBe(true);
            expect(payload.result.echo).toEqual({ revived: true });
            expect(payload.launch).toEqual(expect.objectContaining({ launched: true, reused: false }));
            expect(payload.launch.runtime).toEqual(expect.objectContaining({
                pid: expect.any(Number),
                port,
            }));
            expect(payload.launch.runtime.pid).not.toBe(99999999);
            expect(payload.launch.attempts).toEqual(expect.arrayContaining([
                expect.objectContaining({ reason: "runtime-pid-not-alive" }),
            ]));
            expect(readFileSync(logPath, "utf8")).toContain(`["devices","broker","serve","--host","127.0.0.1","--port","${port}","--runtime-managed-by-parent"]`);
        } finally {
            await callInternalBroker(client, { operation: "brokerShutdown", arguments: { force: true, cleanupTimeoutMs: 300, confirmDestructive: true } });
            rmSync(statusPayload.state.runtimeFile, { force: true });
        }
    });

    it("refuses to autolaunch over another owner's broker runtime metadata", { timeout: TIMEOUT }, async () => {
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: {} });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            state: { runtimeFile: string };
        };
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        const foreignRuntime = {
            ownerId: "0000000000000000",
            pid: 99999999,
            host: "127.0.0.1",
            port: 65529,
            managedBy: "device-lab-mcp",
        };
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify(foreignRuntime));
        const result = await callInternalBroker(client, { operation: "brokerRpc",
            arguments: {
                method: "broker.echo",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port: 65529,
                timeoutMs: 20,
                launchTimeoutMs: 50,
            },
        });
        const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            error: string;
            launch: { error: string; runtime: { ownerId: string } };
        };
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe("runtime-owned-by-another-owner");
        expect(payload.launch).toEqual(expect.objectContaining({
            error: "runtime-owned-by-another-owner",
            runtime: expect.objectContaining({ ownerId: "0000000000000000" }),
        }));
        expect(JSON.parse(readFileSync(statusPayload.state.runtimeFile, "utf8"))).toEqual(foreignRuntime);
        rmSync(statusPayload.state.runtimeFile, { force: true });
    });

    it("ignores another owner's broker runtime metadata on a different requested port", { timeout: TIMEOUT }, async () => {
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: false, autolaunch: false } });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            state: { runtimeFile: string };
        };
        const requestedPort = await freePort();
        const foreignRuntime = {
            ownerId: "0000000000000000",
            pid: 99999999,
            host: "127.0.0.1",
            port: requestedPort + 1,
            managedBy: "ccc-host",
        };
        const logPath = join(homeDir, "fake-ccc-broker-ignore-foreign-runtime.log");
        installFakeCccBroker(pathDir, logPath);
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify(foreignRuntime));

        try {
            const result = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    params: { isolatedPort: true },
                    autolaunch: true,
                    hostCandidates: ["127.0.0.1"],
                    port: requestedPort,
                    timeoutMs: 300,
                    launchTimeoutMs: 3000,
                },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                result: { echo: { isolatedPort: boolean } };
                launch: { launched: boolean; reused: boolean; runtime: { port: number }; attempts: Array<{ reason?: string; requestedPort?: number }> };
            };
            expect(payload.ok).toBe(true);
            expect(payload.result.echo).toEqual({ isolatedPort: true });
            expect(payload.launch).toEqual(expect.objectContaining({ launched: true, reused: false }));
            expect(payload.launch.runtime.port).toBe(requestedPort);
            expect(payload.launch.attempts).toEqual(expect.arrayContaining([
                expect.objectContaining({ reason: "runtime-ignored-for-different-owner-and-port", requestedPort }),
            ]));
        } finally {
            await callInternalBroker(client, { operation: "brokerShutdown", arguments: { force: true, cleanupTimeoutMs: 300, confirmDestructive: true } });
            rmSync(statusPayload.state.runtimeFile, { force: true });
        }
    });

    it("refuses to shut down broker runtime metadata not managed by device-lab-mcp", { timeout: TIMEOUT }, async () => {
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: {} });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            state: { runtimeFile: string };
        };
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        const unmanagedRuntime = {
            ownerId: statusPayload.ownerId,
            pid: 99999999,
            host: "127.0.0.1",
            port: 65528,
            managedBy: "external-service-manager",
        };
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify(unmanagedRuntime));
        const shutdown = await callInternalBroker(client, { operation: "brokerShutdown", arguments: { confirmDestructive: true } });
        expect(JSON.parse(((shutdown.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "runtime-not-managed-by-device-lab-mcp",
            runtime: expect.objectContaining({ managedBy: "external-service-manager" }),
        }));
        expect(JSON.parse(readFileSync(statusPayload.state.runtimeFile, "utf8"))).toEqual(unmanagedRuntime);
        rmSync(statusPayload.state.runtimeFile, { force: true });
    });

    it("uses ccc-host runtime metadata for implicit lifecycle broker routing", { timeout: TIMEOUT }, async () => {
        const methods: string[] = [];
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION } }));
                return;
            }
            if (sendTestOwnerResolve(req, res)) return;
            if (req.method !== "POST" || !req.url?.includes("/rpc")) {
                res.statusCode = 404;
                res.end(JSON.stringify({ ok: false, error: "not-found" }));
                return;
            }
            let body = "";
            req.on("data", (chunk) => { body += chunk.toString(); });
            req.on("end", () => {
                const parsed = JSON.parse(body);
                methods.push(parsed.method);
                res.setHeader("content-type", "application/json");
                if (parsed.method === "broker.inventory") {
                    res.end(JSON.stringify({
                        ok: true,
                        result: {
                            backends: [
                                { backend: "windows-sandbox", stateKey: "windows", devices: [{ id: "win-host-runtime", backend: "windows-sandbox", status: "stopped" }] },
                            ],
                        },
                    }));
                    return;
                }
                if (parsed.method === "broker.command.invoke") {
                    setTimeout(() => {
                        res.end(JSON.stringify({
                            ok: true,
                            result: {
                                ok: true,
                                backend: parsed.params.backend,
                                command: parsed.params.command,
                                deviceId: parsed.params.deviceId,
                                device: { id: parsed.params.deviceId, status: "stopped" },
                                execution: { mode: "exec", providerExecution: "fake", mutatesHost: false },
                            },
                        }));
                    }, 900);
                    return;
                }
                res.statusCode = 418;
                res.end(JSON.stringify({ ok: false, error: "unexpected-method" }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: {} });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            state: { runtimeFile: string };
        };
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify({
            ownerId: "0000000000000000",
            pid: process.pid,
            host: "0.0.0.0",
            probeHost: "127.0.0.1",
            hostCandidates: ["127.0.0.1", "host.docker.internal"],
            port: address.port,
            managedBy: "ccc-host",
        }));
        try {
            const result = await client.callTool({
                name: "status",
                arguments: { deviceId: "win-host-runtime" },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                routedBy: string;
                deviceId: string;
                device: { deviceId: string };
            };
            expect(payload).toEqual(expect.objectContaining({
                routedBy: "device-lifecycle-broker-implicit",
                deviceId: "win-host-runtime",
                device: expect.objectContaining({ deviceId: "win-host-runtime" }),
            }));
            expect(methods).toEqual(["broker.inventory", "broker.command.invoke"]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(statusPayload.state.runtimeFile, { force: true });
        }
    });

    it("does not fall back to local owner identity when broker owner resolution rejects the project", { timeout: TIMEOUT }, async () => {
        const rpcRequests: string[] = [];
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.method === "POST" && req.url === "/v1/owner/resolve") {
                res.statusCode = 409;
                res.end(JSON.stringify({
                    ok: false,
                    error: "project-owner-unavailable",
                    projectMountPath: "/project/wrong",
                    expectedProjectMountPath: "/project/right",
                }));
                return;
            }
            if (req.method === "POST" && req.url?.includes("/rpc")) {
                rpcRequests.push(req.url);
                res.end(JSON.stringify({ ok: true, result: { shouldNotReachRpc: true } }));
                return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: "not-found" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 300,
                },
            });
            expect(result.isError).toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                error: string;
                ownerResolve: { error: string; selected: { status: number } };
            };
            expect(payload).toEqual(expect.objectContaining({
                ok: false,
                error: "project-owner-unavailable",
            }));
            expect(payload.ownerResolve).toEqual(expect.objectContaining({
                error: "project-owner-unavailable",
                selected: expect.objectContaining({ status: 409 }),
            }));
            expect(rpcRequests).toEqual([]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("does not fall back to local owner identity when broker owner resolution endpoint is missing", { timeout: TIMEOUT }, async () => {
        const rpcRequests: string[] = [];
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.method === "POST" && req.url === "/v1/owner/resolve") {
                res.statusCode = 404;
                res.end(JSON.stringify({ ok: false, error: "not-found" }));
                return;
            }
            if (req.method === "POST" && req.url?.includes("/rpc")) {
                rpcRequests.push(req.url);
                res.end(JSON.stringify({ ok: true, result: { shouldNotReachRpc: true } }));
                return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: "not-found" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 300,
                },
            });
            expect(result.isError).toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                error: string;
                ownerResolve: { error: string; attempts: Array<{ status: number }> };
            };
            expect(payload).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-owner-resolve-unavailable",
            }));
            expect(payload.ownerResolve).toEqual(expect.objectContaining({
                error: "broker-owner-resolve-unavailable",
                attempts: [expect.objectContaining({ status: 404 })],
            }));
            expect(rpcRequests).toEqual([]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("forwards lifecycle delete options after owner inventory resolution", { timeout: TIMEOUT }, async () => {
        const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION } }));
                return;
            }
            if (sendTestOwnerResolve(req, res)) return;
            if (req.method !== "POST" || !req.url?.includes("/rpc")) {
                res.statusCode = 404;
                res.end(JSON.stringify({ ok: false, error: "not-found" }));
                return;
            }
            let body = "";
            req.on("data", (chunk) => { body += chunk.toString(); });
            req.on("end", () => {
                const parsed = JSON.parse(body);
                requests.push({ method: parsed.method, params: parsed.params || {} });
                res.setHeader("content-type", "application/json");
                if (parsed.method === "broker.inventory") {
                    res.end(JSON.stringify({ ok: true, result: { backends: [{ stateKey: "android", devices: [{ id: "android-delete-options", backend: "android-emulator" }] }] } }));
                    return;
                }
                res.end(JSON.stringify({
                    ok: true,
                    result: {
                        ok: true,
                        backend: parsed.params.backend,
                        command: parsed.params.command,
                        deviceId: parsed.params.deviceId,
                        device: null,
                        execution: { mode: "noop", providerExecution: "fake", mutatesHost: false },
                    },
                }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "delete",
                arguments: {
                    deviceId: "android-delete-options",
                    broker: true,
                    deleteAvd: false,
                    confirmDestructive: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 10000,
                },
            });
            expect(result.isError, JSON.stringify(result)).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                selected: { timeoutMs: number };
            };
            expect(payload.ok).toBe(true);
            expect(payload).toMatchObject({ backend: "android-emulator", command: "device_delete", deviceId: "android-delete-options" });
            expect(requests).toEqual([{ method: "broker.inventory", params: {} }, {
                method: "broker.command.invoke",
                params: expect.objectContaining({
                    backend: "android-emulator",
                    command: "device_delete",
                    deviceId: "android-delete-options",
                    deleteAvd: false,
                }),
            }]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("unwraps broker-proxied desktop MCP tool results", { timeout: TIMEOUT }, async () => {
        const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (sendCurrentBrokerStatus(req, res)) return;
            if (sendTestOwnerResolve(req, res)) return;
            if (req.method !== "POST" || !req.url?.includes("/rpc")) {
                res.statusCode = 404;
                res.end(JSON.stringify({ ok: false, error: "not-found" }));
                return;
            }
            let body = "";
            req.on("data", (chunk) => { body += chunk.toString(); });
            req.on("end", () => {
                const parsed = JSON.parse(body);
                requests.push({ method: parsed.method, params: parsed.params || {} });
                res.setHeader("content-type", "application/json");
                if (parsed.method === "broker.inventory") {
                    res.end(JSON.stringify({ ok: true, result: { backends: [{ stateKey: "windows", devices: [{ id: "win-proxy", backend: "windows-sandbox" }] }] } }));
                    return;
                }
                res.end(JSON.stringify({
                    ok: true,
                    result: {
                        ownerId: "owner",
                        tool: parsed.params.tool,
                        deviceId: parsed.params.deviceId,
                        backend: "windows-sandbox",
                        stateKey: "windows",
                        mcpResult: {
                            content: [{ type: "text", text: JSON.stringify({ stdout: "proxied ok", status: 0 }) }],
                        },
                    },
                }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "exec",
                arguments: {
                    deviceId: "win-proxy",
                    command: "Write-Output proxied",
                    viaBroker: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(result.isError, JSON.stringify(result)).not.toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({ stdout: "proxied ok", status: 0 });
            expect(requests).toEqual([{ method: "broker.inventory", params: {} }, {
                method: "broker.device.tool.invoke",
                params: expect.objectContaining({
                    tool: "device_exec",
                    deviceId: "win-proxy",
                    command: "Write-Output proxied",
                }),
            }]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes implicit broker desktop actions after a short inventory probe", { timeout: TIMEOUT }, async () => {
        const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION } }));
                return;
            }
            if (sendTestOwnerResolve(req, res)) return;
            if (req.method !== "POST" || !req.url?.includes("/rpc")) {
                res.statusCode = 404;
                res.end(JSON.stringify({ ok: false, error: "not-found" }));
                return;
            }
            let body = "";
            req.on("data", (chunk) => { body += chunk.toString(); });
            req.on("end", () => {
                const parsed = JSON.parse(body);
                requests.push({ method: parsed.method, params: parsed.params || {} });
                res.setHeader("content-type", "application/json");
                if (parsed.method === "broker.inventory") {
                    res.end(JSON.stringify({
                        ok: true,
                        result: {
                            ownerId: parsed.ownerId,
                            backends: [{
                                stateKey: "windows",
                                devices: [{ id: "win-implicit-proxy", backend: "windows-sandbox", status: "running" }],
                            }],
                        },
                    }));
                    return;
                }
                if (parsed.method === "broker.device.tool.invoke") {
                    setTimeout(() => {
                        res.end(JSON.stringify({
                            ok: true,
                            result: {
                                ownerId: parsed.ownerId,
                                tool: parsed.params.tool,
                                deviceId: parsed.params.deviceId,
                                backend: parsed.params.backend,
                                stateKey: "windows",
                                mcpResult: {
                                    content: [{ type: "text", text: JSON.stringify({ stdout: "implicit proxied ok", status: 0 }) }],
                                },
                            },
                        }));
                    }, 300);
                    return;
                }
                res.statusCode = 418;
                res.end(JSON.stringify({ ok: false, error: "unexpected-method" }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: {} });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            state: { runtimeFile: string };
        };
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify({
            ownerId: statusPayload.ownerId,
            pid: process.pid,
            host: "0.0.0.0",
            probeHost: "127.0.0.1",
            hostCandidates: ["127.0.0.1"],
            port: address.port,
            managedBy: "ccc-host",
        }));
        try {
            const result = await client.callTool({
                name: "exec",
                arguments: {
                    deviceId: "win-implicit-proxy",
                    command: "Write-Output implicit",
                },
            });
            expect(result.isError).not.toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({ stdout: "implicit proxied ok", status: 0 });
            expect(requests).toEqual([
                { method: "broker.inventory", params: {} },
                {
                    method: "broker.device.tool.invoke",
                    params: expect.objectContaining({
                        tool: "device_exec",
                        backend: "windows-sandbox",
                        deviceId: "win-implicit-proxy",
                        command: "Write-Output implicit",
                    }),
                },
            ]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(statusPayload.state.runtimeFile, { force: true });
        }
    });

    it.each([
        { label: "default discovery budget", delay: 1400, rpcTimeoutMs: undefined, succeeds: true, tool: "backends" },
        { label: "explicit longer RPC budget", delay: 1400, rpcTimeoutMs: 2500, succeeds: true, tool: "backends" },
        { label: "explicit shorter RPC budget", delay: 250, rpcTimeoutMs: 50, succeeds: false, tool: "backends" },
        { label: "implicit Hyper-V discovery budget", delay: 1400, rpcTimeoutMs: undefined, succeeds: true, tool: "inventory" },
    ])("keeps $label separate from the implicit health probe budget", { timeout: TIMEOUT }, async ({ delay, rpcTimeoutMs, succeeds, tool }) => {
        const methods: string[] = [];
        const invocations: unknown[] = [];
        const timers: ReturnType<typeof setTimeout>[] = [];
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/health") { res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" })); return; }
            if (sendCurrentBrokerStatus(req, res) || sendTestOwnerResolve(req, res)) return;
            const chunks: Buffer[] = [];
            req.on("data", chunk => chunks.push(chunk));
            req.on("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString());
                methods.push(body.method);
                if (body.method === "broker.device.tool.invoke") {
                    invocations.push(body.params);
                    res.end(JSON.stringify({ ok: true, result: { mcpResult: { content: [{ type: "text", text: JSON.stringify({ discoveryRoute: "hyper-v", devices: [] }) }] } } }));
                    return;
                }
                if (body.method !== "broker.backends") { res.writeHead(400).end(JSON.stringify({ ok: false, error: "unexpected-method" })); return; }
                timers.push(setTimeout(() => {
                    if (!res.destroyed) res.end(JSON.stringify({ ok: true, result: {
                        ownerId: body.ownerId, startsDevices: false,
                        backends: [{ name: "windows-sandbox", host: "windows-host", available: true, creatable: true },
                            { name: "linux-vm", provider: "hyper-v", host: "windows-host", available: true }],
                    } }));
                }, delay));
            });
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: { probe: false, autolaunch: false } });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}"));
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify({
            ownerId: statusPayload.ownerId, pid: process.pid, host: "0.0.0.0", probeHost: "127.0.0.1",
            hostCandidates: ["127.0.0.1"], port: (server.address() as AddressInfo).port, managedBy: "ccc-host",
        }));
        try {
            const result = await client.callTool({ name: "devices", arguments: {
                view: tool === "inventory" ? "available" : "backends",
                ...(tool === "inventory" ? { backend: "linux-vm" } : {}),
                ...(rpcTimeoutMs === undefined ? {} : { rpcTimeoutMs }),
            } });
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"));
            if (tool === "inventory") {
                expect(result.isError).not.toBe(true);
                expect(methods).toEqual(["broker.backends", "broker.device.tool.invoke"]);
                expect(invocations).toEqual([expect.objectContaining({ tool: "device_inventory", backend: "linux-vm" })]);
                expect(payload).toEqual({ discoveryRoute: "hyper-v", devices: [] });
                return;
            }
            expect(methods).toEqual(["broker.backends"]);
            expect(payload.broker.available).toBe(true);
            if (succeeds) {
                expect(result.isError).not.toBe(true);
                expect(payload.source).toBe("host-broker-provider-discovery");
                expect(payload.backends).toContainEqual(expect.objectContaining({ name: "windows-sandbox", available: true }));
            } else {
                expect(payload.source).toBe("broker-provider-discovery-failed");
                expect(payload.brokerBackendsError.attempts).toContainEqual(expect.objectContaining({ error: "timeout", timeoutMs: rpcTimeoutMs }));
            }
        } finally {
            timers.forEach(clearTimeout);
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            rmSync(statusPayload.state.runtimeFile, { force: true });
        }
    });

    it("uses ccc-host runtime metadata for backend readiness routing", { timeout: TIMEOUT }, async () => {
        const methods: string[] = [];
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION } }));
                return;
            }
            if (sendTestOwnerResolve(req, res)) return;
            req.setEncoding("utf8");
            let raw = "";
            req.on("data", (chunk) => { raw += chunk; });
            req.on("end", () => {
                const parsed = raw ? JSON.parse(raw) : {};
                methods.push(parsed.method);
                if (parsed.method === "broker.backends") {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({
                        ok: true,
                        result: {
                            ownerId: parsed.ownerId,
                            source: "host-broker-provider-discovery",
                            startsDevices: false,
                            backends: [
                                {
                                    name: "windows-sandbox",
                                    host: "windows-host",
                                    creatable: true,
                                    available: true,
                                    lazy: true,
                                    status: "available",
                                    missing: [],
                                    tools: { wsb: "C:\\Users\\TestUser\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe" },
                                    capabilities: ["inventory", "start", "stop"],
                                },
                            ],
                        },
                    }));
                    return;
                }
                res.statusCode = 418;
                res.end(JSON.stringify({ ok: false, error: "unexpected-method" }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: {} });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            state: { runtimeFile: string };
        };
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify({
            ownerId: "0000000000000000",
            pid: process.pid,
            host: "0.0.0.0",
            probeHost: "127.0.0.1",
            hostCandidates: ["127.0.0.1", "host.docker.internal"],
            port: address.port,
            managedBy: "ccc-host",
        }));
        try {
            const result = await client.callTool({
                name: "devices",
                arguments: { view: "backends",},
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                source: string;
                routedBy: string;
                broker: { mode: string; available: boolean };
                backends: Array<{ name: string; available: boolean; tools?: Record<string, string | null> }>;
                localBackends: Array<{ name: string }>;
            };
            expect(payload).toEqual(expect.objectContaining({
                source: "host-broker-provider-discovery",
                routedBy: "device-backends-broker",
                broker: expect.objectContaining({ mode: "host-broker-detected", available: true }),
            }));
            expect(payload.backends[0].name).toBe("x11-current-display");
            expect(payload.backends.find((backend) => backend.name === "windows-sandbox")).toEqual(expect.objectContaining({
                available: true,
                tools: { wsb: "C:\\Users\\TestUser\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe" },
            }));
            expect(payload.localBackends.map((backend) => backend.name)).toContain("windows-sandbox");
            expect(methods.filter(Boolean)).toEqual(["broker.backends"]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(statusPayload.state.runtimeFile, { force: true });
        }
    });

    it("refuses direct fallback when implicit lifecycle broker routing sees unmanaged runtime metadata", { timeout: TIMEOUT }, async () => {
        const requests: string[] = [];
        const server = createServer((req, res) => {
            requests.push(req.url || "");
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "unmanaged-runtime-used" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const status = await callInternalBroker(client, { operation: "brokerStatus", arguments: {} });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            state: { runtimeFile: string };
        };
        const ownerRoot = join(homeDir, ".ccc/devices/owners", statusPayload.ownerId);
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        mkdirSync(join(ownerRoot, "windows"), { recursive: true });
        const unmanagedRuntime = {
            ownerId: statusPayload.ownerId,
            pid: process.pid,
            host: "127.0.0.1",
            port: address.port,
            managedBy: "external-service-manager",
        };
        writeFileSync(statusPayload.state.runtimeFile, JSON.stringify(unmanagedRuntime));
        writeFileSync(join(ownerRoot, "windows", "devices.json"), JSON.stringify({
            devices: [{ id: "win-unmanaged-runtime-direct", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/unmanaged.wsb" }],
        }));
        try {
            const result = await client.callTool({
                name: "status",
                arguments: { deviceId: "win-unmanaged-runtime-direct" },
            });
            expect(result.isError).toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-runtime-unavailable",
                routedBy: "device-lifecycle-broker-implicit",
            }));
            const inventory = await client.callTool({
                name: "devices",
                arguments: { view: "available", backend: "android-device" },
            });
            expect(JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-runtime-unavailable",
                routedBy: "device-readonly-broker-implicit",
            }));
            expect(requests).toEqual([]);
            expect(JSON.parse(readFileSync(statusPayload.state.runtimeFile, "utf8"))).toEqual(unmanagedRuntime);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(statusPayload.state.runtimeFile, { force: true });
            rmSync(join(ownerRoot, "windows"), { recursive: true, force: true });
        }
    });

    it("clamps explicit broker probe candidate count and timeout", { timeout: TIMEOUT }, async () => {
        const candidates = Array.from({ length: 12 }, (_, index) => `127.0.0.${index + 1}`);
        const result = await callInternalBroker(client, { operation: "brokerStatus",
            arguments: { probe: false, hostCandidates: candidates, timeoutMs: 999999 },
        });
        expect(result.isError).not.toBe(true);
        const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            transport: { hostCandidates: string[]; probeTimeoutMs: number; maxProbeCandidates: number; maxProbeTimeoutMs: number };
        };
        expect(payload.transport.hostCandidates).toHaveLength(8);
        expect(payload.transport.hostCandidates).toEqual(candidates.slice(0, 8));
        expect(payload.transport.probeTimeoutMs).toBe(2000);
        expect(payload.transport.maxProbeCandidates).toBe(8);
        expect(payload.transport.maxProbeTimeoutMs).toBe(2000);
    });

    it("probes an explicitly requested running broker health endpoint without auto-starting one", { timeout: TIMEOUT }, async () => {
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                const body = JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" });
                res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
                res.end(body);
                return;
            }
            if (sendCurrentBrokerStatus(req, res)) return;
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await callInternalBroker(client, { operation: "brokerStatus",
                arguments: { probe: true, hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                mode: string;
                available: boolean;
                rpcReady: boolean;
                probe: { requested: boolean; available: boolean; selected: { endpoint: string; status: number; body: { ok: boolean; name: string } }; attempts: Array<{ ok: boolean }> };
                ownerResolve: { ok: boolean; error: string; attempts: Array<{ status: number }> };
                launch: { ok: boolean; launched: boolean; reused: boolean; error: string; ownerResolve: { error: string } };
                warnings: string[];
                remedies: string[];
                implemented: string[];
                deferred: string[];
            };
            expect(payload.mode).toBe("host-broker-detected");
            expect(payload.available).toBe(true);
            expect(payload.rpcReady).toBe(false);
            expect(payload.ownerResolve).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-owner-resolve-unavailable",
                attempts: [expect.objectContaining({ status: 404 })],
            }));
            expect(payload.launch).toEqual(expect.objectContaining({
                ok: false,
                launched: false,
                reused: false,
                error: "broker-owner-resolve-unavailable",
                ownerResolve: expect.objectContaining({ error: "broker-owner-resolve-unavailable" }),
            }));
            expect(payload.warnings).toEqual(expect.arrayContaining([
                expect.stringContaining("does not satisfy the required owner-resolve contract"),
            ]));
            expect(payload.remedies).toEqual(expect.arrayContaining([
                expect.stringContaining("run ccc devices broker status on the physical host"),
            ]));
            expect(payload.probe.requested).toBe(true);
            expect(payload.probe.available).toBe(true);
            expect(payload.probe.selected).toEqual(expect.objectContaining({
                endpoint: `http://127.0.0.1:${address.port}/health`,
                status: 200,
                body: expect.objectContaining({ ok: true, name: "ccc-device-broker" }),
            }));
            expect(payload.probe.attempts).toHaveLength(1);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports bounded broker probe failures as diagnostics", { timeout: TIMEOUT }, async () => {
        const server = createServer((_req, res) => {
            const body = JSON.stringify({ ok: false });
            res.writeHead(503, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
            res.end(body);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await callInternalBroker(client, { operation: "brokerStatus",
                arguments: { probe: true, hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                mode: string;
                available: boolean;
                probe: { requested: boolean; available: boolean; selected: null; attempts: Array<{ ok: boolean; status: number }> };
            };
            expect(payload.mode).toBe("broker-unavailable");
            expect(payload.available).toBe(false);
            expect(payload.probe).toEqual(expect.objectContaining({
                requested: true,
                available: false,
                selected: null,
            }));
            expect(payload.probe.attempts).toEqual([
                expect.objectContaining({ ok: false, status: 503 }),
            ]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

});


describe("owned broker child supervision", () => {
    function fixture() {
        const child = { pid: 41 };
        const children = new Map([[41, { child, processStartToken: "birth-41" }]]);
        const runtime = { host: "127.0.0.1", ownerId: "owner", managedBy: "device-lab-mcp", pid: 41, port: 17373, processStartToken: "birth-41" };
        const unexpected = () => { throw new Error("unexpected supervision operation"); };
        const ports: BrokerSupervisionPorts = {
            protocolVersion: 1,
            ownerId: () => "owner", ownedChildrenEntries: () => children.entries(),
            deleteOwnedChild: pid => { children.delete(Number(pid)); },
            readBrokerProcessStartToken: vi.fn(() => "birth-41"),
            signalChild: vi.fn(() => undefined),
            terminateBrokerProcess: vi.fn(async () => ({ ok: true, pid: 41 })),
            waitForProcessExit: vi.fn(async () => true), pidAlive: vi.fn(() => false),
            readBrokerRuntime: () => runtime, removeBrokerRuntime: vi.fn(() => true),
            normalizeLaunchOptions: unexpected, probeBrokerHealth: unexpected,
            probeCccHostBrokerProtocol: unexpected, resolveBrokerOwner: unexpected,
            reusableBrokerProcessVerification: unexpected, persistVerifiedBrokerRuntime: unexpected,
            withSetupEvidence: unexpected, terminateVerifiedBrokerRuntime: unexpected,
            waitForBrokerHealth: unexpected, waitForBrokerOwnerResolve: unexpected,
            writeBrokerRuntime: unexpected, launchedBrokerProcessVerification: unexpected,
            cleanupLaunchedBrokerRuntime: unexpected, brokerLogTail: unexpected,
            verifiedBrokerProcess: unexpected, invalidateBrokerSetup: unexpected,
            verifiedOwnedLegacyBrokerProcess: unexpected, currentOperation: unexpected,
            setupCacheKey: unexpected, launchOwnedBroker: unexpected, cleanupOwner: unexpected,
        };
        return { ports, children, child, runtime, supervision: createBrokerSupervision(ports) };
    }

    it("keeps exit cleanup synchronous and signals only the retained child generation", () => {
        const f = fixture();
        expect(f.supervision.cleanupOwnedOnExit()).toBeUndefined();
        expect(f.ports.signalChild).toHaveBeenCalledWith(f.child, "SIGTERM");
        expect(f.ports.terminateBrokerProcess).not.toHaveBeenCalled();
        expect(f.ports.removeBrokerRuntime).not.toHaveBeenCalled();
        expect(f.children.size).toBe(0);
    });

    it("does not signal a successor process or erase its runtime evidence", async () => {
        const f = fixture();
        vi.mocked(f.ports.readBrokerProcessStartToken).mockReturnValue("successor-birth");
        await f.supervision.cleanupOwnedChildren();
        expect(f.ports.signalChild).not.toHaveBeenCalled();
        expect(f.ports.terminateBrokerProcess).not.toHaveBeenCalled();
        expect(f.ports.removeBrokerRuntime).not.toHaveBeenCalled();
    });

    it("retains evidence when native termination refuses the process generation", async () => {
        const f = fixture();
        vi.mocked(f.ports.terminateBrokerProcess).mockResolvedValue({ ok: false, reason: "process-start-token-mismatch" });
        await f.supervision.cleanupOwnedChildren();
        expect(f.ports.signalChild).not.toHaveBeenCalled();
        expect(f.ports.removeBrokerRuntime).not.toHaveBeenCalled();
    });

    it("removes runtime evidence only after a confirmed exit of its matching generation", async () => {
        const f = fixture();
        await f.supervision.cleanupOwnedChildren();
        expect(f.ports.terminateBrokerProcess).toHaveBeenCalledWith(41, 500, "birth-41");
        expect(f.ports.removeBrokerRuntime).toHaveBeenCalledOnce();
        const successor = fixture();
        successor.runtime.processStartToken = "successor-birth";
        await successor.supervision.cleanupOwnedChildren();
        expect(successor.ports.removeBrokerRuntime).not.toHaveBeenCalled();
    });

    async function withPrivateRuntime(test: (file: string) => Promise<void>) {
        const home = mkdtempSync(join(tmpdir(), "broker-runtime-generation-"));
        const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        const file = join(home, ".ccc", "devices", "broker", "runtime.json");
        try { await test(file); }
        finally {
            for (const key of ["HOME", "USERPROFILE"] as const) {
                if (previous[key] === undefined) delete process.env[key];
                else process.env[key] = previous[key];
            }
            rmSync(home, { recursive: true, force: true });
        }
    }

    it("preserves a successor published while shutdown awaits owner cleanup", async () => {
        await withPrivateRuntime(async file => {
            const f = fixture();
            const original = { ...f.runtime };
            const successor = { ...original, pid: 42, processStartToken: "birth-42" };
            expect(writeBrokerRuntimeForTest(original, null)).toBe(true);
            f.ports.readBrokerRuntime = () => original;
            f.ports.pidAlive = () => true;
            f.ports.invalidateBrokerSetup = () => undefined;
            f.ports.probeCccHostBrokerProtocol = async () => ({ ok: true });
            f.ports.verifiedBrokerProcess = () => ({ pid: 41, processStartToken: "birth-41" });
            f.ports.cleanupOwner = async () => {
                expect(writeBrokerRuntimeForTest(successor, original)).toBe(true);
                return { ok: true };
            };
            f.ports.removeBrokerRuntime = removeBrokerRuntimeForTest;
            expect(await f.supervision.shutdown()).toEqual(expect.objectContaining({ ok: true, stopped: true }));
            expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(successor);
        });
    });

    it.each(["initial", "final"] as const)("preserves a successor when the %s parent launch publication loses its CAS", async stage => {
        await withPrivateRuntime(async file => {
            const f = fixture();
            const successor = { ...f.runtime, pid: 42, processStartToken: "birth-42", startedAt: "successor-start" };
            f.ports.currentOperation = () => undefined;
            f.ports.setupCacheKey = () => "private-launch";
            f.ports.invalidateBrokerSetup = () => undefined;
            f.ports.normalizeLaunchOptions = () => ({
                command: process.execPath, args: ["broker-entry.js", "devices", "broker", "serve", "--runtime-managed-by-parent"],
                host: "127.0.0.1", hostCandidates: ["127.0.0.1"], port: 17373, timeoutMs: 1000, launchTimeoutMs: 3000,
            });
            f.ports.probeBrokerHealth = async () => ({ available: false, selected: null, attempts: [] });
            f.ports.readBrokerRuntime = () => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
            f.ports.launchOwnedBroker = async (owner, launch) => {
                if (stage === "initial") expect(writeBrokerRuntimeForTest(successor, null)).toBe(true);
                return {
                    kind: "started", runtime: { ...f.runtime, ownerId: owner, startedAt: "parent-start" },
                    diagnostics: { command: launch.command, args: launch.args, logPath: "private-launch.log" },
                };
            };
            f.ports.writeBrokerRuntime = vi.fn(writeBrokerRuntimeForTest);
            f.ports.waitForBrokerHealth = vi.fn(async () => {
                const published = f.ports.readBrokerRuntime();
                expect(published).toEqual(expect.objectContaining({ managedBy: "device-lab-mcp", pid: 41, startedAt: "parent-start" }));
                expect(writeBrokerRuntimeForTest(successor, published)).toBe(true);
                return { available: true as const, selected: { host: "127.0.0.1", port: 17373 }, attempts: [] };
            });
            f.ports.waitForBrokerOwnerResolve = async () => ({ ok: true, ownerId: "owner" });
            f.ports.probeCccHostBrokerProtocol = async () => ({ ok: true });
            f.ports.launchedBrokerProcessVerification = runtime => ({ verification: { ok: true }, runtime: { ...runtime, startedAt: "verified-start" } });
            f.ports.withSetupEvidence = value => value;
            f.ports.cleanupLaunchedBrokerRuntime = vi.fn(async (runtime, timeoutMs) => {
                expect(timeoutMs).toBe(1500);
                expect(runtime).toEqual(expect.objectContaining({ managedBy: "device-lab-mcp", pid: 41, processStartToken: "birth-41" }));
                expect(removeBrokerRuntimeForTest(runtime)).toBe(false);
                return { ok: true, pid: 41 };
            });

            expect(await f.supervision.ensure()).toEqual(expect.objectContaining({
                ok: false, error: "broker-launch-failed", detail: "broker-runtime-generation-changed",
                launchCleanup: { ok: true, pid: 41 },
            }));
            expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(successor);
            expect(f.ports.writeBrokerRuntime).toHaveBeenCalledTimes(stage === "initial" ? 1 : 2);
            expect(f.ports.waitForBrokerHealth).toHaveBeenCalledTimes(stage === "initial" ? 0 : 1);
            expect(f.ports.cleanupLaunchedBrokerRuntime).toHaveBeenCalledOnce();
        });
    });

    function launchFixture() {
        const f = fixture();
        const launch = {
            command: process.execPath, args: ["broker-entry.js", "devices", "broker", "serve", "--runtime-managed-by-parent"],
            host: "127.0.0.1", hostCandidates: ["127.0.0.1"], port: 17373, timeoutMs: 1000, launchTimeoutMs: 3000,
        };
        const runtime: NonNullable<ReturnType<BrokerSupervisionPorts["readBrokerRuntime"]>> = {
            ...f.runtime, command: launch.command, args: launch.args, logPath: "private-launch.log", startedAt: "parent-start",
        };
        const diagnostics = { command: launch.command, args: launch.args, logPath: "private-launch.log" };
        f.ports.currentOperation = () => undefined;
        f.ports.setupCacheKey = () => "owned-launch";
        f.ports.normalizeLaunchOptions = () => launch;
        f.ports.invalidateBrokerSetup = () => undefined;
        f.ports.probeBrokerHealth = async () => ({ available: false, selected: null, attempts: [{ reason: "before-dispatch" }] });
        f.ports.readBrokerRuntime = () => null;
        f.ports.launchOwnedBroker = vi.fn<BrokerSupervisionPorts["launchOwnedBroker"]>(async () => ({ kind: "started", runtime, diagnostics }));
        f.ports.writeBrokerRuntime = vi.fn(() => true);
        f.ports.waitForBrokerHealth = vi.fn<BrokerSupervisionPorts["waitForBrokerHealth"]>(async () => ({ available: true, selected: { host: launch.host, port: launch.port }, attempts: [{ reason: "after-dispatch" }] }));
        f.ports.waitForBrokerOwnerResolve = vi.fn(async () => ({ ok: true, ownerId: "resolved-owner" }));
        f.ports.probeCccHostBrokerProtocol = vi.fn(async () => ({ ok: true }));
        f.ports.launchedBrokerProcessVerification = vi.fn(runtime => ({ verification: { ok: true }, runtime: { ...runtime, startedAt: "verified-start" } }));
        f.ports.withSetupEvidence = vi.fn(value => value);
        f.ports.cleanupLaunchedBrokerRuntime = vi.fn(async runtime => ({ ok: true, pid: runtime?.pid }));
        f.ports.brokerLogTail = vi.fn(() => "captured broker output");
        return { ...f, launch, launchedRuntime: runtime, diagnostics };
    }

    it("verifies a started launch before publishing readiness and uses the native invocation snapshot unchanged", async () => {
        const f = launchFixture();
        expect(await f.supervision.ensure()).toEqual(expect.objectContaining({
            ok: true, ownerId: "resolved-owner", launched: true, reused: false,
            runtime: expect.objectContaining({ pid: 41, processStartToken: "birth-41", startedAt: "verified-start" }),
        }));
        expect(f.ports.launchOwnedBroker).toHaveBeenCalledExactlyOnceWith("owner", f.launch);
        expect(f.ports.waitForBrokerHealth).toHaveBeenCalledExactlyOnceWith({ host: "127.0.0.1", port: 17373, timeoutMs: 3000 });
        expect(f.ports.waitForBrokerOwnerResolve).toHaveBeenCalledExactlyOnceWith("127.0.0.1", 17373, 3000);
        expect(f.ports.probeCccHostBrokerProtocol).toHaveBeenCalledExactlyOnceWith("127.0.0.1", 17373, 1000);
        expect(f.ports.launchedBrokerProcessVerification).toHaveBeenCalledOnce();
        expect(f.ports.writeBrokerRuntime).toHaveBeenCalledTimes(2);
        expect(f.ports.cleanupLaunchedBrokerRuntime).not.toHaveBeenCalled();
    });

    it("reports a pre-dispatch native failure without manufacturing a child or retiring unrelated runtime", async () => {
        const f = launchFixture();
        f.ports.launchOwnedBroker = vi.fn<BrokerSupervisionPorts["launchOwnedBroker"]>(async () => ({ kind: "failed", runtime: null, detail: "executable-not-found", diagnostics: f.diagnostics }));
        expect(await f.supervision.ensure()).toEqual(expect.objectContaining({
            ok: false, error: "broker-launch-failed", detail: "executable-not-found", ...f.diagnostics,
        }));
        expect(f.ports.cleanupLaunchedBrokerRuntime).not.toHaveBeenCalled();
        expect(f.ports.removeBrokerRuntime).not.toHaveBeenCalled();
        expect(f.ports.writeBrokerRuntime).not.toHaveBeenCalled();
        expect(f.ports.waitForBrokerHealth).not.toHaveBeenCalled();
    });

    it.each(["refuses", "throws"] as const)("retains the exact partial dispatch and its primary failure when compensation %s", async cleanup => {
        const f = launchFixture();
        const detail = { nativeDiagnostic: "cleanup registration failed" };
        f.ports.launchOwnedBroker = vi.fn<BrokerSupervisionPorts["launchOwnedBroker"]>(async () => ({ kind: "failed", runtime: f.launchedRuntime, detail, diagnostics: f.diagnostics }));
        const refusal = { ok: false, pid: 41, reason: "process-start-token-unavailable" };
        f.ports.cleanupLaunchedBrokerRuntime = vi.fn(async runtime => {
            expect(runtime).toBe(f.launchedRuntime);
            if (cleanup === "throws") throw new Error("cleanup observation failed");
            return refusal;
        });
        const result = await f.supervision.ensure();
        expect(result).toEqual(expect.objectContaining({
            ok: false, error: "broker-launch-failed", detail, ...f.diagnostics,
            launchCleanup: cleanup === "refuses" ? refusal : {
                ok: false, pid: 41, reason: "broker-launch-cleanup-failed", detail: "cleanup observation failed",
            },
        }));
        if (result.ok) throw new Error("partial dispatch unexpectedly succeeded");
        expect(result.detail).toBe(detail);
        expect(f.ports.cleanupLaunchedBrokerRuntime).toHaveBeenCalledExactlyOnceWith(f.launchedRuntime, 1500);
        expect(f.ports.writeBrokerRuntime).not.toHaveBeenCalled();
        expect(f.ports.waitForBrokerHealth).not.toHaveBeenCalled();
    });

    it.each(["health", "owner", "protocol", "process"] as const)("preserves %s readiness failure when its sole compensation throws", async phase => {
        const f = launchFixture();
        const expected = {
            health: "broker-launch-health-timeout", owner: "broker-launch-owner-resolve-timeout",
            protocol: "host-broker-incompatible", process: "broker-runtime-process-unverified",
        }[phase];
        if (phase === "health") f.ports.waitForBrokerHealth = async () => ({ available: false, selected: null, attempts: [] });
        if (phase === "owner") f.ports.waitForBrokerOwnerResolve = async () => ({ ok: false, error: "owner-not-ready", selected: null });
        if (phase === "protocol") f.ports.probeCccHostBrokerProtocol = async () => ({ ok: false, error: "wrong-protocol" });
        if (phase === "process") f.ports.launchedBrokerProcessVerification = runtime => ({ verification: { ok: false, reason: "foreign-process" }, runtime });
        f.ports.cleanupLaunchedBrokerRuntime = vi.fn(async () => { throw new Error("cleanup transport failed"); });
        const result = await f.supervision.ensure();
        expect(result).toEqual(expect.objectContaining({
            ok: false, error: expected, runtime: f.launchedRuntime,
            launchCleanup: { ok: false, pid: 41, reason: "broker-launch-cleanup-failed", detail: "cleanup transport failed" },
        }));
        if (result.ok) throw new Error("failed readiness unexpectedly succeeded");
        expect(f.ports.cleanupLaunchedBrokerRuntime).toHaveBeenCalledExactlyOnceWith(f.launchedRuntime, phase === "health" ? 1500 : 3000);
        if (phase === "health" || phase === "owner") expect(result.detail).toBe("captured broker output");
        if (phase === "protocol") expect(result.compatibility).toEqual({ ok: false, error: "wrong-protocol" });
        if (phase === "process") expect(result.attempts).toContainEqual({
            reason: "broker-launch-process-unverified", processVerification: { ok: false, reason: "foreign-process" },
        });
    });

    it("retains health timeout and runtime evidence when cleanup refuses an unverified generation", async () => {
        const f = launchFixture();
        f.launchedRuntime.processStartToken = null;
        f.ports.waitForBrokerHealth = async () => ({ available: false, selected: null, attempts: [] });
        const refusal = { ok: false, pid: 41, reason: "process-start-token-unavailable" };
        f.ports.cleanupLaunchedBrokerRuntime = vi.fn(async () => refusal);
        expect(await f.supervision.ensure()).toEqual(expect.objectContaining({
            ok: false, error: "broker-launch-health-timeout", detail: "captured broker output",
            runtime: f.launchedRuntime, launchCleanup: refusal,
        }));
        expect(f.ports.cleanupLaunchedBrokerRuntime).toHaveBeenCalledExactlyOnceWith(f.launchedRuntime, 1500);
        expect(f.ports.removeBrokerRuntime).not.toHaveBeenCalled();
    });

    it("does not equate a nonthrowing spawn without a PID with readiness", async () => {
        const f = launchFixture();
        const runtime = { ...f.launchedRuntime, pid: null, processStartToken: null };
        f.ports.launchOwnedBroker = async () => ({ kind: "started", runtime, diagnostics: f.diagnostics });
        f.ports.waitForBrokerHealth = vi.fn<BrokerSupervisionPorts["waitForBrokerHealth"]>(async () => ({ available: false, selected: null, attempts: [] }));
        expect(await f.supervision.ensure()).toEqual(expect.objectContaining({
            ok: false, error: "broker-launch-health-timeout", runtime,
        }));
        expect(f.ports.waitForBrokerHealth).toHaveBeenCalledOnce();
        expect(f.ports.cleanupLaunchedBrokerRuntime).toHaveBeenCalledExactlyOnceWith(runtime, 1500);
        expect(f.ports.waitForBrokerOwnerResolve).not.toHaveBeenCalled();
    });

    it("refuses stale removal and late publication but removes the exact captured record", async () => {
        await withPrivateRuntime(async file => {
            const original = { ...fixture().runtime };
            const successor = { ...original, pid: 42, processStartToken: "birth-42" };
            expect(writeBrokerRuntimeForTest(original, null)).toBe(true);
            expect(writeBrokerRuntimeForTest(successor, original)).toBe(true);
            expect(removeBrokerRuntimeForTest(original)).toBe(false);
            expect(writeBrokerRuntimeForTest({ ...original, startedAt: "late" }, original)).toBe(false);
            expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(successor);
            expect(removeBrokerRuntimeForTest(successor)).toBe(true);
            expect(existsSync(file)).toBe(false);
            writeFileSync(file, "unreadable-json");
            expect(writeBrokerRuntimeForTest(original, null)).toBe(false);
            expect(removeBrokerRuntimeForTest(original)).toBe(false);
            expect(readFileSync(file, "utf8")).toBe("unreadable-json");
        });
    });

});
