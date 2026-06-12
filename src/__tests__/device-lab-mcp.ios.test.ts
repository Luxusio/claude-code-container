import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../..");
const TIMEOUT = 30000;

describe("device-lab MCP with fake iOS simctl", () => {
    let client: Client;
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-bin-"));
        logPath = join(homeDir, "fake-ios.log");
        const containerRoot = join(homeDir, "ios-app-container");

        const xcrunPath = join(binDir, "xcrun");
        writeFileSync(xcrunPath, `#!/bin/sh
echo "xcrun $*" >> "$FAKE_IOS_LOG"
if [ "$1" = "simctl" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"host iPhone","udid":"HOST-UDID","state":"Shutdown"}]},"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-17-0","name":"iOS 17.0","isAvailable":true}],"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-15","name":"iPhone 15"}]}'
  exit 0
fi
if [ "$1" = "xctrace" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo "Devices:"
  echo "Build Mac (15.0) (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE)"
  echo "Real iPhone (17.5) (00008110-001C195E0E91801E)"
  echo "Network iPhone (17.5) (00008120-00AA00BB00CC00DD) (Network)"
  echo "Other iPhone (16.7) (00008101-00DEADBEEFCAFE00)"
  echo "Simulators:"
  echo "iPhone 15 Simulator (17.0) (SIM-UDID)"
  exit 0
fi
if [ "$1" = "devicectl" ] && [ "$2" = "device" ] && [ "$3" = "install" ] && [ "$4" = "app" ]; then
  exit 0
fi
if [ "$1" = "devicectl" ] && [ "$2" = "device" ] && [ "$3" = "process" ] && [ "$4" = "launch" ]; then
  echo "launched $8"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "create" ]; then
  echo "CREATED-IOS-UDID"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "boot" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  echo "Booted"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "shutdown" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "delete" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "erase" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "get_app_container" ]; then
  mkdir -p "$FAKE_IOS_CONTAINER_ROOT"
  echo "$FAKE_IOS_CONTAINER_ROOT"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "spawn" ]; then
  echo "ok"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "io" ] && [ "$4" = "screenshot" ]; then
  printf 'fakepng' > "$5"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "io" ] && [ "$4" = "recordVideo" ]; then
  case "$5" in
    *fail-immediate*) exit 9 ;;
    *natural-exit*) exec /bin/sleep 0.3 ;;
    *) exec /bin/sleep 20 ;;
  esac
fi
if [ "$1" = "simctl" ] && [ "$2" = "openurl" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "install" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "launch" ]; then
  echo "$4: 123"
  exit 0
fi
exit 0
`);
        chmodSync(xcrunPath, 0o755);
        const appiumPath = join(binDir, "appium");
        writeFileSync(appiumPath, `#!/bin/sh
echo "appium $*" >> "$FAKE_IOS_LOG"
PORT=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--port" ]; then
    shift
    PORT="$1"
  fi
  shift
done
exec "${process.execPath}" - "$PORT" "$FAKE_IOS_LOG" "${join(homeDir, "stale-ios-session")}" <<'NODE'
const http = require('http');
const fs = require('fs');
const port = Number(process.argv[2]);
const log = process.argv[3];
const stalePath = process.argv[4];
let sessionCounter = 0;
let sessionId = null;
function send(res, status, payload) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(payload));
}
const server = http.createServer((req, res) => {
  fs.appendFileSync(log, 'appium-http ' + req.method + ' ' + req.url + '\\n');
  if (req.method === 'GET' && req.url === '/status') return send(res, 200, {value: {ready: true}});
  if (req.method === 'POST' && req.url === '/session') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      fs.appendFileSync(log, 'appium-session-body ' + body + '\\n');
      sessionCounter += 1;
      sessionId = 'IOS-SESSION-' + sessionCounter;
      send(res, 200, {value: {sessionId}});
    });
    return;
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId) {
    if (fs.existsSync(stalePath)) {
      fs.unlinkSync(stalePath);
      send(res, 404, {value: {error: 'stale'}});
      return;
    }
    return send(res, 200, {value: {sessionId}});
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId + '/source') {
    if (fs.existsSync(stalePath + '-source-fail')) {
      return send(res, 500, {value: {error: 'source failed'}});
    }
    return send(res, 200, {value: '<AppiumAUT><XCUIElementTypeApplication name="Test"/></AppiumAUT>'});
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId + '/screenshot') {
    return send(res, 200, {value: Buffer.from('fake-real-ios-png').toString('base64')});
  }
  if (req.method === 'POST' && sessionId && (
    req.url === '/session/' + sessionId + '/actions' ||
    req.url === '/session/' + sessionId + '/keys' ||
    req.url === '/session/' + sessionId + '/execute/sync' ||
    req.url === '/session/' + sessionId + '/orientation'
  )) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      fs.appendFileSync(log, 'appium-command-body ' + req.url + ' ' + body + '\\n');
      if (body.includes('mobile: activeAppInfo')) {
        send(res, 200, {value: {bundleId: 'com.example.Real', name: 'Real'}});
        return;
      }
      send(res, 200, {value: null});
    });
    return;
  }
  send(res, 404, {value: {error: 'unknown route'}});
});
process.on('SIGINT', () => {
  fs.appendFileSync(log, 'appium-server-sigint ' + port + '\\n');
  server.close(() => process.exit(0));
});
server.listen(port, '127.0.0.1');
NODE
`);
        chmodSync(appiumPath, 0o755);

        const xcodebuildPath = join(binDir, "xcodebuild");
        writeFileSync(xcodebuildPath, `#!/bin/sh
echo "xcodebuild $*" >> "$FAKE_IOS_LOG"
if [ "$1" = "-version" ]; then
  echo "Xcode 15.0"
  exit 0
fi
exit 0
`);
        chmodSync(xcodebuildPath, 0o755);

        for (const name of ["appium-xcuitest-driver", "xcodebuild"]) {
            const toolPath = join(binDir, name);
            writeFileSync(toolPath, `#!/bin/sh
echo "${name} $*" >> "$FAKE_IOS_LOG"
exit 0
`);
            chmodSync(toolPath, 0o755);
        }

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: binDir,
                NODE_ENV: "test",
                FAKE_IOS_LOG: logPath,
                FAKE_IOS_CONTAINER_ROOT: containerRoot,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-ios-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
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

        const launchApp = await client.callTool({
            name: "mobile_launch_app",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Test" },
        });
        expect(launchApp.isError).not.toBe(true);

        const commonInstall = await client.callTool({
            name: "device_install_app",
            arguments: { deviceId: ownedDeviceId, path: "/tmp/Common.app" },
        });
        expect(commonInstall.isError).not.toBe(true);

        const commonLaunch = await client.callTool({
            name: "device_launch_app",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Common" },
        });
        expect(commonLaunch.isError).not.toBe(true);

        const advancedIosCalls = [
            ["mobile_grant_permission", { deviceId: ownedDeviceId, bundleId: "com.example.Test", service: "camera" }],
            ["mobile_revoke_permission", { deviceId: ownedDeviceId, bundleId: "com.example.Test", service: "camera" }],
            ["mobile_set_location", { deviceId: ownedDeviceId, latitude: 37.7749, longitude: -122.4194 }],
            ["mobile_set_clipboard", { deviceId: ownedDeviceId, text: "ios clip" }],
            ["mobile_get_clipboard", { deviceId: ownedDeviceId }],
            ["mobile_wait_for_app", { deviceId: ownedDeviceId, bundleId: "com.example.Test", timeoutMs: 1000, intervalMs: 50 }],
        ] as const;
        for (const [name, callArgs] of advancedIosCalls) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError).not.toBe(true);
        }

        const iosContainerRoot = join(homeDir, "ios-app-container");
        const localUploadPath = join(homeDir, "ios-upload.txt");
        const localDownloadPath = join(homeDir, "ios-download.txt");
        mkdirSync(iosContainerRoot, { recursive: true });
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
        expect((missingLocalUpload.content as Array<{ text?: string }>)[0].text).toContain("localPath does not exist");

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
            arguments: { deviceId: ownedDeviceId, localPath: localUploadPath, remotePath: "Links/escape.txt", bundleId: "com.example.Test" },
        });
        expect(symlinkUpload.isError).toBe(true);
        expect((symlinkUpload.content as Array<{ text?: string }>)[0].text).toContain("escapes the container");

        const symlinkDownload = await client.callTool({
            name: "device_download",
            arguments: { deviceId: ownedDeviceId, remotePath: "Links/outside.txt", localPath: join(homeDir, "symlink-download.txt"), bundleId: "com.example.Test" },
        });
        expect(symlinkDownload.isError).toBe(true);
        expect((symlinkDownload.content as Array<{ text?: string }>)[0].text).toContain("escapes the container");

        const reset = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: ownedDeviceId, bundleId: "com.example.Test" },
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
        expect((screenshot.content as Array<{ type: string }>)[0].type).toBe("image");

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

        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: "/tmp/custom-ios-recording.mp4" },
        });
        expect(recordStart.isError).not.toBe(true);
        const recordStartPayload = JSON.parse(((recordStart.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string; localPath: string };
        };
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "simctl-recordVideo",
            localPath: "/tmp/custom-ios-recording.mp4",
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

        const recordStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(recordStop.isError).not.toBe(true);
        const recordStopPayload = JSON.parse(((recordStop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            stopped: boolean;
            recording: { active: boolean; localPath: string };
            device: { recording: unknown };
        };
        expect(recordStopPayload.stopped).toBe(true);
        expect(recordStopPayload.recording).toEqual(expect.objectContaining({
            active: false,
            localPath: "/tmp/custom-ios-recording.mp4",
        }));
        expect(recordStopPayload.device.recording).toBeNull();

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

        const naturalExitStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: "/tmp/natural-exit-ios-recording.mp4" },
        });
        expect(naturalExitStart.isError).not.toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const statusAfterNaturalExit = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(JSON.parse(((statusAfterNaturalExit.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const stopCleanupRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: ownedDeviceId, localPath: "/tmp/stop-cleanup-ios-recording.mp4" },
        });
        expect(stopCleanupRecordStart.isError).not.toBe(true);

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
            session: { sessionId: string; serverUrl: string };
        };
        expect(statusAfterDumpPayload.session.sessionId).toBe("IOS-SESSION-1");
        expect(statusAfterDumpPayload.session.serverUrl).toBe(dumpPayload.serverUrl);

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
        expect(staleRecoveredDump.isError).not.toBe(true);
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
            ["mobile_set_orientation", { deviceId: ownedDeviceId, orientation: "LANDSCAPE" }],
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
        expect((invalidOrientation.content as Array<{ text?: string }>)[0].text).toContain("requires PORTRAIT or LANDSCAPE");

        const unsupportedBattery = await client.callTool({
            name: "mobile_set_battery",
            arguments: { deviceId: ownedDeviceId, level: 50 },
        });
        expect(unsupportedBattery.isError).toBe(true);
        expect((unsupportedBattery.content as Array<{ text?: string }>)[0].text).toContain("does not support mobile_set_battery through base simctl");

        const deleteWhileBooted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: ownedDeviceId, deleteSimulator: true },
        });
        expect(deleteWhileBooted.isError).toBe(true);

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(stop.isError).not.toBe(true);
        const stoppedPayload = JSON.parse(((stop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { recording: unknown; status: string };
        };
        expect(stoppedPayload.device.status).toBe("stopped");
        expect(stoppedPayload.device.recording).toBeNull();

        const statusAfterDeviceStop = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: ownedDeviceId },
        });
        expect(JSON.parse(((statusAfterDeviceStop.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const eraseReset = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: ownedDeviceId, eraseSimulator: true },
        });
        expect(eraseReset.isError).not.toBe(true);
        const erasePayload = JSON.parse(((eraseReset.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            reset: { eraseSimulator: boolean };
            device: { status: string; bootReady: boolean };
        };
        expect(erasePayload.reset.eraseSimulator).toBe(true);
        expect(erasePayload.device.status).toBe("stopped");
        expect(erasePayload.device.bootReady).toBe(false);

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: ownedDeviceId, deleteSimulator: true },
        });
        expect(deleted.isError).not.toBe(true);
        const deletedPayload = JSON.parse(((deleted.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            simulatorDeleted: boolean;
        };
        expect(deletedPayload).toEqual({ deleted: ownedDeviceId, simulatorDeleted: true });

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`xcrun simctl create ${simulatorName} com.apple.CoreSimulator.SimDeviceType.iPhone-15 com.apple.CoreSimulator.SimRuntime.iOS-17-0`);
        expect(log).toContain("xcrun simctl boot CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl bootstatus CREATED-IOS-UDID -b");
        expect(log).toContain("xcrun simctl openurl CREATED-IOS-UDID https://example.test/ios");
        expect(log).toContain("xcrun simctl install CREATED-IOS-UDID /tmp/Test.app");
        expect(log).toContain("xcrun simctl launch CREATED-IOS-UDID com.example.Test");
        expect(log).toContain("xcrun simctl install CREATED-IOS-UDID /tmp/Common.app");
        expect(log).toContain("xcrun simctl launch CREATED-IOS-UDID com.example.Common");
        expect(log).toContain("xcrun simctl privacy CREATED-IOS-UDID grant camera com.example.Test");
        expect(log).toContain("xcrun simctl privacy CREATED-IOS-UDID revoke camera com.example.Test");
        expect(log).toContain("xcrun simctl location CREATED-IOS-UDID set 37.7749,-122.4194");
        expect(log).toContain("xcrun simctl pbcopy CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl pbpaste CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl spawn CREATED-IOS-UDID pgrep -f com.example.Test");
        expect(log).toContain("xcrun simctl get_app_container CREATED-IOS-UDID com.example.Test data");
        expect(log).toContain("xcrun simctl erase CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID screenshot ");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID recordVideo /tmp/custom-ios-recording.mp4");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID recordVideo /tmp/fail-immediate-ios-recording.mp4");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID recordVideo /tmp/natural-exit-ios-recording.mp4");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID recordVideo /tmp/stop-cleanup-ios-recording.mp4");
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

    it("attaches, inspects, and detaches iOS real devices without simctl lifecycle commands", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "ios-device" },
        });
        expect(inventory.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            hostDevices: { devices: Array<{ name: string; udid: string; version: string; connection: string }> };
            discovery: { available: boolean };
        };
        expect(inventoryPayload.discovery.available).toBe(true);
        expect(inventoryPayload.hostDevices.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "Real iPhone", udid: "00008110-001C195E0E91801E", version: "17.5", connection: "usb" }),
            expect.objectContaining({ name: "Network iPhone", udid: "00008120-00AA00BB00CC00DD", version: "17.5", connection: "wifi" }),
        ]));
        expect(inventoryPayload.hostDevices.devices.some((device) => device.name.includes("Simulator"))).toBe(false);
        expect(inventoryPayload.hostDevices.devices.some((device) => device.name.includes("Mac"))).toBe(false);

        const wirelessStatus = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "ios-device", udid: "00008120-00AA00BB00CC00DD" },
        });
        expect(wirelessStatus.isError).not.toBe(true);
        const wirelessStatusPayload = JSON.parse(((wirelessStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            provider: string;
            networkVisible: boolean;
            selected: { udid: string; connection: string };
            supportedActions: string[];
            unsupportedActions: string[];
        };
        expect(wirelessStatusPayload).toEqual(expect.objectContaining({
            ok: true,
            provider: "xcrun-xctrace",
            networkVisible: true,
            selected: expect.objectContaining({ udid: "00008120-00AA00BB00CC00DD", connection: "wifi" }),
        }));
        expect(wirelessStatusPayload.supportedActions).toEqual(["status"]);
        expect(wirelessStatusPayload.unsupportedActions).toEqual(expect.arrayContaining(["pair", "connect"]));

        const unsupportedIosPair = await client.callTool({
            name: "device_wireless",
            arguments: { backend: "ios-device", action: "pair", udid: "00008110-001C195E0E91801E" },
        });
        expect(unsupportedIosPair.isError).toBe(true);
        const unsupportedIosPairPayload = JSON.parse((unsupportedIosPair.content as Array<{ text?: string }>)[0].text ?? "{}") as {
            ok: boolean;
            error: string;
            networkVisible: boolean;
            attachFlow: string;
        };
        expect(unsupportedIosPairPayload).toEqual(expect.objectContaining({
            ok: false,
            error: "ios-wireless-pairing-requires-xcode-trust",
            networkVisible: false,
        }));
        expect(unsupportedIosPairPayload.attachFlow).toContain("device_inventory");

        const iosLeaseDir = join(homeDir, ".ccc/devices/physical-leases/ios-device/locks");
        mkdirSync(iosLeaseDir, { recursive: true });
        writeFileSync(join(iosLeaseDir, `${encodeURIComponent("00008101-00DEADBEEFCAFE00")}.json`), JSON.stringify({
            backend: "ios-device",
            hardwareId: "00008101-00DEADBEEFCAFE00",
            ownerId: "other-owner",
            deviceId: "ios-device-foreign",
        }));
        const rejectLeased = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "Already Leased iPhone", udid: "00008101-00DEADBEEFCAFE00" },
        });
        expect(rejectLeased.isError).toBe(true);
        expect((rejectLeased.content as Array<{ text?: string }>)[0].text).toContain("already attached by another CCC owner");

        const rejectWifiNotNetworkVisible = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "USB As WiFi", udid: "00008110-001C195E0E91801E", connection: "wifi" },
        });
        expect(rejectWifiNotNetworkVisible.isError).toBe(true);
        expect((rejectWifiNotNetworkVisible.content as Array<{ text?: string }>)[0].text).toContain("requires the device to be paired for network use");

        const attach = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "Real iPhone", udid: "00008110-001C195E0E91801E" },
        });
        expect(attach.isError).not.toBe(true);
        const attached = JSON.parse(((attach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; backend: string; physical: boolean; status: string; creatable: boolean };
        };
        expect(attached.device).toEqual(expect.objectContaining({
            id: "ios-device-real-iphone",
            backend: "ios-device",
            physical: true,
            connection: "usb",
            status: "attached",
            creatable: false,
        }));

        const wifiAttach = await client.callTool({
            name: "device_attach",
            arguments: {
                backend: "ios-device",
                name: "Network iPhone",
                udid: "00008120-00AA00BB00CC00DD",
                connection: "wifi",
                host: "network-iphone.local",
            },
        });
        expect(wifiAttach.isError).not.toBe(true);
        const wifiAttached = JSON.parse(((wifiAttach.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; connection: string; transport: { type: string; host: string; visibleVia: string } };
        };
        expect(wifiAttached.device).toEqual(expect.objectContaining({
            id: "ios-device-network-iphone",
            connection: "wifi",
            transport: expect.objectContaining({ type: "wifi", host: "network-iphone.local", visibleVia: "xctrace" }),
        }));

        const duplicate = await client.callTool({
            name: "device_attach",
            arguments: { backend: "ios-device", name: "Duplicate iPhone", udid: "00008110-001C195E0E91801E" },
        });
        expect(duplicate.isError).toBe(true);
        expect((duplicate.content as Array<{ text?: string }>)[0].text).toContain("iOS UDID already attached");

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(status.isError).not.toBe(true);
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            backend: { name: string; attachable: boolean };
            hostDevice: { udid: string };
            appium: { automationName: string; physical: boolean };
        };
        expect(statusPayload.backend).toEqual(expect.objectContaining({ name: "ios-device", attachable: true }));
        expect(statusPayload.hostDevice.udid).toBe("00008110-001C195E0E91801E");
        expect(statusPayload.appium).toEqual(expect.objectContaining({ automationName: "XCUITest", physical: true }));

        const realSession = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(realSession.isError).not.toBe(true);
        const realSessionPayload = JSON.parse(((realSession.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            automationName: string;
            physical: boolean;
            session: unknown;
            appium: { available: boolean; missing: string[] };
        };
        expect(realSessionPayload).toEqual(expect.objectContaining({
            automationName: "XCUITest",
            physical: true,
            session: null,
        }));
        expect(realSessionPayload.appium.available).toBe(true);
        expect(realSessionPayload.appium.missing).toEqual([]);

        const realDump = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(realDump.isError).not.toBe(true);
        const realDumpPayload = JSON.parse(((realDump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            provider: string;
            physical: boolean;
            source: string;
            sessionId: string;
            serverUrl: string;
        };
        expect(realDumpPayload).toEqual(expect.objectContaining({
            provider: "appium-xcuitest",
            physical: true,
            sessionId: "IOS-SESSION-1",
        }));
        expect(realDumpPayload.source).toContain("XCUIElementTypeApplication");

        const statusAfterRealDump = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        const statusAfterRealDumpPayload = JSON.parse(((statusAfterRealDump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            session: { sessionId: string; serverUrl: string; physical: boolean };
        };
        expect(statusAfterRealDumpPayload.session).toEqual(expect.objectContaining({
            sessionId: "IOS-SESSION-1",
            serverUrl: realDumpPayload.serverUrl,
            physical: true,
        }));

        const realScreenshot = await client.callTool({
            name: "device_screenshot",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(realScreenshot.isError).not.toBe(true);
        expect((realScreenshot.content as Array<{ type: string; mimeType: string }>)[0]).toEqual(expect.objectContaining({
            type: "image",
            mimeType: "image/png",
        }));

        const realMobileScreenshot = await client.callTool({
            name: "mobile_screenshot",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(realMobileScreenshot.isError).not.toBe(true);
        expect((realMobileScreenshot.content as Array<{ type: string }>)[0].type).toBe("image");

        const realInstall = await client.callTool({
            name: "mobile_install_app",
            arguments: { deviceId: "ios-device-real-iphone", path: "/tmp/Real.app" },
        });
        expect(realInstall.isError).not.toBe(true);
        const realInstallPayload = JSON.parse(((realInstall.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            installed: string;
            udid: string;
            provider: string;
        };
        expect(realInstallPayload).toEqual(expect.objectContaining({
            installed: "/tmp/Real.app",
            udid: "00008110-001C195E0E91801E",
            provider: "xcrun-devicectl",
        }));

        const realLaunch = await client.callTool({
            name: "device_launch_app",
            arguments: { deviceId: "ios-device-real-iphone", bundleId: "com.example.Real" },
        });
        expect(realLaunch.isError).not.toBe(true);
        const realLaunchPayload = JSON.parse(((realLaunch.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            launched: string;
            udid: string;
            provider: string;
        };
        expect(realLaunchPayload).toEqual(expect.objectContaining({
            launched: "com.example.Real",
            udid: "00008110-001C195E0E91801E",
            provider: "xcrun-devicectl",
        }));

        const missingInstallPath = await client.callTool({
            name: "device_install_app",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(missingInstallPath.isError).toBe(true);
        expect((missingInstallPath.content as Array<{ text?: string }>)[0].text).toContain("requires path");

        const missingLaunchBundle = await client.callTool({
            name: "mobile_launch_app",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(missingLaunchBundle.isError).toBe(true);
        expect((missingLaunchBundle.content as Array<{ text?: string }>)[0].text).toContain("requires bundleId");

        writeFileSync(join(homeDir, "stale-ios-session"), "1");
        const realRecoveredDump = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(realRecoveredDump.isError).not.toBe(true);
        const realRecoveredPayload = JSON.parse(((realRecoveredDump.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            sessionId: string;
        };
        expect(realRecoveredPayload.sessionId).toBe("IOS-SESSION-1");
        await new Promise((resolve) => setTimeout(resolve, 100));

        const iosRealActions = [
            ["mobile_tap", { deviceId: "ios-device-real-iphone", x: 10, y: 20 }],
            ["mobile_double_tap", { deviceId: "ios-device-real-iphone", x: 11, y: 21 }],
            ["mobile_long_press", { deviceId: "ios-device-real-iphone", x: 12, y: 22, durationMs: 900 }],
            ["mobile_swipe", { deviceId: "ios-device-real-iphone", x1: 10, y1: 20, x2: 30, y2: 40, durationMs: 250 }],
            ["mobile_drag", { deviceId: "ios-device-real-iphone", x1: 15, y1: 25, x2: 35, y2: 45, durationMs: 800 }],
            ["mobile_type_text", { deviceId: "ios-device-real-iphone", text: "hello real ios" }],
            ["mobile_key", { deviceId: "ios-device-real-iphone", key: "Return" }],
            ["mobile_home", { deviceId: "ios-device-real-iphone" }],
            ["mobile_lock", { deviceId: "ios-device-real-iphone" }],
            ["mobile_unlock", { deviceId: "ios-device-real-iphone" }],
            ["mobile_rotate_left", { deviceId: "ios-device-real-iphone" }],
            ["mobile_rotate_right", { deviceId: "ios-device-real-iphone" }],
            ["mobile_set_orientation", { deviceId: "ios-device-real-iphone", orientation: "LANDSCAPE" }],
            ["mobile_wait_for_text", { deviceId: "ios-device-real-iphone", text: "Test", timeoutMs: 1000, intervalMs: 50 }],
            ["mobile_wait_for_app", { deviceId: "ios-device-real-iphone", bundleId: "com.example.Real", timeoutMs: 1000, intervalMs: 50 }],
            ["mobile_stop_app", { deviceId: "ios-device-real-iphone", bundleId: "com.example.Real" }],
        ] as const;
        for (const [name, callArgs] of iosRealActions) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError, `${name}: ${(action.content as Array<{ text?: string }>)[0]?.text ?? ""}`).not.toBe(true);
        }

        const missingRealIosKey = await client.callTool({
            name: "mobile_key",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(missingRealIosKey.isError).toBe(true);
        expect((missingRealIosKey.content as Array<{ text?: string }>)[0].text).toContain("mobile_key requires key or keyCode");

        const invalidRealIosOrientation = await client.callTool({
            name: "mobile_set_orientation",
            arguments: { deviceId: "ios-device-real-iphone", orientation: "upside-down" },
        });
        expect(invalidRealIosOrientation.isError).toBe(true);
        expect((invalidRealIosOrientation.content as Array<{ text?: string }>)[0].text).toContain("requires PORTRAIT or LANDSCAPE");

        const unsupportedRealIosPower = await client.callTool({
            name: "mobile_power",
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(unsupportedRealIosPower.isError).toBe(true);
        expect((unsupportedRealIosPower.content as Array<{ text?: string }>)[0].text).toContain("unavailable or unsafe for physical devices");

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "ios-device-real-iphone" },
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
            arguments: { deviceId: "ios-device-real-iphone" },
        });
        expect(detach.isError).not.toBe(true);
        const wifiDetach = await client.callTool({
            name: "device_detach",
            arguments: { deviceId: "ios-device-network-iphone" },
        });
        expect(wifiDetach.isError).not.toBe(true);
        expect(() => readFileSync(join(iosLeaseDir, `${encodeURIComponent("00008110-001C195E0E91801E")}.json`), "utf-8")).toThrow();
        expect(() => readFileSync(join(iosLeaseDir, `${encodeURIComponent("00008120-00AA00BB00CC00DD")}.json`), "utf-8")).toThrow();

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("xcrun xctrace list devices");
        expect(log).toContain("xcrun devicectl device install app --device 00008110-001C195E0E91801E /tmp/Real.app");
        expect(log).toContain("xcrun devicectl device process launch --device 00008110-001C195E0E91801E com.example.Real");
        expect(log).toContain('"appium:udid":"00008110-001C195E0E91801E"');
        expect(log).toContain('"appium:realDevice":true');
        expect(log).toContain("appium-command-body /session/IOS-SESSION-1/actions");
        expect(log).toContain('"gesture":"tap"');
        expect(log).toContain("hello real ios");
        expect(log).toContain('"script":"mobile: pressButton"');
        expect(log).toContain('"script":"mobile: activeAppInfo"');
        expect(log).toContain('"script":"mobile: terminateApp"');
        expect(log).toContain("appium-server-sigint ");
        expect(log.split("appium-http POST /session").length - 1).toBeGreaterThanOrEqual(2);
        expect(log).not.toContain("xcrun simctl shutdown 00008110-001C195E0E91801E");
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
            arguments: { deviceId: "ios-ios-metadata-only" },
        });
        expect(metadataDeleted.isError).not.toBe(true);

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
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("Refusing to start non-owned iOS Simulator name");

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
            arguments: { deviceId: "ios-foreign-ios-metadata", bundleId: "com.example.Test" },
        });
        expect(foreignAppReset.isError).toBe(true);
        expect((foreignAppReset.content as Array<{ text?: string }>)[0].text).toContain("Refusing iOS Simulator reset for non-owned simulator name");

        const eraseSimulator = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: "ios-foreign-ios-metadata", eraseSimulator: true },
        });
        expect(eraseSimulator.isError).toBe(true);
        expect((eraseSimulator.content as Array<{ text?: string }>)[0].text).toContain("Refusing to erase non-owned iOS Simulator name");

        const deleteSimulator = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-foreign-ios-metadata", deleteSimulator: true },
        });
        expect(deleteSimulator.isError).toBe(true);
        expect((deleteSimulator.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete non-owned iOS Simulator name");

        const foreignDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-foreign-ios-metadata" },
        });
        expect(foreignDeleted.isError).not.toBe(true);

        const log = readFileSync(logPath, "utf-8");
        expect(log).not.toContain(`xcrun simctl create ${metadataOnlyName}`);
        expect(log).not.toContain("xcrun simctl boot FOREIGN-UDID");
        expect(log).not.toContain("xcrun simctl get_app_container FOREIGN-UDID");
        expect(log).not.toContain("xcrun simctl erase FOREIGN-UDID");
        expect(log).not.toContain("xcrun simctl delete FOREIGN-UDID");
    });
});
