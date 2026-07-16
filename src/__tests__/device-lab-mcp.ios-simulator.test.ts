import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { dirname, join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchIosAppiumJson, IOS_APPIUM_HTTP_MAX_TIMEOUT_MS, IOS_APPIUM_RESPONSE_LIMIT_BYTES, normalizeIosAppiumHttpTimeoutMs } from "../../device-lab-mcp/src/backends/ios-simulator.mjs";
import { cleanupFakeIosMcpContext, createFakeIosMcpContext, TIMEOUT, type FakeIosMcpContext } from "./helpers/fake-ios-mcp-fixture.js";

function parseToolJson(result: { content?: unknown }) {
    return JSON.parse((((result.content as Array<{ text?: string }> | undefined) ?? [])[0]?.text ?? "{}")) as Record<string, unknown>;
}

describe("direct iOS Appium HTTP transport", () => {
    it("caps direct Appium HTTP deadlines", () => {
        expect(normalizeIosAppiumHttpTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(IOS_APPIUM_HTTP_MAX_TIMEOUT_MS);
        expect(normalizeIosAppiumHttpTimeoutMs(-1)).toBe(5000);
        expect(normalizeIosAppiumHttpTimeoutMs("invalid")).toBe(5000);
    });

    it("bounds an accepted request whose server never responds", async () => {
        const server = createServer(() => {});
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        try {
            await expect(fetchIosAppiumJson(`http://127.0.0.1:${port}/status`, {
                method: "GET",
                timeoutMs: 25,
            })).rejects.toThrow("Appium request timed out after 25ms");
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("does not follow Appium redirects", async () => {
        let redirectTargetRequests = 0;
        const redirectTarget = createServer((_req, res) => {
            redirectTargetRequests += 1;
            res.end(JSON.stringify({ value: { ready: true } }));
        });
        await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
        const redirectTargetPort = (redirectTarget.address() as AddressInfo).port;
        const redirectSource = createServer((_req, res) => {
            res.writeHead(302, { location: `http://127.0.0.1:${redirectTargetPort}/status` });
            res.end();
        });
        await new Promise<void>((resolve) => redirectSource.listen(0, "127.0.0.1", resolve));
        const port = (redirectSource.address() as AddressInfo).port;
        try {
            await expect(fetchIosAppiumJson(`http://127.0.0.1:${port}/status`)).rejects.toThrow("Appium redirect disallowed (HTTP 302)");
            expect(redirectTargetRequests).toBe(0);
        } finally {
            await new Promise<void>((resolve) => redirectSource.close(() => resolve()));
            await new Promise<void>((resolve) => redirectTarget.close(() => resolve()));
        }
    });

    it("rejects an oversized declared Appium response before accumulation", async () => {
        const server = createServer((_req, res) => {
            res.writeHead(200, {
                "content-type": "application/json",
                "content-length": String(IOS_APPIUM_RESPONSE_LIMIT_BYTES + 1),
            });
            res.end("{}");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        try {
            await expect(fetchIosAppiumJson(`http://127.0.0.1:${port}/status`)).rejects.toThrow(`Appium response exceeded ${IOS_APPIUM_RESPONSE_LIMIT_BYTES} bytes`);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("bounds a chunked Appium response without Content-Length", async () => {
        const chunk = Buffer.alloc(1024 * 1024, 0x61);
        const server = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
            for (let sent = 0; sent <= IOS_APPIUM_RESPONSE_LIMIT_BYTES; sent += chunk.length) res.write(chunk);
            res.end();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        try {
            await expect(fetchIosAppiumJson(`http://127.0.0.1:${port}/status`)).rejects.toThrow(`Appium response exceeded ${IOS_APPIUM_RESPONSE_LIMIT_BYTES} bytes`);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("keeps malformed success and HTTP failure diagnostics within 32 KiB", async () => {
        const malformed = "가".repeat(20000);
        const server = createServer((req, res) => {
            res.writeHead(req.url === "/failure" ? 500 : 200, { "content-type": "application/json" });
            res.end(malformed);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        try {
            const result = await fetchIosAppiumJson(`http://127.0.0.1:${port}/success`);
            expect(Buffer.byteLength(String(result.raw || ""), "utf8")).toBeLessThanOrEqual(32 * 1024);
            let failure: unknown;
            try {
                await fetchIosAppiumJson(`http://127.0.0.1:${port}/failure`);
            } catch (error) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(Error);
            expect(Buffer.byteLength((failure as Error).message, "utf8")).toBeLessThanOrEqual(32 * 1024);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});

describe("device-lab MCP iOS simulator lifecycle with fake simctl", () => {
    let context: FakeIosMcpContext;
    let client: FakeIosMcpContext["client"];
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    function iosStatePath() {
        const ownersRoot = join(homeDir, ".ccc", "devices", "owners");
        return join(ownersRoot, readdirSync(ownersRoot)[0], "ios", "devices.json");
    }

    function armStateReplacement(statePath: string, successor: Record<string, unknown>, command = "bootstatus") {
        writeFileSync(join(homeDir, "fake-ios-replace-state-target"), statePath);
        writeFileSync(join(homeDir, "fake-ios-replace-state-source"), `${JSON.stringify({ devices: [successor] }, null, 2)}\n`);
        writeFileSync(join(homeDir, "fake-ios-replace-state-command"), command);
    }

    function disarmStateReplacement() {
        for (const name of ["target", "source", "command", "done"]) {
            rmSync(join(homeDir, `fake-ios-replace-state-${name}`), { force: true });
        }
    }

    beforeAll(async () => {
        context = await createFakeIosMcpContext();
        client = context.client;
        homeDir = context.homeDir;
        binDir = context.binDir;
        logPath = context.logPath;
    }, TIMEOUT);

    afterAll(async () => {
        await cleanupFakeIosMcpContext(context);
    }, TIMEOUT);

    it("reports iOS simctl inventory without booting simulators", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "ios-simulator" },
        });
        expect(inventory.isError).not.toBe(true);
        const payload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            hostSimulators: {
                available: boolean;
                devices: Record<string, Array<{ name: string; udid: string; state: string }>>;
                runtimes: Array<{ identifier: string }>;
                deviceTypes: Array<{ identifier: string }>;
            };
            devices: Array<{ id: string }>;
            discovery: { available: boolean; xcrun: string };
        };
        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.discovery).toEqual({ available: true, missing: [], xcrun: join(binDir, "xcrun") });
        expect(payload.hostSimulators.available).toBe(true);
        expect(payload.hostSimulators.runtimes[0].identifier).toBe("com.apple.CoreSimulator.SimRuntime.iOS-17-0");
        expect(payload.hostSimulators.deviceTypes[0].identifier).toBe("com.apple.CoreSimulator.SimDeviceType.iPhone-15");
        expect(payload.devices).toEqual([]);

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("xcrun simctl list -j");
        expect(log).not.toContain("xcrun simctl boot ");
        expect(log).not.toContain("xcrun simctl create ");
    });


    it("creates, boots, stops, and deletes owner-prefixed iOS simulators only when explicit", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "ios-simulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const simulatorName = `ccc-${ownerId}-iphone-owned`;
        const ownedDeviceId = `ios-iphone-owned-${Date.now()}`;

        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "iPhone Owned",
                deviceId: ownedDeviceId,
                simulatorName,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        });
        expect(create.isError).not.toBe(true);
        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; simulatorName: string; udid: string; provisioning: string; status: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: ownedDeviceId,
            simulatorName,
            udid: "CREATED-IOS-UDID",
            provisioning: "created",
            status: "stopped",
        }));

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: ownedDeviceId, bootTimeoutMs: 1000 },
        });
        expect(start.isError).not.toBe(true);
        const started = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; bootReady: boolean };
            boot: { ready: boolean };
        };
        expect(started.boot.ready).toBe(true);
        expect(started.device.status).toBe("booted");
        expect(started.device.bootReady).toBe(true);

        const openUrl = await client.callTool({
            name: "mobile_open_url",
            arguments: { deviceId: ownedDeviceId, url: "https://example.test/ios" },
        });
        expect(openUrl.isError).not.toBe(true);
        const openUrlPayload = JSON.parse(((openUrl.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            openedUrl: string;
            provider: string;
        };
        expect(openUrlPayload).toEqual(expect.objectContaining({
            openedUrl: "https://example.test/ios",
            provider: "simctl",
        }));

        const installApp = await client.callTool({
            name: "mobile_install_app",
            arguments: { deviceId: ownedDeviceId, path: "/tmp/Test.app" },
        });
        expect(installApp.isError).not.toBe(true);
        expect(parseToolJson(installApp)).toEqual(expect.objectContaining({
            installed: "/tmp/Test.app",
            stdout: "",
            stderr: "",
        }));

        const launchApp = await client.callTool({
            name: "mobile_launch_app",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Test" },
        });
        expect(launchApp.isError).not.toBe(true);
        expect(parseToolJson(launchApp)).toEqual(expect.objectContaining({
            launched: "com.example.Test",
            stdout: "com.example.Test: 123\n",
            stderr: "",
        }));

        const commonInstall = await client.callTool({
            name: "device_install_app",
            arguments: { deviceId: ownedDeviceId, path: "/tmp/Common.app" },
        });
        expect(commonInstall.isError).not.toBe(true);
        expect(parseToolJson(commonInstall)).toEqual(expect.objectContaining({
            installed: "/tmp/Common.app",
            stdout: "",
            stderr: "",
        }));

        const commonLaunch = await client.callTool({
            name: "device_launch_app",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Common" },
        });
        expect(commonLaunch.isError).not.toBe(true);
        expect(parseToolJson(commonLaunch)).toEqual(expect.objectContaining({
            launched: "com.example.Common",
            stdout: "com.example.Common: 123\n",
            stderr: "",
        }));

        const stopApp = await client.callTool({
            name: "mobile_stop_app",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Test" },
        });
        expect(stopApp.isError).not.toBe(true);
        expect(JSON.parse(((stopApp.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            stopped: "com.example.Test",
            provider: "simctl",
        }));

        const iosContainerRoot = join(homeDir, "ios-app-container");
        mkdirSync(iosContainerRoot, { recursive: true });
        const clearAppData = await client.callTool({
            name: "mobile_clear_app_data",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Test", confirmDestructive: true },
        });
        expect(clearAppData.isError, (clearAppData.content as Array<{ text?: string }>)[0]?.text ?? "").not.toBe(true);
        expect(JSON.parse(((clearAppData.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            reset: { bundleId: "com.example.Test", containerType: "data" },
            provider: "simctl-app-container",
        }));

        const uninstallApp = await client.callTool({
            name: "mobile_uninstall_app",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Test", confirmDestructive: true },
        });
        expect(uninstallApp.isError).not.toBe(true);
        expect(JSON.parse(((uninstallApp.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            uninstalled: "com.example.Test",
            provider: "simctl",
        }));

        const advancedIosCalls: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
            ["mobile_grant_permission", { deviceId: ownedDeviceId, bundleId: "com.example.Test", service: "camera" }, { provider: "simctl", permission: { bundleId: "com.example.Test", service: "camera", action: "grant" } }],
            ["mobile_revoke_permission", { deviceId: ownedDeviceId, bundleId: "com.example.Test", service: "camera" }, { provider: "simctl", permission: { bundleId: "com.example.Test", service: "camera", action: "revoke" } }],
            ["mobile_set_location", { deviceId: ownedDeviceId, latitude: 37.7749, longitude: -122.4194 }, { provider: "simctl", location: { latitude: 37.7749, longitude: -122.4194 } }],
            ["mobile_set_clipboard", { deviceId: ownedDeviceId, text: "ios clip" }, { provider: "simctl", clipboard: { set: true } }],
            ["mobile_get_clipboard", { deviceId: ownedDeviceId }, { provider: "simctl", text: "", status: 0 }],
            ["mobile_wait_for_app", { deviceId: ownedDeviceId, bundleId: "com.example.Test", timeoutMs: 1000, intervalMs: 50 }, { provider: "simctl", bundleId: "com.example.Test", running: true }],
        ] as const;
        for (const [name, callArgs, expectedPayload] of advancedIosCalls) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError).not.toBe(true);
            expect(parseToolJson(action)).toEqual(expect.objectContaining(expectedPayload));
        }

        const localUploadPath = join(homeDir, "ios-upload.txt");
        const localDownloadPath = join(homeDir, "ios-download.txt");
        writeFileSync(localUploadPath, "ios upload content");
        const upload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: ownedDeviceId, localPath: localUploadPath, remotePath: "/Documents/uploaded.txt", bundleId: "com.example.Test" },
        });
        expect(upload.isError, (upload.content as Array<{ text?: string }>)[0].text).not.toBe(true);
        const uploadPayload = JSON.parse(((upload.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            uploaded: { remotePath: string; bundleId: string; containerType: string };
            containerRoot: string;
        };
        expect(uploadPayload.uploaded).toEqual(expect.objectContaining({
            remotePath: "Documents/uploaded.txt",
            bundleId: "com.example.Test",
            containerType: "data",
        }));
        expect(uploadPayload.containerRoot).toBe(iosContainerRoot);
        expect(readFileSync(join(iosContainerRoot, "Documents/uploaded.txt"), "utf-8")).toBe("ios upload content");

        const download = await client.callTool({
            name: "device_download",
            arguments: { deviceId: ownedDeviceId, remotePath: "Documents/uploaded.txt", localPath: localDownloadPath, bundleId: "com.example.Test" },
        });
        expect(download.isError).not.toBe(true);
        expect(parseToolJson(download)).toEqual(expect.objectContaining({
            downloaded: { remotePath: "Documents/uploaded.txt", localPath: localDownloadPath, bundleId: "com.example.Test", containerType: "data" },
            containerRoot: iosContainerRoot,
            provider: "simctl-app-container",
        }));
        expect(readFileSync(localDownloadPath, "utf-8")).toBe("ios upload content");

        const missingBundleUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: ownedDeviceId, localPath: localUploadPath, remotePath: "Documents/missing.txt" },
        });
        expect(missingBundleUpload.isError).toBe(true);
        expect((missingBundleUpload.content as Array<{ text?: string }>)[0].text).toContain("upload requires bundleId");

        const missingLocalUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: ownedDeviceId, localPath: join(homeDir, "missing-upload.txt"), remotePath: "Documents/missing.txt", bundleId: "com.example.Test" },
        });
        expect(missingLocalUpload.isError).toBe(true);
        expect((missingLocalUpload.content as Array<{ text?: string }>)[0].text).toContain("upload-local-path-does-not-exist");

        const escapingUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: ownedDeviceId, localPath: localUploadPath, remotePath: "../escape.txt", bundleId: "com.example.Test" },
        });
        expect(escapingUpload.isError).toBe(true);
        expect((escapingUpload.content as Array<{ text?: string }>)[0].text).toContain("Refusing path outside iOS app container");

        const outsideContainerDir = join(homeDir, "outside-ios-container");
        mkdirSync(outsideContainerDir, { recursive: true });
        writeFileSync(join(outsideContainerDir, "outside.txt"), "outside");
        symlinkSync(outsideContainerDir, join(iosContainerRoot, "Links"));
        const symlinkUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: ownedDeviceId, localPath: localUploadPath, remotePath: "Links/new-dir/escape.txt", bundleId: "com.example.Test" },
        });
        expect(symlinkUpload.isError).toBe(true);
        expect((symlinkUpload.content as Array<{ text?: string }>)[0].text).toContain("escapes the container");
        expect(existsSync(join(outsideContainerDir, "new-dir"))).toBe(false);

        const symlinkDownload = await client.callTool({
            name: "device_download",
            arguments: { deviceId: ownedDeviceId, remotePath: "Links/outside.txt", localPath: join(homeDir, "symlink-download.txt"), bundleId: "com.example.Test" },
        });
        expect(symlinkDownload.isError).toBe(true);
        expect((symlinkDownload.content as Array<{ text?: string }>)[0].text).toContain("escapes the container");

        const reset = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Test", confirmDestructive: true },
        });
        expect(reset.isError).not.toBe(true);
        const resetPayload = JSON.parse(((reset.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            reset: { bundleId: string; containerType: string };
            containerRoot: string;
        };
        expect(resetPayload.reset).toEqual({ bundleId: "com.example.Test", containerType: "data" });
        expect(resetPayload.containerRoot).toBe(iosContainerRoot);
        expect(() => readFileSync(join(iosContainerRoot, "Documents/uploaded.txt"), "utf-8")).toThrow();

        const missingRemoteDownload = await client.callTool({
            name: "device_download",
            arguments: { deviceId: ownedDeviceId, remotePath: "Documents/uploaded.txt", localPath: join(homeDir, "missing-download.txt"), bundleId: "com.example.Test" },
        });
        expect(missingRemoteDownload.isError).toBe(true);
        expect((missingRemoteDownload.content as Array<{ text?: string }>)[0].text).toContain("remotePath does not exist");

        const screenshot = await client.callTool({
            name: "mobile_screenshot",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(screenshot.isError).not.toBe(true);
        expect((screenshot.content as Array<{ type: string; data: string; mimeType: string }>)[0]).toEqual({
            type: "image",
            data: Buffer.from("fakepng").toString("base64"),
            mimeType: "image/png",
        });
        const screenshotLog = readFileSync(logPath, "utf-8");
        const screenshotPath = screenshotLog.match(/simctl io \S+ screenshot (\S+)/)?.[1];
        expect(screenshotPath).toMatch(/ccc-ios-screenshot-/);
        expect(existsSync(screenshotPath || "")).toBe(false);

        const initialRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(initialRecordStatus.isError).not.toBe(true);
        const initialRecordPayload = JSON.parse(((initialRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: unknown;
            provider: string;
        };
        expect(initialRecordPayload.recording).toBeNull();
        expect(initialRecordPayload.provider).toBe("simctl-recordVideo");

        const stopWithoutRecording = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(stopWithoutRecording.isError).toBe(true);
        expect((stopWithoutRecording.content as Array<{ text?: string }>)[0].text).toContain("No iOS Simulator recording active");

        const customRecordingPath = "/tmp/custom-ios-recording.mp4";
        rmSync(customRecordingPath, { force: true });
        writeFileSync(customRecordingPath, "original");
        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: customRecordingPath },
        });
        expect(recordStart.isError).not.toBe(true);
        const recordStartPayload = JSON.parse(((recordStart.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deviceId: string;
            recording: { active: boolean; provider: string; runtimeId: string; processIdentity: { pid: number; startToken: string; commandHash: string }; localPath: string; stagingPath: string };
        };
        expect(recordStartPayload.deviceId).toBe(ownedDeviceId);
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "simctl-recordVideo",
            runtimeId: expect.any(String),
            processIdentity: expect.objectContaining({
                pid: expect.any(Number),
                startToken: expect.any(String),
                commandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
            localPath: customRecordingPath,
            stagingPath: expect.stringMatching(/\/\.recording-stage-[^/]+\/payload$/),
        }));

        const duplicateRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(duplicateRecordStart.isError).toBe(true);
        expect((duplicateRecordStart.content as Array<{ text?: string }>)[0].text).toContain("iOS Simulator recording already active");

        const activeRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        const activeRecordPayload = JSON.parse(((activeRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string };
        };
        expect(activeRecordPayload.recording).toEqual(expect.objectContaining({ active: true, provider: "simctl-recordVideo" }));

        writeFileSync(recordStartPayload.recording.stagingPath, "");
        const rejectedRecordStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(rejectedRecordStop.isError).toBe(true);
        expect((rejectedRecordStop.content as Array<{ text?: string }>)[0].text).toContain("recording-local-path-stage-file-too-small");
        expect(readFileSync(customRecordingPath, "utf8")).toBe("original");
        const pendingRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(parseToolJson(pendingRecordStatus).recording).toEqual(expect.objectContaining({ active: false }));
        writeFileSync(recordStartPayload.recording.stagingPath, "fakevideo");
        const recordStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(recordStop.isError).not.toBe(true);
        const recordStopPayload = JSON.parse(((recordStop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            stopped: boolean;
            provider: string;
            recording: { active: boolean; provider: string; localPath: string };
            device: { recording: unknown };
        };
        expect(recordStopPayload.stopped).toBe(true);
        expect(recordStopPayload.provider).toBe("simctl-recordVideo");
        expect(recordStopPayload.recording).toEqual(expect.objectContaining({
            active: false,
            provider: "simctl-recordVideo",
            localPath: customRecordingPath,
        }));
        expect(recordStopPayload.device.recording).toBeNull();
        expect(readFileSync(customRecordingPath, "utf8")).toBe("fakevideo");

        writeFileSync(join(homeDir, "fake-ios-record-fail-once"), "1");
        const failedRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: "/tmp/fail-immediate-ios-recording.mp4" },
        });
        expect(failedRecordStart.isError).toBe(true);
        expect((failedRecordStart.content as Array<{ text?: string }>)[0].text).toContain("recorder exited before it was ready");
        const statusAfterFailedStart = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(JSON.parse(((statusAfterFailedStart.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        writeFileSync(join(homeDir, "fake-ios-record-natural-exit-once"), "1");
        const naturalExitStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: "/tmp/natural-exit-ios-recording.mp4" },
        });
        expect(naturalExitStart.isError, (naturalExitStart.content as Array<{ text?: string }>)[0].text).not.toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const statusAfterNaturalExit = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(JSON.parse(((statusAfterNaturalExit.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({
            active: false,
            localPath: "/tmp/natural-exit-ios-recording.mp4",
        }));
        const naturalExitStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(naturalExitStop.isError).not.toBe(true);
        expect(readFileSync("/tmp/natural-exit-ios-recording.mp4", "utf8")).toBe("fakevideo");

        const legacyRecordingSource = join(homeDir, "legacy-ios-recording.mp4");
        const legacyRecordingDestination = join(homeDir, "legacy-ios-recording-final.mp4");
        writeFileSync(legacyRecordingSource, "legacy-video");
        const legacyStatePath = join(homeDir, ".ccc", "devices", "owners", ownerId, "ios", "devices.json");
        const legacyState = JSON.parse(readFileSync(legacyStatePath, "utf8")) as { devices: Array<{ id: string; recording?: unknown }> };
        const legacyDevice = legacyState.devices.find((device) => device.id === ownedDeviceId);
        expect(legacyDevice).toBeDefined();
        legacyDevice!.recording = {
            active: false,
            provider: "simctl-recordVideo",
            runtimeId: "legacy-recording-runtime",
            localPath: legacyRecordingSource,
            startedAt: "2026-07-13T00:00:00.000Z",
        };
        writeFileSync(legacyStatePath, `${JSON.stringify(legacyState, null, 2)}\n`);
        const legacyRecordStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: ownedDeviceId, localPath: legacyRecordingDestination },
        });
        expect(legacyRecordStop.isError, (legacyRecordStop.content as Array<{ text?: string }>)[0].text).not.toBe(true);
        expect(readFileSync(legacyRecordingDestination, "utf8")).toBe("legacy-video");

        const stopCleanupRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: "/tmp/stop-cleanup-ios-recording.mp4" },
        });
        expect(stopCleanupRecordStart.isError).not.toBe(true);
        const stopCleanupRecording = parseToolJson(stopCleanupRecordStart).recording as { runtimeId: string; stagingPath: string };

        const session = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(session.isError).not.toBe(true);
        const sessionPayload = JSON.parse(((session.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            appium: { available: boolean; appium: string; xcuitestDriver: string; xcodebuild: string; xcrun: string; missing: string[] };
            session: unknown;
            automationName: string;
            lazy: boolean;
        };
        expect(sessionPayload.appium).toEqual({
            available: true,
            missing: [],
            appium: join(binDir, "appium"),
            xcuitestDriver: join(binDir, "appium-xcuitest-driver"),
            xcodebuild: join(binDir, "xcodebuild"),
            xcrun: join(binDir, "xcrun"),
        });
        expect(sessionPayload.session).toBeNull();
        expect(sessionPayload.automationName).toBe("XCUITest");
        expect(sessionPayload.lazy).toBe(true);

        const dumpUi = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(dumpUi.isError).not.toBe(true);
        const dumpPayload = JSON.parse(((dumpUi.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            provider: string;
            source: string;
            sessionId: string;
            serverUrl: string;
        };
        expect(dumpPayload.provider).toBe("appium-xcuitest");
        expect(dumpPayload.source).toContain("XCUIElementTypeApplication");
        expect(dumpPayload.sessionId).toBe("IOS-SESSION-1");

        const statusAfterDump = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: ownedDeviceId },
        });
        const statusAfterDumpPayload = JSON.parse(((statusAfterDump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            session: { runtimeId: string; processOwner: string; startedBy: string; sessionId: string; serverUrl: string; serverPid: number; processIdentity: { pid: number; startToken: string; commandHash: string } };
        };
        expect(statusAfterDumpPayload.session.runtimeId).toMatch(/^[0-9a-f-]{36}$/);
        expect(statusAfterDumpPayload.session.processOwner).toBe("device-lab-mcp");
        expect(statusAfterDumpPayload.session.startedBy).toBe("direct-provider");
        expect(statusAfterDumpPayload.session.sessionId).toBe("IOS-SESSION-1");
        expect(statusAfterDumpPayload.session.serverUrl).toBe(dumpPayload.serverUrl);
        expect(statusAfterDumpPayload.session.processIdentity).toEqual(expect.objectContaining({
            pid: statusAfterDumpPayload.session.serverPid,
            startToken: expect.any(String),
            commandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }));

        const statePath = join(homeDir, ".ccc", "devices", "owners", ownerId, "ios", "devices.json");
        const originalState = readFileSync(statePath, "utf-8");
        const forgedState = JSON.parse(originalState) as { devices: Array<{
            id: string;
            appium?: { processIdentity?: { commandHash?: string } };
        }> };
        const forgedDevice = forgedState.devices.find((device) => device.id === ownedDeviceId);
        expect(forgedDevice?.appium?.processIdentity).toBeDefined();
        forgedDevice!.appium!.processIdentity!.commandHash = "0".repeat(64);
        writeFileSync(statePath, `${JSON.stringify(forgedState, null, 2)}\n`);
        writeFileSync(join(homeDir, "stale-ios-session"), "1");
        const deleteCountBeforeMismatch = (readFileSync(logPath, "utf-8").match(/appium-http DELETE /g) || []).length;
        const mismatchedRecovery = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(mismatchedRecovery.isError).toBe(true);
        expect(((mismatchedRecovery.content as Array<{ text?: string }>)[0].text ?? "")).toContain("runtime-process-identity-mismatch");
        expect((readFileSync(logPath, "utf-8").match(/appium-http DELETE /g) || []).length).toBe(deleteCountBeforeMismatch);
        writeFileSync(statePath, originalState);

        const reusedDump = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(reusedDump.isError).not.toBe(true);
        expect(((reusedDump.content as Array<{ text?: string }>)[0].text ?? "")).toContain("IOS-SESSION-1");

        writeFileSync(join(homeDir, "stale-ios-session"), "1");
        const staleRecoveredDump = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(staleRecoveredDump.isError, JSON.stringify(staleRecoveredDump)).not.toBe(true);
        const staleRecoveredPayload = JSON.parse(((staleRecoveredDump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            sessionId: string;
        };
        expect(staleRecoveredPayload.sessionId).toBe("IOS-SESSION-1");
        await new Promise((resolve) => setTimeout(resolve, 100));

        const iosAppiumActions = [
            ["mobile_tap", { deviceId: ownedDeviceId, x: 10, y: 20 }],
            ["mobile_double_tap", { deviceId: ownedDeviceId, x: 11, y: 21 }],
            ["mobile_long_press", { deviceId: ownedDeviceId, x: 12, y: 22, durationMs: 900 }],
            ["mobile_swipe", { deviceId: ownedDeviceId, x1: 10, y1: 20, x2: 30, y2: 40, durationMs: 250 }],
            ["mobile_drag", { deviceId: ownedDeviceId, x1: 15, y1: 25, x2: 35, y2: 45, durationMs: 800 }],
            ["mobile_type_text", { deviceId: ownedDeviceId, text: "hello ios" }],
            ["mobile_key", { deviceId: ownedDeviceId, key: "Return" }],
            ["mobile_home", { deviceId: ownedDeviceId }],
            ["mobile_lock", { deviceId: ownedDeviceId }],
            ["mobile_unlock", { deviceId: ownedDeviceId }],
            ["mobile_rotate_left", { deviceId: ownedDeviceId }],
            ["mobile_rotate_right", { deviceId: ownedDeviceId }],
            ["mobile_set_orientation", { deviceId: ownedDeviceId, orientation: "reverse-landscape" }],
            ["mobile_wait_for_text", { deviceId: ownedDeviceId, text: "Test", timeoutMs: 1000, intervalMs: 50 }],
        ] as const;
        for (const [name, callArgs] of iosAppiumActions) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError, `${name}: ${(action.content as Array<{ text?: string }>)[0]?.text ?? ""}`).not.toBe(true);
        }

        const sourceFailMarker = join(homeDir, "stale-ios-session-source-fail");
        writeFileSync(sourceFailMarker, "1");
        const failedWaitForText = await client.callTool({
            name: "mobile_wait_for_text",
            arguments: { deviceId: ownedDeviceId, text: "Never", timeoutMs: 200, intervalMs: 50 },
        });
        expect(failedWaitForText.isError).toBe(true);
        expect((failedWaitForText.content as Array<{ text?: string }>)[0].text).toContain("Appium source request failed");
        rmSync(sourceFailMarker, { force: true });

        const missingIosKey = await client.callTool({
            name: "mobile_key",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(missingIosKey.isError).toBe(true);
        expect((missingIosKey.content as Array<{ text?: string }>)[0].text).toContain("mobile_key requires key or keyCode");

        const invalidOrientation = await client.callTool({
            name: "mobile_set_orientation",
            arguments: { deviceId: ownedDeviceId, orientation: "SIDEWAYS" },
        });
        expect(invalidOrientation.isError).toBe(true);
        expect((invalidOrientation.content as Array<{ text?: string }>)[0].text).toContain("requires portrait, landscape, reverse-portrait, or reverse-landscape");

        const unsupportedBattery = await client.callTool({
            name: "mobile_set_battery",
            arguments: { deviceId: ownedDeviceId, level: 50, confirmDestructive: true },
        });
        expect(unsupportedBattery.isError).toBe(true);
        expect((unsupportedBattery.content as Array<{ text?: string }>)[0].text).toContain("does not support mobile_set_battery through base simctl");

        const deleteWhileBooted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: ownedDeviceId, deleteSimulator: true, confirmDestructive: true },
        });
        expect(deleteWhileBooted.isError).toBe(true);

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(stop.isError).not.toBe(true);
        const stoppedPayload = JSON.parse(((stop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { recording: { active: boolean; runtimeId: string; stagingPath: string }; status: string };
        };
        expect(stoppedPayload.device.status).toBe("stopped");
        expect(stoppedPayload.device.recording).toEqual(expect.objectContaining({
            active: false,
            runtimeId: stopCleanupRecording.runtimeId,
            stagingPath: stopCleanupRecording.stagingPath,
        }));
        expect(existsSync(stopCleanupRecording.stagingPath)).toBe(true);

        const statusAfterDeviceStop = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(JSON.parse(((statusAfterDeviceStop.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({ active: false }));

        const finalizeStoppedDeviceRecording = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(finalizeStoppedDeviceRecording.isError, (finalizeStoppedDeviceRecording.content as Array<{ text?: string }>)[0]?.text ?? "").not.toBe(true);
        expect(readFileSync("/tmp/stop-cleanup-ios-recording.mp4", "utf8")).toBe("fakevideo");

        const eraseReset = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: ownedDeviceId, eraseSimulator: true, confirmDestructive: true },
        });
        expect(eraseReset.isError).not.toBe(true);
        const erasePayload = JSON.parse(((eraseReset.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            reset: { eraseSimulator: boolean };
            device: { status: string; bootReady: boolean };
        };
        expect(erasePayload.reset.eraseSimulator).toBe(true);
        expect(erasePayload.device.status).toBe("stopped");
        expect(erasePayload.device.bootReady).toBe(false);

        const deleteCleanupRecordingPath = join(homeDir, "delete-cleanup-ios-recording.mp4");
        const deleteCleanupRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: deleteCleanupRecordingPath },
        });
        expect(deleteCleanupRecordStart.isError).not.toBe(true);
        const deleteCleanupRecording = parseToolJson(deleteCleanupRecordStart).recording as { pid: number; stagingPath: string };
        expect(existsSync(deleteCleanupRecording.stagingPath)).toBe(true);

        const deleteWithRecording = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: ownedDeviceId, deleteSimulator: true, confirmDestructive: true },
        });
        expect(deleteWithRecording.isError).toBe(true);
        expect((deleteWithRecording.content as Array<{ text?: string }>)[0].text).toContain("recording is active or pending finalization");

        const eraseWithRecording = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: ownedDeviceId, eraseSimulator: true, confirmDestructive: true },
        });
        expect(eraseWithRecording.isError).toBe(true);
        expect((eraseWithRecording.content as Array<{ text?: string }>)[0].text).toContain("recording is active or pending finalization");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: ownedDeviceId, force: true, deleteSimulator: true, confirmDestructive: true },
        });
        expect(deleted.isError).not.toBe(true);
        const deletedPayload = JSON.parse(((deleted.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            simulatorDeleted: boolean;
        };
        expect(deletedPayload).toEqual({ deleted: ownedDeviceId, simulatorDeleted: true });
        expect(existsSync(deleteCleanupRecording.stagingPath)).toBe(false);

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`xcrun simctl create ${simulatorName} com.apple.CoreSimulator.SimDeviceType.iPhone-15 com.apple.CoreSimulator.SimRuntime.iOS-17-0`);
        expect(log).toContain("xcrun simctl boot CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl bootstatus CREATED-IOS-UDID -b");
        expect(log).toContain("xcrun simctl openurl CREATED-IOS-UDID https://example.test/ios");
        expect(log).toContain("xcrun simctl install CREATED-IOS-UDID /tmp/Test.app");
        expect(log).toContain("xcrun simctl launch CREATED-IOS-UDID com.example.Test");
        expect(log).toContain("xcrun simctl install CREATED-IOS-UDID /tmp/Common.app");
        expect(log).toContain("xcrun simctl launch CREATED-IOS-UDID com.example.Common");
        expect(log).toContain("xcrun simctl terminate CREATED-IOS-UDID com.example.Test");
        expect(log).toContain("xcrun simctl uninstall CREATED-IOS-UDID com.example.Test");
        expect(log).toContain("xcrun simctl privacy CREATED-IOS-UDID grant camera com.example.Test");
        expect(log).toContain("xcrun simctl privacy CREATED-IOS-UDID revoke camera com.example.Test");
        expect(log).toContain("xcrun simctl location CREATED-IOS-UDID set 37.7749,-122.4194");
        expect(log).toContain("xcrun simctl pbcopy CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl pbpaste CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl spawn CREATED-IOS-UDID pgrep -f com.example.Test");
        expect(log).toContain("xcrun simctl get_app_container CREATED-IOS-UDID com.example.Test data");
        expect(log).toContain("xcrun simctl erase CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID screenshot ");
        const recordingStagePaths = [...log.matchAll(/xcrun simctl io CREATED-IOS-UDID recordVideo (\S+)/g)].map((match) => match[1]);
        expect(recordingStagePaths).toHaveLength(5);
        expect(recordingStagePaths.every((path) => path.includes("/.recording-stage-") && path.endsWith("/payload"))).toBe(true);
        expect(recordingStagePaths.every((path) => !existsSync(path))).toBe(true);
        expect(log).toContain("xcrun simctl delete CREATED-IOS-UDID");
        expect(log).toContain("appium server --port ");
        expect(log).toContain("appium-http POST /session");
        expect(log).toContain("appium-server-sigint ");
        expect(log).toContain("appium-command-body /session/IOS-SESSION-1/actions");
        expect(log).toContain('"gesture":"tap"');
        expect(log).toContain('"gesture":"doubleTap"');
        expect(log).toContain('"gesture":"longPress"');
        expect(log).toContain('"gesture":"swipe"');
        expect(log).toContain('"gesture":"drag"');
        expect(log).toContain("appium-command-body /session/IOS-SESSION-1/keys");
        expect(log).toContain('"text":"hello ios"');
        expect(log).toContain("mobile: pressButton");
        expect(log).toContain("mobile: lock");
        expect(log).toContain("mobile: unlock");
        expect(log).toContain("appium-command-body /session/IOS-SESSION-1/orientation");
        expect(log).toContain('"appium:automationName":"XCUITest"');
        expect(log).not.toContain("Android backend missing prerequisites");
    });

    it("rolls back a boot superseded by a same-id state generation", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "ios-simulator" } });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const deviceId = `ios-generation-race-${Date.now()}`;
        const simulatorName = `ccc-${ownerId}-generation-race`;
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                deviceId,
                name: "iOS generation race",
                simulatorName,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        });
        expect(create.isError).not.toBe(true);

        const statePath = iosStatePath();
        const successor = {
            id: deviceId,
            name: "successor generation",
            backend: "ios-simulator",
            kind: "mobile",
            platform: "ios",
            ownerId,
            simulatorName,
            udid: "CREATED-IOS-UDID",
            status: "stopped",
            creatable: true,
            successorMarker: "preserve-exactly",
            createdAt: "successor-created",
            updatedAt: "successor-updated",
        };
        armStateReplacement(statePath, successor);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId, bootTimeoutMs: 1000 },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("owner-device-state-conflict");
        expect(existsSync(join(homeDir, "fake-ios-replace-state-done"))).toBe(true);
        expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual({ devices: [successor] });
        expect(readFileSync(logPath, "utf-8")).toContain("xcrun simctl shutdown CREATED-IOS-UDID");

        disarmStateReplacement();
        const cleanup = await client.callTool({
            name: "device_delete",
            arguments: { deviceId, deleteSimulator: true, confirmDestructive: true },
        });
        expect(cleanup.isError).not.toBe(true);
    });

    it.each(["stop", "delete"])("preserves a same-id successor that supersedes iOS Simulator %s", { timeout: TIMEOUT }, async (operation) => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "ios-simulator" } });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const deviceId = `ios-${operation}-race-${Date.now()}`;
        const simulatorName = `ccc-${ownerId}-${operation}-race`;
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                deviceId,
                name: `iOS ${operation} race`,
                simulatorName,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        });
        expect(create.isError).not.toBe(true);
        if (operation === "stop") {
            const start = await client.callTool({ name: "device_start", arguments: { deviceId, bootTimeoutMs: 1000 } });
            expect(start.isError).not.toBe(true);
        }

        const statePath = iosStatePath();
        const successor = {
            id: deviceId,
            name: `${operation} successor generation`,
            backend: "ios-simulator",
            kind: "mobile",
            platform: "ios",
            ownerId,
            simulatorName,
            udid: "CREATED-IOS-UDID",
            status: "stopped",
            creatable: true,
            successorMarker: `${operation}-preserve-exactly`,
            createdAt: `${operation}-successor-created`,
            updatedAt: `${operation}-successor-updated`,
        };
        armStateReplacement(statePath, successor, operation === "stop" ? "shutdown" : "delete");
        const result = await client.callTool({
            name: operation === "stop" ? "device_stop" : "device_delete",
            arguments: operation === "stop"
                ? { deviceId }
                : { deviceId, deleteSimulator: true, confirmDestructive: true },
        });
        expect(result.isError).toBe(true);
        expect((result.content as Array<{ text?: string }>)[0].text).toContain("owner-device-state-conflict");
        expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual({ devices: [successor] });

        disarmStateReplacement();
        const cleanup = await client.callTool({
            name: "device_delete",
            arguments: operation === "stop"
                ? { deviceId, deleteSimulator: true, confirmDestructive: true }
                : { deviceId, confirmDestructive: true },
        });
        expect(cleanup.isError).not.toBe(true);
    });

    it("preserves booted state when simctl shutdown fails", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "ios-simulator" } });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const deviceId = `ios-shutdown-failure-${Date.now()}`;
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                deviceId,
                name: "iOS shutdown failure",
                simulatorName: `ccc-${ownerId}-shutdown-failure`,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        });
        expect(create.isError).not.toBe(true);
        const start = await client.callTool({ name: "device_start", arguments: { deviceId, bootTimeoutMs: 1000 } });
        expect(start.isError).not.toBe(true);
        const startedLifecycle = (parseToolJson(start).device as Record<string, unknown>).lifecycle;

        writeFileSync(join(homeDir, "fake-ios-shutdown-fail-once"), "1");
        const failedStop = await client.callTool({ name: "device_stop", arguments: { deviceId } });
        expect(failedStop.isError).toBe(true);
        const status = await client.callTool({ name: "device_status", arguments: { deviceId } });
        expect(parseToolJson(status).device).toEqual(expect.objectContaining({
            id: deviceId,
            status: "booted",
        }));
        expect((parseToolJson(status).device as Record<string, unknown>).lifecycle).toEqual(startedLifecycle);

        const stop = await client.callTool({ name: "device_stop", arguments: { deviceId } });
        expect(stop.isError).not.toBe(true);
        const cleanup = await client.callTool({
            name: "device_delete",
            arguments: { deviceId, deleteSimulator: true, confirmDestructive: true },
        });
        expect(cleanup.isError).not.toBe(true);
    });

    it("preserves active recording metadata when device stop cannot verify the recorder", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "ios-simulator" } });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const deviceId = `ios-stop-recorder-mismatch-${Date.now()}`;
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                deviceId,
                name: "iOS stop recorder mismatch",
                simulatorName: `ccc-${ownerId}-stop-recorder-mismatch`,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        });
        expect(create.isError).not.toBe(true);
        expect((await client.callTool({ name: "device_start", arguments: { deviceId, bootTimeoutMs: 1000 } })).isError).not.toBe(true);
        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId, localPath: join(homeDir, "stop-recorder-mismatch.mp4") },
        });
        expect(recordStart.isError).not.toBe(true);
        const recording = parseToolJson(recordStart).recording as { runtimeId: string; stagingPath: string };

        const statePath = iosStatePath();
        const originalState = readFileSync(statePath, "utf8");
        const forgedState = JSON.parse(originalState) as { devices: Array<{ id: string; recording?: { processIdentity?: { commandHash?: string } } }> };
        forgedState.devices.find((device) => device.id === deviceId)!.recording!.processIdentity!.commandHash = "0".repeat(64);
        writeFileSync(statePath, `${JSON.stringify(forgedState, null, 2)}\n`);

        const failedStop = await client.callTool({ name: "device_stop", arguments: { deviceId } });
        expect(failedStop.isError).toBe(true);
        expect((failedStop.content as Array<{ text?: string }>)[0]?.text).toContain("runtime-process-identity-mismatch");
        const preserved = (JSON.parse(readFileSync(statePath, "utf8")) as { devices: Array<Record<string, any>> }).devices.find((device) => device.id === deviceId)!;
        expect(preserved.status).toBe("booted");
        expect(preserved.recording).toEqual(expect.objectContaining({ active: true, runtimeId: recording.runtimeId }));
        expect(existsSync(recording.stagingPath)).toBe(true);

        writeFileSync(statePath, originalState);
        expect((await client.callTool({ name: "device_record_video_stop", arguments: { deviceId } })).isError).not.toBe(true);
        expect((await client.callTool({ name: "device_stop", arguments: { deviceId } })).isError).not.toBe(true);
        expect((await client.callTool({
            name: "device_delete",
            arguments: { deviceId, deleteSimulator: true, confirmDestructive: true },
        })).isError).not.toBe(true);
    });

    it("persists recorder and simulator shutdown when later Appium cleanup fails", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "ios-simulator" } });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const deviceId = `ios-stop-partial-cleanup-${Date.now()}`;
        expect((await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                deviceId,
                name: "iOS stop partial cleanup",
                simulatorName: `ccc-${ownerId}-stop-partial-cleanup`,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        })).isError).not.toBe(true);
        expect((await client.callTool({ name: "device_start", arguments: { deviceId, bootTimeoutMs: 1000 } })).isError).not.toBe(true);
        expect((await client.callTool({ name: "mobile_dump_ui", arguments: { deviceId } })).isError).not.toBe(true);
        expect((await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId, localPath: join(homeDir, "stop-partial-cleanup.mp4") },
        })).isError).not.toBe(true);

        const statePath = iosStatePath();
        const state = JSON.parse(readFileSync(statePath, "utf8")) as { devices: Array<Record<string, any>> };
        const before = state.devices.find((device) => device.id === deviceId)!;
        const originalAppium = structuredClone(before.appium);
        const forgedAppium = structuredClone(originalAppium);
        forgedAppium.processIdentity.commandHash = "0".repeat(64);
        before.appium = forgedAppium;
        writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
        const logBefore = readFileSync(logPath, "utf8");
        const shutdownsBefore = (logBefore.match(/xcrun simctl shutdown CREATED-IOS-UDID/g) || []).length;
        const appiumStopsBefore = (logBefore.match(/appium-server-sigint /g) || []).length;

        const failedStop = await client.callTool({ name: "device_stop", arguments: { deviceId } });
        expect(failedStop.isError).toBe(true);
        expect((failedStop.content as Array<{ text?: string }>)[0]?.text).toContain("runtime-process-identity-mismatch");

        const partial = (JSON.parse(readFileSync(statePath, "utf8")) as { devices: Array<Record<string, any>> }).devices.find((device) => device.id === deviceId)!;
        expect(partial.status).toBe("stopped");
        expect(partial.recording).toEqual(expect.objectContaining({
            runtimeId: before.recording.runtimeId,
            active: false,
            endedAt: expect.any(String),
        }));
        expect(partial.appium).toEqual(forgedAppium);
        expect(partial.lifecycle).toBeNull();
        const logAfter = readFileSync(logPath, "utf8");
        expect((logAfter.match(/xcrun simctl shutdown CREATED-IOS-UDID/g) || []).length).toBe(shutdownsBefore + 1);
        expect((logAfter.match(/appium-server-sigint /g) || []).length).toBe(appiumStopsBefore);

        partial.appium = originalAppium;
        const recoveredState = JSON.parse(readFileSync(statePath, "utf8")) as { devices: Array<Record<string, any>> };
        recoveredState.devices = recoveredState.devices.map((device) => device.id === deviceId ? partial : device);
        writeFileSync(statePath, `${JSON.stringify(recoveredState, null, 2)}\n`);
        expect((await client.callTool({ name: "device_record_video_stop", arguments: { deviceId } })).isError).not.toBe(true);
        expect((await client.callTool({ name: "device_stop", arguments: { deviceId } })).isError).not.toBe(true);
        expect((await client.callTool({
            name: "device_delete",
            arguments: { deviceId, deleteSimulator: true, confirmDestructive: true },
        })).isError).not.toBe(true);
    });

    it("preserves Appium metadata when forced delete cannot verify the owned process", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "ios-simulator" } });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const deviceId = `ios-delete-appium-mismatch-${Date.now()}`;
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                deviceId,
                name: "iOS delete Appium mismatch",
                simulatorName: `ccc-${ownerId}-delete-appium-mismatch`,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        });
        expect(create.isError).not.toBe(true);
        expect((await client.callTool({ name: "device_start", arguments: { deviceId, bootTimeoutMs: 1000 } })).isError).not.toBe(true);
        expect((await client.callTool({ name: "mobile_dump_ui", arguments: { deviceId } })).isError).not.toBe(true);

        const statePath = iosStatePath();
        const originalState = readFileSync(statePath, "utf8");
        const forgedState = JSON.parse(originalState) as { devices: Array<{ id: string; appium?: { runtimeId?: string; processIdentity?: { commandHash?: string } } }> };
        const originalAppium = forgedState.devices.find((device) => device.id === deviceId)!.appium!;
        originalAppium.processIdentity!.commandHash = "0".repeat(64);
        writeFileSync(statePath, `${JSON.stringify(forgedState, null, 2)}\n`);
        const logBefore = readFileSync(logPath, "utf8");
        const deletesBefore = (logBefore.match(/xcrun simctl delete CREATED-IOS-UDID/g) || []).length;
        const sessionDeletesBefore = (logBefore.match(/appium-http DELETE /g) || []).length;

        const failedDelete = await client.callTool({
            name: "device_delete",
            arguments: { deviceId, force: true, deleteSimulator: true, confirmDestructive: true },
        });
        expect(failedDelete.isError).toBe(true);
        expect((failedDelete.content as Array<{ text?: string }>)[0]?.text).toContain("runtime-process-identity-mismatch");
        const preserved = (JSON.parse(readFileSync(statePath, "utf8")) as { devices: Array<Record<string, any>> }).devices.find((device) => device.id === deviceId)!;
        expect(preserved.status).toBe("booted");
        expect(preserved.appium).toEqual(originalAppium);
        const logAfterFailure = readFileSync(logPath, "utf8");
        expect((logAfterFailure.match(/xcrun simctl delete CREATED-IOS-UDID/g) || []).length).toBe(deletesBefore);
        expect((logAfterFailure.match(/appium-http DELETE /g) || []).length).toBe(sessionDeletesBefore);

        writeFileSync(statePath, originalState);
        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId, force: true, deleteSimulator: true, confirmDestructive: true },
        });
        expect(deleted.isError, (deleted.content as Array<{ text?: string }>)[0]?.text ?? "").not.toBe(true);
        const cleanupLog = readFileSync(logPath, "utf8");
        expect((cleanupLog.match(/appium-http DELETE /g) || []).length).toBe(sessionDeletesBefore + 1);
        expect((cleanupLog.match(/xcrun simctl delete CREATED-IOS-UDID/g) || []).length).toBe(deletesBefore + 1);
        expect(cleanupLog).toContain("appium-server-sigint");
    });

    it("commits stopped recording and Appium state when simctl delete fails", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "ios-simulator" } });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const deviceId = `ios-delete-partial-simctl-${Date.now()}`;
        expect((await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                deviceId,
                name: "iOS delete partial simctl",
                simulatorName: `ccc-${ownerId}-delete-partial-simctl`,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        })).isError).not.toBe(true);
        expect((await client.callTool({ name: "device_start", arguments: { deviceId, bootTimeoutMs: 1000 } })).isError).not.toBe(true);
        expect((await client.callTool({ name: "mobile_dump_ui", arguments: { deviceId } })).isError).not.toBe(true);
        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId, localPath: join(homeDir, "delete-partial-simctl.mp4") },
        });
        expect(recordStart.isError).not.toBe(true);
        const recording = parseToolJson(recordStart).recording as { runtimeId: string };

        writeFileSync(join(homeDir, "fake-ios-delete-fail-once"), "1");
        const failedDelete = await client.callTool({
            name: "device_delete",
            arguments: { deviceId, force: true, deleteSimulator: true, confirmDestructive: true },
        });
        expect(failedDelete.isError).toBe(true);
        expect((failedDelete.content as Array<{ text?: string }>)[0]?.text).toContain("simulated delete failure");

        const partial = (JSON.parse(readFileSync(iosStatePath(), "utf8")) as { devices: Array<Record<string, any>> }).devices.find((device) => device.id === deviceId)!;
        expect(partial).toEqual(expect.objectContaining({
            status: "stopped",
            bootReady: false,
            appium: null,
            recording: expect.objectContaining({ runtimeId: recording.runtimeId, active: false, endedAt: expect.any(String) }),
        }));
        expect(partial.lifecycle).toBeNull();

        expect((await client.callTool({ name: "device_record_video_stop", arguments: { deviceId } })).isError).not.toBe(true);
        expect((await client.callTool({
            name: "device_delete",
            arguments: { deviceId, deleteSimulator: true, confirmDestructive: true },
        })).isError).not.toBe(true);
    });

    it("does not restore device metadata after simulator deletion when staging cleanup fails", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "ios-simulator" } });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const deviceId = `ios-delete-partial-stage-${Date.now()}`;
        expect((await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                deviceId,
                name: "iOS delete partial stage",
                simulatorName: `ccc-${ownerId}-delete-partial-stage`,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        })).isError).not.toBe(true);
        expect((await client.callTool({ name: "device_start", arguments: { deviceId, bootTimeoutMs: 1000 } })).isError).not.toBe(true);
        expect((await client.callTool({ name: "mobile_dump_ui", arguments: { deviceId } })).isError).not.toBe(true);
        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId, localPath: join(homeDir, "delete-partial-stage.mp4") },
        });
        expect(recordStart.isError).not.toBe(true);
        const recording = parseToolJson(recordStart).recording as { stagingPath: string };

        const state = JSON.parse(readFileSync(iosStatePath(), "utf8")) as { devices: Array<Record<string, any>> };
        state.devices.find((device) => device.id === deviceId)!.recording.stagingPath = join(homeDir, "invalid-recording-stage", "payload");
        writeFileSync(iosStatePath(), `${JSON.stringify(state, null, 2)}\n`);
        const logBefore = readFileSync(logPath, "utf8");
        const appiumStopsBefore = (logBefore.match(/appium-server-sigint /g) || []).length;

        const failedCleanup = await client.callTool({
            name: "device_delete",
            arguments: { deviceId, force: true, deleteSimulator: true, confirmDestructive: true },
        });
        expect(failedCleanup.isError).toBe(true);
        expect((failedCleanup.content as Array<{ text?: string }>)[0]?.text).toContain("simulator and device metadata were deleted");
        const remaining = (JSON.parse(readFileSync(iosStatePath(), "utf8")) as { devices: Array<Record<string, any>> }).devices;
        expect(remaining.some((device) => device.id === deviceId)).toBe(false);
        expect(existsSync(join(homeDir, "fake-ios-created-name"))).toBe(false);
        expect((readFileSync(logPath, "utf8").match(/appium-server-sigint /g) || []).length).toBe(appiumStopsBefore + 1);

        rmSync(dirname(recording.stagingPath), { recursive: true, force: true });
    });


    it("keeps metadata-only iOS definitions lazy and refuses non-owned simulator operations", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "ios-simulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const metadataOnlyName = `ccc-${ownerId}-ios-metadata-only`;

        const metadataOnly = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "iOS Metadata Only",
                simulatorName: metadataOnlyName,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
            },
        });
        expect(metadataOnly.isError).not.toBe(true);
        const metadataPayload = JSON.parse(((metadataOnly.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { provisioning: string; udid: string | null };
        };
        expect(metadataPayload.device.provisioning).toBe("definition-only");
        expect(metadataPayload.device.udid).toBeNull();

        const metadataDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-ios-metadata-only", confirmDestructive: true },
        });
        expect(metadataDeleted.isError).not.toBe(true);

        const forgedAliasId = "ios-forged-owner-alias";
        const forgedAliasName = `ccc-${ownerId}-forged-owner-alias`;
        const forgedAlias = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "Forged Owner Alias",
                deviceId: forgedAliasId,
                simulatorName: forgedAliasName,
                udid: "HOST-UDID",
            },
        });
        expect(forgedAlias.isError).not.toBe(true);
        for (const [name, args] of [
            ["device_start", { deviceId: forgedAliasId, bootTimeoutMs: 1000 }],
            ["device_exec", { deviceId: forgedAliasId, command: "echo unsafe" }],
            ["device_screenshot", { deviceId: forgedAliasId }],
            ["mobile_dump_ui", { deviceId: forgedAliasId }],
            ["device_delete", { deviceId: forgedAliasId, deleteSimulator: true, confirmDestructive: true }],
        ] as const) {
            const result = await client.callTool({ name, arguments: args });
            expect(result.isError, name).toBe(true);
            expect((result.content as Array<{ text?: string }>)[0].text, name).toContain("ownership mismatch");
        }
        const forgedAliasDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: forgedAliasId, confirmDestructive: true },
        });
        expect(forgedAliasDeleted.isError).not.toBe(true);

        const foreignCreate = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "Foreign iOS Create",
                simulatorName: "foreign-ios",
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        });
        expect(foreignCreate.isError).toBe(true);
        expect((foreignCreate.content as Array<{ text?: string }>)[0].text).toContain("Refusing to create non-owned iOS Simulator name");

        const foreignMetadata = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "Foreign iOS Metadata",
                simulatorName: "foreign-ios",
                udid: "FOREIGN-UDID",
            },
        });
        expect(foreignMetadata.isError).not.toBe(true);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "ios-foreign-ios-metadata", bootTimeoutMs: 1000 },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("non-owned simulator name");

        writeFileSync(join(homeDir, "foreign-ios-upload.txt"), "foreign");
        const foreignUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: "ios-foreign-ios-metadata", localPath: join(homeDir, "foreign-ios-upload.txt"), remotePath: "Documents/foreign.txt", bundleId: "com.example.Test" },
        });
        expect(foreignUpload.isError).toBe(true);
        expect((foreignUpload.content as Array<{ text?: string }>)[0].text).toContain("Refusing iOS Simulator upload for non-owned simulator name");

        const foreignDownload = await client.callTool({
            name: "device_download",
            arguments: { deviceId: "ios-foreign-ios-metadata", remotePath: "Documents/foreign.txt", localPath: join(homeDir, "foreign-download.txt"), bundleId: "com.example.Test" },
        });
        expect(foreignDownload.isError).toBe(true);
        expect((foreignDownload.content as Array<{ text?: string }>)[0].text).toContain("Refusing iOS Simulator download for non-owned simulator name");

        const foreignAppReset = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: "ios-foreign-ios-metadata", bundleId: "com.example.Test", confirmDestructive: true },
        });
        expect(foreignAppReset.isError).toBe(true);
        expect((foreignAppReset.content as Array<{ text?: string }>)[0].text).toContain("non-owned simulator name");

        const eraseSimulator = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: "ios-foreign-ios-metadata", eraseSimulator: true, confirmDestructive: true },
        });
        expect(eraseSimulator.isError).toBe(true);
        expect((eraseSimulator.content as Array<{ text?: string }>)[0].text).toContain("non-owned simulator name");

        const deleteSimulator = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-foreign-ios-metadata", deleteSimulator: true, confirmDestructive: true },
        });
        expect(deleteSimulator.isError).toBe(true);
        expect((deleteSimulator.content as Array<{ text?: string }>)[0].text).toContain("non-owned simulator name");

        const foreignDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-foreign-ios-metadata", confirmDestructive: true },
        });
        expect(foreignDeleted.isError).not.toBe(true);

        const log = readFileSync(logPath, "utf-8");
        expect(log).not.toContain(`xcrun simctl create ${metadataOnlyName}`);
        expect(log).not.toContain("xcrun simctl boot FOREIGN-UDID");
        expect(log).not.toContain("xcrun simctl boot HOST-UDID");
        expect(log).not.toContain("xcrun simctl spawn HOST-UDID /bin/sh -lc echo unsafe");
        expect(log).not.toContain("xcrun simctl io HOST-UDID screenshot");
        expect(log).not.toContain("xcrun simctl get_app_container FOREIGN-UDID");
        expect(log).not.toContain("xcrun simctl erase FOREIGN-UDID");
        expect(log).not.toContain("xcrun simctl delete FOREIGN-UDID");
        expect(log).not.toContain("xcrun simctl delete HOST-UDID");
    });});
