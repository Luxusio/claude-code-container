import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../..");
const TIMEOUT = 30000;

describe("device-lab MCP with fake Android SDK", () => {
    let client: Client;
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-android-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-android-bin-"));
        logPath = join(homeDir, "fake-android.log");

        const writeScript = (name: string, body: string) => {
            const path = join(binDir, name);
            writeFileSync(path, `#!/bin/sh\n${body}\n`);
            chmodSync(path, 0o755);
        };

        writeScript("emulator", `
echo "emulator $*" >> "$FAKE_ANDROID_LOG"
if [ "$1" = "-list-avds" ]; then
  echo "host_pixel"
  echo "ccc-external-other"
  exit 0
fi
exit 0
`);
        writeScript("adb", `
echo "adb $*" >> "$FAKE_ANDROID_LOG"
if [ "$1" = "-s" ]; then
  shift
  shift
fi
if [ "$1" = "devices" ] && [ "$2" = "-l" ]; then
  echo "List of devices attached"
  echo "R5CREAL123 device usb:1-1 product:oriole model:Pixel_6 device:oriole transport_id:7"
  echo "192.168.1.50:5555 device product:oriole model:Pixel_6 device:oriole transport_id:9"
  echo "192.168.1.60:5555 device product:oriole model:Pixel_6 device:oriole transport_id:10"
  echo "R5LEASED999 device usb:1-4 product:oriole model:Pixel_6 device:oriole transport_id:8"
  echo "UNAUTHORIZED unauthorized usb:1-2 model:Pixel_5"
  echo "OFFLINE offline usb:1-3 model:Pixel_4"
  echo "emulator-5554 device product:sdk_gphone"
  exit 0
fi
if [ "$1" = "connect" ]; then
  case "$2" in
    192.168.1.50:5555) echo "connected to $2"; exit 0 ;;
    *) echo "failed to connect to $2" >&2; exit 1 ;;
  esac
fi
if [ "$1" = "tcpip" ]; then
  case "$2" in
    5555) echo "restarting in TCP mode port: $2"; exit 0 ;;
    *) echo "failed to restart tcpip on $2" >&2; exit 1 ;;
  esac
fi
if [ "$1" = "pair" ]; then
  if [ "$2" = "192.168.1.70:37099" ] && [ "$3" = "123456" ]; then
    echo "Successfully paired to $2"
    exit 0
  fi
  echo "Failed to pair to $2" >&2
  exit 1
fi
if [ "$1" = "get-state" ]; then
  echo "device"
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "getprop" ] && [ "$3" = "sys.boot_completed" ]; then
  echo "1"
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "uiautomator" ] && [ "$3" = "dump" ]; then
  echo "UI hierchary dumped to: $4"
  exit 0
fi
if [ "$1" = "exec-out" ] && [ "$2" = "cat" ]; then
  printf '%s\\n' '<hierarchy><node text="Hello" resource-id="com.example:id/title"/></hierarchy>'
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "cat" ]; then
  printf '%s\\n' '<hierarchy><node text="Hello" resource-id="com.example:id/title"/></hierarchy>'
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "screenrecord" ]; then
  case "$5" in
    *fail-immediate*) exit 9 ;;
    *natural-exit*) exec /bin/sleep 0.3 ;;
    *) exec /bin/sleep 20 ;;
  esac
fi
if [ "$1" = "pull" ]; then
  case "$2" in
    *fail-pull*) exit 8 ;;
    *) exit 0 ;;
  esac
fi
if [ "$1" = "shell" ]; then
  echo "ok"
  exit 0
fi
exit 0
`);
        writeScript("avdmanager", `
echo "avdmanager $*" >> "$FAKE_ANDROID_LOG"
exit 0
`);

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: binDir,
                NODE_ENV: "test",
                FAKE_ANDROID_LOG: logPath,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-android-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("discovers avdmanager and reports Android host AVD inventory without starting emulators", { timeout: TIMEOUT }, async () => {
        const backends = await client.callTool({ name: "device_backends", arguments: {} });
        const backendPayload = JSON.parse(((backends.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            backends: Array<{
                name: string;
                status: string;
                tools: { adb?: string; emulator?: string; avdmanager?: string };
                provisioning: { available: boolean; missing: string[] };
            }>;
        };
        const android = backendPayload.backends.find((backend) => backend.name === "android-emulator");
        expect(android).toEqual(expect.objectContaining({
            status: "available",
            provisioning: { available: true, missing: [] },
        }));
        expect(android?.tools.avdmanager).toBe(join(binDir, "avdmanager"));

        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        expect(inventory.isError).not.toBe(true);
        const payload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            hostAvds: { available: boolean; avds: string[] };
            devices: Array<{ id: string }>;
        };
        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.hostAvds).toEqual({ available: true, missing: [], avds: ["host_pixel", "ccc-external-other"] });
        expect(payload.devices).toEqual([]);

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("emulator -list-avds");
        expect(log).not.toContain("emulator -avd");
    });

    it("creates and deletes owner-prefixed AVDs through avdmanager only when requested", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const avdName = `ccc-${ownerId}-pixel-owned`;

        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Pixel Owned",
                avdName,
                port: 5582,
                systemImage: "system-images;android-35;google_apis;x86_64",
                deviceProfile: "pixel_6",
                createAvd: true,
            },
        });
        expect(create.isError).not.toBe(true);
        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; avdName: string; provisioned: boolean; status: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "android-pixel-owned",
            avdName,
            provisioned: true,
            status: "stopped",
        }));

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "android-pixel-owned", bootTimeoutMs: 1000 },
        });
        expect(start.isError).not.toBe(true);
        const started = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; bootReady: boolean };
            boot: { ready: boolean };
        };
        expect(started.boot.ready).toBe(true);
        expect(started.device.status).toBe("running");
        expect(started.device.bootReady).toBe(true);

        const primitiveCalls = [
            ["mobile_tap", { deviceId: "android-pixel-owned", x: 10, y: 20 }],
            ["mobile_double_tap", { deviceId: "android-pixel-owned", x: 11, y: 21 }],
            ["mobile_long_press", { deviceId: "android-pixel-owned", x: 12, y: 22, durationMs: 900 }],
            ["mobile_swipe", { deviceId: "android-pixel-owned", x1: 1, y1: 2, x2: 30, y2: 40, durationMs: 500 }],
            ["mobile_drag", { deviceId: "android-pixel-owned", x1: 3, y1: 4, x2: 50, y2: 60, durationMs: 800 }],
            ["mobile_type_text", { deviceId: "android-pixel-owned", text: "hello world" }],
            ["mobile_key", { deviceId: "android-pixel-owned", keyCode: 82 }],
            ["mobile_home", { deviceId: "android-pixel-owned" }],
            ["mobile_back", { deviceId: "android-pixel-owned" }],
            ["mobile_forward", { deviceId: "android-pixel-owned" }],
            ["mobile_recents", { deviceId: "android-pixel-owned" }],
            ["mobile_power", { deviceId: "android-pixel-owned" }],
            ["mobile_lock", { deviceId: "android-pixel-owned" }],
            ["mobile_unlock", { deviceId: "android-pixel-owned" }],
            ["mobile_set_orientation", { deviceId: "android-pixel-owned", orientation: "landscape" }],
            ["mobile_rotate_left", { deviceId: "android-pixel-owned" }],
            ["mobile_rotate_right", { deviceId: "android-pixel-owned" }],
            ["mobile_open_url", { deviceId: "android-pixel-owned", url: "https://example.test/path" }],
            ["mobile_grant_permission", { deviceId: "android-pixel-owned", packageName: "com.example.mobile", permission: "android.permission.CAMERA" }],
            ["mobile_revoke_permission", { deviceId: "android-pixel-owned", packageName: "com.example.mobile", permission: "android.permission.CAMERA" }],
            ["mobile_set_location", { deviceId: "android-pixel-owned", latitude: 37.7749, longitude: -122.4194, altitude: 10 }],
            ["mobile_set_battery", { deviceId: "android-pixel-owned", level: 42, charging: true }],
            ["mobile_set_network", { deviceId: "android-pixel-owned", wifi: false, data: true }],
            ["mobile_toggle_airplane_mode", { deviceId: "android-pixel-owned", enabled: true }],
            ["mobile_set_clipboard", { deviceId: "android-pixel-owned", text: "clip text" }],
            ["mobile_get_clipboard", { deviceId: "android-pixel-owned" }],
        ] as const;
        for (const [name, callArgs] of primitiveCalls) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError).not.toBe(true);
        }
        const waitText = await client.callTool({
            name: "mobile_wait_for_text",
            arguments: { deviceId: "android-pixel-owned", text: "Hello", timeoutMs: 1000, intervalMs: 50 },
        });
        expect(waitText.isError).not.toBe(true);
        const waitTextPayload = JSON.parse(((waitText.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            found: boolean;
            provider: string;
        };
        expect(waitTextPayload).toEqual(expect.objectContaining({ found: true, provider: "adb-uiautomator" }));

        const waitApp = await client.callTool({
            name: "mobile_wait_for_app",
            arguments: { deviceId: "android-pixel-owned", packageName: "com.example.mobile", timeoutMs: 1000, intervalMs: 50 },
        });
        expect(waitApp.isError).not.toBe(true);
        const waitAppPayload = JSON.parse(((waitApp.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            running: boolean;
            provider: string;
        };
        expect(waitAppPayload).toEqual(expect.objectContaining({ running: true, provider: "adb" }));

        const flow = await client.callTool({
            name: "mobile_run_flow",
            arguments: {
                steps: [
                    { label: "tap primary", tool: "mobile_tap", arguments: { deviceId: "android-pixel-owned", x: 15, y: 25 } },
                    { label: "wait title", tool: "mobile_wait_for_text", arguments: { deviceId: "android-pixel-owned", text: "Hello", timeoutMs: 1000, intervalMs: 50 } },
                    { label: "capture", tool: "mobile_screenshot", arguments: { deviceId: "android-pixel-owned" } },
                ],
            },
        });
        expect(flow.isError).not.toBe(true);
        const flowPayload = JSON.parse(((flow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            results: Array<{ label: string; isError: boolean; content: Array<{ type: string; value?: { found?: boolean }; bytes?: number }> }>;
        };
        expect(flowPayload.ok).toBe(true);
        expect(flowPayload.results.map((result) => result.label)).toEqual(["tap primary", "wait title", "capture"]);
        expect(flowPayload.results[1].content[0].value?.found).toBe(true);
        expect(flowPayload.results[2].content[0]).toEqual(expect.objectContaining({ type: "image" }));
        expect(typeof flowPayload.results[2].content[0].bytes).toBe("number");

        const disallowedFlow = await client.callTool({
            name: "mobile_run_flow",
            arguments: {
                steps: [
                    { tool: "device_start", arguments: { deviceId: "android-pixel-owned" } },
                    { tool: "mobile_back", arguments: { deviceId: "android-pixel-owned" } },
                ],
            },
        });
        expect(disallowedFlow.isError).not.toBe(true);
        const disallowedPayload = JSON.parse(((disallowedFlow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            stoppedAt: number;
            results: Array<{ error: string }>;
        };
        expect(disallowedPayload.ok).toBe(false);
        expect(disallowedPayload.stoppedAt).toBe(0);
        expect(disallowedPayload.results[0].error).toContain("does not allow step tool: device_start");

        const screenshot = await client.callTool({
            name: "mobile_screenshot",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(screenshot.isError).not.toBe(true);
        expect((screenshot.content as Array<{ type: string }>)[0].type).toBe("image");

        const initialRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(initialRecordStatus.isError).not.toBe(true);
        const initialRecordPayload = JSON.parse(((initialRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: unknown;
            provider: string;
        };
        expect(initialRecordPayload.recording).toBeNull();
        expect(initialRecordPayload.provider).toBe("adb-screenrecord");

        const stopWithoutRecording = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(stopWithoutRecording.isError).toBe(true);
        expect((stopWithoutRecording.content as Array<{ text?: string }>)[0].text).toContain("No Android recording active");

        const recordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-pixel-owned",
                remotePath: "/sdcard/custom-android-recording.mp4",
                localPath: "/tmp/custom-android-recording.mp4",
                timeLimitSec: 5,
            },
        });
        expect(recordStart.isError).not.toBe(true);
        const recordStartPayload = JSON.parse(((recordStart.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string; remotePath: string; localPath: string; timeLimitSec: number };
        };
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "adb-screenrecord",
            remotePath: "/sdcard/custom-android-recording.mp4",
            localPath: "/tmp/custom-android-recording.mp4",
            timeLimitSec: 5,
        }));

        const duplicateRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(duplicateRecordStart.isError).toBe(true);
        expect((duplicateRecordStart.content as Array<{ text?: string }>)[0].text).toContain("Android recording already active");

        const activeRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        const activeRecordPayload = JSON.parse(((activeRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string };
        };
        expect(activeRecordPayload.recording).toEqual(expect.objectContaining({ active: true, provider: "adb-screenrecord" }));

        const recordStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "android-pixel-owned" },
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
            localPath: "/tmp/custom-android-recording.mp4",
        }));
        expect(recordStopPayload.device.recording).toBeNull();

        const finalRecordStatus = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((finalRecordStatus.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            recording: null,
            provider: "adb-screenrecord",
        }));

        const failedRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-pixel-owned",
                remotePath: "/sdcard/fail-immediate-recording.mp4",
                localPath: "/tmp/fail-immediate-android-recording.mp4",
                timeLimitSec: 5,
            },
        });
        expect(failedRecordStart.isError).toBe(true);
        expect((failedRecordStart.content as Array<{ text?: string }>)[0].text).toContain("recorder exited before it was ready");
        const statusAfterFailedStart = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((statusAfterFailedStart.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const naturalExitStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-pixel-owned",
                remotePath: "/sdcard/natural-exit-recording.mp4",
                localPath: "/tmp/natural-exit-android-recording.mp4",
                timeLimitSec: 5,
            },
        });
        expect(naturalExitStart.isError).not.toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const statusAfterNaturalExit = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((statusAfterNaturalExit.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const pullFailStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-pixel-owned",
                remotePath: "/sdcard/fail-pull-recording.mp4",
                localPath: "/tmp/fail-pull-android-recording.mp4",
                timeLimitSec: 5,
            },
        });
        expect(pullFailStart.isError).not.toBe(true);
        const pullFailStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(pullFailStop.isError).toBe(true);
        expect((pullFailStop.content as Array<{ text?: string }>)[0].text).toContain("Android recording state cleared");
        const statusAfterPullFailure = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((statusAfterPullFailure.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const stopCleanupRecordStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-pixel-owned",
                remotePath: "/sdcard/stop-cleanup-recording.mp4",
                localPath: "/tmp/stop-cleanup-android-recording.mp4",
                timeLimitSec: 5,
            },
        });
        expect(stopCleanupRecordStart.isError).not.toBe(true);

        const dumpUi = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(dumpUi.isError).not.toBe(true);
        const dumpPayload = JSON.parse(((dumpUi.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            provider: string;
            source: string;
            remotePath: string;
        };
        expect(dumpPayload.provider).toBe("adb-uiautomator");
        expect(dumpPayload.source).toContain("<hierarchy>");
        expect(dumpPayload.remotePath).toContain("android-pixel-owned");

        const fileAndAppCalls = [
            ["device_upload", { deviceId: "android-pixel-owned", localPath: "/tmp/local.txt", remotePath: "/sdcard/local.txt" }],
            ["device_download", { deviceId: "android-pixel-owned", remotePath: "/sdcard/remote.txt", localPath: "/tmp/remote.txt" }],
            ["device_install_app", { deviceId: "android-pixel-owned", path: "/tmp/Test.apk" }],
            ["device_launch_app", { deviceId: "android-pixel-owned", packageName: "com.example.test" }],
            ["device_launch_app", { deviceId: "android-pixel-owned", component: "com.example.test/.MainActivity" }],
            ["device_reset", { deviceId: "android-pixel-owned", packageName: "com.example.test" }],
            ["mobile_install_app", { deviceId: "android-pixel-owned", path: "/tmp/Mobile.apk" }],
            ["mobile_launch_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
            ["mobile_uninstall_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
            ["mobile_stop_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
            ["mobile_clear_app_data", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
        ] as const;
        for (const [name, callArgs] of fileAndAppCalls) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError).not.toBe(true);
        }

        const deleteWhileRunning = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-pixel-owned", deleteAvd: true },
        });
        expect(deleteWhileRunning.isError).toBe(true);

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(stop.isError).not.toBe(true);
        const stoppedPayload = JSON.parse(((stop.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { recording: unknown; status: string };
        };
        expect(stoppedPayload.device.status).toBe("stopped");
        expect(stoppedPayload.device.recording).toBeNull();

        const statusAfterDeviceStop = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((statusAfterDeviceStop.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-pixel-owned", deleteAvd: true },
        });
        expect(deleted.isError).not.toBe(true);
        const deletedPayload = JSON.parse(((deleted.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            avdDeleted: boolean;
        };
        expect(deletedPayload).toEqual({ deleted: "android-pixel-owned", avdDeleted: true });

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`avdmanager create avd --name ${avdName} --package system-images;android-35;google_apis;x86_64 --force --device pixel_6`);
        expect(log).toContain(`emulator -avd ${avdName}`);
        expect(log).toContain("adb -s emulator-5582 shell getprop sys.boot_completed");
        expect(log).toContain("adb -s emulator-5582 shell input tap 10 20");
        expect(log).toContain("adb -s emulator-5582 shell input swipe 12 22 12 22 900");
        expect(log).toContain("adb -s emulator-5582 shell input swipe 1 2 30 40 500");
        expect(log).toContain("adb -s emulator-5582 shell input swipe 3 4 50 60 800");
        expect(log).toContain("adb -s emulator-5582 shell input text hello%sworld");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 82");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 3");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 4");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 125");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 187");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 26");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 223");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 224");
        expect(log).toContain("adb -s emulator-5582 shell settings put system accelerometer_rotation 0");
        expect(log).toContain("adb -s emulator-5582 shell settings put system user_rotation 1");
        expect(log).toContain("adb -s emulator-5582 shell settings put system user_rotation 3");
        expect(log).toContain("adb -s emulator-5582 shell am start -a android.intent.action.VIEW -d https://example.test/path");
        expect(log).toContain("adb -s emulator-5582 shell pm grant com.example.mobile android.permission.CAMERA");
        expect(log).toContain("adb -s emulator-5582 shell pm revoke com.example.mobile android.permission.CAMERA");
        expect(log).toContain("adb -s emulator-5582 emu geo fix -122.4194 37.7749 10");
        expect(log).toContain("adb -s emulator-5582 shell dumpsys battery set level 42");
        expect(log).toContain("adb -s emulator-5582 shell dumpsys battery set ac 1");
        expect(log).toContain("adb -s emulator-5582 shell svc wifi disable");
        expect(log).toContain("adb -s emulator-5582 shell svc data enable");
        expect(log).toContain("adb -s emulator-5582 shell settings put global airplane_mode_on 1");
        expect(log).toContain("adb -s emulator-5582 shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true");
        expect(log).toContain("adb -s emulator-5582 shell cmd clipboard set clip text");
        expect(log).toContain("adb -s emulator-5582 shell cmd clipboard get");
        expect(log).toContain("adb -s emulator-5582 shell pidof com.example.mobile");
        expect(log).toContain("adb -s emulator-5582 shell input tap 15 25");
        expect(log).toContain("adb -s emulator-5582 exec-out screencap -p");
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/custom-android-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell pkill -2 screenrecord");
        expect(log).toContain("adb -s emulator-5582 pull /sdcard/custom-android-recording.mp4 /tmp/custom-android-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell rm -f /sdcard/custom-android-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/fail-immediate-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/natural-exit-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 pull /sdcard/fail-pull-recording.mp4 /tmp/fail-pull-android-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/stop-cleanup-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell uiautomator dump /sdcard/window-android-pixel-owned.xml");
        expect(log).toContain("adb -s emulator-5582 exec-out cat /sdcard/window-android-pixel-owned.xml");
        expect(log).toContain("adb -s emulator-5582 push /tmp/local.txt /sdcard/local.txt");
        expect(log).toContain("adb -s emulator-5582 pull /sdcard/remote.txt /tmp/remote.txt");
        expect(log).toContain("adb -s emulator-5582 install -r /tmp/Test.apk");
        expect(log).toContain("adb -s emulator-5582 shell monkey -p com.example.test 1");
        expect(log).toContain("adb -s emulator-5582 shell am start -n com.example.test/.MainActivity");
        expect(log).toContain("adb -s emulator-5582 shell pm clear com.example.test");
        expect(log).toContain("adb -s emulator-5582 install -r /tmp/Mobile.apk");
        expect(log).toContain("adb -s emulator-5582 shell monkey -p com.example.mobile 1");
        expect(log).toContain("adb -s emulator-5582 uninstall com.example.mobile");
        expect(log).toContain("adb -s emulator-5582 shell am force-stop com.example.mobile");
        expect(log).toContain("adb -s emulator-5582 shell pm clear com.example.mobile");
        expect(log).toContain(`avdmanager delete avd --name ${avdName}`);
        expect(log).not.toContain("appium");
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
        }));
        writeFileSync(join(androidLeaseDir, `${encodeURIComponent("192.168.1.52:5555")}.json`), JSON.stringify({
            backend: "android-device",
            hardwareId: "192.168.1.52:5555",
            ownerId: "other-owner",
            deviceId: "android-device-wifi-foreign",
        }));
        const rejectLeased = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Already Leased", serial: "R5LEASED999" },
        });
        expect(rejectLeased.isError).toBe(true);
        expect((rejectLeased.content as Array<{ text?: string }>)[0].text).toContain("already attached by another CCC owner");
        const rejectWifiLeased = await client.callTool({
            name: "device_attach",
            arguments: { backend: "android-device", name: "Already Leased WiFi", connection: "wifi", host: "192.168.1.52" },
        });
        expect(rejectWifiLeased.isError).toBe(true);
        expect((rejectWifiLeased.content as Array<{ text?: string }>)[0].text).toContain("already attached by another CCC owner");

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
            device: { id: string; backend: string; serial: string; status: string; creatable: boolean; physical: boolean };
        };
        expect(attached.device).toEqual(expect.objectContaining({
            id: "android-device-real-pixel",
            backend: "android-device",
            serial: "R5CREAL123",
            connection: "usb",
            status: "attached",
            creatable: false,
            physical: true,
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
            hostState: { stdout: string };
            backend: { name: string; attachable: boolean };
        };
        expect(statusPayload.hostState.stdout).toBe("device");
        expect(statusPayload.backend).toEqual(expect.objectContaining({ name: "android-device", attachable: true }));

        for (const [tool, args] of [
            ["device_exec", { deviceId: "android-device-real-pixel", command: "echo ok" }],
            ["mobile_tap", { deviceId: "android-device-real-pixel", x: 10, y: 20 }],
            ["mobile_back", { deviceId: "android-device-real-pixel" }],
            ["mobile_dump_ui", { deviceId: "android-device-real-pixel" }],
            ["mobile_wait_for_text", { deviceId: "android-device-real-pixel", text: "Hello", timeoutMs: 100, intervalMs: 50 }],
            ["device_install_app", { deviceId: "android-device-real-pixel", path: "/tmp/Real.apk" }],
            ["device_launch_app", { deviceId: "android-device-real-pixel", packageName: "com.example.real" }],
            ["device_screenshot", { deviceId: "android-device-real-pixel" }],
        ] as Array<[string, Record<string, unknown>]>) {
            const result = await client.callTool({ name: tool, arguments: args });
            expect(result.isError, tool).not.toBe(true);
        }

        const unsafeBattery = await client.callTool({
            name: "mobile_set_battery",
            arguments: { deviceId: "android-device-real-pixel", level: 10 },
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

    it("refuses avdmanager create/delete for non-owned Android AVD names", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const metadataOnlyAvd = `ccc-${ownerId}-metadata-only`;

        const metadataWithSystemImage = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Metadata System Image",
                avdName: metadataOnlyAvd,
                systemImage: "system-images;android-35;google_apis;x86_64",
            },
        });
        expect(metadataWithSystemImage.isError).not.toBe(true);
        const metadataPayload = JSON.parse(((metadataWithSystemImage.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { provisioned: boolean; systemImage: string };
        };
        expect(metadataPayload.device.provisioned).toBe(false);
        expect(metadataPayload.device.systemImage).toBe("system-images;android-35;google_apis;x86_64");

        const metadataSystemImageDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-metadata-system-image" },
        });
        expect(metadataSystemImageDeleted.isError).not.toBe(true);

        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Foreign Create",
                avdName: "foreign-avd",
                systemImage: "system-images;android-35;google_apis;x86_64",
                createAvd: true,
            },
        });
        expect(create.isError).toBe(true);
        expect((create.content as Array<{ text?: string }>)[0].text).toContain("Refusing to create non-owned Android AVD name");

        const metadataOnly = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Foreign Metadata",
                avdName: "foreign-avd",
            },
        });
        expect(metadataOnly.isError).not.toBe(true);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "android-foreign-metadata", bootTimeoutMs: 1000 },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("Refusing to start non-owned Android AVD name");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-foreign-metadata", deleteAvd: true },
        });
        expect(deleted.isError).toBe(true);
        expect((deleted.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete non-owned Android AVD name");

        const metadataDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-foreign-metadata" },
        });
        expect(metadataDeleted.isError).not.toBe(true);

        const log = readFileSync(logPath, "utf-8");
        expect(log).not.toContain(`avdmanager create avd --name ${metadataOnlyAvd}`);
        expect(log).not.toContain("emulator -avd foreign-avd");
    });
});
