import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceBrokerServer } from "../device-lab-broker.js";
import { backendRoot, cleanupOwner, close, listen, ownerRoot, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";

describe("device-lab host broker lifecycle commands", () => {
    let originalHome: string | undefined;

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

    it("plans lifecycle commands and dry-run invokes without provider execution", async () => {
        const ownerId = "5555666677778888";
        const commandRunner = vi.fn((command) => ({
            mode: command.mode,
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: 0,
            pid: command.mode === "detached" ? 12345 : undefined,
            stdout: "started",
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-command-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { emulator: "/fake/emulator" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "android", [{ id: "android-owned", status: "stopped", backend: "android-emulator", avdName: "ccc-test-pixel", port: 5580 }]);

            const plan = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-owned" },
                }),
            });
            expect(plan.status).toBe(200);
            expect(await plan.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    ownerId,
                    backend: "android-emulator",
                    stateKey: "android",
                    command: "device_start",
                    deviceId: "android-owned",
                    execution: expect.objectContaining({
                        mode: "planned",
                        providerExecution: "available",
                        mutatesHost: false,
                    }),
                }),
            }));

            const invoke = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-owned", dryRun: true },
                }),
            });
            expect(invoke.status).toBe(200);
            expect(await invoke.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    invoked: false,
                    dryRun: true,
                    execution: expect.objectContaining({ mode: "dry-run", mutatesHost: false }),
                }),
            }));

            const realInvoke = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-owned", dryRun: false },
                }),
            });
            expect(realInvoke.status).toBe(200);
            expect(await realInvoke.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    invoked: true,
                    dryRun: false,
                    device: expect.objectContaining({ status: "running" }),
                    execution: expect.objectContaining({
                        mode: "detached",
                        providerExecution: "executed",
                        mutatesHost: true,
                        command: expect.objectContaining({
                            provider: "emulator",
                            executable: "/fake/emulator",
                            args: ["-avd", "ccc-test-pixel", "-port", "5580"],
                            pid: 12345,
                        }),
                    }),
                }),
            }));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({
                mode: "detached",
                provider: "emulator",
                executable: "/fake/emulator",
                args: ["-avd", "ccc-test-pixel", "-port", "5580"],
            }), expect.objectContaining({ timeoutMs: 5000, outputLimit: 32768 }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("validates lifecycle command params and keeps plans owner scoped", async () => {
        const ownerA = "6666777788889999";
        const ownerB = "777788889999aaaa";
        const server = createDeviceBrokerServer({ cwd: "/project/broker-command-guard-test", host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const endpointA = ownerRpcEndpoint(baseUrl, ownerA);
        const endpointB = ownerRpcEndpoint(baseUrl, ownerB);
        const headersA = ownerRpcHeaders(ownerA);
        const headersB = ownerRpcHeaders(ownerB);
        try {
            writeBrokerDevices(ownerA, "windows", [{ id: "win-owned", status: "stopped", backend: "windows-sandbox" }]);

            const foreignPlan = await fetch(endpointB, {
                method: "POST",
                headers: headersB,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "windows-sandbox", command: "device_delete", deviceId: "win-owned" },
                }),
            });
            expect(foreignPlan.status).toBe(404);
            expect(await foreignPlan.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "owner-device-not-found",
                ownerId: ownerB,
            }));

            const invalidBackend = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "unknown", command: "device_start", deviceId: "win-owned" },
                }),
            });
            expect(invalidBackend.status).toBe(400);
            expect(await invalidBackend.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-command-backend" }));

            const invalidCommand = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "windows-sandbox", command: "device_exec", deviceId: "win-owned" },
                }),
            });
            expect(invalidCommand.status).toBe(400);
            expect(await invalidCommand.json()).toEqual(expect.objectContaining({ ok: false, error: "unsupported-lifecycle-command" }));

            const invalidDeviceId = await fetch(endpointA, {
                method: "POST",
                headers: headersA,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "../win-owned" },
                }),
            });
            expect(invalidDeviceId.status).toBe(400);
            expect(await invalidDeviceId.json()).toEqual(expect.objectContaining({ ok: false, error: "invalid-device-id" }));
        } finally {
            await close(server);
            cleanupOwner(ownerA);
            cleanupOwner(ownerB);
        }
    });

    it("builds provider command plans for each device backend and reports missing metadata", async () => {
        const ownerId = "88889999aaaabbbb";
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-provider-plan-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: {
                adb: "/fake/adb",
                xcrun: "/fake/xcrun",
                wsb: "/fake/wsb",
                tart: "/fake/tart",
            },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            writeBrokerDevices(ownerId, "android-device", [{ id: "android-real", serial: "real-serial" }]);
            writeBrokerDevices(ownerId, "ios", [{ id: "ios-sim", udid: "SIM-UDID" }]);
            writeBrokerDevices(ownerId, "ios-device", [{ id: "ios-real", udid: "REAL-UDID" }]);
            writeBrokerDevices(ownerId, "windows", [{ id: "win", configPath: "C:/ccc/win.wsb" }]);
            writeBrokerDevices(ownerId, "macos", [
                { id: "mac", provider: "tart", providerInstance: "ccc-mac" },
                { id: "mac-missing", provider: "tart" },
                { id: "mac-unsafe", provider: "/tmp/unsafe-provider", providerInstance: "ccc-mac" },
            ]);

            const cases = [
                { backend: "android-device", command: "device_status", deviceId: "android-real", provider: "adb", args: ["-s", "real-serial", "get-state"] },
                { backend: "ios-simulator", command: "device_stop", deviceId: "ios-sim", provider: "xcrun", args: ["simctl", "shutdown", "SIM-UDID"] },
                { backend: "ios-device", command: "device_status", deviceId: "ios-real", provider: "xcrun", args: ["devicectl", "device", "info", "details", "--device", "REAL-UDID"] },
                { backend: "windows-sandbox", command: "device_start", deviceId: "win", provider: "wsb", args: ["start", "C:/ccc/win.wsb"] },
                { backend: "macos-vm", command: "device_stop", deviceId: "mac", provider: "tart", args: ["stop", "ccc-mac"] },
            ];
            for (const item of cases) {
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ method: "broker.command.plan", params: item }),
                });
                expect(response.status).toBe(200);
                const body = await response.json() as { result: { providerCommand: { provider: string; executable: string; args: string[] } } };
                expect(body.result.providerCommand).toEqual(expect.objectContaining({
                    provider: item.provider,
                    executable: `/fake/${item.provider}`,
                    args: item.args,
                }));
            }

            const missing = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: { backend: "macos-vm", command: "device_start", deviceId: "android-real" },
                }),
            });
            expect(missing.status).toBe(404);
            expect(await missing.json()).toEqual(expect.objectContaining({ ok: false, error: "owner-device-not-found" }));

            const missingMetadata = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "macos-vm", command: "device_start", deviceId: "mac-missing", dryRun: false },
                }),
            });
            expect(missingMetadata.status).toBe(400);
            expect(await missingMetadata.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "missing-provider-metadata",
                missing: ["providerInstance"],
            }));

            const unsafeProvider = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "macos-vm", command: "device_start", deviceId: "mac-unsafe", dryRun: false },
                }),
            });
            expect(unsafeProvider.status).toBe(400);
            expect(await unsafeProvider.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "unsupported-provider-command",
                missing: ["provider"],
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("bounds default provider execution output, reports timeouts, and preserves state on failures", async () => {
        const ownerId = "9999aaaabbbbcccc";
        const ownerStateRoot = ownerRoot(ownerId);
        const windowsRoot = backendRoot(ownerId, "windows");
        const fakeWsb = join(ownerStateRoot, "fake-wsb");
        mkdirSync(windowsRoot, { recursive: true });
        writeFileSync(fakeWsb, [
            "#!/bin/sh",
            "case \"$2\" in",
            "  *slow*) sleep 1; exit 0 ;;",
            "  *loud*) head -c 40000 /dev/zero | tr \"\\0\" x; exit 7 ;;",
            "  *) echo provider failed >&2; exit 9 ;;",
            "esac",
            "",
        ].join("\n"));
        chmodSync(fakeWsb, 0o755);
        writeBrokerDevices(ownerId, "windows", [
            { id: "win-fail", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/fail.wsb" },
            { id: "win-loud", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/loud.wsb" },
            { id: "win-slow", backend: "windows-sandbox", status: "stopped", configPath: "C:/ccc/slow.wsb" },
        ]);

        const server = createDeviceBrokerServer({
            cwd: "/project/broker-provider-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { wsb: fakeWsb },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const failed = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-fail", dryRun: false },
                }),
            });
            expect(failed.status).toBe(502);
            expect(await failed.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "provider-command-failed",
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: "win-fail", status: "stopped" }),
                    execution: expect.objectContaining({
                        mutatesHost: false,
                        command: expect.objectContaining({
                            status: 9,
                            stderr: expect.stringContaining("provider failed"),
                        }),
                    }),
                }),
            }));

            const loudServer = createDeviceBrokerServer({
                cwd: "/project/broker-provider-output-test",
                host: "127.0.0.1",
                port: 0,
                providerPaths: { wsb: fakeWsb },
            });
            const loudBaseUrl = await listen(loudServer);
            try {
                const loud = await fetch(`${loudBaseUrl}/v1/owners/${ownerId}/rpc`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.command.invoke",
                        params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-loud", dryRun: false },
                    }),
                });
                expect(loud.status).toBe(502);
                const loudBody = await loud.json() as { result: { execution: { command: { stdout: string; error?: string; timedOut?: boolean } } } };
                expect(loudBody.result.execution.command.stdout).toHaveLength(32768);
                expect(loudBody.result.execution.command.error).toContain("ENOBUFS");
                expect(loudBody.result.execution.command.timedOut).toBe(false);
            } finally {
                await close(loudServer);
            }

            const slowServer = createDeviceBrokerServer({
                cwd: "/project/broker-provider-timeout-test",
                host: "127.0.0.1",
                port: 0,
                providerPaths: { wsb: fakeWsb },
                commandTimeoutMs: 1,
            });
            const slowBaseUrl = await listen(slowServer);
            try {
                const timedOut = await fetch(`${slowBaseUrl}/v1/owners/${ownerId}/rpc`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        method: "broker.command.invoke",
                        params: { backend: "windows-sandbox", command: "device_start", deviceId: "win-slow", dryRun: false },
                    }),
                });
                expect(timedOut.status).toBe(502);
                expect(await timedOut.json()).toEqual(expect.objectContaining({
                    ok: false,
                    error: "provider-command-failed",
                    result: expect.objectContaining({
                        execution: expect.objectContaining({
                            command: expect.objectContaining({ timedOut: true }),
                        }),
                    }),
                }));
            } finally {
                await close(slowServer);
            }

            const state = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf8")) as { devices: Array<{ id: string; status: string }> };
            expect(state.devices).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: "win-fail", status: "stopped" }),
                expect.objectContaining({ id: "win-loud", status: "stopped" }),
                expect.objectContaining({ id: "win-slow", status: "stopped" }),
            ]));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("reports detached provider startup failures before mutating owner state", async () => {
        const ownerId = "aaaabbbbccccdddd";
        const ownerStateRoot = ownerRoot(ownerId);
        const androidRoot = writeBrokerDevices(ownerId, "android", [{ id: "android-detached-missing", backend: "android-emulator", status: "stopped", avdName: "ccc-missing-provider", port: 5592 }]);
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-detached-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { emulator: join(ownerStateRoot, "missing-emulator") },
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "android-emulator", command: "device_start", deviceId: "android-detached-missing", dryRun: false },
                }),
            });
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(expect.objectContaining({
                ok: false,
                error: "provider-command-failed",
                result: expect.objectContaining({
                    device: expect.objectContaining({ id: "android-detached-missing", status: "stopped" }),
                    execution: expect.objectContaining({
                        mode: "detached",
                        mutatesHost: false,
                        command: expect.objectContaining({
                            provider: "emulator",
                            error: "executable-not-found",
                            status: null,
                        }),
                    }),
                }),
            }));
            const state = JSON.parse(readFileSync(join(androidRoot, "devices.json"), "utf8")) as { devices: Array<{ id: string; status: string }> };
            expect(state.devices).toEqual([expect.objectContaining({ id: "android-detached-missing", status: "stopped" })]);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });
});
