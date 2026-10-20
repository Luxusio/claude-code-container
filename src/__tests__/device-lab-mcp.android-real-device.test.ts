import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupFakeAndroidMcpContext, createFakeAndroidMcpContext, TIMEOUT, type FakeAndroidMcpContext } from "./helpers/fake-android-mcp-fixture.js";
import { repoRoot } from "./helpers/device-lab-mcp-fixture.js";
import { fakeAndroidGuestWriterPath, fakeAndroidRecordingArtifactPath } from "./helpers/fake-android-provider-script.js";
import { withSharedMutationLockAsync } from "@ccc/device-lab/providers/state/shared-mutation-lock.mjs";

function parseToolJson(result: { content?: unknown }) {
    return JSON.parse((((result.content as Array<{ text?: string }> | undefined) ?? [])[0]?.text ?? "{}")) as Record<string, unknown>;
}

describe("device-lab MCP Android real-device flows with fake SDK", () => {
    let context: FakeAndroidMcpContext;
    let client: FakeAndroidMcpContext["client"];
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    beforeEach(async () => {
        context = await createFakeAndroidMcpContext({ entrypoint: join(repoRoot, "dist/device-lab-mcp/server.mjs") });
        client = context.client;
        homeDir = context.homeDir;
        binDir = context.binDir;
        logPath = context.logPath;
    }, TIMEOUT);

    afterEach(async () => {
        await cleanupFakeAndroidMcpContext(context);
    }, TIMEOUT);

    async function startSettlementRecording(remotePath: string) {
        const deviceId = "android-real-emitted-settlement", serial = "R5CREAL123";
        const attached = await client.callTool({ name: "attach", arguments: { backend: "android-device", deviceId, name: "Emitted Recording Settlement", serial } });
        expect(attached.isError, JSON.stringify(attached.content)).not.toBe(true);
        const device = parseToolJson(attached).device as Record<string, unknown>;
        const statePath = join(homeDir, ".ccc", "devices", "owners", String(device.ownerId), "android-device", "devices.json");
        const leasePath = join(homeDir, ".ccc", "devices", "physical-leases", "android-device", "locks", `${encodeURIComponent(serial)}.json`);
        const localPath = join(homeDir, "settlement-video.mp4"); writeFileSync(localPath, "previous destination");
        const started = await client.callTool({ name: "record_video", arguments: { action: "start", deviceId, remotePath, localPath, timeLimitSec: 5 } });
        expect(started.isError, JSON.stringify(started.content)).not.toBe(true);
        const recording = parseToolJson(started).recording as Record<string, unknown>;
        const artifact = fakeAndroidRecordingArtifactPath(homeDir, serial, remotePath), writer = fakeAndroidGuestWriterPath(homeDir, serial);
        await expect.poll(() => existsSync(writer)).toBe(true); expect(readFileSync(artifact, "utf8")).toBe("downloaded");
        const readState = () => JSON.parse(readFileSync(statePath, "utf8")) as { devices: Array<Record<string, unknown>> };
        const readRecording = () => readState().devices.find(current => current.id === deviceId)?.recording;
        const replaceRecording = (next: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({
            devices: readState().devices.map(current => current.id === deviceId ? { ...current, recording: next } : current),
        }));
        const stop = () => client.callTool({ name: "record_video", arguments: { action: "stop", deviceId } });
        const assertLease = () => expect(JSON.parse(readFileSync(leasePath, "utf8"))).toMatchObject({ deviceId, hardwareId: serial });
        return { deviceId, recording, artifact, writer, localPath, readRecording, replaceRecording, stop, assertLease };
    }

    it("emitted physical recording stop retains unavailable identity, lease and failed fallback recovery bytes", { timeout: TIMEOUT }, async () => {
        const f = await startSettlementRecording("/sdcard/emitted-unavailable-real-recording.mp4");
        const unavailable = { ...f.recording }; delete unavailable.processIdentity;
        f.replaceRecording(unavailable); writeFileSync(join(homeDir, "fake-adb-pkill-fail"), "1");
        const failed = await f.stop();
        expect(failed.isError, JSON.stringify(failed.content)).toBe(true); expect(f.readRecording()).toEqual(unavailable); f.assertLease();
        expect(readFileSync(f.localPath, "utf8")).toBe("previous destination"); expect(readFileSync(f.artifact, "utf8")).toBe("downloaded"); expect(existsSync(f.writer)).toBe(true);
        f.replaceRecording(f.recording); rmSync(join(homeDir, "fake-adb-pkill-fail"));
        const recovered = await f.stop();
        expect(recovered.isError, JSON.stringify(recovered.content)).not.toBe(true); expect(parseToolJson(recovered)).toMatchObject({ stopped: true, provider: "adb-screenrecord" });
        expect(f.readRecording()).toBeNull(); f.assertLease(); expect(readFileSync(f.localPath, "utf8")).toBe("downloaded");
        expect(existsSync(f.artifact)).toBe(false); expect(existsSync(f.writer)).toBe(false);
    });

    it("emitted physical pending recording retry checks the selected guest and retains its lease", { timeout: TIMEOUT }, async () => {
        const f = await startSettlementRecording("/sdcard/fail-once-pull-emitted-real-recording.mp4");
        expect((await f.stop()).isError).toBe(true);
        const pending = f.readRecording(); expect(pending).toMatchObject({ active: false }); f.assertLease();
        expect(readFileSync(f.localPath, "utf8")).toBe("previous destination"); expect(readFileSync(f.artifact, "utf8")).toBe("downloaded");
        writeFileSync(f.writer, "unverified selected guest writer"); writeFileSync(join(homeDir, "fake-adb-guest-unavailable"), "1");
        const uncertainRetry = await f.stop();
        expect(uncertainRetry.isError, JSON.stringify(uncertainRetry.content)).toBe(true); expect(f.readRecording()).toEqual(pending); f.assertLease();
        expect(readFileSync(f.localPath, "utf8")).toBe("previous destination"); expect(readFileSync(f.artifact, "utf8")).toBe("downloaded"); expect(existsSync(f.writer)).toBe(true);
        rmSync(f.writer); rmSync(join(homeDir, "fake-adb-guest-unavailable"));
        const recovered = await f.stop();
        expect(recovered.isError, JSON.stringify(recovered.content)).not.toBe(true); expect(f.readRecording()).toBeNull(); f.assertLease();
        expect(readFileSync(f.localPath, "utf8")).toBe("downloaded"); expect(existsSync(f.artifact)).toBe(false);
    });

    it("emitted physical status cannot convert a mismatched recorder into permission to finalize a running guest", { timeout: TIMEOUT }, async () => {
        const f = await startSettlementRecording("/sdcard/emitted-mismatch-real-recording.mp4");
        const mismatched = { ...f.recording, processIdentity: { ...(f.recording.processIdentity as Record<string, unknown>), startToken: "successor-start" } };
        f.replaceRecording(mismatched);
        const status = await client.callTool({ name: "record_video", arguments: { action: "status", deviceId: f.deviceId } });
        expect(status.isError, JSON.stringify(status.content)).not.toBe(true); expect(parseToolJson(status).recording).toEqual(mismatched);
        const failed = await f.stop();
        expect(failed.isError, JSON.stringify(failed.content)).toBe(true); expect(f.readRecording()).toEqual(mismatched); f.assertLease();
        expect(readFileSync(f.localPath, "utf8")).toBe("previous destination"); expect(readFileSync(f.artifact, "utf8")).toBe("downloaded"); expect(existsSync(f.writer)).toBe(true);
        expect(readFileSync(logPath, "utf8")).not.toContain("shell pkill -2 screenrecord");
        f.replaceRecording(f.recording);
        const recovered = await f.stop();
        expect(recovered.isError, JSON.stringify(recovered.content)).not.toBe(true); expect(f.readRecording()).toBeNull(); f.assertLease();
        expect(readFileSync(f.localPath, "utf8")).toBe("downloaded"); expect(existsSync(f.artifact)).toBe(false);
    });

    it("emitted physical recording settlement revalidates its captured target without restarting SDK discovery", { timeout: TIMEOUT }, async () => {
        const f = await startSettlementRecording("/sdcard/emitted-captured-target-real-recording.mp4");
        writeFileSync(join(homeDir, "fake-recording-arm-guard-discovery"), "1");
        const stopped = await f.stop();
        expect(stopped.isError, JSON.stringify(stopped.content)).not.toBe(true);
        expect(parseToolJson(stopped)).toMatchObject({ stopped: true, provider: "adb-screenrecord" });
        expect(f.readRecording()).toBeNull(); f.assertLease(); expect(readFileSync(f.localPath, "utf8")).toBe("downloaded");
        expect(existsSync(f.artifact)).toBe(false); expect(existsSync(f.writer)).toBe(false);
        expect(existsSync(join(homeDir, "fake-recording-guard-discovery-armed"))).toBe(true);
        expect(readFileSync(logPath, "utf8")).not.toContain("recording-guard-discovery ");
    });

    it.each(["hardware", "aggregate"] as const)("emitted physical recording settlement bounds its contended %s lease lock by the remaining allowance", { timeout: TIMEOUT }, async scope => {
        const f = await startSettlementRecording("/sdcard/natural-exit-contended-lease-recording.mp4");
        writeFileSync(join(homeDir, "fake-adb-release-natural-recording"), "release");
        await expect.poll(f.readRecording, { timeout: 10000 }).toMatchObject({ active: false });
        const pending = f.readRecording();
        const root = join(homeDir, ".ccc", "devices", "physical-leases");
        const lockPath = scope === "hardware" ? join(root, "android-device", "locks", "R5CREAL123.mutation.lock") : join(root, "android-device.mutation.lock");
        const marker = (name: string) => join(homeDir, `fake-recording-guest-probe-${name}`);
        writeFileSync(marker("gate"), "1");
        let releaseLock: (() => void) | undefined, holder: Promise<unknown> | undefined;
        const stopRequest = f.stop();
        try {
            await expect.poll(() => existsSync(marker("ready")), { timeout: 5000 }).toBe(true);
            let entered!: () => void;
            const acquired = new Promise<void>(resolve => { entered = resolve; });
            const gate = new Promise<void>(resolve => { releaseLock = resolve; });
            holder = withSharedMutationLockAsync(lockPath, async () => { entered(); await gate; });
            await Promise.race([acquired, holder]);
            const ownedLock = readFileSync(lockPath, "utf8");
            writeFileSync(join(homeDir, "fake-stop-clock-offset"), "2000");
            const releasedAt = performance.now();
            writeFileSync(marker("release"), "release");
            const refused = await stopRequest;
            const elapsed = performance.now() - releasedAt;
            expect(refused.isError, JSON.stringify(refused.content)).toBe(true);
            expect(f.readRecording()).toEqual(pending); f.assertLease();
            expect(readFileSync(f.localPath, "utf8")).toBe("previous destination"); expect(readFileSync(f.artifact, "utf8")).toBe("downloaded");
            expect(readFileSync(lockPath, "utf8")).toBe(ownedLock);
            expect(readFileSync(logPath, "utf8")).not.toContain(" pull /sdcard/natural-exit-contended-lease-recording.mp4 ");
            expect(elapsed).toBeLessThan(2000);
        } finally {
            writeFileSync(marker("release"), "release");
            releaseLock?.();
            if (holder) await holder;
            await stopRequest;
            for (const name of ["gate", "ready", "release"]) rmSync(marker(name), { force: true });
            rmSync(join(homeDir, "fake-stop-clock-offset"), { force: true });
        }
        expect(existsSync(lockPath)).toBe(false);
        const recovered = await f.stop();
        expect(recovered.isError, JSON.stringify(recovered.content)).not.toBe(true);
        expect(f.readRecording()).toBeNull(); f.assertLease(); expect(readFileSync(f.localPath, "utf8")).toBe("downloaded"); expect(existsSync(f.artifact)).toBe(false);
    });

    it("reports missing explicit Android physical mobile targets instead of unknown tools", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "status",
            arguments: { deviceId: "missing-android-real-device" },
        });
        const payload = JSON.parse(((result.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            error: string;
            backend: string;
            deviceId: string;
        };

        expect(result.isError).toBe(true);
        expect(payload).toMatchObject({
            ok: false,
            error: "device-not-found",
            deviceId: "missing-android-real-device",
        });
    });

    it("attaches, uses, and detaches host-connected Android real devices without emulator lifecycle commands", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "devices",
            arguments: { view: "available", backend: "android-device" },
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
            name: "wireless",
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

        const listBeforeWirelessPrepare = await client.callTool({ name: "devices", arguments: {} });
        const listedBeforeWirelessPrepare = JSON.parse(((listBeforeWirelessPrepare.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ backend?: string }>;
        };
        expect(listedBeforeWirelessPrepare.devices.some((device) => device.backend === "android-device")).toBe(false);

        const usbTcpip = await client.callTool({
            name: "wireless",
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
            name: "wireless",
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
            name: "wireless",
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
        expect(pairMissingConnectTargetPayload.error).toContain("connect:true requires host");
        expect(pairMissingConnectTargetPayload).not.toHaveProperty("pair");

        const failedPair = await client.callTool({
            name: "wireless",
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

        const listAfterWirelessPrepare = await client.callTool({ name: "devices", arguments: {} });
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
            name: "attach",
            arguments: { backend: "android-device", name: "Already Leased", serial: "R5LEASED999" },
        });
        expect(rejectLeased.isError).toBe(true);
        expect((rejectLeased.content as Array<{ text?: string }>)[0].text).toContain("already attached or an attach is in progress");
        const rejectWifiLeased = await client.callTool({
            name: "attach",
            arguments: { backend: "android-device", name: "Already Leased WiFi", connection: "wifi", host: "192.168.1.52" },
        });
        expect(rejectWifiLeased.isError).toBe(true);
        expect((rejectWifiLeased.content as Array<{ text?: string }>)[0].text).toContain("already attached or an attach is in progress");

        const rejectEmulator = await client.callTool({
            name: "attach",
            arguments: { backend: "android-device", name: "Bad Emulator", serial: "emulator-5554" },
        });
        expect(rejectEmulator.isError).toBe(true);
        expect((rejectEmulator.content as Array<{ text?: string }>)[0].text).toContain("Refusing to attach emulator serial");

        const rejectUnauthorized = await client.callTool({
            name: "attach",
            arguments: { backend: "android-device", name: "Unauthorized", serial: "UNAUTHORIZED" },
        });
        expect(rejectUnauthorized.isError).toBe(true);
        expect((rejectUnauthorized.content as Array<{ text?: string }>)[0].text).toContain("adb state is unauthorized");

        const rejectWifiMissingHost = await client.callTool({
            name: "attach",
            arguments: { backend: "android-device", name: "WiFi Missing Host", connection: "wifi" },
        });
        expect(rejectWifiMissingHost.isError).toBe(true);
        expect((rejectWifiMissingHost.content as Array<{ text?: string }>)[0].text).toContain("Android Wi-Fi attach requires host");

        const rejectWifiConnect = await client.callTool({
            name: "attach",
            arguments: { backend: "android-device", name: "WiFi Bad", connection: "wifi", host: "192.168.1.51" },
        });
        expect(rejectWifiConnect.isError).toBe(true);
        expect((rejectWifiConnect.content as Array<{ text?: string }>)[0].text).toContain("failed to connect");
        expect(existsSync(join(androidLeaseDir, `${encodeURIComponent("192.168.1.51:5555")}.json`))).toBe(false);

        const attach = await client.callTool({
            name: "attach",
            arguments: { backend: "android-device", name: "Real Pixel", serial: "R5CREAL123" },
        });
        expect(attach.isError).not.toBe(true);
        const attached = JSON.parse(((attach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { deviceId: string; backend: string; serial: string; status: string; creatable: boolean; physical: boolean; targetStatus: { targetKind: string; leaseState: { state: string; hardwareId: string }; sessionState: { state: string } } };
        };
        expect(attached.device).toEqual(expect.objectContaining({
            deviceId: "android-device-real-pixel",
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
            name: "attach",
            arguments: { backend: "android-device", name: "WiFi Pixel", connection: "wifi", host: "192.168.1.50", port: 5555 },
        });
        expect(wifiAttach.isError).not.toBe(true);
        const wifiAttached = JSON.parse(((wifiAttach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { deviceId: string; serial: string; connection: string; transport: { type: string; host: string; port: number } };
        };
        expect(wifiAttached.device).toEqual(expect.objectContaining({
            deviceId: "android-device-wifi-pixel",
            serial: "192.168.1.50:5555",
            connection: "wifi",
            transport: expect.objectContaining({ type: "wifi", host: "192.168.1.50", port: 5555 }),
        }));
        const wifiSerialAttach = await client.callTool({
            name: "attach",
            arguments: { backend: "android-device", name: "WiFi Serial Pixel", serial: "192.168.1.60:5555" },
        });
        expect(wifiSerialAttach.isError).not.toBe(true);
        const wifiSerialAttached = JSON.parse(((wifiSerialAttach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { deviceId: string; serial: string; connection: string; transport: { type: string; host: string; port: number } };
        };
        expect(wifiSerialAttached.device).toEqual(expect.objectContaining({
            deviceId: "android-device-wifi-serial-pixel",
            serial: "192.168.1.60:5555",
            connection: "wifi",
            transport: expect.objectContaining({ type: "wifi", host: "192.168.1.60", port: 5555 }),
        }));

        const duplicate = await client.callTool({
            name: "attach",
            arguments: { backend: "android-device", name: "Real Pixel Duplicate", serial: "R5CREAL123" },
        });
        expect(duplicate.isError).toBe(true);
        expect((duplicate.content as Array<{ text?: string }>)[0].text).toContain("Android serial already attached");

        const status = await client.callTool({
            name: "status",
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
            ["exec", { deviceId: "android-device-real-pixel", command: "echo ok" }, { stdout: "ok\n", stderr: "", status: 0 }],
            ["click", { deviceId: "android-device-real-pixel", x: 10, y: 20 }, { provider: "adb", tapped: { x: 10, y: 20 } }],
            ["back", { deviceId: "android-device-real-pixel" }, { provider: "adb", key: 4 }],
            ["set_orientation", { deviceId: "android-device-real-pixel", orientation: "reverse-portrait" }, { provider: "adb", orientation: "reverse-portrait", rotation: "2", stdout: "ok\n", stderr: "", status: 0 }],
            ["ui", { deviceId: "android-device-real-pixel" }, { provider: "adb-uiautomator", source: expect.stringContaining("<hierarchy>"), remotePath: "/sdcard/window-android-device-real-pixel.xml" }],
            ["wait_for_text", { deviceId: "android-device-real-pixel", text: "Hello", timeoutMs: 5000, intervalMs: 50 }, { provider: "adb-uiautomator", text: "Hello", found: true }],
            ["install_app", { deviceId: "android-device-real-pixel", path: "/tmp/Real.apk" }, { provider: "adb", installed: "/tmp/Real.apk" }],
            ["launch_app", { deviceId: "android-device-real-pixel", appId: "com.example.real" }, { provider: "adb", launched: "com.example.real" }],
            ["screenshot", { deviceId: "android-device-real-pixel" }, { type: "image", data: expectedAndroidPng, mimeType: "image/png" }],
        ] as Array<[string, Record<string, unknown>, Record<string, unknown>]>) {
            const result = await client.callTool({ name: tool, arguments: args });
            expect(result.isError, `${tool}: ${JSON.stringify(result.content)}`).not.toBe(true);
            if (tool === "screenshot") {
                expect((result.content as Array<{ type: string; data: string; mimeType: string }>)[0]).toEqual(expectedPayload);
            } else {
                expect(parseToolJson(result)).toEqual(expect.objectContaining(expectedPayload));
            }
        }

        const flakyScreencapMarker = join(homeDir, "fake-screencap-exit-1");
        expect(readFileSync(logPath, "utf8")).toContain("adb -s R5CREAL123 shell settings put system accelerometer_rotation 0\n");
        expect(readFileSync(logPath, "utf8")).toContain("adb -s R5CREAL123 shell settings put system user_rotation 2\n");
        writeFileSync(flakyScreencapMarker, "1");
        try {
            const flakyScreenshot = await client.callTool({
                name: "screenshot",
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
            name: "upload",
            arguments: { deviceId: "android-device-real-pixel", localPath: realUploadPath, remotePath: "/sdcard/../escape.txt" },
        });
        expect(rejectedRemoteUpload.isError).toBe(true);
        expect((rejectedRemoteUpload.content as Array<{ text?: string }>)[0].text).toContain("upload-remote-path-traversal-rejected");
        const rejectedRemoteDownload = await client.callTool({
            name: "download",
            arguments: { deviceId: "android-device-real-pixel", remotePath: "relative.txt", localPath: join(homeDir, "real-download.txt") },
        });
        expect(rejectedRemoteDownload.isError).toBe(true);
        expect((rejectedRemoteDownload.content as Array<{ text?: string }>)[0].text).toContain("download-remote-path-not-absolute");
        expect(readFileSync(logPath, "utf-8")).toBe(logBeforeRejectedRemoteTransfer);

        const uploaded = await client.callTool({ name: "upload", arguments: { deviceId: "android-device-real-pixel", localPath: realUploadPath, remotePath: "/sdcard/real-upload.txt" } });
        expect(uploaded.isError, JSON.stringify(uploaded.content)).not.toBe(true);
        expect(parseToolJson(uploaded)).toMatchObject({ uploaded: { localPath: realUploadPath, remotePath: "/sdcard/real-upload.txt" }, provider: "adb" });
        const realDownloadPath = join(homeDir, "real-download.txt");
        const downloaded = await client.callTool({ name: "download", arguments: { deviceId: "android-device-real-pixel", remotePath: "/sdcard/real-download.txt", localPath: realDownloadPath } });
        expect(downloaded.isError, JSON.stringify(downloaded.content)).not.toBe(true);
        expect(parseToolJson(downloaded)).toMatchObject({ downloaded: { localPath: realDownloadPath, remotePath: "/sdcard/real-download.txt" }, provider: "adb" });
        expect(readFileSync(realDownloadPath, "utf8")).toBe("downloaded");
        writeFileSync(realDownloadPath, "retained physical download");
        const failedDownload = await client.callTool({ name: "download", arguments: { deviceId: "android-device-real-pixel", remotePath: "/sdcard/fail-pull.txt", localPath: realDownloadPath } });
        expect(failedDownload.isError).toBe(true);
        expect(readFileSync(realDownloadPath, "utf8")).toBe("retained physical download");
        const failedStage = readFileSync(logPath, "utf8").match(/adb -s R5CREAL123 pull \/sdcard\/fail-pull\.txt (.+)/)?.[1];
        if (!failedStage) throw new Error("Failed physical download did not reach its allocated ADB stage");
        expect(existsSync(dirname(failedStage))).toBe(false);

        const realRecordingPath = join(homeDir, "real-recording.mp4");
        writeFileSync(realRecordingPath, "original");
        const realRecordStart = await client.callTool({
            name: "record_video",
            arguments: { action: "start",
                deviceId: "android-device-real-pixel",
                remotePath: "/sdcard/fail-once-pull-real-recording.mp4",
                localPath: realRecordingPath,
                timeLimitSec: 5,
            },
        });
        expect(realRecordStart.isError).not.toBe(true);
        const failedRealRecordStop = await client.callTool({
            name: "record_video",
            arguments: { action: "stop", deviceId: "android-device-real-pixel" },
        });
        expect(failedRealRecordStop.isError).toBe(true);
        expect((failedRealRecordStop.content as Array<{ text?: string }>)[0].text).toContain("remains pending finalization");
        expect(readFileSync(realRecordingPath, "utf8")).toBe("original");
        const pendingRealRecording = await client.callTool({
            name: "record_video",
            arguments: { action: "status", deviceId: "android-device-real-pixel" },
        });
        expect(parseToolJson(pendingRealRecording).recording).toEqual(expect.objectContaining({
            active: false,
            remotePath: "/sdcard/fail-once-pull-real-recording.mp4",
        }));
        const retriedRealRecordStop = await client.callTool({
            name: "record_video",
            arguments: { action: "stop", deviceId: "android-device-real-pixel" },
        });
        expect(retriedRealRecordStop.isError).not.toBe(true);
        expect(readFileSync(realRecordingPath, "utf8")).toBe("downloaded");

        const unsafeBattery = await client.callTool({
            name: "set_battery",
            arguments: { deviceId: "android-device-real-pixel", level: 10, confirmDestructive: true },
        });
        expect(unsafeBattery.isError).toBe(true);
        expect((unsafeBattery.content as Array<{ text?: string }>)[0].text).toContain("Android real devices do not support mobile_set_battery safely");
        const unsafeLocation = await client.callTool({
            name: "set_location",
            arguments: { deviceId: "android-device-real-pixel", latitude: 37.7749, longitude: -122.4194 },
        });
        expect(unsafeLocation.isError).toBe(true);
        expect((unsafeLocation.content as Array<{ text?: string }>)[0].text).toContain("Android real devices do not support mobile_set_location safely");

        const stop = await client.callTool({
            name: "stop",
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
            name: "detach",
            arguments: { deviceId: "android-device-real-pixel" },
        });
        expect(detach.isError).not.toBe(true);
        expect(() => readFileSync(join(androidLeaseDir, `${encodeURIComponent("R5CREAL123")}.json`), "utf-8")).toThrow();
        const wifiDetach = await client.callTool({
            name: "detach",
            arguments: { deviceId: "android-device-wifi-pixel" },
        });
        expect(wifiDetach.isError).not.toBe(true);
        expect(() => readFileSync(join(androidLeaseDir, `${encodeURIComponent("192.168.1.50:5555")}.json`), "utf-8")).toThrow();
        const wifiSerialDetach = await client.callTool({
            name: "detach",
            arguments: { deviceId: "android-device-wifi-serial-pixel" },
        });
        expect(wifiSerialDetach.isError).not.toBe(true);
        expect(() => readFileSync(join(androidLeaseDir, `${encodeURIComponent("192.168.1.60:5555")}.json`), "utf-8")).toThrow();

        const list = await client.callTool({ name: "devices", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ deviceId: string }>;
        };
        expect(listed.devices.some((device) => device.deviceId === "android-device-real-pixel")).toBe(false);

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
                name: "attach",
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
            const uploadPath = join(homeDir, "lease-fenced-upload.txt");
            writeFileSync(uploadPath, "owned transfer input");

            for (const request of [
                { name: "status", arguments: { deviceId } },
                { name: "exec", arguments: { deviceId, command: "echo fenced" } },
                { name: "screenshot", arguments: { deviceId } },
                { name: "ui", arguments: { deviceId } },
                { name: "wait_for_text", arguments: { deviceId, text: "Hello", timeoutMs: 100, implicitBroker: false } },
                { name: "wait_for_app", arguments: { deviceId, appId: "com.example.Real", timeoutMs: 100, implicitBroker: false } },
                { name: "click", arguments: { deviceId, x: 1, y: 2 } },
                { name: "set_orientation", arguments: { deviceId, orientation: "portrait" } },
                { name: "upload", arguments: { deviceId, localPath: uploadPath, remotePath: "/sdcard/fenced.txt" } },
                { name: "download", arguments: { deviceId, remotePath: "/sdcard/fenced.txt", localPath: join(homeDir, "lease-fenced-download.txt") } },
                { name: "start", arguments: { deviceId } },
                { name: "detach", arguments: { deviceId } },
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
                    name: "detach",
                    arguments: { deviceId },
                });
                expect(detach.isError).not.toBe(true);
            }
        }
    });

    it("rejects ambiguous device IDs without provider effects or changing either owned record", { timeout: TIMEOUT }, async () => {
        const sharedId = "android-shared-target";
        const createEmulator = await client.callTool({
            name: "create_android_emulator",
            arguments: {

                name: "Shared Target Emulator",
                deviceId: sharedId,
                avdName: "ccc-shared-target",
                port: 5590,
            },
        });
        expect(createEmulator.isError).not.toBe(true);

        const attachReal = await client.callTool({
            name: "attach",
            arguments: {
                backend: "android-device",
                name: "Shared Target Real",
                deviceId: sharedId,
                serial: "R5CREAL123",
            },
        });
        expect(attachReal.isError).not.toBe(true);


        const attached = parseToolJson(attachReal).device as Record<string, unknown>;
        const ownerRoot = join(homeDir, ".ccc/devices/owners", String(attached.ownerId));
        const emulatorFile = join(ownerRoot, "android", "devices.json");
        const physicalFile = join(ownerRoot, "android-device", "devices.json");
        const emulatorBefore = readFileSync(emulatorFile, "utf8");
        const physicalBefore = readFileSync(physicalFile, "utf8");
        try {
            for (const name of ["home", "status", "stop", "detach"] ) {
                writeFileSync(logPath, "");
                const result = await client.callTool({ name, arguments: { deviceId: sharedId } });
                expect(result.isError, JSON.stringify(result)).toBe(true);
                expect(parseToolJson(result)).toMatchObject({ ok: false, error: "ambiguous-device-backend" });
                expect(readFileSync(logPath, "utf8")).toBe("");
                expect(readFileSync(emulatorFile, "utf8")).toBe(emulatorBefore);
                expect(readFileSync(physicalFile, "utf8")).toBe(physicalBefore);
            }
        } finally {
            // Remove the test collision temporarily so each public cleanup call has one owned ID.
            renameSync(emulatorFile, emulatorFile + ".collision");
            try {
                expect((await client.callTool({ name: "detach", arguments: { deviceId: sharedId } })).isError).not.toBe(true);
            } finally { renameSync(emulatorFile + ".collision", emulatorFile); }
            expect((await client.callTool({ name: "delete", arguments: { deviceId: sharedId, confirmDestructive: true } })).isError).not.toBe(true);
        }

    });

    it("preserves a same-id physical attachment successor during stop and detach", { timeout: TIMEOUT }, async () => {
        const deviceId = "android-real-state-generation";
        const attachedResult = await client.callTool({
            name: "attach",
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
        const stop = await client.callTool({ name: "stop", arguments: { deviceId } });
        expect(stop.isError).toBe(true);
        expect((stop.content as Array<{ text?: string }>)[0]?.text).toContain("owner-device-state-conflict");
        expect((JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> }).devices.find((device) => device.id === deviceId)).toEqual(stopSuccessor);

        const detachSuccessor = armConflict("detach");
        const detach = await client.callTool({ name: "detach", arguments: { deviceId } });
        expect(detach.isError).toBe(true);
        expect((detach.content as Array<{ text?: string }>)[0]?.text).toContain("owner-device-state-conflict");
        expect((JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> }).devices.find((device) => device.id === deviceId)).toEqual(detachSuccessor);
        expect(JSON.parse(readFileSync(leasePath, "utf-8"))).toEqual(expect.objectContaining({ deviceId, hardwareId: attached.serial }));

        const cleanup = await client.callTool({ name: "detach", arguments: { deviceId } });
        expect(cleanup.isError).not.toBe(true);
    });

    async function verifyRecorderCleanup(mode: "identity" | "signal") {
        const deviceId = "android-real-recorder-cleanup-retry";
        const attachedResult = await client.callTool({
            name: "attach",
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
        writeFileSync(adbPath, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
if (args[0] === '-s' && args[2] === 'shell' && args[3] === 'pkill' && fs.existsSync(path.join(process.env.HOME, 'fake-adb-pkill-fail'))) { console.error('screenrecord pkill denied'); process.exit(17); }
if (args[0] === '-s' && args[2] === 'shell' && args[3] === 'screenrecord' && fs.existsSync(path.join(process.env.HOME, 'fake-adb-screenrecord-ignore-sigint'))) process.on('SIGINT', () => {});
require(${JSON.stringify(originalAdbPath)});
`);
        chmodSync(adbPath, 0o755);

        let stubbornPid: number | undefined;
        try {
          if (mode === "identity") {
            const started = await client.callTool({
                name: "record_video",
                arguments: { action: "start", deviceId, remotePath: "/sdcard/cleanup-failure.mp4" },
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

            for (const tool of ["stop", "detach"]) {
                const failed = await client.callTool({ name: tool, arguments: { deviceId } });
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
            const finalized = await client.callTool({ name: "record_video", arguments: { action: "stop", deviceId } });
            expect(finalized.isError).not.toBe(true);

          } else {
            writeFileSync(ignoreSignalMarker, "1");
            const stubbornStart = await client.callTool({
                name: "record_video",
                arguments: { action: "start", deviceId, remotePath: "/sdcard/stubborn-cleanup.mp4" },
            });
            expect(stubbornStart.isError).not.toBe(true);
            stubbornPid = Number((parseToolJson(stubbornStart).recording as Record<string, unknown>).pid);

            const remainsActive = await client.callTool({ name: "stop", arguments: { deviceId } });
            expect(remainsActive.isError).toBe(true);
            expect((remainsActive.content as Array<{ text?: string }>)[0]?.text).toContain("did not exit within 3000ms");
            const preservedActive = (JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> }).devices.find((device) => device.id === deviceId);
            expect(preservedActive).toEqual(expect.objectContaining({
                status: "attached",
                recording: expect.objectContaining({ active: true, pid: stubbornPid }),
            }));
            expect(() => readFileSync(leasePath, "utf-8")).not.toThrow();
          }
        } finally {
            rmSync(failFallbackMarker, { force: true });
            rmSync(ignoreSignalMarker, { force: true });
            if (stubbornPid) {
                try { process.kill(stubbornPid, "SIGKILL"); } catch { /* recorder already exited */ }
            }
            rmSync(adbPath, { force: true });
            renameSync(originalAdbPath, adbPath);
            await new Promise((resolve) => setTimeout(resolve, 100));
            await client.callTool({ name: "detach", arguments: { deviceId } });
        }
    }

    it("preserves recording metadata and physical lease when identity verification and fallback fail", { timeout: TIMEOUT }, () => verifyRecorderCleanup("identity"));
    // Windows does not support a child ignoring process.kill(SIGINT); retain this real signal test on POSIX.
    it.skipIf(process.platform === "win32")("preserves recording metadata and physical lease while a recorder ignores SIGINT", { timeout: TIMEOUT }, () => verifyRecorderCleanup("signal"));

    it("formats IPv6 wireless endpoints and bounds physical-device install and launch results", { timeout: TIMEOUT }, async () => {
        const deviceId = "android-real-adb-result-validation";
        const adbPath = join(binDir, "adb");
        const delegatedAdbPath = join(binDir, "adb-before-real-result-validation");
        renameSync(adbPath, delegatedAdbPath);
        writeFileSync(adbPath, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
if (args[0] === 'connect' && args[1] === '[2001:db8::50]:5555') { fs.appendFileSync(process.env.FAKE_ANDROID_LOG, 'adb ' + args.join(' ') + '\\n'); console.log('connected to ' + args[1]); }
else if (args[0] === 'pair' && args[1] === '[2001:db8::70]:37099' && args[2] === '123456') { fs.appendFileSync(process.env.FAKE_ANDROID_LOG, 'adb ' + args.join(' ') + '\\n'); console.log('Successfully paired to ' + args[1]); }
else if (args[0] === '-s' && args[2] === 'install' && args[4] === '/tmp/slow-real-install.apk') setTimeout(() => {}, 1000);
else if (args[0] === '-s' && args[2] === 'shell' && args[3] === 'monkey' && args[5] === 'com.example.real.missing') console.log('No activities found to run, monkey aborted.');
else require(${JSON.stringify(delegatedAdbPath)});
`);
        chmodSync(adbPath, 0o755);

        try {
            const ipv6 = await client.callTool({
                name: "wireless",
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
                name: "wireless",
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
                name: "attach",
                arguments: { backend: "android-device", deviceId, name: "ADB Result Validation", serial: "R5CREAL123" },
            });
            expect(attached.isError).not.toBe(true);

            const startedAt = Date.now();
            const timedOutInstall = await client.callTool({
                name: "install_app",
                arguments: { deviceId, path: "/tmp/slow-real-install.apk", timeoutMs: 25 },
            });
            expect(timedOutInstall.isError).toBe(true);
            expect(Date.now() - startedAt).toBeLessThan(750);
            expect((timedOutInstall.content as Array<{ text?: string }>)[0]?.text).toMatch(/timed out|ETIMEDOUT/i);

            const launch = await client.callTool({
                name: "launch_app",
                arguments: { deviceId, appId: "com.example.real.missing" },
            });
            expect(launch.isError).toBe(true);
            expect((launch.content as Array<{ text?: string }>)[0]?.text).toContain("No activities found");
        } finally {
            await client.callTool({ name: "detach", arguments: { deviceId } });
            rmSync(adbPath, { force: true });
            renameSync(delegatedAdbPath, adbPath);
        }
    });
});
