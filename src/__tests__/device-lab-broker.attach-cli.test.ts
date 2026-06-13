import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createDeviceBrokerServer,
    deviceBrokerCli,
    deviceBrokerOwnerToken,
    formatDeviceBrokerStatus,
    parseBrokerServeArgs,
    startDeviceBrokerServe,
} from "../device-lab-broker.js";
import { devicesCli } from "../device-lab-admin.js";
import { close, listen } from "./helpers/host-broker-test-fixture.js";

describe("device-lab host broker physical attach and CLI", () => {
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = mkdtempSync(join(tmpdir(), "ccc-device-broker-attach-test-home-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    it("attaches and detaches physical Android/iOS devices through broker RPC with leases", async () => {
        const ownerId = "bbbbccccddddeeee";
        const ownerRoot = join(homedir(), ".ccc/devices/owners", ownerId);
        const androidLease = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("192.168.1.80:5555")}.json`);
        const iosLease = join(homedir(), ".ccc/devices/physical-leases/ios-device/locks", `${encodeURIComponent("00008120-00AA00BB00CC00DD")}.json`);
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb" && command.args?.[0] === "connect") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: `connected to ${command.args[1]}`, stderr: "" };
            }
            if (command.provider === "adb" && command.args?.join(" ") === "devices -l") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: "List of devices attached\n192.168.1.80:5555 device product:pixel model:Pixel_8\nUSB123 device product:pixel model:Pixel_USB\n", stderr: "" };
            }
            if (command.provider === "xcrun" && command.args?.join(" ") === "xctrace list devices") {
                return { mode: "exec", provider: "xcrun", executable: command.executable, args: command.args, status: 0, stdout: "== Devices ==\nReal iPhone (17.5) (00008110-001C195E0E91801E)\nNetwork iPhone (17.5) (00008120-00AA00BB00CC00DD) (Network)\n", stderr: "" };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "unexpected command" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-physical-attach-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", xcrun: "/fake/xcrun" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        try {
            const missingWifiTarget = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "android-device", deviceId: "android-missing-target", connection: "wifi" },
                }),
            });
            expect(missingWifiTarget.status).toBe(400);
            expect(await missingWifiTarget.json()).toEqual(expect.objectContaining({ ok: false, error: "missing-android-wifi-target" }));
            expect(commandRunner).not.toHaveBeenCalledWith(expect.objectContaining({ provider: "adb", args: ["connect", "null:5555"] }), expect.any(Object));

            const androidAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "android-device", deviceId: "android-wifi", name: "WiFi Pixel", connection: "wifi", host: "192.168.1.80", port: 5555 },
                }),
            });
            expect(androidAttach.status).toBe(200);
            expect(await androidAttach.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: "android-wifi",
                        serial: "192.168.1.80:5555",
                        connection: "wifi",
                        transport: { type: "wifi", host: "192.168.1.80", port: 5555 },
                    }),
                    lease: expect.objectContaining({ hardwareId: "192.168.1.80:5555", ownerId }),
                }),
            }));
            expect(commandRunner).toHaveBeenCalledWith(expect.objectContaining({ provider: "adb", args: ["connect", "192.168.1.80:5555"] }), expect.any(Object));

            const iosAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "ios-device", deviceId: "ios-network", name: "Network iPhone", connection: "wifi", udid: "00008120-00AA00BB00CC00DD", host: "network-iphone.local" },
                }),
            });
            expect(iosAttach.status).toBe(200);
            expect(await iosAttach.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    device: expect.objectContaining({
                        id: "ios-network",
                        udid: "00008120-00AA00BB00CC00DD",
                        connection: "wifi",
                        transport: expect.objectContaining({ type: "wifi", host: "network-iphone.local", visibleVia: "xctrace" }),
                    }),
                    lease: expect.objectContaining({ hardwareId: "00008120-00AA00BB00CC00DD", ownerId }),
                }),
            }));

            const list = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.physical.list", params: { backend: "android-device" } }),
            });
            expect(list.status).toBe(200);
            expect(await list.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    devices: [expect.objectContaining({ id: "android-wifi" })],
                    leases: [expect.objectContaining({ hardwareId: "192.168.1.80:5555" })],
                }),
            }));

            const androidDetach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ method: "broker.physical.detach", params: { backend: "android-device", deviceId: "android-wifi" } }),
            });
            expect(androidDetach.status).toBe(200);
            expect(await androidDetach.json()).toEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({ detached: "android-wifi", physicalDevicePoweredOff: false, disconnected: false }),
            }));
            expect(existsSync(androidLease)).toBe(false);
        } finally {
            await close(server);
            rmSync(ownerRoot, { recursive: true, force: true });
            rmSync(androidLease, { force: true });
            rmSync(iosLease, { force: true });
        }
    });

    it("cleans Android broker leases on adb connect failure and rejects non-network iOS Wi-Fi attach", async () => {
        const ownerId = "cccceeeeffff0000";
        const ownerRoot = join(homedir(), ".ccc/devices/owners", ownerId);
        const androidLease = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("192.168.1.81:5555")}.json`);
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb" && command.args?.[0] === "connect") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "failed to connect" };
            }
            if (command.provider === "xcrun") {
                return { mode: "exec", provider: "xcrun", executable: command.executable, args: command.args, status: 0, stdout: "== Devices ==\nUSB iPhone (17.5) (00008110-001C195E0E91801E)\n", stderr: "" };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 0, stdout: "", stderr: "" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-physical-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", xcrun: "/fake/xcrun" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        try {
            const androidAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "android-device", deviceId: "android-fail", connection: "wifi", host: "192.168.1.81" },
                }),
            });
            expect(androidAttach.status).toBe(502);
            expect(await androidAttach.json()).toEqual(expect.objectContaining({ ok: false, error: "adb-connect-failed" }));
            expect(existsSync(androidLease)).toBe(false);

            const iosAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "ios-device", deviceId: "ios-usb-as-wifi", connection: "wifi", udid: "00008110-001C195E0E91801E" },
                }),
            });
            expect(iosAttach.status).toBe(409);
            expect(await iosAttach.json()).toEqual(expect.objectContaining({ ok: false, error: "ios-wifi-device-not-network-visible" }));
        } finally {
            await close(server);
            rmSync(ownerRoot, { recursive: true, force: true });
            rmSync(androidLease, { force: true });
        }
    });

    it("releases physical leases when attached device owner state cannot be written", async () => {
        const ownerId = "ddddffff00001111";
        const ownerRoot = join(homedir(), ".ccc/devices/owners", ownerId);
        const androidLease = join(homedir(), ".ccc/devices/physical-leases/android-device/locks", `${encodeURIComponent("192.168.1.82:5555")}.json`);
        const iosLease = join(homedir(), ".ccc/devices/physical-leases/ios-device/locks", `${encodeURIComponent("00008140-00AA00BB00CC00FF")}.json`);
        const commandRunner = vi.fn((command) => {
            if (command.provider === "adb" && command.args?.[0] === "connect") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: `connected to ${command.args[1]}`, stderr: "" };
            }
            if (command.provider === "adb" && command.args?.join(" ") === "devices -l") {
                return { mode: "exec", provider: "adb", executable: command.executable, args: command.args, status: 0, stdout: "List of devices attached\n192.168.1.82:5555 device product:pixel model:Pixel_8\n", stderr: "" };
            }
            if (command.provider === "xcrun") {
                return { mode: "exec", provider: "xcrun", executable: command.executable, args: command.args, status: 0, stdout: "== Devices ==\nNetwork iPhone (17.5) (00008140-00AA00BB00CC00FF) (Network)\n", stderr: "" };
            }
            return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args, status: 1, stdout: "", stderr: "unexpected command" };
        });
        const server = createDeviceBrokerServer({
            cwd: "/project/broker-physical-write-failure-test",
            host: "127.0.0.1",
            port: 0,
            providerPaths: { adb: "/fake/adb", xcrun: "/fake/xcrun" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = `${baseUrl}/v1/owners/${ownerId}/rpc`;
        const headers = { "content-type": "application/json", "x-ccc-device-token": deviceBrokerOwnerToken(ownerId) };
        try {
            mkdirSync(ownerRoot, { recursive: true });
            writeFileSync(join(ownerRoot, "android-device"), "not-a-directory");
            const androidAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "android-device", deviceId: "android-write-fails", connection: "wifi", host: "192.168.1.82" },
                }),
            });
            expect(androidAttach.status).toBe(500);
            expect(await androidAttach.json()).toEqual(expect.objectContaining({ ok: false, error: "owner-state-write-failed" }));
            expect(existsSync(androidLease)).toBe(false);

            rmSync(join(ownerRoot, "android-device"), { force: true });
            writeFileSync(join(ownerRoot, "ios-device"), "not-a-directory");
            const iosAttach = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    method: "broker.physical.attach",
                    params: { backend: "ios-device", deviceId: "ios-write-fails", udid: "00008140-00AA00BB00CC00FF" },
                }),
            });
            expect(iosAttach.status).toBe(500);
            expect(await iosAttach.json()).toEqual(expect.objectContaining({ ok: false, error: "owner-state-write-failed" }));
            expect(existsSync(iosLease)).toBe(false);
        } finally {
            await close(server);
            rmSync(ownerRoot, { recursive: true, force: true });
            rmSync(androidLease, { force: true });
            rmSync(iosLease, { force: true });
        }
    });

    it("formats broker status and routes through ccc devices broker status", () => {
        const direct = formatDeviceBrokerStatus({ cwd: "/project/broker-cli-test" });
        expect(direct).toContain("=== CCC Device Broker ===");
        expect(direct).toContain("mode: host-broker-daemon");
        expect(direct).toContain("explicit-mcp-autolaunch-compatible");

        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const exitCode = deviceBrokerCli(["status"], "/project/broker-cli-test");
        expect(exitCode).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("=== CCC Device Broker ==="));

        log.mockClear();
        const routedExitCode = devicesCli(["broker", "status"], "/project/broker-cli-test");
        expect(routedExitCode).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("mode: host-broker-daemon"));
    });

    it("parses and starts the broker serve CLI route through an injectable server", () => {
        expect(parseBrokerServeArgs(["--host", "0.0.0.0", "--port", "19001"])).toEqual({
            host: "0.0.0.0",
            port: 19001,
        });
        expect(parseBrokerServeArgs(["--port", "not-a-number"])).toEqual({
            host: "127.0.0.1",
            port: 17373,
        });

        const listen = vi.fn((_port: number, _host: string, callback: () => void) => {
            callback();
            return undefined;
        });
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const factory = vi.fn(() => ({ listen }) as unknown as ReturnType<typeof createDeviceBrokerServer>);

        const exitCode = startDeviceBrokerServe(["--host", "0.0.0.0", "--port", "19001"], "/project/broker-serve-test", factory);

        expect(exitCode).toBe(0);
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({
            cwd: "/project/broker-serve-test",
            host: "0.0.0.0",
            port: 19001,
        }));
        expect(listen).toHaveBeenCalledWith(19001, "0.0.0.0", expect.any(Function));
        expect(log).toHaveBeenCalledWith("ccc-device-broker listening on http://0.0.0.0:19001");
    });

    it("rejects unknown broker CLI subcommands", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(deviceBrokerCli(["unknown"], "/project/broker-cli-test")).toBe(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("Usage: ccc devices broker"));
    });
});
