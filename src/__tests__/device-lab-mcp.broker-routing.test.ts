import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { AddressInfo } from "net";
import { homedir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeviceBrokerServer } from "../device-lab-broker.js";
import {
    cleanupDeviceLabMcpTestContext,
    createDeviceLabMcpTestContext,
    repoRoot,
    TIMEOUT,
    type DeviceLabMcpTestContext,
} from "./helpers/device-lab-mcp-fixture.js";

describe("device-lab MCP broker routing", () => {
    let context: DeviceLabMcpTestContext;
    let client: DeviceLabMcpTestContext["client"];
    let homeDir: string;

    beforeAll(async () => {
        context = await createDeviceLabMcpTestContext();
        client = context.client;
        homeDir = context.homeDir;
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupDeviceLabMcpTestContext(context);
    }, TIMEOUT);

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
            const result = await client.callTool({
                name: "device_broker_rpc",
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

    it("reports broker RPC failures as structured diagnostics without starting a broker", { timeout: TIMEOUT }, async () => {
        const unavailable = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.echo",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unavailable.isError).not.toBe(true);
        const unavailablePayload = JSON.parse(((unavailable.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            error: string;
            attempts: Array<{ ok: boolean; status: null; error: string }>;
        };
        expect(unavailablePayload.ok).toBe(false);
        expect(unavailablePayload.error).toBe("broker-rpc-unavailable");
        expect(unavailablePayload.attempts).toEqual([expect.objectContaining({ ok: false, status: null })]);

        const tooLarge = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.echo",
                params: { payload: "x".repeat(70 * 1024) },
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(tooLarge.isError).not.toBe(true);
        expect(JSON.parse(((tooLarge.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "request-too-large",
            attempts: [],
        }));

        const unsupportedLeaseRpc = await client.callTool({
            name: "device_broker_rpc",
            arguments: {
                method: "broker.lease.claim",
                params: { backend: "android-device", hardwareId: "x" },
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unsupportedLeaseRpc.isError).not.toBe(true);
        expect(JSON.parse(((unsupportedLeaseRpc.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
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
            const claim = await client.callTool({
                name: "device_broker_lease",
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
                }),
            }));

            const list = await client.callTool({
                name: "device_broker_lease",
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

            const release = await client.callTool({
                name: "device_broker_lease",
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
            const androidAttach = await client.callTool({
                name: "device_broker_attach",
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

            const iosAttach = await client.callTool({
                name: "device_broker_attach",
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

            const list = await client.callTool({
                name: "device_broker_attach",
                arguments: { action: "list", backend: "android-device", hostCandidates: ["127.0.0.1"], port: address.port, timeoutMs: 500 },
            });
            expect(JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ devices: [expect.objectContaining({ id: "android-broker-wifi" })] }),
            }));

            const detach = await client.callTool({
                name: "device_broker_attach",
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

    it("reports broker lease validation and unavailable broker failures without autolaunch", { timeout: TIMEOUT }, async () => {
        const invalidAction = await client.callTool({
            name: "device_broker_lease",
            arguments: { action: "steal", backend: "android-device" },
        });
        expect(invalidAction.isError).not.toBe(true);
        expect(JSON.parse(((invalidAction.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "invalid-lease-action",
            attempts: [],
        }));

        const unavailable = await client.callTool({
            name: "device_broker_lease",
            arguments: {
                action: "list",
                backend: "ios-device",
                hostCandidates: ["127.0.0.1"],
                port: 9,
                timeoutMs: 50,
            },
        });
        expect(unavailable.isError).not.toBe(true);
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
            const claim = await client.callTool({
                name: "device_broker_lease",
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

            const duplicate = await client.callTool({
                name: "device_broker_lease",
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
            expect(duplicate.isError).not.toBe(true);
            expect(JSON.parse(((duplicate.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: false,
                error: "physical-lease-device-mismatch",
                status: 409,
                selected: expect.objectContaining({ status: 409 }),
            }));

            const invalid = await client.callTool({
                name: "device_broker_lease",
                arguments: {
                    action: "claim",
                    backend: "android-device",
                    hardwareId: "",
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(invalid.isError).not.toBe(true);
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
        const status = await client.callTool({ name: "device_broker_status", arguments: {} });
        const owner = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string };
        const ownerRoot = join(homedir(), ".ccc/devices/owners", owner.ownerId);
        const fakeWsb = join(homeDir, "fake-wsb");
        writeFileSync(fakeWsb, "#!/bin/sh\ncase \"$2\" in\n  *fail*) echo broker failure >&2; exit 7 ;;\n  *) echo wsb \"$@\"; exit 0 ;;\nesac\n");
        chmodSync(fakeWsb, 0o755);
        mkdirSync(join(ownerRoot, "windows"), { recursive: true });
        writeFileSync(join(ownerRoot, "windows", "devices.json"), JSON.stringify({
            devices: [
                { id: "win-broker-plan", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/win-broker-plan.wsb" },
                { id: "win-broker-fail", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/fail.wsb" },
                { id: "win-broker-missing", backend: "windows-sandbox", status: "stopped" },
            ],
        }));
        const server = createDeviceBrokerServer({
            cwd: repoRoot,
            host: "127.0.0.1",
            port: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            providerPaths: { wsb: fakeWsb },
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as AddressInfo;
        try {
            const plan = await client.callTool({
                name: "device_broker_command",
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
                    ownerId: owner.ownerId,
                    backend: "windows-sandbox",
                    command: "device_start",
                    deviceId: "win-broker-plan",
                    execution: expect.objectContaining({ mode: "planned", providerExecution: "available" }),
                }),
            }));

            const dryRun = await client.callTool({
                name: "device_broker_command",
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

            const realRun = await client.callTool({
                name: "device_broker_command",
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
                            args: ["start", "C:/ccc/win-broker-plan.wsb"],
                            status: 0,
                            stdout: expect.stringContaining("wsb start C:/ccc/win-broker-plan.wsb"),
                        }),
                    }),
                }),
            }));

            const lifecycleStatus = await client.callTool({
                name: "device_status",
                arguments: {
                    deviceId: "win-broker-plan",
                    backend: "windows-sandbox",
                    broker: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(lifecycleStatus.isError).not.toBe(true);
            expect(JSON.parse(((lifecycleStatus.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    backend: "windows-sandbox",
                    command: "device_status",
                    deviceId: "win-broker-plan",
                    invoked: true,
                    execution: expect.objectContaining({
                        mode: "noop",
                        providerExecution: "executed",
                        mutatesHost: false,
                    }),
                }),
            }));

            const lifecycleStop = await client.callTool({
                name: "device_stop",
                arguments: {
                    deviceId: "win-broker-plan",
                    backend: "windows-sandbox",
                    viaBroker: true,
                    dryRun: true,
                    hostCandidates: ["127.0.0.1"],
                    port: address.port,
                    timeoutMs: 500,
                },
            });
            expect(lifecycleStop.isError).not.toBe(true);
            expect(JSON.parse(((lifecycleStop.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    backend: "windows-sandbox",
                    command: "device_stop",
                    invoked: false,
                    dryRun: true,
                    execution: expect.objectContaining({ mode: "dry-run", mutatesHost: false }),
                }),
            }));

            const failedRun = await client.callTool({
                name: "device_broker_command",
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
            expect(failedRun.isError).not.toBe(true);
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

            const missingMetadata = await client.callTool({
                name: "device_broker_command",
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
            expect(missingMetadata.isError).not.toBe(true);
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

    it("reports broker command validation and unavailable broker failures without autolaunch", { timeout: TIMEOUT }, async () => {
        const invalidAction = await client.callTool({
            name: "device_broker_command",
            arguments: { action: "run", backend: "android-emulator", command: "device_start", deviceId: "android-x" },
        });
        expect(invalidAction.isError).not.toBe(true);
        expect(JSON.parse(((invalidAction.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "invalid-command-action",
            attempts: [],
        }));

        const inferenceFailure = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "missing-broker-device", broker: true },
        });
        expect(inferenceFailure.isError).not.toBe(true);
        expect(JSON.parse(((inferenceFailure.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "device-backend-not-found",
            deviceId: "missing-broker-device",
            routedBy: "device-lifecycle-broker",
        }));

        const unavailable = await client.callTool({
            name: "device_broker_command",
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
        expect(unavailable.isError).not.toBe(true);
        expect(JSON.parse(((unavailable.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-rpc-unavailable",
            attempts: [expect.objectContaining({ ok: false, status: null })],
        }));
    });
});
