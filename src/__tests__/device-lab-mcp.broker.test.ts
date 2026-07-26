import { spawn } from "child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createServer } from "http";
import { AddressInfo } from "net";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    cleanupDeviceLabMcpTestContext,
    createDeviceLabMcpTestContext,
    repoRoot,
    TIMEOUT,
    type DeviceLabMcpTestContext,
} from "./helpers/device-lab-mcp-fixture.js";
import { freePort, installFakeCccBroker, installIgnoringCccBroker, pidAlive, waitForHealthUnavailable } from "./helpers/fake-broker-mcp-fixture.js";
import { BROKER_CONTROL_RESPONSE_LIMIT_BYTES, BROKER_RPC_RESPONSE_LIMIT_BYTES, REQUIRED_CCC_HOST_BROKER_CAPABILITIES, brokerLaunchInvocation, brokerLogTail, brokerRpc, brokerStatus, implicitBrokerProbeOptions, waitForBrokerOwnerResolve } from "../../device-lab-mcp/src/broker.mjs";
import { projectMountPath } from "../../device-lab-mcp/src/context.mjs";

const TEST_BROKER_OWNER_ID = "1111111111111111";

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
    res.end(JSON.stringify({ ok: true, broker: { implemented: REQUIRED_CCC_HOST_BROKER_CAPABILITIES } }));
    return true;
}

