import { spawnSync } from "child_process";
import { toolOperation, publicToolName } from "../../device-lab-mcp/src/tools.mjs";
import { callInternalBroker } from "./helpers/device-lab-mcp-fixture.js";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { AddressInfo } from "net";
import { homedir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { createDeviceBrokerServer } from "@ccc/device-lab/device-lab-broker.js";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { cleanupOwner, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";
import {
    cleanupDeviceLabMcpTestContext,
    createDeviceLabMcpTestContext,
    repoRoot,
    TIMEOUT,
    type DeviceLabMcpTestContext,
} from "./helpers/device-lab-mcp-fixture.js";

function ed25519PublicKeyBlob(seed: number): Buffer {
    const algorithm = Buffer.from("ssh-ed25519", "ascii");
    const key = Buffer.alloc(32, seed);
    const algorithmLength = Buffer.alloc(4);
    const keyLength = Buffer.alloc(4);
    algorithmLength.writeUInt32BE(algorithm.length);
    keyLength.writeUInt32BE(key.length);
    return Buffer.concat([algorithmLength, algorithm, keyLength, key]);
}

describe("device-lab MCP broker routing", () => {
    let context: DeviceLabMcpTestContext;
    let client: DeviceLabMcpTestContext["client"];
    let homeDir: string;

    beforeAll(async () => {
        context = await createDeviceLabMcpTestContext({ defaultImplicitBroker: true });
        client = context.client;
        homeDir = context.homeDir;
        cleanupOwner(brokerOwnerId());
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupDeviceLabMcpTestContext(context);
    }, TIMEOUT);

    function brokerOwnerId() {
        return deviceLabOwnerId(repoRoot);
    }

    function projectTestPath(name: string) {
        return join(repoRoot, "results", name);
    }

    function sendOwnerResolve(req: { method?: string; url?: string }, res: { setHeader(name: string, value: string): void; end(data?: string): void }) {
        if (req.method !== "POST" || req.url !== "/v1/owner/resolve") return false;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: { ownerId: brokerOwnerId() } }));
        return true;
    }

    function writeOwnerDevices(owner: string, stateKey: string, devices: unknown[]) {
        const root = join(homeDir, ".ccc/devices/owners", owner, stateKey);
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "devices.json"), JSON.stringify({ devices }));
    }

    function writePhysicalLease(owner: string, backend: "android-device" | "ios-device", hardwareId: string, deviceId: string, claimId: string, claimNonce: string) {
        const root = join(homeDir, ".ccc/devices/physical-leases", backend, "locks");
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, `${encodeURIComponent(hardwareId)}.json`), JSON.stringify({
            backend,
            hardwareId,
            ownerId: owner,
            deviceId,
            claimId,
            claimNonce,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
    }

    it("preserves public Hyper-V create options across broker routing", { timeout: TIMEOUT }, async () => {
        let receivedParams: Record<string, unknown> = {};
        const authRoot = join(homeDir, ".ccc", "devices", "broker", "auth");
        const authFile = join(authRoot, `${brokerOwnerId()}.json`);
        mkdirSync(authRoot, { recursive: true });
        writeFileSync(authFile, JSON.stringify({ ownerId: brokerOwnerId(), secret: "b".repeat(64), version: 1 }), { mode: 0o600 });
        let activeGuiBackend = "windows-vm";
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({
                    ok: true,
                    name: "ccc-device-broker",
                    mode: "host-broker-daemon",
                    broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION },
                }));
                return;
            }
            if (sendOwnerResolve(req, res)) return;
            let body = "";
            req.on("data", (chunk) => { body += chunk.toString(); });
            req.on("end", () => {
                const parsed = JSON.parse(body || "{}");
                receivedParams = parsed.params || {};
                res.setHeader("content-type", "application/json");
                if (parsed.method === "broker.inventory") {
                    res.end(JSON.stringify({ ok: true, result: { backends: [{ stateKey: activeGuiBackend, backend: activeGuiBackend, devices: [{ id: "hyper-v-create-routing", backend: activeGuiBackend }] }] } }));
                    return;
                }
                if (parsed.method === "broker.backends") {
                    res.end(JSON.stringify({ ok: true, result: { backends: [{ name: "linux-vm", provider: "hyper-v" }] } }));
                    return;
                }
                if (parsed.method === "broker.device.tool.invoke" && parsed.params?.tool === "device_screenshot") {
                    res.end(JSON.stringify({ ok: true, result: { mcpResult: { content: [
                        { type: "text", text: JSON.stringify({ width: 1, height: 1, incarnationId: "4".repeat(32) }) },
                        { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/RuoAAAAASUVORK5CYII=" },
                    ] } } }));
                    return;
                }
                if (parsed.params?.command === "device_start") {
                    res.end(JSON.stringify({ ok: true, result: {
                        device: { id: parsed.params.deviceId, backend: activeGuiBackend, status: "running" },
                        bootReady: false,
                    } }));
                    return;
                }
                res.end(JSON.stringify({ ok: true, result: { deviceId: parsed.params?.deviceId } }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "create_windows_vm",
                arguments: {

                    deviceId: "hyper-v-create-routing",
                    name: "Hyper-V create routing",
                    profile: "windows-11",
                    sourceImage: "C:\\images\\windows-11.vhdx",
                    switchName: "CCC Device Lab",
                    secureBootTemplate: "MicrosoftWindows",
                    viaBroker: true,
                    hostCandidates: ["127.0.0.1"],
                    brokerPort: address.port,
                },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text || "{}"));
            expect(receivedParams, JSON.stringify(payload)).toEqual(expect.objectContaining({
                backend: "windows-vm",
                command: "device_create",
                deviceId: "hyper-v-create-routing",
                profile: "windows-11",
                sourceImage: "C:\\images\\windows-11.vhdx",
                switchName: "CCC Device Lab",
                secureBootTemplate: "MicrosoftWindows",
            }));

            const reboot = await client.callTool({
                name: "reboot",
                arguments: {
                    deviceId: "hyper-v-create-routing",
                    incarnationId: "11111111111111111111111111111111",
                    startIfStopped: true,
                    waitForBoot: false,
                    viaBroker: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                },
            });
            expect(reboot.isError).not.toBe(true);
            expect(receivedParams).toEqual(expect.objectContaining({
                backend: "windows-vm",
                command: "device_reboot",
                deviceId: "hyper-v-create-routing",
                incarnationId: "11111111111111111111111111111111",
                startIfStopped: true,
                waitForBoot: false,
            }));

            const status = await client.callTool({
                name: "status",
                arguments: {
                    deviceId: "hyper-v-create-routing",
                    incarnationId: "22222222222222222222222222222222",
                    viaBroker: true,
                    implicitBroker: false,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                },
            });
            expect(status.isError).not.toBe(true);
            expect(receivedParams).toEqual(expect.objectContaining({
                backend: "windows-vm",
                command: "device_status",
                deviceId: "hyper-v-create-routing",
                incarnationId: "22222222222222222222222222222222",
            }));

            const started = await client.callTool({
                name: "start",
                arguments: {
                    deviceId: "hyper-v-create-routing",
                    incarnationId: "22222222222222222222222222222222",
                    viaBroker: true,
                    waitForBoot: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                },
            });
            expect(started.isError).toBe(true);
            expect(JSON.parse((started.content as Array<{ text: string }>)[0].text)).toMatchObject({
                error: "device-start-not-ready",
                deviceId: "hyper-v-create-routing",
                detail: "boot-readiness-failed",
            });
            expect(receivedParams).toMatchObject({ command: "device_start", waitForBoot: true });

            const snapshots = await client.callTool({
                name: "snapshot",
                arguments: { action: "list",
                    deviceId: "hyper-v-create-routing",
                    incarnationId: "33333333333333333333333333333333",
                    viaBroker: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                },
            });
            expect(snapshots.isError).not.toBe(true);
            expect(receivedParams).toEqual(expect.objectContaining({
                backend: "windows-vm",
                tool: "device_snapshot_list",
                deviceId: "hyper-v-create-routing",
                incarnationId: "33333333333333333333333333333333",
            }));

            const guiCases = [
                ["screenshot", {}],
                ["click", { x: 0, y: 0 }],
                ["click", { count: 2, x: 0, y: 0, button: "right" }],
                ["key", { key: "Ctrl+C" }],
                ["type", { text: "hello" }],
                ["scroll", { x: 0, y: 0, direction: "down" }],
                ["cursor_position", {}],
                ["move", { x: 0, y: 0 }],
            ] as const;
            for (const backend of ["windows-vm", "linux-vm"] as const) {
                activeGuiBackend = backend;
                for (const [name, extra] of guiCases) {
                    const guiResult = await client.callTool({
                        name,
                        arguments: {
                            deviceId: "hyper-v-create-routing",
                            incarnationId: "4".repeat(32),
                            viaBroker: true,
                            hostCandidates: ["127.0.0.1"],
                            port: address.port,
                            ...extra,
                        },
                    });
                    expect(guiResult.isError, `${backend} ${name}: ${JSON.stringify(guiResult.content)}`).not.toBe(true);
                    expect(receivedParams).toEqual(expect.objectContaining({
                        backend, tool: toolOperation(name, extra), deviceId: "hyper-v-create-routing", incarnationId: "4".repeat(32), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "count")),
                    }));
                    if (name === "screenshot") {
                        expect(guiResult.content).toEqual(expect.arrayContaining([
                            expect.objectContaining({ type: "image", mimeType: "image/png" }),
                        ]));
                    }
                }
            }
            const implicitLinux = await client.callTool({
                name: "key",
                arguments: {
                    deviceId: "hyper-v-create-routing",
                    incarnationId: "4".repeat(32),
                    key: "Enter",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                },
            });
            expect(implicitLinux.isError, JSON.stringify(implicitLinux.content)).not.toBe(true);
            expect(receivedParams).toEqual(expect.objectContaining({
                backend: "linux-vm", tool: "device_key", deviceId: "hyper-v-create-routing", key: "Enter",
            }));
            for (const invalid of [
                { backend: "linux-vm", x: 0 },
                { backend: "windows-vm", x: 0, y: -1 },
                { backend: "windows-sandbox", x: 0, y: 0 },
            ]) {
                const rejected = await client.callTool({
                    name: "cursor_position",
                    arguments: { deviceId: "hyper-v-create-routing", incarnationId: "4".repeat(32), ...invalid },
                });
                expect(JSON.parse(((rejected.content as Array<{ text?: string }>)[0].text || "{}"))).toEqual(expect.objectContaining({ ok: false }));
            }
        } finally {
            rmSync(authFile, { force: true });
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes explicit deletion to the broker and refuses implicit cross-backend ownership ambiguity", { timeout: TIMEOUT }, async () => {
        const deviceId = "qemu-broker-delete-route";
        const localLab = { id: deviceId, name: "Retained QEMU lab", provider: "container-qemu", runtimeState: "stopped", runtime: null };
        const labDir = join(homeDir, ".ccc/labs/owners", brokerOwnerId(), "labs", deviceId);
        const labFile = join(labDir, "lab.json");
        mkdirSync(labDir, { recursive: true });
        writeFileSync(labFile, JSON.stringify(localLab));
        const windowsRoot = join(homeDir, ".ccc/devices/owners", brokerOwnerId(), "windows");
        const windowsFile = join(windowsRoot, "devices.json");
        const previousWindows = existsSync(windowsFile) ? readFileSync(windowsFile) : undefined;
        const authRoot = join(homeDir, ".ccc/devices/broker/auth");
        const authFile = join(authRoot, `${brokerOwnerId()}.json`);
        const previousAuth = existsSync(authFile) ? readFileSync(authFile) : undefined;
        mkdirSync(authRoot, { recursive: true });
        writeFileSync(authFile, JSON.stringify({ ownerId: brokerOwnerId(), secret: "b".repeat(64), version: 1 }), { mode: 0o600 });
        const invocations: Array<Record<string, unknown>> = [];
        let brokerBackends: Array<{ stateKey?: string; devices: Array<{ id: string; backend?: string }> }> = [
            { stateKey: "windows-vm", devices: [{ id: deviceId, backend: "windows-vm" }] },
        ];
        const server = createServer(async (req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/health" || req.url === "/status") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon", broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION } }));
                return;
            }
            if (sendOwnerResolve(req, res)) return;
            let rawBody = "";
            for await (const chunk of req) rawBody += chunk;
            const body = JSON.parse(rawBody || "{}") as { method?: string; params?: Record<string, unknown> };
            if (body.method === "broker.inventory") {
                res.end(JSON.stringify({ ok: true, result: { backends: brokerBackends } }));
                return;
            }
            if (body.method === "broker.command.invoke") {
                invocations.push(body.params || {});
                res.end(JSON.stringify({ ok: true, result: { deleted: deviceId } }));
                return;
            }
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: "unexpected-broker-operation" }));
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const route = { deviceId, confirmDestructive: true, hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 };
            const explicit = await client.callTool({ name: "delete", arguments: { ...route, broker: true, incarnationId: "5".repeat(32) } });
            expect(explicit.isError, JSON.stringify(explicit.content)).not.toBe(true);
            expect(invocations).toEqual([expect.objectContaining({ command: "device_delete", backend: "windows-vm", deviceId })]);
            expect(JSON.parse(readFileSync(labFile, "utf8"))).toEqual(localLab);

            invocations.length = 0;
            const implicit = await client.callTool({ name: "delete", arguments: route });
            expect(implicit.isError).toBe(true);
            expect(JSON.parse((implicit.content as Array<{ text: string }>)[0].text)).toMatchObject({
                error: "ambiguous-device-backend", deviceId, matches: ["linux-vm", "windows-vm"],
            });
            expect(invocations).toEqual([]);
            expect(JSON.parse(readFileSync(labFile, "utf8"))).toEqual(localLab);

            for (const unattributed of [
                { devices: [{ id: deviceId }] },
                { stateKey: "unknown-backend", devices: [{ id: deviceId }] },
            ]) {
                brokerBackends = [unattributed];
                const refused = await client.callTool({ name: "delete", arguments: route });
                expect(refused.isError).toBe(true);
                expect(JSON.parse((refused.content as Array<{ text: string }>)[0].text)).toMatchObject({
                    ok: false, error: "broker-inventory-invalid",
                });
                expect(invocations).toEqual([]);
                expect(JSON.parse(readFileSync(labFile, "utf8"))).toEqual(localLab);
            }
            brokerBackends = [{ stateKey: "windows-vm", devices: [{ id: deviceId, backend: "windows-vm" }] }];

            const localWindows = { id: deviceId, backend: "windows-sandbox", status: "stopped", configPath: join(windowsRoot, "owned-collision.wsb") };
            mkdirSync(windowsRoot, { recursive: true });
            writeFileSync(windowsFile, JSON.stringify({ devices: [localWindows] }));
            const localCollision = await client.callTool({ name: "delete", arguments: route });
            expect(localCollision.isError).toBe(true);
            expect(JSON.parse((localCollision.content as Array<{ text: string }>)[0].text)).toMatchObject({
                error: "ambiguous-device-backend", deviceId, matches: ["windows-sandbox", "linux-vm"],
            });
            expect(invocations).toEqual([]);
            expect(JSON.parse(readFileSync(labFile, "utf8"))).toEqual(localLab);
            expect(JSON.parse(readFileSync(windowsFile, "utf8"))).toEqual({ devices: [localWindows] });
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            rmSync(labDir, { recursive: true, force: true });
            if (previousWindows) writeFileSync(windowsFile, previousWindows);
            else rmSync(windowsFile, { force: true });
            if (previousAuth) writeFileSync(authFile, previousAuth, { mode: 0o600 });
            else rmSync(authFile, { force: true });
        }
    });

    it("preserves the Hyper-V Linux create response contract across MCP broker routing", { timeout: TIMEOUT }, async () => {
        const device = {
            id: "hyper-v-linux-create-response",
            backend: "linux-vm",
            provider: "hyper-v",
            guestProvisioned: true,
            guestTransport: "ssh",
            switchName: "CCC Device Lab",
            networkAddress: "172.29.0.10",
        };
        const authRoot = join(homeDir, ".ccc", "devices", "broker", "auth");
        const authFile = join(authRoot, `${brokerOwnerId()}.json`);
        mkdirSync(authRoot, { recursive: true });
        writeFileSync(authFile, JSON.stringify({ ownerId: brokerOwnerId(), secret: "b".repeat(64), version: 1 }), { mode: 0o600 });
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({
                    ok: true,
                    name: "ccc-device-broker",
                    mode: "host-broker-daemon",
                    broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION },
                }));
                return;
            }
            if (sendOwnerResolve(req, res)) return;
            let body = "";
            req.on("data", (chunk) => { body += chunk.toString(); });
            req.on("end", () => {
                const parsed = JSON.parse(body || "{}");
                res.setHeader("content-type", "application/json");
                if (parsed.method === "broker.backends") {
                    res.end(JSON.stringify({
                        ok: true,
                        result: { backends: [{ name: "linux-vm", provider: "hyper-v" }] },
                    }));
                    return;
                }
                if (parsed.method === "broker.command.invoke"
                    && parsed.params?.deviceId === "hyper-v-network-diagnostic-failure") {
                    res.statusCode = 502;
                    res.end(JSON.stringify({
                        ok: false,
                        error: "hyper-v-network-setup-failed",
                        detail: "hyper-v-network-pipe-handshake-timeout",
                        execution: {
                            mode: "exec",
                            provider: "hyper-v",
                            status: 1,
                            stdoutPresent: true,
                            stderrPresent: true,
                            outputRedacted: true,
                            diagnosticCode: "hyper-v-network-pipe-handshake-timeout",
                        },
                    }));
                    return;
                }
                res.end(JSON.stringify({ ok: true, result: { device } }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "create_linux_vm",
                arguments: {

                    deviceId: device.id,
                    name: "Hyper-V Linux create response",
                    provider: "hyper-v",
                    broker: true,
                    implicitBroker: false,
                    hostCandidates: ["127.0.0.1"],
                    brokerPort: address.port,
                },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text || "{}"));
            expect(payload).toEqual(expect.objectContaining({
                ok: true,
                routedBy: "device-lifecycle-broker",
                result: { device: { ...device, id: undefined, deviceId: device.id } },
            }));
            const failed = await client.callTool({
                name: "create_linux_vm",
                arguments: {

                    deviceId: "hyper-v-network-diagnostic-failure",
                    name: "Hyper-V Linux diagnostic failure",
                    viaBroker: true,
                    hostCandidates: ["127.0.0.1"],
                    brokerPort: address.port,
                },
            });
            const failedPayload = JSON.parse(((failed.content as Array<{ text?: string }>)[0].text || "{}"));
            expect(failedPayload).toEqual(expect.objectContaining({
                ok: false,
                detail: "hyper-v-network-pipe-handshake-timeout",
                body: expect.objectContaining({
                    execution: expect.objectContaining({
                        outputRedacted: true,
                        diagnosticCode: "hyper-v-network-pipe-handshake-timeout",
                    }),
                }),
                routedBy: "device-lifecycle-broker",
            }));
            expect(JSON.stringify(failedPayload)).not.toContain("sensitive-network");
        } finally {
            rmSync(authFile, { force: true });
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("rejects caller-selected broker hosts before owner tokens can be sent", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "status",
            arguments: {
                deviceId: "untrusted-broker-route",
                viaBroker: true,
                hostCandidates: ["attacker.example.test"],
                brokerPort: 17373,
            },
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text || "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "invalid-broker-host-candidate",
            host: "attacker.example.test",
            attempts: [],
        }));
    });

    it("ignores untrusted hosts persisted in broker runtime metadata", { timeout: TIMEOUT }, async () => {
        let attackerRequests = 0;
        const attacker = createServer((_req, res) => {
            attackerRequests += 1;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, result: { ownerId: brokerOwnerId() } }));
        });
        await new Promise<void>((resolve) => attacker.listen(0, "127.0.0.1", resolve));
        const address = attacker.address() as AddressInfo;
        const runtimeFile = join(homeDir, ".ccc/devices/broker/runtime.json");
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        try {
            for (const runtime of [
                { host: "localhost", hostCandidates: ["localhost"] },
                { host: "0.0.0.0", probeHost: "localhost", hostCandidates: ["127.0.0.1"] },
            ]) {
                writeFileSync(runtimeFile, JSON.stringify({
                    ownerId: brokerOwnerId(),
                    pid: process.pid,
                    ...runtime,
                    port: address.port,
                    managedBy: "ccc-host",
                }));
                await client.callTool({
                    name: "status",
                    arguments: { deviceId: "forged-runtime-route" },
                });
            }
            expect(attackerRequests).toBe(0);
        } finally {
            rmSync(runtimeFile, { force: true });
            await new Promise<void>((resolve, reject) => attacker.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("promotes bounded broker lifecycle diagnostics to the public MCP error", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { wsb: "C:\\Windows\\System32\\WindowsSandbox.exe" },
            commandRunner: vi.fn((command) => ({
                ...command,
                status: 1,
                stdout: "",
                stderr: "hyper-v-base-image-download-host-rejected",
            })),
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const created = await client.callTool({
                name: "create_windows_sandbox",
                arguments: {

                    deviceId: "hyper-v-diagnostic-routing",
                    name: "Hyper-V diagnostic routing",
                    viaBroker: true,
                    hostCandidates: ["127.0.0.1"],
                    brokerPort: address.port,
                },
            });
            expect(JSON.parse(((created.content as Array<{ text?: string }>)[0].text || "{}"))).toEqual(expect.objectContaining({ ok: true }));
            const result = await client.callTool({
                name: "start",
                arguments: {
                    deviceId: "hyper-v-diagnostic-routing",
                    viaBroker: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                },
            });
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text || "{}"));
            expect(payload).toEqual(expect.objectContaining({
                ok: false,
                error: "windows-sandbox-runtime-snapshot-failed",
                detail: "error: windows-sandbox-runtime-snapshot-failed\nstderr: hyper-v-base-image-download-host-rejected",
                routedBy: "device-lifecycle-broker-implicit",
            }));
        } finally {
            cleanupOwner(brokerOwnerId());
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes device_list through broker inventory while retaining the container display", { timeout: TIMEOUT }, async () => {
        const owner = brokerOwnerId();
        writeOwnerDevices(owner, "windows-vm", [{
            id: "broker-listed-windows-vm",
            backend: "windows-vm",
            status: "stopped",
        }]);
        const server = createDeviceBrokerServer({ cwd: repoRoot, host: "127.0.0.1", port: 0 });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "devices",
                arguments: { hostCandidates: ["127.0.0.1"], port: address.port },
            });
            expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text || "{}"));
            expect(payload.routedBy).toBe("device-list-broker-implicit");
            expect(payload.devices).toEqual(expect.arrayContaining([
                expect.objectContaining({ deviceId: "x11-current-display" }),
                expect.objectContaining({ deviceId: "broker-listed-windows-vm", backend: "windows-vm" }),
            ]));
        } finally {
            cleanupOwner(owner);
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes explicit Hyper-V Linux tools through the advertised host broker backend", { timeout: TIMEOUT }, async () => {
        const owner = brokerOwnerId();
        const privateRoot = join(homeDir, ".ccc/device-broker-private/owners", owner, "linux-vm", "hyper-v-linux-route");
        const deviceRoot = join(privateRoot, "artifacts");
        const sshPrivateKeyPath = join(privateRoot, "secrets", "id_ed25519");
        const sshHostPublicKeyPath = join(privateRoot, "secrets", "ssh_host_ed25519_key.pub");
        const sshKnownHostsPath = join(privateRoot, "secrets", "known_hosts");
        const hostKeyBytes = ed25519PublicKeyBlob(5);
        const hostKeyBase64 = hostKeyBytes.toString("base64");
        const hostKeyFingerprint = `SHA256:${createHash("sha256").update(hostKeyBytes).digest("base64").replace(/=+$/, "")}`;
        const incarnationId = "1".repeat(32);
        mkdirSync(deviceRoot, { recursive: true });
        mkdirSync(join(privateRoot, "secrets"), { recursive: true });
        writeFileSync(sshPrivateKeyPath, "test-private-key");
        writeFileSync(sshHostPublicKeyPath, `ssh-ed25519 ${hostKeyBase64} ccc-host\n`);
        writeFileSync(sshKnownHostsPath, `172.29.0.10 ssh-ed25519 ${hostKeyBase64} ccc-host\n`);
        writeFileSync(join(privateRoot, "incarnation.json"), JSON.stringify({ version: 1, ownerId: owner, backend: "linux-vm", deviceId: "hyper-v-linux-route", incarnationId, createdAt: new Date().toISOString() }));
        const networkStatePath = join(homeDir, ".ccc", "device-broker-private", "network", "hyper-v.json");
        mkdirSync(join(homeDir, ".ccc", "device-broker-private", "network"), { recursive: true });
        writeFileSync(networkStatePath, JSON.stringify({ version: 1, switchName: "CCC Device Lab", switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", natName: "CCCDeviceLab", prefix: "172.29.0.0/24", gateway: "172.29.0.1", allocations: [{ ownerId: owner, deviceId: "hyper-v-linux-route", address: "172.29.0.10", allocatedAt: new Date().toISOString() }] }));
        const routeDevice = {
            id: "hyper-v-linux-route",
            backend: "linux-vm",
            status: "running",
            provider: "hyper-v",
            incarnationId,
            memoryMb: 2048,
            cpus: 2,
            diskMaxBytes: 32 * 1024 * 1024 * 1024,
            vmId: "12345678-1234-1234-1234-123456789abc",
            vmName: `ccc-${owner}-hyper-v-linux-route-${incarnationId}`,
            diskPath: join(deviceRoot, "disks", "root.vhdx"),
            deviceRoot,
            privateRoot,
            sshPrivateKeyPath,
            sshHostPublicKeyPath,
            sshHostKeyFingerprint: hostKeyFingerprint,
            sshKnownHostsPath,
            guestUsername: `ccc${owner.slice(0, 8)}`,
            networkAddress: "172.29.0.10",
        };
        writeBrokerDevices(owner, "linux-vm", [routeDevice]);
        const commandRunner = vi.fn((command) => {
            const script = command.provider === "hyper-v"
                ? Buffer.from(command.args?.at(-1) || "", "base64").toString("utf16le")
                : "";
            return {
                ...command,
                status: 0,
                stdout: command.provider === "hyper-v-ssh"
                    ? "Linux"
                    : script.includes("Restart-VM")
                        ? JSON.stringify({ ok: true, vmId: "12345678-1234-1234-1234-123456789abc", vmName: `ccc-${owner}-hyper-v-linux-route-${incarnationId}`, state: "Running", status: "Operating normally", diskPath: join(deviceRoot, "disks", "root.vhdx") })
                        : JSON.stringify({ available: true, platform: "win32", powershell: true, hyperVModule: true, hypervisorPresent: true, vmmsRunning: true, rebootPending: false, totalMemoryMb: 32768, freeMemoryMb: 16384, logicalProcessors: 16, missing: [] }),
                stderr: "",
            };
        });
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "C:\\Windows\\powershell.exe", "ssh.exe": "C:\\Windows\\ssh.exe", ssh: "C:\\Windows\\ssh.exe", "scp.exe": "C:\\Windows\\scp.exe", scp: "C:\\Windows\\scp.exe" },
            commandRunner,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "exec",
                arguments: {
                    deviceId: "hyper-v-linux-route",
                    incarnationId,
                    command: "uname -s",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                },
            });
            expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text || "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ provider: "hyper-v-ssh", stdout: "Linux", backend: "linux-vm" }),
            }));
            expect(commandRunner.mock.calls.some(([command]) => command.provider === "hyper-v-ssh")).toBe(true);

            const reboot = await client.callTool({
                name: "reboot",
                arguments: {
                    deviceId: "hyper-v-linux-route",
                    incarnationId,
                    waitForBoot: false,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                },
            });
            const rebootPayload = JSON.parse(((reboot.content as Array<{ text?: string }>)[0].text || "{}"));
            expect(rebootPayload, JSON.stringify(rebootPayload)).toEqual(expect.objectContaining({
                ok: false,
                status: 400,
                error: "linux-vm-bootstrap-requires-boot-wait",
            }));
            expect(commandRunner.mock.calls.some(([command]) => {
                if (command.provider !== "hyper-v") return false;
                return Buffer.from(command.args?.at(-1) || "", "base64").toString("utf16le").includes("Restart-VM");
            })).toBe(false);

            writeBrokerDevices(owner, "linux-vm", [{ ...routeDevice, sshHostKeyFingerprint: `SHA256:${"A".repeat(43)}` }]);
            const rejected = await client.callTool({
                name: "exec",
                arguments: { deviceId: "hyper-v-linux-route", incarnationId, command: "uname -s", hostCandidates: ["127.0.0.1"], port: address.port },
            });
            expect(JSON.parse(((rejected.content as Array<{ text?: string }>)[0].text || "{}"))).toEqual(expect.objectContaining({ ok: false, error: "hyper-v-linux-ssh-host-identity-invalid" }));
        } finally {
            cleanupOwner(owner);
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("calls an explicitly supplied host broker RPC endpoint with owner token guard", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await callInternalBroker(client, { operation: "brokerRpc",
                arguments: {
                    method: "broker.echo",
                    params: { wifiRealDevice: true },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                ownerId: string;
                method: string;
                selected: { endpoint: string; status: number; body: { ok: boolean } };
                result: { ownerId: string; params: { wifiRealDevice: boolean } };
                attempts: Array<{ ok: boolean; status: number }>;
            };
            expect(payload.ok).toBe(true);
            expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
            expect(payload.method).toBe("broker.echo");
            expect(payload.selected).toEqual(expect.objectContaining({
                endpoint: `http://127.0.0.1:${address.port}/v1/owners/${payload.ownerId}/rpc`,
                status: 200,
                body: expect.objectContaining({ ok: true }),
            }));
            expect(payload.result).toEqual({
                ownerId: payload.ownerId,
                params: { wifiRealDevice: true },
            });
            expect(payload.attempts).toEqual([expect.objectContaining({ ok: true, status: 200 })]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes explicit recording start and stop through the owner-scoped broker", { timeout: TIMEOUT }, async () => {
        const owner = brokerOwnerId();
        writeOwnerDevices(owner, "android", [{
            id: "pixel-mcp-record",
            status: "running",
            backend: "android-emulator",
            port: 5572,
        }]);
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            pid: command.mode === "detached" ? 13579 : undefined,
            stdout: "ok",
            stderr: "",
        }));
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const start = await client.callTool({
                name: "record_video",
                arguments: { action: "start",
                    broker: true,
                    deviceId: "pixel-mcp-record",
                    remotePath: "/sdcard/mcp.mp4",
                    localPath: projectTestPath("mcp.mp4"),
                    timeLimitSec: 9,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(start.isError).not.toBe(true);
            expect(JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                routedBy: "device-mutating-broker-implicit",
                    tool: "device_record_video_start",
                    backend: "android-emulator",
                    deviceId: "pixel-mcp-record",
                    startsDevices: false,
                    recording: expect.objectContaining({
                        active: true,
                        remotePath: "/sdcard/mcp.mp4",
                        localPath: projectTestPath("mcp.mp4"),
                        timeLimitSec: 9,
                    }),
            }));

            const stop = await client.callTool({
                name: "record_video",
                arguments: { action: "stop",
                    broker: true,
                    deviceId: "pixel-mcp-record",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(stop.isError).not.toBe(true);
            expect(JSON.parse(((stop.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                routedBy: "device-mutating-broker-implicit",
                    tool: "device_record_video_stop",
                    stopped: true,
                    recording: expect.objectContaining({ active: false, localPath: projectTestPath("mcp.mp4") }),
            }));
            expect(killSpy).not.toHaveBeenCalled();
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                mode: "detached",
                provider: "adb",
                args: ["-s", "emulator-5572", "shell", "screenrecord", "--time-limit", "9", "/sdcard/mcp.mp4"],
            }), expect.any(Object));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                mode: "exec",
                provider: "adb",
                args: ["-s", "emulator-5572", "pull", "/sdcard/mcp.mp4", projectTestPath("mcp.mp4")],
            }), expect.any(Object));

            const implicitStart = await client.callTool({
                name: "record_video",
                arguments: { action: "start",
                    deviceId: "pixel-mcp-record",
                    remotePath: "/sdcard/implicit.mp4",
                    localPath: projectTestPath("implicit.mp4"),
                    timeLimitSec: 5,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(JSON.parse(((implicitStart.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                tool: "device_record_video_start",
                provider: "adb-screenrecord",
                recording: expect.objectContaining({ active: true, localPath: projectTestPath("implicit.mp4") }),
                routedBy: "device-mutating-broker-implicit",
            }));

            const implicitStatus = await client.callTool({
                name: "record_video",
                arguments: { action: "status", deviceId: "pixel-mcp-record", hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 },
            });
            expect(JSON.parse(((implicitStatus.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "adb-screenrecord",
                recording: expect.objectContaining({ active: true }),
                routedBy: "device-readonly-broker-implicit",
            }));

            const implicitStop = await client.callTool({
                name: "record_video",
                arguments: { action: "stop", deviceId: "pixel-mcp-record", hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 },
            });
            expect(JSON.parse(((implicitStop.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                tool: "device_record_video_stop",
                provider: "adb-screenrecord",
                stopped: true,
                recording: expect.objectContaining({ active: false }),
                routedBy: "device-mutating-broker-implicit",
            }));
            const persisted = JSON.parse(readFileSync(join(homeDir, ".ccc/devices/owners", owner, "android", "devices.json"), "utf8"));
            expect(persisted.devices[0].recording).toBeNull();
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes Android file and app device tools through the MCP broker wrapper", { timeout: TIMEOUT }, async () => {
        const owner = brokerOwnerId();
        writeOwnerDevices(owner, "android", [{
            id: "android-route",
            backend: "android-emulator",
            status: "running",
            port: 5586,
        }]);
        const deviceToolRunner = vi.fn((runnerOwner, parsed, match) => ({
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId: runnerOwner,
                    tool: parsed.tool,
                    deviceId: parsed.deviceId,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    provider: "fake-android-device-tool-runner",
                    mcpResult: {
                        content: [{ type: "text", text: JSON.stringify({ tool: parsed.tool, params: parsed.params }) }],
                    },
                },
            },
        }));
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            deviceToolRunner,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const install = await client.callTool({
                name: "install_app",
                arguments: {
                    viaBroker: true,
                    deviceId: "android-route",
                    path: projectTestPath("Test.apk"),
                    replace: false,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(install.isError).not.toBe(true);
            expect(JSON.parse(((install.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({
                tool: "device_install_app",
                params: expect.objectContaining({
                    backend: "android-emulator",
                    deviceId: "android-route",
                    path: projectTestPath("Test.apk"),
                    replace: false,
                }),
            });
            expect(deviceToolRunner).toHaveBeenCalledWith(owner, expect.objectContaining({
                tool: "device_install_app",
                deviceId: "android-route",
                params: expect.objectContaining({ path: projectTestPath("Test.apk"), replace: false }),
            }), expect.objectContaining({ backend: "android-emulator", stateKey: "android" }), expect.any(Object));

            const download = await client.callTool({
                name: "download",
                arguments: {
                    viaBroker: true,
                    deviceId: "android-route",
                    remotePath: "/sdcard/out.txt",
                    localPath: projectTestPath("out.txt"),
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(download.isError).not.toBe(true);
            expect(JSON.parse(((download.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({
                tool: "device_download",
                params: expect.objectContaining({
                    remotePath: "/sdcard/out.txt",
                    localPath: projectTestPath("out.txt"),
                }),
            });
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes every backend-runner device tool through broker.device.tool.invoke", { timeout: TIMEOUT }, async () => {
        const owner = brokerOwnerId();
        writeOwnerDevices(owner, "windows", [{
            id: "win-runner-route",
            backend: "windows-sandbox",
            status: "running",
            configPath: "C:/ccc/win-runner-route.wsb",
        }]);
        writeOwnerDevices(owner, "android", [{
            id: "android-runner-route",
            backend: "android-emulator",
            status: "running",
            port: 5598,
        }]);
        writeOwnerDevices(owner, "ios", [{
            id: "ios-runner-route",
            backend: "ios-simulator",
            status: "running",
            udid: "SIM-RUNNER-ROUTE",
        }]);
        writeOwnerDevices(owner, "ios-device", [{
            id: "ios-real-runner-route",
            backend: "ios-device",
            status: "attached",
            udid: "REAL-RUNNER-ROUTE",
            leaseClaimId: "ios-real-runner-route-claim",
            leaseClaimNonce: "ios-real-runner-route-nonce",
        }]);
        writePhysicalLease(owner, "ios-device", "REAL-RUNNER-ROUTE", "ios-real-runner-route", "ios-real-runner-route-claim", "ios-real-runner-route-nonce");
        const deviceToolRunner = vi.fn((runnerOwner, parsed, match) => ({
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId: runnerOwner,
                    tool: parsed.tool,
                    deviceId: parsed.deviceId,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    mcpResult: {
                        content: [{ type: "text", text: JSON.stringify({ tool: parsed.tool, backend: match.backend, params: parsed.params }) }],
                    },
                },
            },
        }));
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            deviceToolRunner,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const baseBrokerArgs = {
            viaBroker: true,
            hostCandidates: ["127.0.0.1"],
            port: address.port,
            timeoutMs: 500,
        };
        const desktopCases = [
            ["exec", { command: "Write-Output ok" }],
            ["screenshot", {}],
            ["click", { x: 10, y: 11 }],
            ["click", { count: 2, x: 12, y: 13 }],
            ["key", { key: "Escape" }],
            ["type", { text: "hello" }],
            ["scroll", { direction: "down", amount: 2 }],
            ["cursor_position", {}],
            ["window_list", {}],
            ["ui", { maxDepth: 1, maxNodes: 5 }],
            ["upload", { localPath: projectTestPath("upload.txt"), remotePath: "C:\\ccc\\upload.txt" }],
            ["download", { remotePath: "C:\\ccc\\download.txt", localPath: projectTestPath("download.txt") }],
        ] as const;
        const androidCases = [
            ["clear_app_data", { appId: "com.example.route", confirmDestructive: true }],
            ["install_app", { path: projectTestPath("Test.apk"), replace: true }],
            ["launch_app", { appId: "com.example.route" }],
            ["clear_app_data", { appId: "com.example.route", confirmDestructive: true }],
        ] as const;
        const iosSimulatorCases = [
            ["screenshot", {}],
            ["exec", { command: "xcrun simctl getenv booted SIMULATOR_UDID" }],
            ["clear_app_data", { appId: "com.example.route", containerType: "data", confirmDestructive: true }],
        ] as const;
        const iosRealCases = [
            ["screenshot", {}],
        ] as const;

        try {
            for (const [name, extra] of desktopCases) {
                const result = await client.callTool({
                    name,
                    arguments: {
                        ...baseBrokerArgs,
                        deviceId: "win-runner-route",
                        ...extra,
                    },
                });
                expect(result.isError).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    tool: toolOperation(name, extra),
                    backend: "windows-sandbox",
                    params: expect.objectContaining({
                        backend: "windows-sandbox",
                        deviceId: "win-runner-route",
                    }),
                }));
            }

            for (const [name, extra] of androidCases) {
                const result = await client.callTool({
                    name,
                    arguments: {
                        ...baseBrokerArgs,
                        deviceId: "android-runner-route",
                        ...extra,
                    },
                });
                expect(result.isError).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    tool: toolOperation(name, extra),
                    backend: "android-emulator",
                    params: expect.objectContaining({
                        backend: "android-emulator",
                        deviceId: "android-runner-route",
                    }),
                }));
            }

            for (const [name, extra] of iosSimulatorCases) {
                const result = await client.callTool({
                    name,
                    arguments: {
                        ...baseBrokerArgs,
                        deviceId: "ios-runner-route",
                        ...extra,
                    },
                });
                expect(result.isError).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    tool: toolOperation(name, extra),
                    backend: "ios-simulator",
                    params: expect.objectContaining({
                        backend: "ios-simulator",
                        deviceId: "ios-runner-route",
                    }),
                }));
            }

            for (const [name, extra] of iosRealCases) {
                const result = await client.callTool({
                    name,
                    arguments: {
                        ...baseBrokerArgs,
                        deviceId: "ios-real-runner-route",
                        ...extra,
                    },
                });
                expect(result.isError).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    tool: toolOperation(name, extra),
                    backend: "ios-device",
                    params: expect.objectContaining({
                        backend: "ios-device",
                        deviceId: "ios-real-runner-route",
                    }),
                }));
            }

            expect(deviceToolRunner).toHaveBeenCalledTimes(desktopCases.length + androidCases.length + iosSimulatorCases.length + iosRealCases.length);
            expect(deviceToolRunner.mock.calls.map(([, parsed]) => publicToolName(parsed.tool))).toEqual([
                ...desktopCases.map(([name]) => name),
                ...androidCases.map(([name]) => name),
                ...iosSimulatorCases.map(([name]) => name),
                ...iosRealCases.map(([name]) => name),
            ]);
            expect(deviceToolRunner.mock.calls.map(([, , match]) => match.backend)).toEqual([
                ...desktopCases.map(() => "windows-sandbox"),
                ...androidCases.map(() => "android-emulator"),
                ...iosSimulatorCases.map(() => "ios-simulator"),
                ...iosRealCases.map(() => "ios-device"),
            ]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(homeDir, ".ccc/devices/owners", owner, "windows"), { recursive: true, force: true });
            rmSync(join(homeDir, ".ccc/devices/owners", owner, "android"), { recursive: true, force: true });
            rmSync(join(homeDir, ".ccc/devices/owners", owner, "ios"), { recursive: true, force: true });
            rmSync(join(homeDir, ".ccc/devices/owners", owner, "ios-device"), { recursive: true, force: true });
            rmSync(join(homeDir, ".ccc/devices/physical-leases/ios-device/locks", `${encodeURIComponent("REAL-RUNNER-ROUTE")}.json`), { force: true });
        }
    });

    it("routes implicit mobile controls through the owner-scoped broker device tool", { timeout: TIMEOUT }, async () => {
        const owner = brokerOwnerId();
        writeBrokerDevices(owner, "android-device", [{
            id: "android-real-route",
            backend: "android-device",
            status: "attached",
            serial: "R5CIMPLICIT123",
            leaseClaimId: "android-real-route-claim",
            leaseClaimNonce: "android-real-route-nonce",
        }]);
        writePhysicalLease(owner, "android-device", "R5CIMPLICIT123", "android-real-route", "android-real-route-claim", "android-real-route-nonce");
        const deviceToolRunner = vi.fn((runnerOwner, parsed, match) => ({
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId: runnerOwner,
                    tool: parsed.tool,
                    deviceId: parsed.deviceId,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    provider: "fake-android-real-mobile-tool-runner",
                    mcpResult: {
                        content: [{ type: "text", text: JSON.stringify({ tool: parsed.tool, params: parsed.params }) }],
                    },
                },
            },
        }));
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            deviceToolRunner,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const implicitMobileCases = [
                ["key", { keyCode: 224 }],
                ["click", { x: 10, y: 20 }],
                ["screenshot", {}],
                ["ui", {}],
                ["wait_for_text", { text: "Ready", timeoutMs: 100, intervalMs: 50 }],
                ["open_url", { url: "https://example.test/route" }],
                ["install_app", { path: projectTestPath("Route.apk") }],
                ["launch_app", { appId: "com.example.route" }],
                ["stop_app", { appId: "com.example.route" }],
            ] as const;

            for (const [name, extra] of implicitMobileCases) {
                const result = await client.callTool({
                    name,
                    arguments: {
                        deviceId: "android-real-route",
                        hostCandidates: ["127.0.0.1"],
                        port: address.port,
                        timeoutMs: 500,
                        ...extra,
                    },
                });

                expect(result.isError).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({
                    tool: ({ click: "mobile_tap", type: "mobile_type_text", key: "mobile_key", ui: "mobile_dump_ui" } as Record<string, string>)[name] || toolOperation(name, extra),
                    params: expect.objectContaining({
                        backend: "android-device",
                        deviceId: "android-real-route",
                        ...("appId" in extra ? { packageName: extra.appId, bundleId: extra.appId } : extra),
                    }),
                });
            }
            expect(deviceToolRunner).toHaveBeenCalledTimes(implicitMobileCases.length);
            expect(deviceToolRunner.mock.calls.map(([, parsed]) => publicToolName(parsed.tool))).toEqual(implicitMobileCases.map(([name]) => name));
            for (const [, parsed, match] of deviceToolRunner.mock.calls) {
                expect(parsed).toEqual(expect.objectContaining({ deviceId: "android-real-route" }));
                expect(match).toEqual(expect.objectContaining({ backend: "android-device", stateKey: "android-device" }));
            }
        } finally {
            cleanupOwner(owner);
            rmSync(join(homeDir, ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("R5CIMPLICIT123")}.json`), { force: true });
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("keeps bounded mobile waits alive beyond their device timeout", { timeout: TIMEOUT }, async () => {
        const requests: string[] = [];
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (sendOwnerResolve(req, res)) return;
            let raw = "";
            req.setEncoding("utf8");
            req.on("data", (chunk) => { raw += chunk; });
            req.on("end", () => {
                const parsed = JSON.parse(raw || "{}");
                requests.push(parsed.method);
                res.setHeader("content-type", "application/json");
                if (parsed.method === "broker.inventory") {
                    res.end(JSON.stringify({
                        ok: true,
                        result: {
                            backends: [{
                                stateKey: "android",
                                devices: [{ id: "android-bounded-wait", backend: "android-emulator", status: "running" }],
                            }],
                        },
                    }));
                    return;
                }
                if (parsed.method === "broker.device.tool.invoke") {
                    setTimeout(() => res.end(JSON.stringify({
                        ok: true,
                        result: {
                            tool: parsed.params.tool,
                            deviceId: parsed.params.deviceId,
                            backend: parsed.params.backend,
                            mcpResult: {
                                content: [{ type: "text", text: JSON.stringify({ found: false, provider: "adb-uiautomator" }) }],
                            },
                        },
                    })), 150);
                    return;
                }
                res.statusCode = 501;
                res.end(JSON.stringify({ ok: false, error: "unexpected-method" }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "wait_for_text",
                arguments: {
                    deviceId: "android-bounded-wait",
                    text: "Ready",
                    timeoutMs: 50,
                    intervalMs: 50,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                },
            });
            expect(result.isError).not.toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({
                found: false, matched: false, reason: "wait-condition-not-met",
                provider: "adb-uiautomator",
            });
            expect(requests).toEqual(["broker.inventory", "broker.device.tool.invoke"]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes explicit broker backend-only mobile controls through the owner-scoped broker device tool", { timeout: TIMEOUT }, async () => {
        const owner = brokerOwnerId();
        writeBrokerDevices(owner, "android", [{
            id: "android-explicit-mobile-route",
            backend: "android-emulator",
            status: "running",
            port: 5590,
        }]);
        const deviceToolRunner = vi.fn((runnerOwner, parsed, match) => ({
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId: runnerOwner,
                    tool: parsed.tool,
                    deviceId: parsed.deviceId,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    provider: "fake-android-explicit-mobile-tool-runner",
                    mcpResult: {
                        content: [{ type: "text", text: JSON.stringify({ tool: parsed.tool, params: parsed.params }) }],
                    },
                },
            },
        }));
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            deviceToolRunner,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            for (const [name, extra] of [
                ["permission", { action: "grant", appId: "com.example.mobile", permission: "android.permission.CAMERA" }],
                ["permission", { action: "revoke", appId: "com.example.mobile", permission: "android.permission.CAMERA" }],
                ["set_battery", { level: 42, charging: true, confirmDestructive: true }],
            ] as const) {
                const result = await client.callTool({
                    name,
                    arguments: {
                        broker: true,
                        deviceId: "android-explicit-mobile-route",
                        hostCandidates: ["127.0.0.1"],
                        port: address.port,
                        timeoutMs: 500,
                        ...extra,
                    },
                });
                expect(result.isError).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({
                    tool: toolOperation(name, extra),
                    params: expect.objectContaining({
                        backend: "android-emulator",
                        deviceId: "android-explicit-mobile-route",
                        ...("appId" in extra ? { packageName: extra.appId, bundleId: extra.appId, permission: extra.permission, service: extra.permission } : extra),
                    }),
                });
            }
            expect(deviceToolRunner).toHaveBeenCalledTimes(3);
            expect(deviceToolRunner).toHaveBeenCalledWith(owner, expect.objectContaining({
                tool: "mobile_set_battery",
                deviceId: "android-explicit-mobile-route",
                params: expect.objectContaining({ level: 42, charging: true }),
            }), expect.objectContaining({ backend: "android-emulator", stateKey: "android" }), expect.any(Object));
        } finally {
            cleanupOwner(owner);
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("routes Hyper-V and Sandbox cursor moves and rejects unresolved devices", { timeout: TIMEOUT }, async () => {
        const authRoot = join(homeDir, ".ccc", "devices", "broker", "auth");
        const authFile = join(authRoot, `${brokerOwnerId()}.json`);
        mkdirSync(authRoot, { recursive: true });
        // Later tests in this file reuse an existing owner secret, so leave one that was already there.
        const authExisted = existsSync(authFile);
        if (!authExisted) writeFileSync(authFile, JSON.stringify({ ownerId: brokerOwnerId(), secret: "b".repeat(64), version: 1 }), { mode: 0o600 });
        const invoked: Array<Record<string, unknown>> = [];
        const server = createServer(async (req, res) => {
            if (sendOwnerResolve(req, res)) return;
            let rawBody = "";
            for await (const chunk of req) rawBody += chunk;
            const body = JSON.parse(rawBody || "{}") as { method?: string; params?: Record<string, unknown> };
            res.setHeader("content-type", "application/json");
            if (body.method === "broker.inventory") {
                res.end(JSON.stringify({ ok: true, result: { backends: [
                    { stateKey: "windows-vm", devices: [{ id: "hv-cursor", backend: "windows-vm", status: "running" }] },
                    { stateKey: "windows", devices: [{ id: "sandbox-cursor", backend: "windows-sandbox", status: "running" }] },
                ] } }));
                return;
            }
            if (body.method === "broker.device.tool.invoke") {
                invoked.push(body.params || {});
                res.end(JSON.stringify({ ok: true, result: { tool: "device_cursor_position", applied: true } }));
                return;
            }
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: "unexpected-cursor-rpc" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const call = async (args: Record<string, unknown>) => {
            const result = await client.callTool({
                name: "move",
                arguments: { hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500, ...args },
            });
            return JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"));
        };
        try {
            const incarnationId = "1".repeat(32);
            const moved = await call({ deviceId: "hv-cursor", incarnationId, x: 10, y: 20 });
            expect(moved, JSON.stringify(moved)).toEqual(expect.objectContaining({ routedBy: "device-mutating-broker-implicit" }));
            expect(invoked, JSON.stringify(moved)).toEqual([expect.objectContaining({ tool: "device_cursor_position", backend: "windows-vm", deviceId: "hv-cursor", x: 10, y: 20 })]);

            const sandbox = await call({ deviceId: "sandbox-cursor", x: 10, y: 20 });
            expect(sandbox.ok).toBe(true);
            expect(invoked.at(-1)).toMatchObject({ tool: "device_cursor_position", backend: "windows-sandbox", deviceId: "sandbox-cursor", x: 10, y: 20 });
            for (const args of [
                { x: 10, y: 20 },
                { deviceId: "sandbox-cursor", x: 10, y: 20, broker: false },
                { deviceId: "hv-cursor", incarnationId, x: 10, y: 20, implicitBroker: false },
            ]) {
                expect(await call(args)).toEqual(expect.objectContaining({ ok: false, error: expect.any(String) }));
            }
            expect(invoked).toHaveLength(2);
        } finally {
            if (!authExisted) rmSync(authFile, { force: true });
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("maps explicit broker mobile controls into bounded Appium requests", { timeout: TIMEOUT }, async () => {
        const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
        let appiumEnsureDelayMs = 0;
        const server = createServer(async (req, res) => {
            if (sendOwnerResolve(req, res)) return;
            let rawBody = "";
            for await (const chunk of req) rawBody += chunk;
            const body = JSON.parse(rawBody || "{}") as { method?: string; params?: Record<string, unknown> };
            rpcCalls.push({ method: String(body.method || ""), params: body.params || {} });
            res.setHeader("content-type", "application/json");
            if (body.method === "broker.appium.session.ensure") {
                if (appiumEnsureDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, appiumEnsureDelayMs));
                res.end(JSON.stringify({ ok: true, result: { sessionId: "appium-session-route" } }));
                return;
            }
            if (body.method === "broker.inventory") {
                res.end(JSON.stringify({
                    ok: true,
                    result: {
                        backends: [{ stateKey: "android", devices: [{ id: "android-appium-route", backend: "android-emulator", status: "running" }] }],
                    },
                }));
                return;
            }
            if (body.method === "broker.device.tool.invoke") {
                res.end(JSON.stringify({ ok: true, result: { mcpResult: {
                    content: [{ type: "text", text: JSON.stringify({ provider: "native-network-fixture" }) }],
                } } }));
                return;
            }
            if (body.method === "broker.appium.request") {
                const responseBody = body.params?.path === "/appium/device/get_clipboard"
                    ? { value: Buffer.from("broker clip", "utf8").toString("base64") }
                    : { value: "ok" };
                res.end(JSON.stringify({ ok: true, result: { response: { body: responseBody } } }));
                return;
            }
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: "unexpected-appium-rpc" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const route = {
                broker: true,
                autolaunch: false,
                backend: "android-emulator",
                deviceId: "android-appium-route",
                hostCandidates: ["127.0.0.1"],
                port: address.port,
                timeoutMs: 500,
            };

            const cases = [
                {
                    name: "open_url",
                    args: { url: "https://example.test/appium-route" },
                    requests: [
                        { method: "POST", path: "/url", body: { url: "https://example.test/appium-route" } },
                    ],
                },
                {
                    name: "clipboard",
                    args: { text: "broker clip" },
                    requests: [
                        { method: "POST", path: "/appium/device/set_clipboard", body: { content: Buffer.from("broker clip", "utf8").toString("base64"), contentType: "plaintext", label: "text" } },
                    ],
                },
                {
                    name: "clipboard",
                    args: {},
                    requests: [
                        { method: "POST", path: "/appium/device/get_clipboard", body: { contentType: "plaintext" } },
                    ],
                    payload: expect.objectContaining({ text: "broker clip" }),
                },
            ] as const;

            for (const item of cases) {
                const offset = rpcCalls.length;
                const result = await client.callTool({
                    name: item.name,
                    arguments: { broker: route.broker, autolaunch: route.autolaunch, deviceId: route.deviceId, hostCandidates: route.hostCandidates, port: route.port, timeoutMs: route.timeoutMs, ...item.args },
                });
                expect(result.isError).not.toBe(true);
                const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"));
                expect(payload).toEqual(expect.objectContaining({
                    provider: "broker-appium",
                    backend: "android-emulator",
                    requests: item.requests.length,
                }));
                if (item.payload) expect(payload).toEqual(item.payload);

                const calls = rpcCalls.slice(offset);
                expect(calls.map((call) => call.method)).toEqual([
                    "broker.inventory",
                    "broker.appium.session.ensure",
                    ...item.requests.map(() => "broker.appium.request"),
                ]);
                expect(calls[1].params).toEqual(expect.objectContaining({
                    backend: "android-emulator",
                    deviceId: "android-appium-route",
                }));
                expect(calls.slice(2).map((call) => call.params)).toEqual(
                    item.requests.map((request) => expect.objectContaining({
                        backend: "android-emulator",
                        deviceId: "android-appium-route",
                        ...request,
                    })),
                );
            }

            for (const args of [
                { wifi: true, data: false },
                { airplaneMode: false },
            ]) {
                const offset = rpcCalls.length;
                const result = await client.callTool({ name: "set_network", arguments: {
                    broker: true, autolaunch: false, deviceId: route.deviceId,
                    hostCandidates: route.hostCandidates, port: route.port, timeoutMs: route.timeoutMs,
                    ...args, confirmDestructive: true,
                } });
                expect(result.isError, JSON.stringify(result)).not.toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({ provider: "native-network-fixture" });
                const calls = rpcCalls.slice(offset);
                expect(calls.map(call => call.method)).toEqual(["broker.inventory", "broker.device.tool.invoke"]);
                expect(calls[1].params).toMatchObject({
                    backend: "android-emulator", deviceId: route.deviceId, tool: "mobile_set_network",
                    ...args, confirmDestructive: true,
                });
            }

            appiumEnsureDelayMs = 100;
            const implicitSet = await client.callTool({
                name: "clipboard",
                arguments: {
                    deviceId: "android-appium-route",
                    text: "broker clip",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 50,
                },
            });
            expect(JSON.parse(((implicitSet.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "android-emulator",
            }));

            const implicitGet = await client.callTool({
                name: "clipboard",
                arguments: {
                    deviceId: "android-appium-route",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 50,
                },
            });
            expect(JSON.parse(((implicitGet.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                provider: "broker-appium",
                backend: "android-emulator",
                text: "broker clip",
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports stale owner-basis wiring instead of falling back to direct mobile handling", { timeout: TIMEOUT }, async () => {
        const owner = brokerOwnerId();
        writeOwnerDevices(owner, "android-device", [{
            id: "android-real-direct-fallback",
            name: "Android direct fallback",
            backend: "android-device",
            kind: "mobile",
            platform: "android",
            physical: true,
            ownerId: owner,
            serial: "R5CSTALEOWNER",
            connection: "usb",
            status: "attached",
        }]);
        const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (sendOwnerResolve(req, res)) return;
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
                                stateKey: "android-device",
                                devices: [{ id: "android-real-direct-fallback", backend: "android-device", status: "attached" }],
                            }],
                        },
                    }));
                    return;
                }
                res.statusCode = 409;
                res.end(JSON.stringify({
                    ok: false,
                    error: "broker-owner-basis-unavailable",
                    ownerId: parsed.ownerId,
                    expectedOwnerId: "different-owner",
                    tool: parsed.params.tool,
                }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "status",
                arguments: {
                    deviceId: "android-real-direct-fallback",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(result.isError).toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"));
            expect(payload).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-owner-basis-unavailable",
                routedBy: "device-lifecycle-broker-implicit",
            }));
            expect(requests.map((request) => request.method)).toEqual([
                "broker.inventory",
                "broker.command.invoke",
            ]);
        } finally {
            rmSync(join(homeDir, ".ccc/devices/owners", owner, "android-device"), { recursive: true, force: true });
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("returns mobile automation metadata with device status without Appium requests", { timeout: TIMEOUT }, async () => {
        const owner = brokerOwnerId();
        writeOwnerDevices(owner, "android", [{
            id: "android-broker-session-status",
            backend: "android-emulator",
            status: "running",
            port: 5584,
            appium: {
                authority: "host-broker",
                processOwner: "host-broker",
                serverPid: 24680,
                serverUrl: "http://127.0.0.1:4723",
                sessionId: "broker-session-1",
            },
        }]);
        const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (sendOwnerResolve(req, res)) return;
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
                                stateKey: "android",
                                devices: [{ id: "android-broker-session-status", backend: "android-emulator", status: "running" }],
                            }],
                        },
                    }));
                    return;
                }
                if (parsed.method === "broker.command.invoke") {
                    res.end(JSON.stringify({
                        ok: true,
                        result: {
                            ownerId: parsed.ownerId,
                            backend: "android-emulator",
                            stateKey: "android",
                            deviceId: parsed.params.deviceId,
                            device: { id: parsed.params.deviceId, backend: "android-emulator" },
                            authority: "host-broker",
                            automation: {
                                serverUrl: "http://127.0.0.1:4723",
                                sessionId: "broker-session-1",
                            },
                        },
                    }));
                    return;
                }
                res.statusCode = 404;
                res.end(JSON.stringify({ ok: false, error: "unexpected-method" }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "status",
                arguments: {
                    deviceId: "android-broker-session-status",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"));
            expect(payload).toEqual(expect.objectContaining({
                routedBy: "device-lifecycle-broker-implicit",
                device: expect.objectContaining({ deviceId: "android-broker-session-status" }),
                authority: "host-broker",
                automation: expect.objectContaining({ sessionId: "broker-session-1" }),
            }));
            expect(requests).toEqual([
                expect.objectContaining({ method: "broker.inventory" }),
                expect.objectContaining({
                    method: "broker.command.invoke",
                    params: expect.objectContaining({
                        backend: "android-emulator",
                        deviceId: "android-broker-session-status",
                    }),
                }),
            ]);
        } finally {
            rmSync(join(homeDir, ".ccc/devices/owners", owner, "android"), { recursive: true, force: true });
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("does not expose the legacy MCP broker service-manager tool", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "device_broker_service",
            arguments: { action: "status" },
        });

        expect(result.isError).toBe(true);
        expect((result.content as Array<{ text?: string }>)[0].text).toContain("Unknown tool: device_broker_service");
    });

    it("routes Apple trust diagnostics through the dedicated MCP broker tool", { timeout: TIMEOUT }, async () => {
        const commandRunner = vi.fn((command) => {
            if (command.provider === "xcrun" && command.args?.join(" ") === "xctrace list devices") {
                return { mode: "exec", provider: "xcrun", executable: command.executable, args: command.args, status: 0, stdout: "== Devices ==\nNetwork iPhone (17.5) (00008120-00AA00BB00CC00DD) (Network)\n", stderr: "" };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "unexpected command" };
        });
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            providerPaths: { xcrun: "/fake/xcrun" },
            commandRunner,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await callInternalBroker(client, { operation: "brokerApple",
                arguments: {
                    action: "status",
                    backend: "ios-device",
                    udid: "00008120-00AA00BB00CC00DD",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(result.isError).not.toBe(true);
            const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                method: string;
                result: {
                    attachFlow: string;
                    manualSteps: string[];
                    readyToAttach: boolean;
                    networkVisible: boolean;
                    safety: { bypassesTrustPrompt: boolean };
                };
            };
            expect(payload.ok).toBe(true);
            expect(payload.method).toBe("broker.apple.trust");
            expect(payload.result).toEqual(expect.objectContaining({
                readyToAttach: true,
                networkVisible: true,
                safety: expect.objectContaining({ bypassesTrustPrompt: false }),
            }));
            expect(payload.result.attachFlow).toContain("attach");
            expect(payload.result.attachFlow).not.toContain("device_broker_attach");
            expect(payload.result.manualSteps.join("\n")).toContain("wireless");
            expect(payload.result.manualSteps.join("\n")).toContain("attach");
            expect(payload.result.manualSteps.join("\n")).not.toContain("device_broker_apple");
            expect(payload.result.manualSteps.join("\n")).not.toContain("device_broker_attach");

            const connect = await callInternalBroker(client, { operation: "brokerApple",
                arguments: {
                    action: "connect",
                    backend: "ios-device",
                    udid: "00008120-00AA00BB00CC00DD",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(connect.isError).not.toBe(true);
            expect(JSON.parse(((connect.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ alreadyNetworkVisible: true, manualRequired: false }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports broker RPC failures as structured diagnostics without starting a broker", { timeout: TIMEOUT }, async () => {
        const unavailable = await callInternalBroker(client, { operation: "brokerRpc",
            arguments: {
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unavailable.isError).toBe(true);
        const unavailablePayload = JSON.parse(((unavailable.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            error: string;
            attempts: Array<{ ok: boolean; status: null; error: string }>;
        };
        expect(unavailablePayload.ok).toBe(false);
        expect(unavailablePayload.error).toBe("broker-rpc-unavailable");
        expect(unavailablePayload.attempts).toEqual([expect.objectContaining({ ok: false, status: null })]);

        const tooLarge = await callInternalBroker(client, { operation: "brokerRpc",
            arguments: {
                method: "broker.echo",
                params: { payload: "x".repeat(70 * 1024) },
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(tooLarge.isError).toBe(true);
        expect(JSON.parse(((tooLarge.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "request-too-large",
            attempts: [],
        }));

        const unsupportedLeaseRpc = await callInternalBroker(client, { operation: "brokerRpc",
            arguments: {
                method: "broker.lease.claim",
                params: { backend: "android-device", hardwareId: "x" },
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unsupportedLeaseRpc.isError).toBe(true);
        expect(JSON.parse(((unsupportedLeaseRpc.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "unsupported-public-broker-rpc-method",
            attempts: [],
        }));

        const unsupportedServiceRpc = await callInternalBroker(client, { operation: "brokerRpc",
            arguments: {
                method: "broker.service.manager",
                params: { action: "start" },
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unsupportedServiceRpc.isError).toBe(true);
        expect(JSON.parse(((unsupportedServiceRpc.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "unsupported-public-broker-rpc-method",
            attempts: [],
        }));
    });

    it("claims, lists, and releases a physical lease through an explicitly supplied host broker", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const claim = await callInternalBroker(client, { operation: "brokerLease",
                arguments: {
                    action: "claim",
                    backend: "android-device",
                    hardwareId: "10.0.0.8:5555",
                    deviceId: "android-wifi-phone",
                    connection: "wifi",
                    transport: { host: "10.0.0.8", port: 5555 },
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(claim.isError).not.toBe(true);
            const claimPayload = JSON.parse(((claim.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                result: { lease: { ownerId: string; backend: string; hardwareId: string; connection: string; transport: { host: string; port: number } }; created: boolean };
            };
            expect(claimPayload.ok).toBe(true);
            expect(claimPayload.result).toEqual(expect.objectContaining({
                created: true,
                lease: expect.objectContaining({
                    backend: "android-device",
                    hardwareId: "10.0.0.8:5555",
                    connection: "wifi",
                    transport: { host: "10.0.0.8", port: 5555 },
                    expiresAt: expect.any(String),
                }),
            }));

            const heartbeat = await callInternalBroker(client, { operation: "brokerLease",
                arguments: {
                    action: "heartbeat",
                    backend: "android-device",
                    hardwareId: "10.0.0.8:5555",
                    deviceId: "android-wifi-phone",
                    ttlMs: 120000,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(heartbeat.isError).not.toBe(true);
            expect(JSON.parse(((heartbeat.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    heartbeat: true,
                    lease: expect.objectContaining({ ttlMs: 120000, expiresAt: expect.any(String) }),
                }),
            }));

            const list = await callInternalBroker(client, { operation: "brokerLease",
                arguments: {
                    action: "list",
                    backend: "android-device",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(list.isError).not.toBe(true);
            const listPayload = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                ok: boolean;
                result: { leases: Array<{ hardwareId: string }> };
            };
            expect(listPayload.ok).toBe(true);
            expect(listPayload.result.leases).toEqual([expect.objectContaining({ hardwareId: "10.0.0.8:5555" })]);

            const prune = await callInternalBroker(client, { operation: "brokerLease",
                arguments: {
                    action: "prune",
                    backend: "android-device",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(prune.isError).not.toBe(true);
            expect(JSON.parse(((prune.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ pruned: [] }),
            }));

            const release = await callInternalBroker(client, { operation: "brokerLease",
                arguments: {
                    action: "release",
                    backend: "android-device",
                    hardwareId: "10.0.0.8:5555",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(release.isError).not.toBe(true);
            expect(JSON.parse(((release.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ released: true }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("10.0.0.8:5555")}.json`), { force: true });
        }
    });

    it("attaches and detaches physical devices through an explicitly supplied host broker", { timeout: TIMEOUT }, async () => {
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb" && command.args?.[0] === "connect") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: `connected to ${command.args[1]}`, stderr: "" };
            }
            if (command.provider === "adb" && command.args?.join(" ") === "devices -l") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: "List of devices attached\n10.0.0.10:5555 device product:pixel model:Pixel_Real\n", stderr: "" };
            }
            if (command.provider === "xcrun") {
                return { mode: "exec", provider: "xcrun", executable: command.executable, args: command.args, status: 0, stdout: "== Devices ==\nBroker Network iPhone (17.5) (00008130-00AA00BB00CC00EE) (Network)\n", stderr: "" };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "unexpected" };
        });
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            providerPaths: { adb: "/fake/adb", xcrun: "/fake/xcrun" },
            commandRunner,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const androidAttach = await callInternalBroker(client, { operation: "brokerPhysical",
                arguments: {
                    action: "attach",
                    backend: "android-device",
                    deviceId: "android-broker-wifi",
                    name: "Broker WiFi Pixel",
                    connection: "wifi",
                    host: "10.0.0.10",
                    devicePort: 5555,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(androidAttach.isError).not.toBe(true);
            expect(JSON.parse(((androidAttach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: "android-broker-wifi",
                        serial: "10.0.0.10:5555",
                        connection: "wifi",
                    }),
                }),
            }));

            const iosAttach = await callInternalBroker(client, { operation: "brokerPhysical",
                arguments: {
                    action: "attach",
                    backend: "ios-device",
                    deviceId: "ios-broker-wifi",
                    connection: "wifi",
                    udid: "00008130-00AA00BB00CC00EE",
                    host: "network-iphone.local",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(JSON.parse(((iosAttach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: "ios-broker-wifi",
                        udid: "00008130-00AA00BB00CC00EE",
                        connection: "wifi",
                    }),
                }),
            }));

            const list = await callInternalBroker(client, { operation: "brokerPhysical",
                arguments: { action: "list", backend: "android-device", hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 },
            });
            expect(JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ devices: [expect.objectContaining({ id: "android-broker-wifi" })] }),
            }));

            const detach = await callInternalBroker(client, { operation: "brokerPhysical",
                arguments: { action: "detach", backend: "android-device", deviceId: "android-broker-wifi", hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 },
            });
            expect(JSON.parse(((detach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ detached: "android-broker-wifi", physicalDevicePoweredOff: false }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("10.0.0.10:5555")}.json`), { force: true });
            rmSync(join(homedir(), ".ccc/devices/physical-leases/ios-device/locks", `${encodeURIComponent("00008130-00AA00BB00CC00EE")}.json`), { force: true });
        }
    });

    it("routes zero-config physical attach and detach through a reachable host broker", { timeout: TIMEOUT }, async () => {
        let delayedConnect = false;
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb" && command.args?.[0] === "connect") {
                if (!delayedConnect) {
                    delayedConnect = true;
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
                }
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: `connected to ${command.args[1]}`, stderr: "" };
            }
            if (command.provider === "adb" && command.args?.join(" ") === "devices -l") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: "List of devices attached\n10.0.0.11:5555 device product:pixel model:Pixel_Implicit\n", stderr: "" };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "unexpected" };
        });
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            providerPaths: { adb: "/fake/adb" },
            commandRunner,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const attach = await client.callTool({
                name: "attach",
                arguments: {
                    backend: "android-device",
                    deviceId: "android-implicit-wifi",
                    name: "Implicit WiFi Pixel",
                    connection: "wifi",
                    host: "10.0.0.11",
                    port: 5555,
                    brokerPort: address.port,
                    hostCandidates: ["127.0.0.1"],
                },
            });
            expect(attach.isError).not.toBe(true);
            expect(JSON.parse(((attach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                routedBy: "device-physical-broker-implicit",
                method: "broker.physical.attach",
                selected: expect.objectContaining({ timeoutMs: 30000 }),
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        deviceId: "android-implicit-wifi",
                        serial: "10.0.0.11:5555",
                        connection: "wifi",
                    }),
                }),
            }));

            const detach = await client.callTool({
                name: "detach",
                arguments: {
                    deviceId: "android-implicit-wifi",
                    brokerPort: address.port,
                    hostCandidates: ["127.0.0.1"],
                },
            });
            expect(detach.isError).not.toBe(true);
            expect(JSON.parse(((detach.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                routedBy: "device-physical-broker-implicit",
                method: "broker.physical.detach",
                result: expect.objectContaining({ detached: "android-implicit-wifi", physicalDevicePoweredOff: false }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("10.0.0.11:5555")}.json`), { force: true });
        }
    });

    it("routes unattached physical wireless diagnostics through the host broker", { timeout: TIMEOUT }, async () => {
        const deviceToolRunner = vi.fn((runnerOwner, parsed, match) => ({
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId: runnerOwner,
                    tool: parsed.tool,
                    backend: match.backend,
                    mcpResult: {
                        content: [{ type: "text", text: JSON.stringify({
                            ok: true,
                            backend: match.backend,
                            provider: "adb",
                            hostDevices: { devices: [{ serial: "USB-UNAUTHORIZED", state: "unauthorized" }] },
                        }) }],
                    },
                },
            },
        }));
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            deviceToolRunner,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const wireless = await client.callTool({
                name: "wireless",
                arguments: {
                    backend: "android-device",
                    action: "status",
                    hostCandidates: ["127.0.0.1"],
                    brokerPort: address.port,
                },
            });
            expect(wireless.isError).not.toBe(true);
            expect(JSON.parse(((wireless.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                backend: "android-device",
                provider: "adb",
                hostDevices: { devices: [expect.objectContaining({ serial: "USB-UNAUTHORIZED", state: "unauthorized" })] },
            }));
            expect(deviceToolRunner).toHaveBeenCalledOnce();
            expect(deviceToolRunner.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
                tool: "device_wireless",
                backend: "android-device",
                deviceId: null,
            }));
            expect(deviceToolRunner.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
                backend: "android-device",
                stateKey: "android-device",
                device: {},
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports broker lease validation and unavailable broker failures without autolaunch", { timeout: TIMEOUT }, async () => {
        const invalidAction = await callInternalBroker(client, { operation: "brokerLease",
            arguments: { action: "steal", backend: "android-device" },
        });
        expect(invalidAction.isError).toBe(true);
        expect(JSON.parse(((invalidAction.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "invalid-lease-action",
            attempts: [],
        }));

        const unavailable = await callInternalBroker(client, { operation: "brokerLease",
            arguments: {
                action: "list",
                backend: "ios-device",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unavailable.isError).toBe(true);
        expect(JSON.parse(((unavailable.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-rpc-unavailable",
            attempts: [expect.objectContaining({ ok: false, status: null })],
        }));
    });

    it("preserves live broker lease errors at the top level", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const serial = "10.0.0.9:5555";
        try {
            const claim = await callInternalBroker(client, { operation: "brokerLease",
                arguments: {
                    action: "claim",
                    backend: "android-device",
                    hardwareId: serial,
                    deviceId: "owner-device",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(claim.isError).not.toBe(true);
            expect(JSON.parse(((claim.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({ ok: true }));

            const duplicate = await callInternalBroker(client, { operation: "brokerLease",
                arguments: {
                    action: "release",
                    backend: "android-device",
                    hardwareId: serial,
                    deviceId: "different-device",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(duplicate.isError).toBe(true);
            expect(JSON.parse(((duplicate.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-lease-device-mismatch",
                status: 409,
                selected: expect.objectContaining({ status: 409 }),
            }));

            const invalid = await callInternalBroker(client, { operation: "brokerLease",
                arguments: {
                    action: "claim",
                    backend: "android-device",
                    hardwareId: "",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(invalid.isError).toBe(true);
            expect(JSON.parse(((invalid.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "invalid-hardware-id",
                status: 400,
                selected: expect.objectContaining({ status: 400 }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent(serial)}.json`), { force: true });
        }
    });

    it("plans and dry-runs lifecycle commands through an explicitly supplied host broker", { timeout: TIMEOUT }, async () => {
        const ownerRoot = join(homedir(), ".ccc/devices/owners", brokerOwnerId());
        const fakeWsb = join(homeDir, "fake-wsb");
        writeFileSync(fakeWsb, "const args = process.argv.slice(2); if (args[4]?.includes('fail')) { console.error('broker failure'); process.exit(7); } console.log('wsb ' + args.join(' '));\n");
        chmodSync(fakeWsb, 0o755);
        const windowsRoot = join(ownerRoot, "windows");
        mkdirSync(windowsRoot, { recursive: true });
        const planConfigPath = join(windowsRoot, "win-broker-plan.wsb");
        const failConfigPath = join(windowsRoot, "fail.wsb");
        writeFileSync(planConfigPath, "<Configuration><Networking>Disabled</Networking></Configuration>");
        writeFileSync(failConfigPath, "<Configuration>fail</Configuration>");
        writeFileSync(join(ownerRoot, "windows", "devices.json"), JSON.stringify({
            devices: [
                { id: "win-broker-plan", backend: "windows-sandbox", status: "stopped", configPath: planConfigPath, sandboxId: "12345678-1234-4234-9234-1234567890ab" },
                { id: "win-broker-fail", backend: "windows-sandbox", status: "stopped", configPath: failConfigPath, sandboxId: "12345678-1234-4234-9234-1234567890ac" },
                { id: "win-broker-missing", backend: "windows-sandbox", status: "stopped" },
            ],
        }));
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            platform: "linux", // Exercise CLI routing; native Sandbox registration has separate coverage.
            providerPaths: { wsb: fakeWsb },
            // Execute the fake CLI as Node rather than requiring host shell associations.
            commandRunner: (command) => {
                if (command.mode !== "exec") return { ...command, status: 0, stdout: "", stderr: "" };
                const result = spawnSync(process.execPath, [fakeWsb, ...(command.args || [])], { encoding: "utf8", timeout: 5000, windowsHide: true });
                return { ...command, status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
            },
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const brokerCreate = await client.callTool({
                name: "create_windows_sandbox",
                arguments: {

                    name: "Broker Created",
                    viaBroker: true,
                    hostCandidates: ["127.0.0.1"],
                    brokerPort: address.port,
                    timeoutMs: 500,
                },
            });
            expect(brokerCreate.isError).not.toBe(true);
            expect(JSON.parse(((brokerCreate.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    command: "device_create",
                    deviceId: "windows-broker-created",
                    device: expect.objectContaining({
                        deviceId: "windows-broker-created",
                        status: "stopped",
                        authority: "host-broker",
                    }),
                }),
            }));

            const plan = await callInternalBroker(client, { operation: "brokerCommand",
                arguments: {
                    action: "plan",
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-plan",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(plan.isError).not.toBe(true);
            expect(JSON.parse(((plan.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId: brokerOwnerId(),
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-plan",
                    execution: expect.objectContaining({ mode: "planned", providerExecution: "available" }),
                }),
            }));

            const dryRun = await callInternalBroker(client, { operation: "brokerCommand",
                arguments: {
                    action: "invoke",
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-plan",
                    dryRun: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(dryRun.isError).not.toBe(true);
            expect(JSON.parse(((dryRun.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    invoked: false,
                    dryRun: true,
                    execution: expect.objectContaining({ mode: "dry-run", mutatesHost: false }),
                }),
            }));

            const realRun = await callInternalBroker(client, { operation: "brokerCommand",
                arguments: {
                    action: "invoke",
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-plan",
                    dryRun: false,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(realRun.isError).not.toBe(true);
            expect(JSON.parse(((realRun.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    invoked: true,
                    dryRun: false,
                    device: expect.objectContaining({ status: "running" }),
                    execution: expect.objectContaining({
                        mode: "exec",
                        providerExecution: "executed",
                        mutatesHost: true,
                        command: expect.objectContaining({
                            provider: "wsb",
                            executable: fakeWsb,
                            args: ["start", "--id", "12345678-1234-4234-9234-1234567890ab", "--config", "<Configuration><Networking>Disabled</Networking></Configuration>"],
                            status: 0,
                            stdout: expect.stringContaining("wsb start --id 12345678-1234-4234-9234-1234567890ab --config <Configuration><Networking>Disabled</Networking></Configuration>"),
                        }),
                    }),
                }),
            }));

            const lifecycleStatus = await client.callTool({
                name: "status",
                arguments: {
                    deviceId: "win-broker-plan",
                    broker: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(lifecycleStatus.isError).not.toBe(true);
            expect(JSON.parse(((lifecycleStatus.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    backend: "windows-sandbox",
                    command: "device_status",
                    deviceId: "win-broker-plan",
                    invoked: true,
                    execution: expect.objectContaining({
                        mode: "noop",
                        providerExecution: "executed",
                        mutatesHost: false,
                    }),
            }));

            const implicitLifecycleStatus = await client.callTool({
                name: "status",
                arguments: {
                    deviceId: "win-broker-plan",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(implicitLifecycleStatus.isError).not.toBe(true);
            expect(JSON.parse(((implicitLifecycleStatus.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                routedBy: "device-lifecycle-broker-implicit",
                backend: "windows-sandbox",
                command: "device_status",
                deviceId: "win-broker-plan",
                invoked: true,
                device: expect.objectContaining({ deviceId: "win-broker-plan" }),
            }));

            const lifecycleStop = await client.callTool({
                name: "stop",
                arguments: {
                    deviceId: "win-broker-plan",
                    viaBroker: true,
                    dryRun: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(lifecycleStop.isError).toBe(true);
            expect(JSON.stringify(lifecycleStop)).toContain("stop does not support dryRun");

            const implicitLifecycleStop = await client.callTool({
                name: "stop",
                arguments: {
                    deviceId: "win-broker-plan",
                    dryRun: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(implicitLifecycleStop.isError).toBe(true);
            expect(JSON.stringify(implicitLifecycleStop)).toContain("stop does not support dryRun");

            const realLifecycleStop = await client.callTool({
                name: "stop",
                arguments: {
                    deviceId: "win-broker-plan",
                    viaBroker: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(realLifecycleStop.isError).not.toBe(true);
            expect(JSON.parse(((realLifecycleStop.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    backend: "windows-sandbox",
                    command: "device_stop",
                    invoked: true,
                    dryRun: false,
                    device: expect.objectContaining({ deviceId: "win-broker-plan", status: "stopped" }),
            }));

            const failedRun = await callInternalBroker(client, { operation: "brokerCommand",
                arguments: {
                    action: "invoke",
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-fail",
                    dryRun: false,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(failedRun.isError).toBe(true);
            expect(JSON.parse(((failedRun.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "provider-command-failed",
                status: 502,
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: "win-broker-fail", status: "stopped" }),
                    execution: expect.objectContaining({
                        command: expect.objectContaining({
                            status: 7,
                            stderr: expect.stringContaining("broker failure"),
                        }),
                    }),
                }),
            }));

            const missingMetadata = await callInternalBroker(client, { operation: "brokerCommand",
                arguments: {
                    action: "invoke",
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-missing",
                    dryRun: false,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(missingMetadata.isError).toBe(true);
            expect(JSON.parse(((missingMetadata.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "missing-provider-metadata",
                status: 400,
                body: expect.objectContaining({ missing: ["configPath"] }),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(ownerRoot, { recursive: true, force: true });
        }
    });

    it("keeps implicit Android AVD creation RPCs independent from the short broker probe timeout", { timeout: TIMEOUT }, async () => {
        const server = createServer(async (req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/health") {
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker" }));
                return;
            }
            if (req.url === "/status") {
                res.end(JSON.stringify({
                    ok: true,
                    broker: {
                        protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
                    },
                }));
                return;
            }
            if (sendOwnerResolve(req, res)) return;
            let rawBody = "";
            for await (const chunk of req) rawBody += chunk;
            const body = JSON.parse(rawBody || "{}") as { method?: string; params?: { deviceId?: string } };
            if (body.method !== "broker.command.invoke") {
                res.statusCode = 418;
                res.end(JSON.stringify({ ok: false, error: "unexpected-method" }));
                return;
            }
            setTimeout(() => res.end(JSON.stringify({
                ok: true,
                result: {
                    backend: "android-emulator",
                    command: "device_create",
                    deviceId: body.params?.deviceId,
                    device: { id: body.params?.deviceId, status: "stopped", provisioned: true },
                    invoked: true,
                },
            })), 400);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const runtimeFile = join(homeDir, ".ccc/devices/broker/runtime.json");
        mkdirSync(join(homeDir, ".ccc/devices/broker"), { recursive: true });
        writeFileSync(runtimeFile, JSON.stringify({
            ownerId: brokerOwnerId(),
            pid: process.pid,
            host: "127.0.0.1",
            port: address.port,
            managedBy: "ccc-host",
        }));
        try {
            const result = await client.callTool({
                name: "create_android_emulator",
                arguments: {

                    name: "Slow AVD",
                    deviceId: "android-slow-avd",
                    systemImage: "system-images;android-35;google_apis;x86_64",
                },
            });
            expect(result.isError).not.toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                deviceId: "android-slow-avd",
                device: expect.objectContaining({ deviceId: "android-slow-avd", provisioned: true }),
                routedBy: "device-lifecycle-broker-implicit",
            }));
        } finally {
            rmSync(runtimeFile, { force: true });
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports broker-unavailable for lifecycle providers instead of falling back to direct providers", { timeout: TIMEOUT }, async () => {
        const ownerRoot = join(homedir(), ".ccc/devices/owners", brokerOwnerId());
        mkdirSync(join(ownerRoot, "windows"), { recursive: true });
        writeFileSync(join(ownerRoot, "windows", "devices.json"), JSON.stringify({
            devices: [{ id: "win-local-direct", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/local.wsb" }],
        }));
        try {
            const result = await client.callTool({
                name: "status",
                arguments: {
                    deviceId: "win-local-direct",
                    hostCandidates: ["127.0.0.1"],
                    port: 9,
                    timeoutMs: 50,
                },
            });
            expect(result.isError).toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-rpc-unavailable",
                routedBy: "device-lifecycle-broker-implicit",
            }));

            const hyperVLinux = await client.callTool({
                name: "create_linux_vm",
                arguments: {

                    provider: "hyper-v",
                    deviceId: "hyper-v-linux-no-direct-fallback",
                    name: "Hyper-V Linux no direct fallback",
                    viaBroker: true,
                    autolaunch: false,
                    hostCandidates: ["127.0.0.1"],
                    brokerPort: 9,
                    timeoutMs: 50,
                },
            });
            expect(hyperVLinux.isError).toBe(true);
            expect(JSON.parse(((hyperVLinux.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-rpc-unavailable",
                routedBy: "device-lifecycle-broker",
            }));
        } finally {
            rmSync(join(ownerRoot, "windows"), { recursive: true, force: true });
        }
    });

    it("keeps missing lifecycle operations and explicit Hyper-V deletion fail-closed without an owned identity", { timeout: TIMEOUT }, async () => {
        const methods: string[] = [];
        const invokeParams: Array<Record<string, unknown>> = [];
        const server = createServer(async (req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (req.url === "/status") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({
                    ok: true,
                    name: "ccc-device-broker",
                    mode: "host-broker-daemon",
                    broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION },
                }));
                return;
            }
            if (sendOwnerResolve(req, res)) return;
            let rawBody = "";
            for await (const chunk of req) rawBody += chunk;
            const body = JSON.parse(rawBody || "{}") as { method?: string; params?: Record<string, unknown> };
            methods.push(String(body.method || ""));
            res.setHeader("content-type", "application/json");
            if (body.method === "broker.inventory") {
                res.end(JSON.stringify({ ok: true, result: { backends: [] } }));
                return;
            }
            if (body.method === "broker.command.invoke") {
                invokeParams.push(body.params || {});
                res.end(JSON.stringify({
                    ok: true,
                    result: {
                        backend: "windows-vm",
                        command: "device_delete",
                        deviceId: "windows-vm-real-e2e-stale",
                        idempotent: true,
                        alreadyMissing: true,
                        invoked: false,
                    },
                }));
                return;
            }
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: "unexpected-broker-command" }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const authRoot = join(homeDir, ".ccc/devices/broker/auth");
        const authFile = join(authRoot, `${brokerOwnerId()}.json`);
        mkdirSync(authRoot, { recursive: true });
        writeFileSync(authFile, JSON.stringify({ ownerId: brokerOwnerId(), secret: "b".repeat(64), version: 1 }), { mode: 0o600 });
        const ownerRoot = join(homeDir, ".ccc/devices/owners", brokerOwnerId());
        mkdirSync(join(ownerRoot, "windows"), { recursive: true });
        writeFileSync(join(ownerRoot, "windows", "devices.json"), JSON.stringify({
            devices: [{ id: "win-direct-only", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/direct-only.wsb" }],
        }));
        try {
            const result = await client.callTool({
                name: "status",
                arguments: {
                    deviceId: "win-direct-only",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(result.isError).toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "device-not-found",
                deviceId: "win-direct-only",
                routedBy: "device-lifecycle-broker-implicit",
            }));
            expect(methods.filter(Boolean)).toEqual(["broker.inventory"]);

            for (const arguments_ of [
                { deviceId: "missing-delete-without-backend" },
                { deviceId: "missing-non-hyper-v-delete" },
            ]) {
                const missingDeletion = await client.callTool({
                    name: "delete",
                    arguments: {
                        ...arguments_,
                        confirmDestructive: true,
                        hostCandidates: ["127.0.0.1"],
                        port: address.port,
                        timeoutMs: 500,
                    },
                });
                expect(missingDeletion.isError).toBe(true);
                expect(JSON.parse(((missingDeletion.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    ok: false,
                    error: "device-not-found",
                    deviceId: arguments_.deviceId,
                    routedBy: "device-lifecycle-broker-implicit",
                }));
            }

            const deletion = await client.callTool({
                name: "delete",
                arguments: {
                    deviceId: "windows-vm-real-e2e-stale",
                    incarnationId: "1".repeat(32),
                    force: true,
                    preserveNetwork: true,
                    confirmDestructive: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(deletion.isError).toBe(true);
            expect(JSON.parse(((deletion.content as Array<{ text?: string }>)[0].text ?? "{}"))).toMatchObject({
                ok: false, error: "device-not-found", deviceId: "windows-vm-real-e2e-stale",
            });
            const explicitDeletion = await client.callTool({
                name: "delete",
                arguments: {
                    deviceId: "windows-vm-real-e2e-stale",
                    incarnationId: "1".repeat(32),
                    force: true,
                    preserveNetwork: true,
                    confirmDestructive: true,
                    viaBroker: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(explicitDeletion.isError).toBe(true);
            expect(JSON.parse(((explicitDeletion.content as Array<{ text?: string }>)[0].text ?? "{}"))).toMatchObject({
                ok: false, error: "device-not-found", deviceId: "windows-vm-real-e2e-stale",
            });
            expect(methods).toEqual(Array(5).fill("broker.inventory"));
            expect(invokeParams).toEqual([]);

        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(ownerRoot, "windows"), { recursive: true, force: true });
            rmSync(authFile, { force: true });
        }
    });

    it("rejects backend selectors on owned targets before provider dispatch", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const ownerRoot = join(homedir(), ".ccc/devices/owners", brokerOwnerId());
        mkdirSync(join(ownerRoot, "android"), { recursive: true });
        writeFileSync(join(ownerRoot, "android", "devices.json"), JSON.stringify({
            devices: [{
                id: "android-mismatch-broker",
                backend: "android-emulator",
                status: "running",
                port: 5554,
            }],
        }));
        try {
            for (const [name, args] of [
                ["status", {  }, "device-lifecycle-broker-implicit"],
                ["screenshot", { timeoutMs: 1 }, "device-readonly-broker-implicit"],
                ["key", { key: "Return" }, "device-mutating-broker-implicit"],
            ] as const) {
                const result = await client.callTool({
                    name,
                    arguments: {
                        backend: "windows-sandbox",
                        deviceId: "android-mismatch-broker",
                        hostCandidates: ["127.0.0.1"],
                        port: address.port,
                        timeoutMs: 500,
                        ...args,
                    },
                });
                expect(result.isError).toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    ok: false,
                    error: "deviceId determines the backend; omit backend",
                }));
            }
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(ownerRoot, "android"), { recursive: true, force: true });
        }
    });

    it("reports unsupported broker inventory backend instead of falling back to direct providers", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const ownerRoot = join(homedir(), ".ccc/devices/owners", brokerOwnerId());
        mkdirSync(join(ownerRoot, "windows"), { recursive: true });
        writeFileSync(join(ownerRoot, "windows", "devices.json"), JSON.stringify({
            devices: [{
                id: "win-unsupported-broker",
                backend: "windows-sandbox",
                status: "running",
                configPath: "C:/ccc/unsupported.wsb",
            }],
        }));
        try {
            const mobile = await client.callTool({
                name: "key",
                arguments: {
                    deviceId: "win-unsupported-broker",
                    keyCode: 4,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(mobile.isError).toBe(true);
            expect((mobile.content as Array<{ text?: string }>)[0].text).toContain("keyCode is supported only on Android");

            const physical = await client.callTool({
                name: "detach",
                arguments: {
                    deviceId: "win-unsupported-broker",
                    hostCandidates: ["127.0.0.1"],
                    brokerPort: address.port,
                    timeoutMs: 500,
                },
            });
            expect(physical.isError).toBe(true);
            expect(JSON.parse(((physical.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "unsupported-physical-backend",
                deviceId: "win-unsupported-broker",
                actualBackend: "windows-sandbox",
                routedBy: "device-physical-broker-implicit",
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(ownerRoot, "windows"), { recursive: true, force: true });
        }
    });

    it("routes owned devices, backend discovery, available inventory and recording status through a reachable broker", { timeout: TIMEOUT }, async () => {
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            deviceToolRunner: async (_ownerId, parsed) => ({
                status: 200,
                payload: {
                    ok: true,
                    result: {
                        deviceId: parsed.deviceId,
                        recording: { active: true, sessionId: "rec-broker" },
                        provider: "windows-helper-frame-archive",
                        helper: "Windows Sandbox helper recording status",
                    },
                },
            }),
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        const ownerRoot = join(homedir(), ".ccc/devices/owners", brokerOwnerId());
        mkdirSync(join(ownerRoot, "windows"), { recursive: true });
        writeFileSync(join(ownerRoot, "windows", "devices.json"), JSON.stringify({
            devices: [{
                id: "win-readonly-broker",
                backend: "windows-sandbox",
                status: "running",
                configPath: "C:/ccc/readonly.wsb",
                recording: { active: true, sessionId: "rec-broker", localPath: "C:/ccc/recording.zip" },
            }],
        }));
        try {
            const route = { broker: true, hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 };
            const owned = await client.callTool({
                name: "devices",
                arguments: { ...route, view: "owned", backend: "windows-sandbox" },
            });
            expect(owned.isError, JSON.stringify(owned.content)).not.toBe(true);
            expect(JSON.parse(((owned.content as Array<{ text?: string }>)[0].text ?? "{}"))).toMatchObject({
                ownerId: brokerOwnerId(),
                routedBy: "device-list-broker-implicit",
                devices: [expect.objectContaining({ deviceId: "win-readonly-broker", backend: "windows-sandbox", status: "running" })],
            });

            const discovery = await client.callTool({
                name: "devices",
                arguments: { ...route, view: "backends", backend: "windows-sandbox" },
            });
            expect(discovery.isError, JSON.stringify(discovery.content)).not.toBe(true);
            expect(JSON.parse(((discovery.content as Array<{ text?: string }>)[0].text ?? "{}"))).toMatchObject({
                source: "host-broker-provider-discovery",
                routedBy: "device-backends-broker",
                backends: [expect.objectContaining({ name: "windows-sandbox", lazy: true })],
                hostBackends: { startsDevices: false },
            });

            const inventory = await client.callTool({
                name: "devices",
                arguments: { view: "available",
                    backend: "windows-sandbox",
                    broker: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(inventory.isError).not.toBe(true);
            expect(JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                routedBy: "device-readonly-broker",
                result: expect.objectContaining({
                    tool: "device_inventory",
                    backend: "windows-sandbox",
                    devices: [expect.objectContaining({ deviceId: "win-readonly-broker" })],
                    source: "host-broker-owner-state",
                    startsDevices: false,
                }),
            }));

            const recording = await client.callTool({
                name: "record_video",
                arguments: { action: "status",
                    deviceId: "win-readonly-broker",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(recording.isError).not.toBe(true);
            expect(JSON.parse(((recording.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                deviceId: "win-readonly-broker",
                recording: expect.objectContaining({ active: true, sessionId: "rec-broker" }),
                provider: "windows-helper-frame-archive",
                helper: expect.stringContaining("Windows Sandbox helper"),
            }));
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            rmSync(join(ownerRoot, "windows"), { recursive: true, force: true });
        }
    });

    it("reports broker-unavailable for read-only device tools instead of falling back to direct providers", { timeout: TIMEOUT }, async () => {
        const ownerRoot = join(homedir(), ".ccc/devices/owners", brokerOwnerId());
        mkdirSync(join(ownerRoot, "android"), { recursive: true });
        writeFileSync(join(ownerRoot, "android", "devices.json"), JSON.stringify({
            devices: [{
                id: "android-readonly-direct",
                backend: "android-emulator",
                status: "running",
                avdName: "Pixel_Readonly",
                recording: { active: true, pid: 99999999, localPath: "/tmp/readonly.mp4" },
            }],
        }));
        try {
            const result = await client.callTool({
                name: "record_video",
                arguments: { action: "status",
                    deviceId: "android-readonly-direct",
                    hostCandidates: ["127.0.0.1"],
                    port: 9,
                    timeoutMs: 50,
                },
            });
            expect(result.isError).toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-rpc-unavailable",
                routedBy: "device-readonly-broker-implicit",
            }));
        } finally {
            rmSync(join(ownerRoot, "android"), { recursive: true, force: true });
        }
    });

    it("reports broker-unavailable for mobile backend-only tools instead of falling back to direct providers", { timeout: TIMEOUT }, async () => {
        const ownerRoot = join(homedir(), ".ccc/devices/owners", brokerOwnerId());
        mkdirSync(join(ownerRoot, "android"), { recursive: true });
        writeFileSync(join(ownerRoot, "android", "devices.json"), JSON.stringify({
            devices: [{
                id: "android-mobile-direct",
                backend: "android-emulator",
                status: "running",
                avdName: "Pixel_Mobile_Direct",
                port: 5554,
            }],
        }));
        try {
            for (const [name, extra] of [
                ["permission", { action: "grant", appId: "com.example.mobile", permission: "android.permission.CAMERA" }],
                ["permission", { action: "revoke", appId: "com.example.mobile", permission: "android.permission.CAMERA" }],
                ["set_battery", { level: 42, charging: true, confirmDestructive: true }],
            ] as const) {
                const result = await client.callTool({
                    name,
                    arguments: {
                        deviceId: "android-mobile-direct",
                        hostCandidates: ["127.0.0.1"],
                        port: 9,
                        timeoutMs: 50,
                        ...extra,
                    },
                });
                expect(result.isError).toBe(true);
                expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                    ok: false,
                    error: "broker-rpc-unavailable",
                    routedBy: "mobile-device-broker-implicit",
                }));
            }
        } finally {
            rmSync(join(ownerRoot, "android"), { recursive: true, force: true });
        }
    });

    it("does not hide broker device-tool failures after broker inventory matches the device", { timeout: TIMEOUT }, async () => {
        const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
        const server = createServer((req, res) => {
            if (req.url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" }));
                return;
            }
            if (sendOwnerResolve(req, res)) return;
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
                                devices: [{ id: "win-broker-failure", backend: "windows-sandbox", status: "running" }],
                            }],
                        },
                    }));
                    return;
                }
                res.statusCode = 501;
                res.end(JSON.stringify({
                    ok: false,
                    error: "broker-device-tool-backend-not-supported",
                    backend: "windows-sandbox",
                    tool: parsed.params.tool,
                    deviceId: parsed.params.deviceId,
                }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const result = await client.callTool({
                name: "exec",
                arguments: {
                    deviceId: "win-broker-failure",
                    command: "Write-Output should-not-fallback",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(result.isError).toBe(true);
            expect(JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "broker-device-tool-backend-not-supported",
                routedBy: "device-mutating-broker-implicit",
            }));
            const screenshot = await client.callTool({
                name: "screenshot",
                arguments: {
                    deviceId: "win-broker-failure",
                    timeoutMs: 45000,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                },
            });
            expect(JSON.parse(((screenshot.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                selected: expect.objectContaining({ timeoutMs: 75000 }),
                routedBy: "device-readonly-broker-implicit",
            }));
            expect(requests.map((request) => request.method)).toEqual([
                "broker.inventory",
                "broker.device.tool.invoke",
                "broker.inventory",
                "broker.device.tool.invoke",
            ]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it("reports broker command validation and unavailable broker failures without autolaunch", { timeout: TIMEOUT }, async () => {
        const invalidAction = await callInternalBroker(client, { operation: "brokerCommand",
            arguments: { action: "run", backend: "android-emulator", command: "device_start", deviceId: "android-x" },
        });
        expect(invalidAction.isError).toBe(true);
        expect(JSON.parse(((invalidAction.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "invalid-command-action",
            attempts: [],
        }));

        const inferenceFailure = await client.callTool({
            name: "status",
            arguments: { deviceId: "missing-broker-device", broker: true, hostCandidates: ["127.0.0.1"], port: 9, autolaunch: false, timeoutMs: 50 },
        });
        expect(inferenceFailure.isError).toBe(true);
        expect(JSON.parse(((inferenceFailure.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-rpc-unavailable",
            method: "broker.inventory",
            routedBy: "device-lifecycle-broker-implicit",
        }));

        const unavailable = await callInternalBroker(client, { operation: "brokerCommand",
            arguments: {
                action: "plan",
                backend: "ios-simulator",
                command: "device_start",
                deviceId: "ios-x",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unavailable.isError).toBe(true);
        expect(JSON.parse(((unavailable.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-rpc-unavailable",
            attempts: [expect.objectContaining({ ok: false, status: null })],
        }));
    });
});
