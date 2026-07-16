import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFakeAndroidMcpContext, createFakeAndroidMcpContext, TIMEOUT, type FakeAndroidMcpContext } from "./helpers/fake-android-mcp-fixture.js";

function parseToolJson(result: { content?: unknown }) {
    return JSON.parse((((result.content as Array<{ text?: string }> | undefined) ?? [])[0]?.text ?? "{}")) as Record<string, unknown>;
}

describe("device-lab MCP Android real-device flows with fake SDK", () => {
    let context: FakeAndroidMcpContext;
    let client: FakeAndroidMcpContext["client"];
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    beforeAll(async () => {
        context = await createFakeAndroidMcpContext();
        client = context.client;
        homeDir = context.homeDir;
        binDir = context.binDir;
        logPath = context.logPath;
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupFakeAndroidMcpContext(context);
    }, TIMEOUT);

    it("reports missing explicit Android physical mobile targets instead of unknown tools", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "mobile_session_status",
            arguments: { backend: "android-device", deviceId: "missing-android-real-device" },
        });
        const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            error: string;
            backend: string;
            deviceId: string;
        };

        expect(result.isError).toBe(true);
        expect(payload).toEqual({
            ok: false,
            error: "device-not-found",
            backend: "android-device",
            deviceId: "missing-android-real-device",
        });
    });

    it("attaches, uses, and detaches host-connected Android real devices without emulator lifecycle commands", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-device" },
        });
        expect(inventory.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            hostDevices: { devices: Array<{ serial: string; state: string; emulator: boolean; connection: string; details: { model?: string } }> };
        };
        expect(inventoryPayload.hostDevices.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ serial: "R5CREAL123", state: "device", emulator: false, connection: "usb", details: expect.objectContaining({ model: "Pixel_6" }) }),
            expect.objectContaining({ serial: "192.168.1.50:5555", state: "device", emulator: false, connection: "wifi" }),
            expect.objectContaining({ serial: "192.168.1.60:5555", state: "device", emulator: false, connection: "wifi" }),
            expect.objectContaining({ serial: "R5LEASED999", state: "device" }),
            expect.objectContaining({ serial: "UNAUTHORIZED", state: "unauthorized" }),
            expect.objectContaining({ serial: "emulator-5554", emulator: true }),
        ]));

        const wirelessStatus = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "android-device" },
        });
        expect(wirelessStatus.isError).not.toBe(true);
        const wirelessStatusPayload = JSON.parse(((wirelessStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            actions: string[];
            hostDevices: { devices: Array<{ serial: string; connection: string }> };
        };
        expect(wirelessStatusPayload.actions).toEqual(expect.arrayContaining(["usb-tcpip", "pair", "connect"]));
        expect(wirelessStatusPayload.hostDevices.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ serial: "192.168.1.50:5555", connection: "wifi" }),
        ]));

        const listBeforeWirelessPrepare = await client.callTool({ name: "device_list", arguments: {} });
        const listedBeforeWirelessPrepare = JSON.parse(((listBeforeWirelessPrepare.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ backend?: string }>;
        };
        expect(listedBeforeWirelessPrepare.devices.some((device) => device.backend === "android-device")).toBe(false);

        const usbTcpip = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "android-device", action: "usb-tcpip", serial: "R5CREAL123", host: "192.168.1.50", port: 5555 },
        });
        expect(usbTcpip.isError).not.toBe(true);
        const usbTcpipPayload = JSON.parse(((usbTcpip.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            action: string;
            stateMutated: boolean;
            target: string;
            attachNext: { arguments: { host: string; port: number } };
        };
        expect(usbTcpipPayload).toEqual(expect.objectContaining({
            ok: true,
            action: "usb-tcpip",
            stateMutated: false,
            target: "192.168.1.50:5555",
        }));
        expect(usbTcpipPayload.attachNext.arguments).toEqual(expect.objectContaining({ host: "192.168.1.50", port: 5555 }));

        const pairConnect = await client.callTool({
            name: "device_wireless",
            arguments: {
                backend: "android-device",
                action: "pair",
                pairHost: "192.168.1.70",
                pairPort: 37099,
                pairingCode: "123456",
                host: "192.168.1.50",
                port: 5555,
            },
        });
        expect(pairConnect.isError).not.toBe(true);
        const pairConnectPayload = JSON.parse(((pairConnect.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            pairTarget: string;
            pair: { args: string[] };
            target: string;
            stateMutated: boolean;
        };
        expect(pairConnectPayload).toEqual(expect.objectContaining({
            ok: true,
            pairTarget: "192.168.1.70:37099",
            target: "192.168.1.50:5555",
            stateMutated: false,
        }));
        expect(pairConnectPayload.pair.args).toEqual(["pair", "192.168.1.70:37099", "[redacted]"]);

        const pairMissingConnectTarget = await client.callTool({
            name: "device_wireless",
            arguments: {
                backend: "android-device",
                action: "pair",
                pairHost: "192.168.1.70",
                pairPort: 37099,
                pairingCode: "123456",
                connect: true,
            },
        });
        expect(pairMissingConnectTarget.isError).toBe(true);
        const pairMissingConnectTargetPayload = JSON.parse((pairMissingConnectTarget.content as Array<{ text?: string }>)[0].text ?? "{}") as {
            error: string;
            pair: { args: string[] };
        };
        expect(pairMissingConnectTargetPayload.error).toBe("android-wireless-connect-requires-host");
        expect(pairMissingConnectTargetPayload.pair.args).toEqual(["pair", "192.168.1.70:37099", "[redacted]"]);

        const failedPair = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "android-device", action: "pair", pairHost: "192.168.1.70", pairPort: 37099, pairingCode: "000000" },
        });
        expect(failedPair.isError).toBe(true);
        const failedPairPayload = JSON.parse((failedPair.content as Array<{ text?: string }>)[0].text ?? "{}") as {
            ok: boolean;
            error: string;
            command: { args: string[]; status: number; stderr: string };
        };
        expect(failedPairPayload).toEqual(expect.objectContaining({ ok: false, error: "android-wireless-pair-failed" }));
        expect(failedPairPayload.command).toEqual(expect.objectContaining({ status: 1, stderr: expect.stringContaining("Failed to pair") }));
        expect(failedPairPayload.command.args).toEqual(["pair", "192.168.1.70:37099", "[redacted]"]);

        const listAfterWirelessPrepare = await client.callTool({ name: "device_list", arguments: {} });
        const listedAfterWirelessPrepare = JSON.parse(((listAfterWirelessPrepare.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ backend?: string }>;
        };
        expect(listedAfterWirelessPrepare.devices.some((device) => device.backend === "android-device")).toBe(false);

        const androidLeaseDir = join(homeDir, ".ccc/devices/physical-leases/android-device/locks");
        mkdirSync(androidLeaseDir, { recursive: true });
        writeFileSync(join(androidLeaseDir, `${encodeURIComponent("R5LEASED999")}.json`), JSON.stringify({
            backend: "android-device",
            hardwareId: "R5LEASED999",
            ownerId: "other-owner",
            deviceId: "android-device-foreign",
            updatedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            ttlMs: 60 * 60 * 1000,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }));
        writeFileSync(join(androidLeaseDir, `${encodeURIComponent("192.168.1.52:5555")}.json`), JSON.stringify({
            backend: "android-device",
            hardwareId: "192.168.1.52:5555",
            ownerId: "other-owner",
            deviceId: "android-device-wifi-foreign",
            updatedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            ttlMs: 60 * 60 * 1000,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }));
        const rejectLeased = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Already Leased", serial: "R5LEASED999" },
        });
        expect(rejectLeased.isError).toBe(true);
        expect((rejectLeased.content as Array<{ text?: string }>)[0].text).toContain("already attached or an attach is in progress");
        const rejectWifiLeased = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Already Leased WiFi", connection: "wifi", host: "192.168.1.52" },
        });
        expect(rejectWifiLeased.isError).toBe(true);
        expect((rejectWifiLeased.content as Array<{ text?: string }>)[0].text).toContain("already attached or an attach is in progress");

        const rejectEmulator = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Bad Emulator", serial: "emulator-5554" },
        });
        expect(rejectEmulator.isError).toBe(true);
        expect((rejectEmulator.content as Array<{ text?: string }>)[0].text).toContain("Refusing to attach emulator serial");

        const rejectUnauthorized = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Unauthorized", serial: "UNAUTHORIZED" },
        });
        expect(rejectUnauthorized.isError).toBe(true);
        expect((rejectUnauthorized.content as Array<{ text?: string }>)[0].text).toContain("adb state is unauthorized");

        const rejectWifiMissingHost = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "WiFi Missing Host", connection: "wifi" },
        });
        expect(rejectWifiMissingHost.isError).toBe(true);
        expect((rejectWifiMissingHost.content as Array<{ text?: string }>)[0].text).toContain("Android Wi-Fi attach requires host");

        const rejectWifiConnect = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "WiFi Bad", connection: "wifi", host: "192.168.1.51" },
        });
        expect(rejectWifiConnect.isError).toBe(true);
        expect((rejectWifiConnect.content as Array<{ text?: string }>)[0].text).toContain("failed to connect");

        const attach = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Real Pixel", serial: "R5CREAL123" },
        });
        expect(attach.isError).not.toBe(true);
        const attached = JSON.parse(((attach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; backend: string; serial: string; status: string; creatable: boolean; physical: boolean; targetStatus: { targetKind: string; leaseState: { state: string; hardwareId: string }; sessionState: { state: string } } };
        };
        expect(attached.device).toEqual(expect.objectContaining({
            id: "android-device-real-pixel",
            backend: "android-device",
            serial: "R5CREAL123",
            connection: "usb",
            status: "attached",
            creatable: false,
            physical: true,
            targetKind: "physical-device",
            runtimeState: "attached",
            targetStatus: expect.objectContaining({
                targetKind: "physical-device",
                creatable: false,
                attachable: true,
                runtimeState: "attached",
                readiness: { state: "ready" },
                leaseState: expect.objectContaining({ state: "owned", hardwareId: "R5CREAL123" }),
                sessionState: expect.objectContaining({ state: "none" }),
            }),
        }));

        const wifiAttach = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "WiFi Pixel", connection: "wifi", host: "192.168.1.50", port: 5555 },
        });
        expect(wifiAttach.isError).not.toBe(true);
        const wifiAttached = JSON.parse(((wifiAttach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; serial: string; connection: string; transport: { type: string; host: string; port: number } };
        };
        expect(wifiAttached.device).toEqual(expect.objectContaining({
            id: "android-device-wifi-pixel",
            serial: "192.168.1.50:5555",
            connection: "wifi",
            transport: expect.objectContaining({ type: "wifi", host: "192.168.1.50", port: 5555 }),
        }));
        const wifiSerialAttach = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "WiFi Serial Pixel", serial: "192.168.1.60:5555" },
        });
        expect(wifiSerialAttach.isError).not.toBe(true);
        const wifiSerialAttached = JSON.parse(((wifiSerialAttach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; serial: string; connection: string; transport: { type: string; host: string; port: number } };
        };
        expect(wifiSerialAttached.device).toEqual(expect.objectContaining({
            id: "android-device-wifi-serial-pixel",
            serial: "192.168.1.60:5555",
            connection: "wifi",
            transport: expect.objectContaining({ type: "wifi", host: "192.168.1.60", port: 5555 }),
        }));

        const duplicate = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Real Pixel Duplicate", serial: "R5CREAL123" },
        });
        expect(duplicate.isError).toBe(true);
        expect((duplicate.content as Array<{ text?: string }>)[0].text).toContain("Android serial already attached");

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "android-device-real-pixel" },
        });
        expect(status.isError).not.toBe(true);
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { targetStatus: { targetKind: string; leaseState: { state: string; hardwareId: string } } };
            hostState: { stdout: string };
            backend: { name: string; attachable: boolean };
        };
        expect(statusPayload.device.targetStatus).toEqual(expect.objectContaining({
            targetKind: "physical-device",
            attachable: true,
            leaseState: expect.objectContaining({ state: "owned", hardwareId: "R5CREAL123" }),
        }));
        expect(statusPayload.hostState.stdout).toBe("device");
        expect(statusPayload.backend).toEqual(expect.objectContaining({ name: "android-device", attachable: true }));

        const expectedAndroidPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("FAKEPNG")]).toString("base64");
        for (const [tool, args, expectedPayload] of [
            ["device_exec", { deviceId: "android-device-real-pixel", command: "echo ok" }, { stdout: "ok\n", stderr: "", status: 0 }],
            ["mobile_tap", { deviceId: "android-device-real-pixel", x: 10, y: 20 }, { provider: "adb", tapped: { x: 10, y: 20 } }],
            ["mobile_back", { deviceId: "android-device-real-pixel" }, { provider: "adb", key: 4 }],
            ["mobile_dump_ui", { deviceId: "android-device-real-pixel" }, { provider: "adb-uiautomator", source: expect.stringContaining("<hierarchy>"), remotePath: "/sdcard/window-android-device-real-pixel.xml" }],
            ["mobile_wait_for_text", { deviceId: "android-device-real-pixel", text: "Hello", timeoutMs: 100, intervalMs: 50 }, { provider: "adb-uiautomator", text: "Hello", found: true }],
            ["device_install_app", { deviceId: "android-device-real-pixel", path: "/tmp/Real.apk" }, { provider: "adb", installed: "/tmp/Real.apk" }],
            ["device_launch_app", { deviceId: "android-device-real-pixel", packageName: "com.example.real" }, { provider: "adb", launched: "com.example.real" }],
            ["device_screenshot", { deviceId: "android-device-real-pixel" }, { type: "image", data: expectedAndroidPng, mimeType: "image/png" }],
        ] as Array<[string, Record<string, unknown>, Record<string, unknown>]>) {
            const result = await client.callTool({ name: tool, arguments: args });
            expect(result.isError, tool).not.toBe(true);
            if (tool === "device_screenshot") {
                expect((result.content as Array<{ type: string; data: string; mimeType: string }>)[0]).toEqual(expectedPayload);
            } else {
                expect(parseToolJson(result)).toEqual(expect.objectContaining(expectedPayload));
            }
        }

        const flakyScreencapMarker = join(homeDir, "fake-screencap-exit-1");
        writeFileSync(flakyScreencapMarker, "1");
        try {
            const flakyScreenshot = await client.callTool({
                name: "mobile_screenshot",
                arguments: { deviceId: "android-device-real-pixel" },
            });
            expect(flakyScreenshot.isError).not.toBe(true);
            expect((flakyScreenshot.content as Array<{ type: string; mimeType?: string; data?: string }>)[0]).toEqual(expect.objectContaining({
                type: "image",
                mimeType: "image/png",
                data: expectedAndroidPng,
            }));
        } finally {
            rmSync(flakyScreencapMarker, { force: true });
        }

        const realUploadPath = join(homeDir, "real-upload.txt");
        writeFileSync(realUploadPath, "real upload");
        const logBeforeRejectedRemoteTransfer = readFileSync(logPath, "utf-8");
        const rejectedRemoteUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: "android-device-real-pixel", localPath: realUploadPath, remotePath: "/sdcard/../escape.txt" },
        });
        expect(rejectedRemoteUpload.isError).toBe(true);
        expect((rejectedRemoteUpload.content as Array<{ text?: string }>)[0].text).toContain("upload-remote-path-traversal-rejected");
        const rejectedRemoteDownload = await client.callTool({
            name: "device_download",
            arguments: { deviceId: "android-device-real-pixel", remotePath: "relative.txt", localPath: join(homeDir, "real-download.txt") },
        });
        expect(rejectedRemoteDownload.isError).toBe(true);
        expect((rejectedRemoteDownload.content as Array<{ text?: string }>)[0].text).toContain("download-remote-path-not-absolute");
        expect(readFileSync(logPath, "utf-8")).toBe(logBeforeRejectedRemoteTransfer);

        const realRecordingPath = join(homeDir, "real-recording.mp4");
        writeFileSync(realRecordingPath, "original");
        const realRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-device-real-pixel",
                remotePath: "/sdcard/fail-once-pull-real-recording.mp4",
                localPath: realRecordingPath,
                timeLimitSec: 5,
            },
        });
        expect(realRecordStart.isError).not.toBe(true);
        const failedRealRecordStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "android-device-real-pixel" },
        });
        expect(failedRealRecordStop.isError).toBe(true);
        expect((failedRealRecordStop.content as Array<{ text?: string }>)[0].text).toContain("remains pending finalization");
        expect(readFileSync(realRecordingPath, "utf8")).toBe("original");
        const pendingRealRecording = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-device-real-pixel" },
        });
        expect(parseToolJson(pendingRealRecording).recording).toEqual(expect.objectContaining({
            active: false,
            remotePath: "/sdcard/fail-once-pull-real-recording.mp4",
        }));
        const retriedRealRecordStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "android-device-real-pixel" },
        });
        expect(retriedRealRecordStop.isError).not.toBe(true);
        expect(readFileSync(realRecordingPath, "utf8")).toBe("downloaded");

        const unsafeBattery = await client.callTool({
            name: "mobile_set_battery",
            arguments: { deviceId: "android-device-real-pixel", level: 10, confirmDestructive: true },
        });
        expect(unsafeBattery.isError).toBe(true);
        expect((unsafeBattery.content as Array<{ text?: string }>)[0].text).toContain("Android real devices do not support mobile_set_battery safely");
        const unsafeLocation = await client.callTool({
            name: "mobile_set_location",
            arguments: { deviceId: "android-device-real-pixel", latitude: 37.7749, longitude: -122.4194 },
        });
        expect(unsafeLocation.isError).toBe(true);
        expect((unsafeLocation.content as Array<{ text?: string }>)[0].text).toContain("Android real devices do not support mobile_set_location safely");

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "android-device-real-pixel" },
        });
        expect(stop.isError).not.toBe(true);
        const stopped = JSON.parse(((stop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            physicalDevicePoweredOff: boolean;
            device: { status: string };
        };
        expect(stopped.physicalDevicePoweredOff).toBe(false);
        expect(stopped.device.status).toBe("attached");

        const detach = await client.callTool({
            name: "device_detach",
            arguments: { deviceId: "android-device-real-pixel" },
        });
        expect(detach.isError).not.toBe(true);
        expect(() => readFileSync(join(androidLeaseDir, `${encodeURIComponent("R5CREAL123")}.json`), "utf-8")).toThrow();
        const wifiDetach = await client.callTool({
            name: "device_detach",
            arguments: { deviceId: "android-device-wifi-pixel" },
        });
        expect(wifiDetach.isError).not.toBe(true);
        expect(() => readFileSync(join(androidLeaseDir, `${encodeURIComponent("192.168.1.50:5555")}.json`), "utf-8")).toThrow();
        const wifiSerialDetach = await client.callTool({
            name: "device_detach",
            arguments: { deviceId: "android-device-wifi-serial-pixel" },
        });
        expect(wifiSerialDetach.isError).not.toBe(true);
        expect(() => readFileSync(join(androidLeaseDir, `${encodeURIComponent("192.168.1.60:5555")}.json`), "utf-8")).toThrow();

        const list = await client.callTool({ name: "device_list", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string }>;
        };
        expect(listed.devices.some((device) => device.id === "android-device-real-pixel")).toBe(false);

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("adb devices -l");
        expect(log).toContain("adb -s R5CREAL123 tcpip 5555");
        expect(log).toContain("adb pair 192.168.1.70:37099 123456");
        expect(log).toContain("adb pair 192.168.1.70:37099 000000");
        expect(log).toContain("adb connect 192.168.1.50:5555");
        expect(log).toContain("adb connect 192.168.1.51:5555");
        expect(log).not.toContain("adb connect 192.168.1.52:5555");
        expect(log).not.toContain("adb connect 192.168.1.60:5555");
        expect(log).toContain("adb -s R5CREAL123 get-state");
        expect(log).toContain("adb -s R5CREAL123 shell echo ok");
        expect(log).toContain("adb -s R5CREAL123 shell input tap 10 20");
        expect(log).toContain("adb -s R5CREAL123 shell input keyevent 4");
        expect(log).toContain("adb -s R5CREAL123 install -r /tmp/Real.apk");
        expect(log).toContain("adb -s R5CREAL123 shell monkey -p com.example.real 1");
        expect(log).toContain("adb -s R5CREAL123 exec-out screencap -p");
        expect(log).not.toContain("adb -s R5CREAL123 emu kill");
    });

    it("rejects Android physical effects after the exact attachment lease is lost", { timeout: TIMEOUT }, async () => {
        const deviceId = "android-device-lease-fence";
        const serial = "R5CREAL123";
        const leasePath = join(
            homeDir,
            ".ccc/devices/physical-leases/android-device/locks",
            `${encodeURIComponent(serial)}.json`,
        );
        let ownedLease: string | undefined;

        try {
            const attach = await client.callTool({
                name: "device_attach",
                arguments: {
                    backend: "android-device",
                    name: "Lease Fence Pixel",
                    deviceId,
                    serial,
                },
            });
            expect(attach.isError).not.toBe(true);

            ownedLease = readFileSync(leasePath, "utf-8");
            const forgedLease = {
                ...JSON.parse(ownedLease) as Record<string, unknown>,
                claimNonce: "forged-claim-nonce",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
            writeFileSync(leasePath, JSON.stringify(forgedLease, null, 2));
            writeFileSync(logPath, "");

            for (const request of [
                { name: "device_status", arguments: { backend: "android-device", deviceId } },
                { name: "device_exec", arguments: { backend: "android-device", deviceId, command: "echo fenced" } },
                { name: "device_start", arguments: { backend: "android-device", deviceId } },
                { name: "device_detach", arguments: { backend: "android-device", deviceId } },
            ]) {
                const result = await client.callTool(request);
                expect(result.isError).toBe(true);
                expect((result.content as Array<{ text?: string }>)[0]?.text).toContain("lease is not owned by this attachment");
            }

            expect(readFileSync(logPath, "utf-8")).not.toContain(`adb -s ${serial}`);
        } finally {
            if (ownedLease) {
                writeFileSync(leasePath, ownedLease);
                const detach = await client.callTool({
                    name: "device_detach",
                    arguments: { backend: "android-device", deviceId },
                });
                expect(detach.isError).not.toBe(true);
            }
        }
    });

    it("honors explicit Android backend hints when emulator and real-device ids collide", { timeout: TIMEOUT }, async () => {
        const sharedId = "android-shared-target";
        const createEmulator = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Shared Target Emulator",
                deviceId: sharedId,
                avdName: "ccc-shared-target",
                port: 5590,
            },
        });
        expect(createEmulator.isError).not.toBe(true);

        const attachReal = await client.callTool({
            name: "device_attach",
            arguments: {
                backend: "android-device",
                name: "Shared Target Real",
                deviceId: sharedId,
                serial: "R5CREAL123",
            },
        });
        expect(attachReal.isError).not.toBe(true);

        writeFileSync(logPath, "");
        const realHome = await client.callTool({
            name: "mobile_home",
            arguments: { backend: "android-device", deviceId: sharedId },
        });
        expect(realHome.isError).not.toBe(true);
        let log = readFileSync(logPath, "utf-8");
        expect(log).toContain("adb -s R5CREAL123 shell input keyevent 3");
        expect(log).not.toContain("adb -s emulator-5590 shell input keyevent 3");

        writeFileSync(logPath, "");
        const emulatorHome = await client.callTool({
            name: "mobile_home",
            arguments: { backend: "android-emulator", deviceId: sharedId },
        });
        expect(emulatorHome.isError).not.toBe(true);
        log = readFileSync(logPath, "utf-8");
        expect(log).toContain("adb -s emulator-5590 shell input keyevent 3");
        expect(log).not.toContain("adb -s R5CREAL123 shell input keyevent 3");

        const realStatus = await client.callTool({
            name: "device_status",
            arguments: { backend: "android-device", deviceId: sharedId },
        });
        expect(realStatus.isError).not.toBe(true);
        const realStatusPayload = JSON.parse(((realStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            backend: { name: string };
            device: { backend: string; serial: string };
        };
        expect(realStatusPayload.backend.name).toBe("android-device");
        expect(realStatusPayload.device).toEqual(expect.objectContaining({ backend: "android-device", serial: "R5CREAL123" }));

        const detachReal = await client.callTool({ name: "device_detach", arguments: { deviceId: sharedId } });
        expect(detachReal.isError).not.toBe(true);

        writeFileSync(logPath, "");
        const mismatch = await client.callTool({
            name: "mobile_home",
            arguments: { backend: "android-device", deviceId: sharedId },
        });
        expect(mismatch.isError).not.toBe(true);
        const mismatchPayload = JSON.parse(((mismatch.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            error: string;
            requestedBackend: string;
            actualBackend: string;
        };
        expect(mismatchPayload).toEqual(expect.objectContaining({
            ok: false,
            error: "device-backend-mismatch",
            requestedBackend: "android-device",
            actualBackend: "android-emulator",
        }));
        expect(readFileSync(logPath, "utf-8")).toBe("");

        const deleteEmulator = await client.callTool({
            name: "device_delete",
            arguments: { backend: "android-emulator", deviceId: sharedId, confirmDestructive: true },
        });
        expect(deleteEmulator.isError).not.toBe(true);
    });

    it("preserves a same-id physical attachment successor during stop and detach", { timeout: TIMEOUT }, async () => {
        const deviceId = "android-real-state-generation";
        const attachedResult = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", deviceId, name: "Generation Real", serial: "R5CREAL123" },
        });
        expect(attachedResult.isError).not.toBe(true);
        const attached = parseToolJson(attachedResult).device as Record<string, unknown>;
        const statePath = join(homeDir, ".ccc", "devices", "owners", String(attached.ownerId), "android-device", "devices.json");
        const leasePath = join(homeDir, ".ccc", "devices", "physical-leases", "android-device", "locks", `${encodeURIComponent(String(attached.serial))}.json`);
        const armConflict = (marker: string) => {
            const currentState = JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> };
            const current = currentState.devices.find((device) => device.id === deviceId);
            expect(current).toBeDefined();
            const active = {
                ...current,
                recording: { active: true, runtimeId: `recording-${marker}`, remotePath: `/sdcard/${marker}.mp4` },
            };
            writeFileSync(statePath, JSON.stringify({ devices: currentState.devices.map((device) => device.id === deviceId ? active : device) }, null, 2));
            const successor = { ...current, name: `Successor ${marker}`, successorMarker: marker, updatedAt: new Date().toISOString() };
            writeFileSync(join(homeDir, "fake-android-real-state-conflict.json"), JSON.stringify({ devices: currentState.devices.map((device) => device.id === deviceId ? successor : device) }, null, 2));
            writeFileSync(join(homeDir, "fake-android-real-state-conflict-path"), statePath);
            return successor;
        };

        const stopSuccessor = armConflict("stop");
        const stop = await client.callTool({ name: "device_stop", arguments: { backend: "android-device", deviceId } });
        expect(stop.isError).toBe(true);
        expect((stop.content as Array<{ text?: string }>)[0]?.text).toContain("owner-device-state-conflict");
        expect((JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> }).devices.find((device) => device.id === deviceId)).toEqual(stopSuccessor);

        const detachSuccessor = armConflict("detach");
        const detach = await client.callTool({ name: "device_detach", arguments: { backend: "android-device", deviceId } });
        expect(detach.isError).toBe(true);
        expect((detach.content as Array<{ text?: string }>)[0]?.text).toContain("owner-device-state-conflict");
        expect((JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> }).devices.find((device) => device.id === deviceId)).toEqual(detachSuccessor);
        expect(JSON.parse(readFileSync(leasePath, "utf-8"))).toEqual(expect.objectContaining({ deviceId, hardwareId: attached.serial }));

        const cleanup = await client.callTool({ name: "device_detach", arguments: { backend: "android-device", deviceId } });
        expect(cleanup.isError).not.toBe(true);
    });

    it("preserves active recording metadata and the physical lease when stop or detach cannot confirm recorder exit", { timeout: TIMEOUT }, async () => {
        const deviceId = "android-real-recorder-cleanup-retry";
        const attachedResult = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", deviceId, name: "Recorder Cleanup Retry", serial: "R5CREAL123" },
        });
        expect(attachedResult.isError).not.toBe(true);
        const attached = parseToolJson(attachedResult).device as Record<string, unknown>;
        const statePath = join(homeDir, ".ccc", "devices", "owners", String(attached.ownerId), "android-device", "devices.json");
        const leasePath = join(homeDir, ".ccc", "devices", "physical-leases", "android-device", "locks", `${encodeURIComponent("R5CREAL123")}.json`);
        const adbPath = join(binDir, "adb");
        const originalAdbPath = join(binDir, "adb-original");
        const failFallbackMarker = join(homeDir, "fake-adb-pkill-fail");
        const ignoreSignalMarker = join(homeDir, "fake-adb-screenrecord-ignore-sigint");

        renameSync(adbPath, originalAdbPath);
        writeFileSync(adbPath, `#!/bin/sh
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "pkill" ] && [ -f "$HOME/fake-adb-pkill-fail" ]; then
  echo "screenrecord pkill denied" >&2
  exit 17
fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "screenrecord" ] && [ -f "$HOME/fake-adb-screenrecord-ignore-sigint" ]; then
  trap '' INT
fi
exec "${originalAdbPath}" "$@"
`);
        chmodSync(adbPath, 0o755);

        let stubbornPid: number | undefined;
        try {
            const started = await client.callTool({
                name: "device_record_video_start",
                arguments: { backend: "android-device", deviceId, remotePath: "/sdcard/cleanup-failure.mp4" },
            });
            expect(started.isError).not.toBe(true);

            const state = JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> };
            const current = state.devices.find((device) => device.id === deviceId);
            const originalRecording = current?.recording as Record<string, unknown>;
            expect(originalRecording.active).toBe(true);
            const mismatchedRecording = {
                ...originalRecording,
                processIdentity: { ...(originalRecording.processIdentity as Record<string, unknown>), startToken: "mismatched" },
            };
            writeFileSync(statePath, JSON.stringify({
                devices: state.devices.map((device) => device.id === deviceId ? { ...device, recording: mismatchedRecording } : device),
            }, null, 2));
            writeFileSync(failFallbackMarker, "1");

            for (const tool of ["device_stop", "device_detach"]) {
                const failed = await client.callTool({ name: tool, arguments: { backend: "android-device", deviceId } });
                expect(failed.isError, tool).toBe(true);
                expect((failed.content as Array<{ text?: string }>)[0]?.text).toContain("preserved for retry");
                const preserved = (JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> }).devices.find((device) => device.id === deviceId);
                expect(preserved).toEqual(expect.objectContaining({ status: "attached", recording: mismatchedRecording }));
                expect(() => readFileSync(leasePath, "utf-8")).not.toThrow();
            }

            rmSync(failFallbackMarker, { force: true });
            const stateBeforeRetry = JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> };
            writeFileSync(statePath, JSON.stringify({
                devices: stateBeforeRetry.devices.map((device) => device.id === deviceId ? { ...device, recording: originalRecording } : device),
            }, null, 2));
            const finalized = await client.callTool({ name: "device_record_video_stop", arguments: { backend: "android-device", deviceId } });
            expect(finalized.isError).not.toBe(true);

            writeFileSync(ignoreSignalMarker, "1");
            const stubbornStart = await client.callTool({
                name: "device_record_video_start",
                arguments: { backend: "android-device", deviceId, remotePath: "/sdcard/stubborn-cleanup.mp4" },
            });
            expect(stubbornStart.isError).not.toBe(true);
            stubbornPid = Number((parseToolJson(stubbornStart).recording as Record<string, unknown>).pid);

            const remainsActive = await client.callTool({ name: "device_stop", arguments: { backend: "android-device", deviceId } });
            expect(remainsActive.isError).toBe(true);
            expect((remainsActive.content as Array<{ text?: string }>)[0]?.text).toContain("did not exit within 3000ms");
            const preservedActive = (JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> }).devices.find((device) => device.id === deviceId);
            expect(preservedActive).toEqual(expect.objectContaining({
                status: "attached",
                recording: expect.objectContaining({ active: true, pid: stubbornPid }),
            }));
            expect(() => readFileSync(leasePath, "utf-8")).not.toThrow();
        } finally {
            rmSync(failFallbackMarker, { force: true });
            rmSync(ignoreSignalMarker, { force: true });
            if (stubbornPid) {
                try { process.kill(stubbornPid, "SIGKILL"); } catch { /* recorder already exited */ }
            }
            rmSync(adbPath, { force: true });
            renameSync(originalAdbPath, adbPath);
            await new Promise((resolve) => setTimeout(resolve, 100));
            await client.callTool({ name: "device_detach", arguments: { backend: "android-device", deviceId } });
        }
    });

    it("formats IPv6 wireless endpoints and bounds physical-device install and launch results", { timeout: TIMEOUT }, async () => {
        const deviceId = "android-real-adb-result-validation";
        const adbPath = join(binDir, "adb");
        const delegatedAdbPath = join(binDir, "adb-before-real-result-validation");
        renameSync(adbPath, delegatedAdbPath);
        writeFileSync(adbPath, `#!/bin/sh
if [ "$1" = "connect" ] && [ "$2" = "[2001:db8::50]:5555" ]; then
  echo "adb $*" >> "$FAKE_ANDROID_LOG"
  echo "connected to $2"
  exit 0
fi
if [ "$1" = "pair" ] && [ "$2" = "[2001:db8::70]:37099" ] && [ "$3" = "123456" ]; then
  echo "adb $*" >> "$FAKE_ANDROID_LOG"
  echo "Successfully paired to $2"
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "install" ] && [ "$5" = "/tmp/slow-real-install.apk" ]; then
  /bin/sleep 1
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "monkey" ] && [ "$6" = "com.example.real.missing" ]; then
  echo "No activities found to run, monkey aborted."
  exit 0
fi
exec "${delegatedAdbPath}" "$@"
`);
        chmodSync(adbPath, 0o755);

        try {
            const ipv6 = await client.callTool({
                name: "device_wireless",
                arguments: { backend: "android-device", action: "connect", host: "2001:db8::50", port: 5555 },
            });
            expect(ipv6.isError).not.toBe(true);
            expect(parseToolJson(ipv6)).toEqual(expect.objectContaining({
                target: "[2001:db8::50]:5555",
                attachNext: expect.objectContaining({
                    arguments: expect.objectContaining({ host: "2001:db8::50", port: 5555 }),
                }),
            }));
            expect(readFileSync(logPath, "utf8")).toContain("adb connect [2001:db8::50]:5555");

            const ipv6Pair = await client.callTool({
                name: "device_wireless",
                arguments: {
                    backend: "android-device",
                    action: "pair",
                    pairHost: "2001:db8::70",
                    pairPort: 37099,
                    pairingCode: "123456",
                },
            });
            expect(ipv6Pair.isError).not.toBe(true);
            expect(parseToolJson(ipv6Pair)).toEqual(expect.objectContaining({ pairTarget: "[2001:db8::70]:37099" }));
            expect(readFileSync(logPath, "utf8")).toContain("adb pair [2001:db8::70]:37099 123456");

            const attached = await client.callTool({
                name: "device_attach",
                arguments: { backend: "android-device", deviceId, name: "ADB Result Validation", serial: "R5CREAL123" },
            });
            expect(attached.isError).not.toBe(true);

            const startedAt = Date.now();
            const timedOutInstall = await client.callTool({
                name: "mobile_install_app",
                arguments: { deviceId, path: "/tmp/slow-real-install.apk", helperTimeoutMs: 25 },
            });
            expect(timedOutInstall.isError).toBe(true);
            expect(Date.now() - startedAt).toBeLessThan(750);
            expect((timedOutInstall.content as Array<{ text?: string }>)[0]?.text).toMatch(/timed out|ETIMEDOUT/i);

            const launch = await client.callTool({
                name: "device_launch_app",
                arguments: { deviceId, packageName: "com.example.real.missing" },
            });
            expect(launch.isError).toBe(true);
            expect((launch.content as Array<{ text?: string }>)[0]?.text).toContain("No activities found");
        } finally {
            await client.callTool({ name: "device_detach", arguments: { backend: "android-device", deviceId } });
            rmSync(adbPath, { force: true });
            renameSync(delegatedAdbPath, adbPath);
        }
    });
});