describe("device-lab MCP", () => {
    let context: DeviceLabMcpTestContext;
    let client: DeviceLabMcpTestContext["client"];
    let homeDir: string;
    let pathDir: string;
    let originalBrokerAuthFile: string | undefined;

    beforeAll(async () => {
        originalBrokerAuthFile = process.env.CCC_DEVICE_BROKER_AUTH_FILE;
        delete process.env.CCC_DEVICE_BROKER_AUTH_FILE;
        context = await createDeviceLabMcpTestContext({ defaultImplicitBroker: true });
        client = context.client;
        homeDir = context.homeDir;
        pathDir = context.pathDir;
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupDeviceLabMcpTestContext(context);
        if (originalBrokerAuthFile === undefined) delete process.env.CCC_DEVICE_BROKER_AUTH_FILE;
        else process.env.CCC_DEVICE_BROKER_AUTH_FILE = originalBrokerAuthFile;
    }, TIMEOUT);

    it("launches the packaged CLI directly for Windows broker recovery", () => {
        const invocation = brokerLaunchInvocation("127.0.0.1", 17373, {
            platform: "win32",
            packageRoot: join(repoRoot, "device-lab-mcp"),
            execPath: "C:\\Program Files\\nodejs\\node.exe",
        });

        expect(invocation.command).toBe("C:\\Program Files\\nodejs\\node.exe");
        expect(invocation.args).toEqual([
            join(repoRoot, "dist", "index.js"),
            "devices", "broker", "serve", "--host", "127.0.0.1", "--port", "17373",
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
        const status = await client.callTool({ name: "device_broker_status", arguments: { probe: false, autolaunch: false } });
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
        expect(payload.persistence).toEqual(expect.objectContaining({
            durableAcrossContainerRecreation: true,
            environmentVariablesRequired: false,
        }));
        expect(payload.persistence.ownerScoped.ownerRoot).toBe(payload.state.ownerRoot);
        expect(payload.persistence.ownerScoped.deviceDefinitions).toEqual(expect.objectContaining({
            android: expect.stringContaining("/android/devices.json"),
            "android-device": expect.stringContaining("/android-device/devices.json"),
            ios: expect.stringContaining("/ios/devices.json"),
            "ios-device": expect.stringContaining("/ios-device/devices.json"),
            windows: expect.stringContaining("/windows/devices.json"),
            macos: expect.stringContaining("/macos/devices.json"),
        }));
        expect(payload.persistence.ownerScoped.recordings).toEqual(expect.objectContaining({
            android: expect.stringContaining("/android/<device-id>/recordings"),
            windows: expect.stringContaining("/windows/<device-id>/recordings"),
            macos: expect.stringContaining("/macos/<device-id>/recordings"),
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
            expect.stringContaining("/owners/<foreign-owner-id>"),
            "host toolchains and shared/base VM images",
        ]));
        expect(payload.persistence.cleanupBoundary.staleMetadataPolicy).toContain("without deleting shared toolchain caches");
    });

    it("enables default implicit broker probing without runtime metadata", { timeout: TIMEOUT }, async () => {
        const status = await client.callTool({ name: "device_broker_status", arguments: { probe: false, autolaunch: false } });
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
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 1000,
                autolaunch: false,
            });
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
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 1000,
                autolaunch: false,
            });
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
        symlinkSync(externalRoot, authRoot);
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
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 1000,
                autolaunch: false,
            });
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
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 3000,
                autolaunch: false,
            });
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
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 3000,
                autolaunch: false,
            });
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
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                rpcTimeoutMs: 1000,
                timeoutMs: 1000,
                autolaunch: false,
            });
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
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                rpcTimeoutMs: 1000,
                timeoutMs: 1000,
                autolaunch: false,
            });
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
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                rpcTimeoutMs: 50,
                timeoutMs: 1000,
                autolaunch: false,
            });
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
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port,
                rpcTimeoutMs: 1000,
                timeoutMs: 1000,
                autolaunch: false,
            });
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

    it("uses shared ccc-host runtime metadata for zero-config broker status", { timeout: TIMEOUT }, async () => {
        const initial = await client.callTool({ name: "device_broker_status", arguments: { probe: false, autolaunch: false } });
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
                res.end(JSON.stringify({ ok: true, broker: { implemented: ["windows-sandbox-window-minimize-v4", "constant-time-existing-owner-auth-v1", "atomic-owner-secret-provisioning-v1", "owner-mutation-serialization-v1", "atomic-owner-device-state-v1", "cross-process-owner-state-serialization-v1", "owner-device-identity-fencing-v1", "rpc-fault-containment-v1", "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1", "physical-detach-runtime-cleanup-v1", "physical-runtime-cleanup-lease-fencing-v1", "physical-lease-state-write-rollback-v1", "runtime-cleanup-failure-preservation-v1", "appium-runtime-generation-fencing-v1", "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "direct-appium-process-identity-v1", "owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1", "ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v15", "hyper-v-setup-network-v3", "hyper-v-guest-readiness-diagnostics-v1"] } }));
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
            const result = await client.callTool({ name: "device_broker_status", arguments: { probe: true } });
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

    it("rejects a ccc-host runtime missing required broker capabilities without version metadata", { timeout: TIMEOUT }, async () => {
        const initial = await client.callTool({ name: "device_broker_status", arguments: { probe: false, autolaunch: false } });
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
                res.end(JSON.stringify({ ok: true, broker: { implemented: [] } }));
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
            const result = await client.callTool({ name: "device_broker_status", arguments: { probe: true } });
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
                        missingCapabilities: ["windows-sandbox-window-minimize-v4", "constant-time-existing-owner-auth-v1", "atomic-owner-secret-provisioning-v1", "owner-mutation-serialization-v1", "atomic-owner-device-state-v1", "cross-process-owner-state-serialization-v1", "owner-device-identity-fencing-v1", "rpc-fault-containment-v1", "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1", "physical-detach-runtime-cleanup-v1", "physical-runtime-cleanup-lease-fencing-v1", "physical-lease-state-write-rollback-v1", "runtime-cleanup-failure-preservation-v1", "appium-runtime-generation-fencing-v1", "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "direct-appium-process-identity-v1", "owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1", "ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v15", "hyper-v-setup-network-v3", "hyper-v-guest-readiness-diagnostics-v1"],
                    }),
                }),
            }));
            expect(payload.warnings.join(" ")).toContain("windows-sandbox-window-minimize-v4");
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(initialPayload.state.runtimeFile, { force: true });
        }
    });

    it("rejects a stale v14 Hyper-V broker even when runtime metadata is missing", { timeout: TIMEOUT }, async () => {
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        implemented: [
                            ...REQUIRED_CCC_HOST_BROKER_CAPABILITIES.filter((capability) =>
                                capability !== "hyper-v-vm-managed-auto-images-v15"),
                            "hyper-v-vm-managed-auto-images-v14",
                        ],
                    },
                }));
                return;
            }
            if (sendTestOwnerResolve(req, res)) return;
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: "not-found" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;

        try {
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 3000,
                autolaunch: true,
            });
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "host-broker-incompatible",
                launch: expect.objectContaining({
                    ok: false,
                    reused: false,
                    error: "host-broker-incompatible",
                    compatibility: expect.objectContaining({
                        missingCapabilities: ["hyper-v-vm-managed-auto-images-v15"],
                    }),
                }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("rejects a current Hyper-V lifecycle broker with the previous network capability", { timeout: TIMEOUT }, async () => {
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        implemented: [
                            ...REQUIRED_CCC_HOST_BROKER_CAPABILITIES.filter((capability) => capability !== "hyper-v-setup-network-v3"),
                            "hyper-v-setup-network-v2",
                        ],
                    },
                }));
                return;
            }
            if (sendTestOwnerResolve(req, res)) return;
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: "not-found" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;

        try {
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 3000,
                autolaunch: true,
            });
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "host-broker-incompatible",
                launch: expect.objectContaining({
                    ok: false,
                    reused: false,
                    error: "host-broker-incompatible",
                    compatibility: expect.objectContaining({
                        missingCapabilities: ["hyper-v-setup-network-v3"],
                    }),
                }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("rejects a same-version broker without Hyper-V guest readiness diagnostics", { timeout: TIMEOUT }, async () => {
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        implemented: REQUIRED_CCC_HOST_BROKER_CAPABILITIES.filter((capability) =>
                            capability !== "hyper-v-guest-readiness-diagnostics-v1"),
                    },
                }));
                return;
            }
            if (sendTestOwnerResolve(req, res)) return;
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: "not-found" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;

        try {
            const result = await brokerRpc({
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 3000,
                autolaunch: true,
            });
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "host-broker-incompatible",
                launch: expect.objectContaining({
                    ok: false,
                    reused: false,
                    error: "host-broker-incompatible",
                    compatibility: expect.objectContaining({
                        missingCapabilities: ["hyper-v-guest-readiness-diagnostics-v1"],
                    }),
                }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("does not signal a PID claimed by incompatible MCP runtime metadata", { timeout: TIMEOUT }, async () => {
        const initial = await client.callTool({ name: "device_broker_status", arguments: { probe: false, autolaunch: false } });
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
            const result = await client.callTool({
                name: "device_broker_status",
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

    it.runIf(process.platform !== "win32")("atomically replaces a linked MCP runtime without mutating its target", { timeout: TIMEOUT }, async () => {
        const initial = await client.callTool({ name: "device_broker_status", arguments: { probe: false, autolaunch: false } });
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
            const result = await client.callTool({
                name: "device_broker_rpc",
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
            expect(payload.ok).toBe(true);
            launchedPid = payload.launch.runtime.pid;
            expect(readFileSync(external, "utf8")).toBe(externalBytes);
            expect(lstatSync(runtimeFile).isSymbolicLink()).toBe(false);
            expect(JSON.parse(readFileSync(runtimeFile, "utf8"))).toEqual(expect.objectContaining({
                managedBy: "device-lab-mcp",
                port,
            }));
        } finally {
            if (launchedPid && pidAlive(launchedPid)) process.kill(launchedPid, "SIGTERM");
            rmSync(runtimeFile, { force: true });
        }
    });

    it.runIf(process.platform !== "win32")("refuses MCP broker autolaunch through a linked log directory", { timeout: TIMEOUT }, async () => {
        const initial = await client.callTool({ name: "device_broker_status", arguments: { probe: false, autolaunch: false } });
        const initialPayload = JSON.parse(((initial.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            state: { runtimeFile: string; logsRoot: string };
        };
        const externalDirectory = join(homeDir, "external-mcp-broker-logs");
        const marker = join(externalDirectory, "preserve.txt");
        rmSync(initialPayload.state.runtimeFile, { force: true });
        rmSync(initialPayload.state.logsRoot, { recursive: true, force: true });
        mkdirSync(externalDirectory, { recursive: true });
        writeFileSync(marker, "preserve");
        symlinkSync(externalDirectory, initialPayload.state.logsRoot);
        const port = await freePort();
        const launchLog = join(homeDir, "linked-log-launch-attempt.log");
        installFakeCccBroker(pathDir, launchLog);

        try {
            const result = await client.callTool({
                name: "device_broker_rpc",
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

    it("autolaunches, reuses, routes RPC/lease/command, and shuts down an MCP-owned broker", { timeout: TIMEOUT }, async () => {
        const port = await freePort();
        const logPath = join(homeDir, "fake-ccc-broker.log");
        installFakeCccBroker(pathDir, logPath);

        const first = await client.callTool({
            name: "device_broker_rpc",
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
            command: "ccc",
            args: ["devices", "broker", "serve", "--host", "127.0.0.1", "--port", String(port)],
        }));

        const status = await client.callTool({
            name: "device_broker_status",
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

        const second = await client.callTool({
            name: "device_broker_rpc",
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

        const lease = await client.callTool({
            name: "device_broker_lease",
            arguments: { action: "list", backend: "android-device", autolaunch: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        expect(JSON.parse(((lease.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({ backend: "android-device", leases: [] }),
        }));

        const attach = await client.callTool({
            name: "device_broker_attach",
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

        const attachList = await client.callTool({
            name: "device_broker_attach",
            arguments: { action: "list", backend: "android-device", autolaunch: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        expect(JSON.parse(((attachList.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({ backend: "android-device", devices: [], leases: [] }),
        }));

        const detach = await client.callTool({
            name: "device_broker_attach",
            arguments: { action: "detach", backend: "android-device", deviceId: "android-broker-real", autolaunch: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        expect(JSON.parse(((detach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({ detached: "android-broker-real", physicalDevicePoweredOff: false }),
        }));

        const command = await client.callTool({
            name: "device_broker_command",
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

        const brokerFlagCommand = await client.callTool({
            name: "device_status",
            arguments: {
                broker: true,
                backend: "windows-sandbox",
                deviceId: "win-autolaunch",
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
            },
        });
        expect(JSON.parse(((brokerFlagCommand.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            launch: expect.objectContaining({ launched: false, reused: true }),
            result: expect.objectContaining({
                backend: "windows-sandbox",
                command: "device_status",
                deviceId: "win-autolaunch",
                invoked: true,
            }),
            routedBy: "device-lifecycle-broker",
        }));

        mkdirSync(join(homeDir, ".ccc/devices/owners", firstPayload.launch.runtime.ownerId, "windows"), { recursive: true });
        writeFileSync(join(homeDir, ".ccc/devices/owners", firstPayload.launch.runtime.ownerId, "windows", "devices.json"), JSON.stringify({
            devices: [{ id: "win-autolaunch", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/win-autolaunch.wsb" }],
        }));
        const lifecycleStart = await client.callTool({
            name: "device_start",
            arguments: {
                deviceId: "win-autolaunch",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port,
                timeoutMs: 300,
            },
        });
        expect(JSON.parse(((lifecycleStart.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({
                backend: "windows-sandbox",
                command: "device_start",
                deviceId: "win-autolaunch",
                invoked: true,
                execution: expect.objectContaining({ mode: "exec", providerExecution: "fake" }),
            }),
        }));

        const shutdown = await client.callTool({ name: "device_broker_shutdown", arguments: { confirmDestructive: true } });
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

    it("preserves runtime metadata when explicit broker shutdown times out", { timeout: TIMEOUT }, async () => {
        const port = await freePort();
        const logPath = join(homeDir, "fake-ccc-broker-ignore.log");
        installIgnoringCccBroker(pathDir, logPath);
        const launched = await client.callTool({
            name: "device_broker_rpc",
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
        const status = await client.callTool({
            name: "device_broker_status",
            arguments: { probe: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as { state: { runtimeFile: string } };

        const shutdown = await client.callTool({ name: "device_broker_shutdown", arguments: { confirmDestructive: true } });
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
        const launched = await client.callTool({
            name: "device_broker_rpc",
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
        const status = await client.callTool({
            name: "device_broker_status",
            arguments: { probe: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as { state: { runtimeFile: string } };

        const shutdown = await client.callTool({ name: "device_broker_shutdown", arguments: { confirmDestructive: true } });
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
        const launched = await client.callTool({
            name: "device_broker_rpc",
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
        const status = await client.callTool({
            name: "device_broker_status",
            arguments: { probe: true, hostCandidates: ["127.0.0.1"], port, timeoutMs: 300 },
        });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as { state: { runtimeFile: string } };

        const shutdown = await client.callTool({ name: "device_broker_shutdown", arguments: { cleanupTimeoutMs: 200, confirmDestructive: true } });
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

    it("cleans an MCP-owned broker child on MCP process SIGTERM", { timeout: TIMEOUT }, async () => {
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
        const script = join(signalHome, "launch-broker.mjs");
        writeFileSync(script, `
import { brokerRpc } from ${JSON.stringify(join(repoRoot, "device-lab-mcp/src/broker.mjs"))};
const result = await brokerRpc({ method: "broker.echo", autolaunch: true, hostCandidates: ["127.0.0.1"], port: ${port}, timeoutMs: 300, launchTimeoutMs: 3000 });
process.stdout.write(JSON.stringify(result.launch.runtime) + "\\n");
setInterval(() => {}, 1000);
`);
        const child = spawn(process.execPath, [script], {
            cwd: repoRoot,
            env: { ...process.env, HOME: signalHome, PATH: signalBin },
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
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
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
        rmSync(join(pathDir, "ccc"), { force: true });
        const result = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.echo",
                autolaunch: true,
                hostCandidates: ["127.0.0.1"],
                port: 65530,
                timeoutMs: 20,
                launchTimeoutMs: 50,
            },
        });
        expect(result.isError).not.toBe(true);
        const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            error: string;
            launch: { error: string; attempts: Array<{ reason?: string }> };
        };
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe("broker-launch-failed");
        expect(payload.launch.error).toBe("broker-launch-failed");
        expect(payload.launch.attempts).toEqual(expect.arrayContaining([
            expect.objectContaining({ reason: "runtime-pid-not-alive" }),
        ]));
        expect(existsSync(statusPayload.state.runtimeFile)).toBe(false);
    });

    it("relaunches an MCP-owned broker when runtime metadata points at a dead process", { timeout: TIMEOUT }, async () => {
        const status = await client.callTool({ name: "device_broker_status", arguments: { probe: false, autolaunch: false } });
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
            const result = await client.callTool({
                name: "device_broker_rpc",
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
            expect(readFileSync(logPath, "utf8")).toContain(`["devices","broker","serve","--host","127.0.0.1","--port","${port}"]`);
        } finally {
            await client.callTool({ name: "device_broker_shutdown", arguments: { force: true, cleanupTimeoutMs: 300, confirmDestructive: true } });
            rmSync(statusPayload.state.runtimeFile, { force: true });
        }
    });

    it("refuses to autolaunch over another owner's broker runtime metadata", { timeout: TIMEOUT }, async () => {
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
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
        const result = await client.callTool({
            name: "device_broker_rpc",
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
        const status = await client.callTool({ name: "device_broker_status", arguments: { probe: false, autolaunch: false } });
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
            const result = await client.callTool({
                name: "device_broker_rpc",
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
            await client.callTool({ name: "device_broker_shutdown", arguments: { force: true, cleanupTimeoutMs: 300, confirmDestructive: true } });
            rmSync(statusPayload.state.runtimeFile, { force: true });
        }
    });

    it("refuses to shut down broker runtime metadata not managed by device-lab-mcp", { timeout: TIMEOUT }, async () => {
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
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
        const shutdown = await client.callTool({ name: "device_broker_shutdown", arguments: { confirmDestructive: true } });
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
                res.end(JSON.stringify({ ok: true, broker: { implemented: ["windows-sandbox-window-minimize-v4", "constant-time-existing-owner-auth-v1", "atomic-owner-secret-provisioning-v1", "owner-mutation-serialization-v1", "atomic-owner-device-state-v1", "cross-process-owner-state-serialization-v1", "owner-device-identity-fencing-v1", "rpc-fault-containment-v1", "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1", "physical-detach-runtime-cleanup-v1", "physical-runtime-cleanup-lease-fencing-v1", "physical-lease-state-write-rollback-v1", "runtime-cleanup-failure-preservation-v1", "appium-runtime-generation-fencing-v1", "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "direct-appium-process-identity-v1", "owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1", "ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v15", "hyper-v-setup-network-v3", "hyper-v-guest-readiness-diagnostics-v1"] } }));
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
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
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
                name: "device_status",
                arguments: { deviceId: "win-host-runtime" },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                routedBy: string;
                deviceId: string;
                device: { id: string };
            };
            expect(payload).toEqual(expect.objectContaining({
                routedBy: "device-lifecycle-broker-implicit",
                deviceId: "win-host-runtime",
                device: expect.objectContaining({ id: "win-host-runtime" }),
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
            const result = await client.callTool({
                name: "device_broker_rpc",
                arguments: {
                    method: "broker.echo",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 300,
                },
            });
            expect(result.isError).not.toBe(true);
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
            const result = await client.callTool({
                name: "device_broker_rpc",
                arguments: {
                    method: "broker.echo",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 300,
                },
            });
            expect(result.isError).not.toBe(true);
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

    it("forwards lifecycle delete options and long RPC timeouts to the host broker", { timeout: TIMEOUT }, async () => {
        const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, broker: { implemented: ["windows-sandbox-window-minimize-v4", "constant-time-existing-owner-auth-v1", "atomic-owner-secret-provisioning-v1", "owner-mutation-serialization-v1", "atomic-owner-device-state-v1", "cross-process-owner-state-serialization-v1", "owner-device-identity-fencing-v1", "rpc-fault-containment-v1", "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1", "physical-detach-runtime-cleanup-v1", "physical-runtime-cleanup-lease-fencing-v1", "physical-lease-state-write-rollback-v1", "runtime-cleanup-failure-preservation-v1", "appium-runtime-generation-fencing-v1", "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "direct-appium-process-identity-v1", "owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1", "ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v15", "hyper-v-setup-network-v3", "hyper-v-guest-readiness-diagnostics-v1"] } }));
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
                name: "device_delete",
                arguments: {
                    deviceId: "android-delete-options",
                    backend: "android-emulator",
                    broker: true,
                    deleteAvd: false,
                    confirmDestructive: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 10000,
                },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                selected: { timeoutMs: number };
            };
            expect(payload.ok).toBe(true);
            expect(payload.selected.timeoutMs).toBe(10000);
            expect(requests).toEqual([{
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
                name: "device_exec",
                arguments: {
                    deviceId: "win-proxy",
                    command: "Write-Output proxied",
                    viaBroker: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(result.isError).not.toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({ stdout: "proxied ok", status: 0 });
            expect(requests).toEqual([{
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
                res.end(JSON.stringify({ ok: true, broker: { implemented: ["windows-sandbox-window-minimize-v4", "constant-time-existing-owner-auth-v1", "atomic-owner-secret-provisioning-v1", "owner-mutation-serialization-v1", "atomic-owner-device-state-v1", "cross-process-owner-state-serialization-v1", "owner-device-identity-fencing-v1", "rpc-fault-containment-v1", "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1", "physical-detach-runtime-cleanup-v1", "physical-runtime-cleanup-lease-fencing-v1", "physical-lease-state-write-rollback-v1", "runtime-cleanup-failure-preservation-v1", "appium-runtime-generation-fencing-v1", "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "direct-appium-process-identity-v1", "owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1", "ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v15", "hyper-v-setup-network-v3", "hyper-v-guest-readiness-diagnostics-v1"] } }));
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
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
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
                name: "device_exec",
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
                res.end(JSON.stringify({ ok: true, broker: { implemented: ["windows-sandbox-window-minimize-v4", "constant-time-existing-owner-auth-v1", "atomic-owner-secret-provisioning-v1", "owner-mutation-serialization-v1", "atomic-owner-device-state-v1", "cross-process-owner-state-serialization-v1", "owner-device-identity-fencing-v1", "rpc-fault-containment-v1", "cross-owner-physical-lease-serialization-v1", "physical-lease-operation-fencing-v1", "physical-lifecycle-lease-fencing-v1", "physical-attach-detach-operation-serialization-v1", "physical-detach-runtime-cleanup-v1", "physical-runtime-cleanup-lease-fencing-v1", "physical-lease-state-write-rollback-v1", "runtime-cleanup-failure-preservation-v1", "appium-runtime-generation-fencing-v1", "windows-sandbox-singleton-fencing-v1", "cross-process-device-operation-serialization-v1", "cross-process-device-runtime-serialization-v1", "direct-recording-generation-fencing-v1", "direct-appium-generation-fencing-v1", "finite-device-operation-serialization-v1", "direct-runtime-process-identity-v1", "host-recording-process-identity-v1", "runtime-process-observation-v1", "host-appium-process-identity-v1", "broker-owned-owner-secret-provisioning-v1", "host-broker-port-process-identity-v1", "direct-appium-process-identity-v1", "owner-device-state-validation-v1","shared-device-ownership-state-validation-v1","android-emulator-port-allocation-fencing-v1", "bounded-error-responses-v1", "physical-lease-directory-fencing-v1","owner-auth-directory-fencing-v1", "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1", "ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v15", "hyper-v-setup-network-v3", "hyper-v-guest-readiness-diagnostics-v1"] } }));
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
                                    capabilities: ["device_inventory", "device_start", "device_stop"],
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
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
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
                name: "device_backends",
                arguments: {},
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
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
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
                name: "device_status",
                arguments: { deviceId: "win-unmanaged-runtime-direct" },
            });
            expect(result.isError).not.toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-runtime-unavailable",
                routedBy: "device-lifecycle-broker-implicit",
            }));
            const inventory = await client.callTool({
                name: "device_inventory",
                arguments: { backend: "android-device" },
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
        const result = await client.callTool({
            name: "device_broker_status",
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
            const result = await client.callTool({
                name: "device_broker_status",
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
                expect.stringContaining("Restart the host ccc device broker"),
            ]));
            expect(payload.probe.requested).toBe(true);
            expect(payload.probe.available).toBe(true);
            expect(payload.probe.selected).toEqual(expect.objectContaining({
                endpoint: `http://127.0.0.1:${address.port}/health`,
                status: 200,
                body: expect.objectContaining({ ok: true, name: "ccc-device-broker" }),
            }));
            expect(payload.probe.attempts).toHaveLength(1);
            expect(payload.implemented).toContain("broker health probe");
            expect(payload.implemented).toContain("explicit broker Appium process/session/request routing");
            expect(payload.implemented).toContain("opt-in high-level mobile broker Appium routing");
            expect(payload.implemented).toContain("broker desktop device tool result proxying");
            expect(payload.deferred).not.toContain("broker health probe");
            expect(payload.deferred).not.toContain("full direct-provider routing parity through broker");
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
            const result = await client.callTool({
                name: "device_broker_status",
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
