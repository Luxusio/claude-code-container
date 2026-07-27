import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { androidWindowsHiddenLauncherScript } from "../../device-lab-mcp/src/backends/android.mjs";
import { withSharedMutationLockAsync } from "../../device-lab-mcp/src/state/shared-mutation-lock.mjs";
import { cleanupFakeAndroidMcpContext, createFakeAndroidMcpContext, TIMEOUT, type FakeAndroidMcpContext } from "./helpers/fake-android-mcp-fixture.js";

function parseToolJson(result: { content?: unknown }) {
    return JSON.parse((((result.content as Array<{ text?: string }> | undefined) ?? [])[0]?.text ?? "{}")) as Record<string, unknown>;
}

describe("device-lab MCP Android emulator lifecycle with fake SDK", () => {
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

    it("builds a hidden Windows launcher for emulator starts without a console log window", () => {
        const script = androidWindowsHiddenLauncherScript("C:\\Users\\TestUser\\Android Sdk\\emulator\\emulator.exe", [
            "-avd",
            "Pixel 8",
            "-netsim-args",
            "--no-cli-ui --no-web-ui",
        ]);

        expect(script).toContain("WScript.Shell");
        expect(script).toContain("%ComSpec% /d /s /c");
        expect(script).toContain("\"\"C:\\Users\\TestUser\\Android Sdk\\emulator\\emulator.exe\"\"");
        expect(script).toContain("\"\"--no-cli-ui --no-web-ui\"\"");
        expect(script).toContain(">NUL 2>NUL");
        expect(script).toContain(", 0, True");
    });

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
        expect(created.device).not.toHaveProperty("avdRoot");
        const avdDataPath = join(homeDir, ".android", "avd", `${avdName}.avd`);
        const avdIniPath = join(homeDir, ".android", "avd", `${avdName}.ini`);
        mkdirSync(avdDataPath, { recursive: true });
        writeFileSync(join(avdDataPath, "userdata-qemu.img"), "owned-avd-data");
        writeFileSync(avdIniPath, `path=${avdDataPath}`);

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

        let releaseOperation!: () => void;
        let operationEntered!: () => void;
        const operationGate = new Promise<void>((resolve) => { releaseOperation = resolve; });
        const operationLockEntered = new Promise<void>((resolve) => { operationEntered = resolve; });
        const [testOwnerId] = readdirSync(join(homeDir, ".ccc", "devices", "owners"));
        const operationKey = createHash("sha256").update("android-pixel-owned").digest("hex").slice(0, 32);
        const operationLock = join(homeDir, ".ccc", "devices", "owners", testOwnerId, "android", "operations", `${operationKey}.lock`);
        const operationHolder = withSharedMutationLockAsync(operationLock, async () => {
            operationEntered();
            await operationGate;
        });
        await operationLockEntered;
        let execSettled = false;
        const serializedExec = client.callTool({
            name: "device_exec",
            arguments: { deviceId: "android-pixel-owned", command: "echo serialized" },
        }).then((result) => {
            execSettled = true;
            return result;
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(execSettled).toBe(false);
            const waitResult = await client.callTool({
                name: "mobile_wait_for_app",
                arguments: { deviceId: "android-pixel-owned", packageName: "com.example.ready", timeoutMs: 100, intervalMs: 10 },
            });
            expect(waitResult.isError).not.toBe(true);
        } finally {
            releaseOperation();
            await operationHolder;
        }
        expect((await serializedExec).isError).not.toBe(true);

        const sessionStatus = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(sessionStatus.isError).not.toBe(true);
        expect(parseToolJson(sessionStatus)).toEqual(expect.objectContaining({
            deviceId: "android-pixel-owned",
            device: expect.objectContaining({ id: "android-pixel-owned", status: "running" }),
            provider: "adb",
            lazy: true,
        }));

        const primitiveCalls: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
            ["mobile_tap", { deviceId: "android-pixel-owned", x: 10, y: 20 }, { provider: "adb", tapped: { x: 10, y: 20 } }],
            ["mobile_double_tap", { deviceId: "android-pixel-owned", x: 11, y: 21 }, { provider: "adb", doubleTapped: { x: 11, y: 21 } }],
            ["mobile_long_press", { deviceId: "android-pixel-owned", x: 12, y: 22, durationMs: 900 }, { provider: "adb", longPressed: { x: 12, y: 22, durationMs: 900 } }],
            ["mobile_swipe", { deviceId: "android-pixel-owned", x1: 1, y1: 2, x2: 30, y2: 40, durationMs: 500 }, { provider: "adb", swiped: { x1: 1, y1: 2, x2: 30, y2: 40, durationMs: 500 } }],
            ["mobile_drag", { deviceId: "android-pixel-owned", x1: 3, y1: 4, x2: 50, y2: 60, durationMs: 800 }, { provider: "adb", dragged: { x1: 3, y1: 4, x2: 50, y2: 60, durationMs: 800 } }],
            ["mobile_type_text", { deviceId: "android-pixel-owned", text: "hello world" }, { provider: "adb", typed: true }],
            ["mobile_key", { deviceId: "android-pixel-owned", keyCode: 82 }, { provider: "adb", key: 82 }],
            ["mobile_home", { deviceId: "android-pixel-owned" }, { provider: "adb", home: true }],
            ["mobile_back", { deviceId: "android-pixel-owned" }, { provider: "adb", back: true }],
            ["mobile_forward", { deviceId: "android-pixel-owned" }, { provider: "adb", forward: true }],
            ["mobile_recents", { deviceId: "android-pixel-owned" }, { provider: "adb", recents: true }],
            ["mobile_power", { deviceId: "android-pixel-owned" }, { provider: "adb", power: true }],
            ["mobile_lock", { deviceId: "android-pixel-owned" }, { provider: "adb", locked: true }],
            ["mobile_unlock", { deviceId: "android-pixel-owned" }, { provider: "adb", unlocked: true }],
            ["mobile_set_orientation", { deviceId: "android-pixel-owned", orientation: "landscape" }, { provider: "adb", orientation: "landscape", rotation: "1" }],
            ["mobile_rotate_left", { deviceId: "android-pixel-owned" }, { provider: "adb", orientation: "landscape", rotation: "1" }],
            ["mobile_rotate_right", { deviceId: "android-pixel-owned" }, { provider: "adb", orientation: "reverse-landscape", rotation: "3" }],
            ["mobile_open_url", { deviceId: "android-pixel-owned", url: "https://example.test/path" }, { provider: "adb", openedUrl: "https://example.test/path" }],
            ["mobile_grant_permission", { deviceId: "android-pixel-owned", packageName: "com.example.mobile", permission: "android.permission.CAMERA" }, { provider: "adb", permission: { packageName: "com.example.mobile", permission: "android.permission.CAMERA", action: "grant" } }],
            ["mobile_revoke_permission", { deviceId: "android-pixel-owned", packageName: "com.example.mobile", permission: "android.permission.CAMERA" }, { provider: "adb", permission: { packageName: "com.example.mobile", permission: "android.permission.CAMERA", action: "revoke" } }],
            ["mobile_set_location", { deviceId: "android-pixel-owned", latitude: 37.7749, longitude: -122.4194, altitude: 10 }, { provider: "adb-emulator", location: { latitude: 37.7749, longitude: -122.4194, altitude: 10 } }],
            ["mobile_set_battery", { deviceId: "android-pixel-owned", level: 42, charging: true, confirmDestructive: true }, { provider: "adb", battery: { level: 42, status: null, charging: true } }],
            ["mobile_set_network", { deviceId: "android-pixel-owned", wifi: false, data: true, confirmDestructive: true }, { provider: "adb", network: { wifi: false, data: true } }],
            ["mobile_toggle_airplane_mode", { deviceId: "android-pixel-owned", enabled: true, confirmDestructive: true }, { provider: "adb", airplaneMode: true }],
            ["mobile_set_clipboard", { deviceId: "android-pixel-owned", text: "clip text" }, { provider: "adb", clipboard: { set: true } }],
            ["mobile_get_clipboard", { deviceId: "android-pixel-owned" }, { provider: "adb", text: "ok\n", status: 0 }],
        ] as const;
        for (const [name, callArgs, expectedPayload] of primitiveCalls) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError, name).not.toBe(true);
            expect(parseToolJson(action)).toEqual(expect.objectContaining(expectedPayload));
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
                    { label: "tap primary", tool: "mobile_tap", arguments: { deviceId: "android-pixel-owned", x: 15, y: 25, implicitBroker: false } },
                    { label: "wait title", tool: "mobile_wait_for_text", arguments: { deviceId: "android-pixel-owned", text: "Hello", timeoutMs: 1000, intervalMs: 50, implicitBroker: false } },
                    { label: "capture", tool: "mobile_screenshot", arguments: { deviceId: "android-pixel-owned", implicitBroker: false } },
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

        const deviceFlow = await client.callTool({
            name: "device_run_flow",
            arguments: {
                steps: [
                    { label: "status", tool: "device_status", arguments: { deviceId: "android-pixel-owned", implicitBroker: false } },
                    { label: "wait title", tool: "mobile_wait_for_text", arguments: { deviceId: "android-pixel-owned", text: "Hello", timeoutMs: 1000, intervalMs: 50, implicitBroker: false } },
                    { label: "capture", tool: "mobile_screenshot", arguments: { deviceId: "android-pixel-owned", implicitBroker: false } },
                ],
            },
        });
        expect(deviceFlow.isError).not.toBe(true);
        const deviceFlowPayload = JSON.parse(((deviceFlow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            results: Array<{ label: string; isError: boolean; content: Array<{ type: string; value?: { device?: { id?: string }; found?: boolean }; bytes?: number }> }>;
        };
        expect(deviceFlowPayload.ok).toBe(true);
        expect(deviceFlowPayload.results.map((result) => result.label)).toEqual(["status", "wait title", "capture"]);
        expect(deviceFlowPayload.results[0].content[0].value?.device?.id).toBe("android-pixel-owned");
        expect(deviceFlowPayload.results[1].content[0].value?.found).toBe(true);
        expect(deviceFlowPayload.results[2].content[0]).toEqual(expect.objectContaining({ type: "image" }));
        expect(typeof deviceFlowPayload.results[2].content[0].bytes).toBe("number");

        const unsafeDeviceFlow = await client.callTool({
            name: "device_run_flow",
            arguments: {
                steps: [
                    { tool: "mobile_install_app", arguments: { deviceId: "android-pixel-owned", path: "/tmp/app.apk" } },
                    { tool: "mobile_back", arguments: { deviceId: "android-pixel-owned" } },
                ],
            },
        });
        expect(unsafeDeviceFlow.isError).not.toBe(true);
        const unsafeDeviceFlowPayload = JSON.parse(((unsafeDeviceFlow.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ok: boolean;
            stoppedAt: number;
            results: Array<{ error: string }>;
        };
        expect(unsafeDeviceFlowPayload.ok).toBe(false);
        expect(unsafeDeviceFlowPayload.stoppedAt).toBe(0);
        expect(unsafeDeviceFlowPayload.results[0].error).toContain("device_run_flow does not allow step tool: mobile_install_app");

        const screenshot = await client.callTool({
            name: "mobile_screenshot",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(screenshot.isError).not.toBe(true);
        const expectedAndroidPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("FAKEPNG")]).toString("base64");
        expect((screenshot.content as Array<{ type: string; data: string; mimeType: string }>)[0]).toEqual({
            type: "image",
            data: expectedAndroidPng,
            mimeType: "image/png",
        });

        const largeScreencapMarker = join(homeDir, "fake-screencap-large");
        writeFileSync(largeScreencapMarker, "1");
        try {
            const largeScreenshot = await client.callTool({
                name: "device_screenshot",
                arguments: { deviceId: "android-pixel-owned" },
            });
            expect(largeScreenshot.isError).not.toBe(true);
            const image = (largeScreenshot.content as Array<{ type: string; data: string; mimeType: string }>)[0];
            expect(image.type).toBe("image");
            expect(Buffer.from(image.data, "base64").length).toBeGreaterThan(2 * 1024 * 1024);
        } finally {
            rmSync(largeScreencapMarker, { force: true });
        }

        const flakyScreencapMarker = join(homeDir, "fake-screencap-exit-1");
        writeFileSync(flakyScreencapMarker, "1");
        try {
            const flakyScreenshot = await client.callTool({
                name: "device_screenshot",
                arguments: { deviceId: "android-pixel-owned" },
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
            recording: { active: boolean; provider: string; runtimeId: string; processIdentity: { pid: number; startToken: string; commandHash: string }; remotePath: string; localPath: string; timeLimitSec: number };
        };
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "adb-screenrecord",
            runtimeId: expect.any(String),
            processIdentity: expect.objectContaining({
                pid: expect.any(Number),
                startToken: expect.any(String),
                commandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
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
            provider: string;
            recording: { active: boolean; provider: string; remotePath: string; localPath: string; timeLimitSec: number };
            device: { recording: unknown };
        };
        expect(recordStopPayload.stopped).toBe(true);
        expect(recordStopPayload.provider).toBe("adb-screenrecord");
        expect(recordStopPayload.recording).toEqual(expect.objectContaining({
            active: false,
            provider: "adb-screenrecord",
            remotePath: "/sdcard/custom-android-recording.mp4",
            localPath: "/tmp/custom-android-recording.mp4",
            timeLimitSec: 5,
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
        expect(JSON.parse(((statusAfterNaturalExit.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({
            active: false,
            remotePath: "/sdcard/natural-exit-recording.mp4",
        }));
        const naturalExitStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(naturalExitStop.isError).not.toBe(true);

        const retryDestination = "/tmp/fail-once-pull-android-recording.mp4";
        writeFileSync(retryDestination, "original");
        const pullFailStart = await client.callTool({
            name: "device_record_video_start",
            arguments: {
                deviceId: "android-pixel-owned",
                remotePath: "/sdcard/fail-once-pull-recording.mp4",
                localPath: retryDestination,
                timeLimitSec: 5,
            },
        });
        expect(pullFailStart.isError).not.toBe(true);
        const pullFailStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(pullFailStop.isError).toBe(true);
        expect((pullFailStop.content as Array<{ text?: string }>)[0].text).toContain("Android recording remains pending finalization");
        expect(readFileSync(retryDestination, "utf8")).toBe("original");
        const statusAfterPullFailure = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((statusAfterPullFailure.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({
            active: false,
            remotePath: "/sdcard/fail-once-pull-recording.mp4",
        }));
        const pullRetryStop = await client.callTool({
            name: "device_record_video_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(pullRetryStop.isError).not.toBe(true);
        expect(readFileSync(retryDestination, "utf8")).toBe("downloaded");
        const statusAfterPullRetry = await client.callTool({
            name: "device_record_video_status",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(JSON.parse(((statusAfterPullRetry.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

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

        const localUploadPath = join(homeDir, "android-local.txt");
        const localDownloadPath = join(homeDir, "android-remote.txt");
        writeFileSync(localUploadPath, "android local");
        const fileAndAppCalls: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
            ["device_upload", { deviceId: "android-pixel-owned", localPath: localUploadPath, remotePath: "/sdcard/local.txt" }, { provider: "adb", uploaded: { localPath: localUploadPath, remotePath: "/sdcard/local.txt" } }],
            ["device_download", { deviceId: "android-pixel-owned", remotePath: "/sdcard/remote.txt", localPath: localDownloadPath }, { provider: "adb", downloaded: { remotePath: "/sdcard/remote.txt", localPath: localDownloadPath } }],
            ["device_install_app", { deviceId: "android-pixel-owned", path: "/tmp/Test.apk" }, { provider: "adb", installed: "/tmp/Test.apk" }],
            ["device_launch_app", { deviceId: "android-pixel-owned", packageName: "com.example.test" }, { provider: "adb", launched: "com.example.test" }],
            ["device_launch_app", { deviceId: "android-pixel-owned", component: "com.example.test/.MainActivity" }, { provider: "adb", launched: "com.example.test/.MainActivity" }],
            ["device_reset", { deviceId: "android-pixel-owned", packageName: "com.example.test", confirmDestructive: true }, { provider: "adb", reset: { packageName: "com.example.test" } }],
            ["mobile_install_app", { deviceId: "android-pixel-owned", path: "/tmp/Mobile.apk" }, { provider: "adb", installed: "/tmp/Mobile.apk" }],
            ["mobile_launch_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }, { provider: "adb", launched: "com.example.mobile" }],
            ["mobile_uninstall_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile", confirmDestructive: true }, { provider: "adb", uninstalled: "com.example.mobile" }],
            ["mobile_stop_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }, { provider: "adb", stopped: "com.example.mobile" }],
            ["mobile_clear_app_data", { deviceId: "android-pixel-owned", packageName: "com.example.mobile", confirmDestructive: true }, { provider: "adb", reset: { packageName: "com.example.mobile" } }],
        ] as const;
        for (const [name, callArgs, expectedPayload] of fileAndAppCalls) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError).not.toBe(true);
            expect(parseToolJson(action)).toEqual(expect.objectContaining(expectedPayload));
        }

        const logBeforeRejectedRemoteTransfer = readFileSync(logPath, "utf-8");
        const rejectedRemoteUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: "android-pixel-owned", localPath: localUploadPath, remotePath: "/sdcard/../escape.txt" },
        });
        expect(rejectedRemoteUpload.isError).toBe(true);
        expect((rejectedRemoteUpload.content as Array<{ text?: string }>)[0].text).toContain("upload-remote-path-traversal-rejected");
        const rejectedRemoteDownload = await client.callTool({
            name: "device_download",
            arguments: { deviceId: "android-pixel-owned", remotePath: "relative.txt", localPath: localDownloadPath },
        });
        expect(rejectedRemoteDownload.isError).toBe(true);
        expect((rejectedRemoteDownload.content as Array<{ text?: string }>)[0].text).toContain("download-remote-path-not-absolute");
        expect(readFileSync(logPath, "utf-8")).toBe(logBeforeRejectedRemoteTransfer);

        const preservedDownloadPath = join(homeDir, "preserved-download.txt");
        writeFileSync(preservedDownloadPath, "original");
        const failedDownload = await client.callTool({
            name: "device_download",
            arguments: { deviceId: "android-pixel-owned", remotePath: "/sdcard/fail-pull.txt", localPath: preservedDownloadPath },
        });
        expect(failedDownload.isError).toBe(true);
        expect(readFileSync(preservedDownloadPath, "utf-8")).toBe("original");

        const failedUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: "android-pixel-owned", localPath: localUploadPath, remotePath: "/sdcard/fail-push.txt" },
        });
        expect(failedUpload.isError).toBe(true);

        const secretUploadPath = join(homeDir, ".env");
        writeFileSync(secretUploadPath, "TOKEN=secret");
        const rejectedSecretUpload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: "android-pixel-owned", localPath: secretUploadPath, remotePath: "/sdcard/.env" },
        });
        expect(rejectedSecretUpload.isError).toBe(true);
        expect((rejectedSecretUpload.content as Array<{ text?: string }>)[0].text).toContain("upload-local-path-secret-looking-file");

        const deleteWhileRunning = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-pixel-owned", deleteAvd: true, confirmDestructive: true },
        });
        expect(deleteWhileRunning.isError).toBe(true);

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(stop.isError, JSON.stringify(stop)).not.toBe(true);
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
            arguments: { deviceId: "android-pixel-owned", deleteAvd: true, confirmDestructive: true },
        });
        expect(deleted.isError).not.toBe(true);
        const deletedPayload = JSON.parse(((deleted.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            avdDeleted: boolean;
        };
        expect(deletedPayload).toEqual({ deleted: "android-pixel-owned", avdDeleted: true });
        expect(existsSync(avdDataPath)).toBe(false);
        expect(existsSync(avdIniPath)).toBe(false);

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`avdmanager create avd --name ${avdName} --package system-images;android-35;google_apis;x86_64 --force --device pixel_6`);
        expect(log).toContain(`emulator -avd ${avdName} -port 5582 -no-window -no-audio -netsim-args --no-cli-ui --no-web-ui`);
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
        expect(log).toContain("adb -s emulator-5582 shell cmd connectivity airplane-mode enable");
        expect(log).toContain("adb -s emulator-5582 shell cmd clipboard set clip text");
        expect(log).toContain("adb -s emulator-5582 shell cmd clipboard get");
        expect(log).toContain("adb -s emulator-5582 shell pidof com.example.mobile");
        expect(log).toContain("adb -s emulator-5582 shell input tap 15 25");
        expect(log).toContain("adb -s emulator-5582 exec-out screencap -p");
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/custom-android-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell pkill -2 screenrecord");
        expect(log).toMatch(/adb -s emulator-5582 pull \/sdcard\/custom-android-recording\.mp4 \/tmp\/ccc-device-download-\S+\/payload/);
        expect(log).toContain("adb -s emulator-5582 shell rm -f /sdcard/custom-android-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/fail-immediate-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/natural-exit-recording.mp4");
        expect(log.match(/adb -s emulator-5582 pull \/sdcard\/fail-once-pull-recording\.mp4 \/tmp\/ccc-device-download-\S+\/payload/g)).toHaveLength(2);
        expect(log).toContain("adb -s emulator-5582 shell screenrecord --time-limit 5 /sdcard/stop-cleanup-recording.mp4");
        expect(log).toContain("adb -s emulator-5582 shell uiautomator dump /sdcard/window-android-pixel-owned.xml");
        expect(log).toContain("adb -s emulator-5582 exec-out cat /sdcard/window-android-pixel-owned.xml");
        const uploadStagePath = log.match(/adb -s emulator-5582 push (\/tmp\/ccc-device-upload-\S+\/payload) \/sdcard\/local\.txt/)?.[1];
        const downloadStagePath = log.match(/adb -s emulator-5582 pull \/sdcard\/remote\.txt (\/tmp\/ccc-device-download-\S+\/payload)/)?.[1];
        const failedUploadStagePath = log.match(/adb -s emulator-5582 push (\/tmp\/ccc-device-upload-\S+\/payload) \/sdcard\/fail-push\.txt/)?.[1];
        expect(uploadStagePath).toBeTruthy();
        expect(downloadStagePath).toBeTruthy();
        expect(failedUploadStagePath).toBeTruthy();
        expect(existsSync(uploadStagePath || "")).toBe(false);
        expect(existsSync(downloadStagePath || "")).toBe(false);
        expect(existsSync(failedUploadStagePath || "")).toBe(false);
        expect(log).toContain("adb -s emulator-5582 install -r /tmp/Test.apk");
        expect(log).toContain("adb -s emulator-5582 shell monkey -p com.example.test 1");
        expect(log).toContain("adb -s emulator-5582 shell am start -n com.example.test/.MainActivity");
        expect(log).toContain("adb -s emulator-5582 shell pm clear com.example.test");
        expect(log).toContain("adb -s emulator-5582 install -r /tmp/Mobile.apk");
        expect(log).toContain("adb -s emulator-5582 shell monkey -p com.example.mobile 1");
        expect(log).toContain("adb -s emulator-5582 uninstall com.example.mobile");
        expect(log).toContain("adb -s emulator-5582 shell am force-stop com.example.mobile");
        expect(log).toContain("adb -s emulator-5582 shell pm clear com.example.mobile");
        expect(log).not.toContain(`avdmanager delete avd --name ${avdName}`);
        expect(log).not.toContain("appium");
    });

    it("assigns and persists a deterministic direct emulator port when none is requested", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Auto Port",
                deviceId: "android-auto-port",
            },
        });
        expect(create.isError).not.toBe(true);
        const payload = parseToolJson(create) as { device: { port: number; serial: string } };
        expect(payload.device.port).toBeGreaterThanOrEqual(5554);
        expect(payload.device.port).toBeLessThanOrEqual(5682);
        expect(payload.device.port % 2).toBe(0);
        expect(payload.device.serial).toBe(`emulator-${payload.device.port}`);

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-auto-port", confirmDestructive: true },
        });
        expect(deleted.isError).not.toBe(true);
    });

    it("rejects a direct port occupied by a live unmanaged emulator", { timeout: TIMEOUT }, async () => {
        const beforeLog = readFileSync(logPath, "utf8");
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Live Direct Conflict",
                deviceId: "android-live-direct-conflict",
                port: 5554,
                systemImage: "system-images;android-35;google_apis;x86_64",
                createAvd: true,
            },
        });
        expect(create.isError).toBe(true);
        expect((create.content as Array<{ text?: string }>)[0].text).toContain("android-emulator-port-conflict: port-5554-already-allocated");
        const addedLog = readFileSync(logPath, "utf8").slice(beforeLog.length);
        expect(addedLog).toContain("adb devices -l");
        expect(addedLog).not.toContain("avdmanager create");
    });

    it("fails closed before direct provisioning when live ADB inventory is unavailable", { timeout: TIMEOUT }, async () => {
        const marker = join(homeDir, "fake-adb-devices-fail");
        writeFileSync(marker, "1");
        const beforeLog = readFileSync(logPath, "utf8");
        try {
            const create = await client.callTool({
                name: "device_create",
                arguments: {
                    backend: "android-emulator",
                    name: "Unavailable Direct Live Inventory",
                    deviceId: "android-unavailable-direct-live-inventory",
                    systemImage: "system-images;android-35;google_apis;x86_64",
                    createAvd: true,
                },
            });
            expect(create.isError).toBe(true);
            expect((create.content as Array<{ text?: string }>)[0].text).toContain("android-emulator-live-port-inventory-unavailable: adb server unavailable");
            const addedLog = readFileSync(logPath, "utf8").slice(beforeLog.length);
            expect(addedLog).toContain("adb devices -l");
            expect(addedLog).not.toContain("avdmanager create");
        } finally {
            rmSync(marker, { force: true });
        }
    });

    it("refuses to start when an unmanaged emulator takes the reserved direct port", { timeout: TIMEOUT }, async () => {
        const deviceId = "android-direct-start-port-conflict";
        const port = 5680;
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Direct Start Port Conflict",
                deviceId,
                port,
            },
        });
        expect(create.isError).not.toBe(true);

        const marker = join(homeDir, "fake-adb-extra-emulator");
        writeFileSync(marker, String(port));
        const beforeLog = readFileSync(logPath, "utf8");
        try {
            const start = await client.callTool({
                name: "device_start",
                arguments: { deviceId, waitForBoot: false },
            });
            expect(start.isError).toBe(true);
            expect((start.content as Array<{ text?: string }>)[0].text).toContain(`android-emulator-port-conflict: port-${port}-already-in-use`);
            const addedLog = readFileSync(logPath, "utf8").slice(beforeLog.length);
            expect(addedLog).toContain("adb devices -l");
            expect(addedLog).not.toContain("emulator -avd");
        } finally {
            rmSync(marker, { force: true });
            const deleted = await client.callTool({
                name: "device_delete",
                arguments: { deviceId, confirmDestructive: true },
            });
            expect(deleted.isError).not.toBe(true);
        }
    });

    it("rejects a direct port allocated to another project before provisioning an AVD", { timeout: TIMEOUT }, async () => {
        const foreignOwnerId = "6162636465666768";
        const foreignStateRoot = join(homeDir, ".ccc", "devices", "owners", foreignOwnerId, "android");
        const foreignStateFile = join(foreignStateRoot, "devices.json");
        mkdirSync(foreignStateRoot, { recursive: true });
        writeFileSync(foreignStateFile, JSON.stringify({ devices: [{ id: "foreign-emulator", port: 5682 }] }));
        const beforeLog = readFileSync(logPath, "utf8");
        try {
            const create = await client.callTool({
                name: "device_create",
                arguments: {
                    backend: "android-emulator",
                    name: "Foreign Port Conflict",
                    deviceId: "android-foreign-port-conflict",
                    port: 5682,
                    systemImage: "system-images;android-35;google_apis;x86_64",
                    createAvd: true,
                },
            });
            expect(create.isError).toBe(true);
            expect((create.content as Array<{ text?: string }>)[0].text).toContain("android-emulator-port-conflict: port-5682-already-allocated");
            expect(readFileSync(logPath, "utf8")).toBe(beforeLog);
        } finally {
            rmSync(join(homeDir, ".ccc", "devices", "owners", foreignOwnerId), { recursive: true, force: true });
        }
    });

    it("fails closed before direct AVD provisioning when another project Android state is corrupt", { timeout: TIMEOUT }, async () => {
        const foreignOwnerId = "7172737475767778";
        const foreignStateRoot = join(homeDir, ".ccc", "devices", "owners", foreignOwnerId, "android");
        const foreignStateFile = join(foreignStateRoot, "devices.json");
        mkdirSync(foreignStateRoot, { recursive: true });
        writeFileSync(foreignStateFile, "{");
        const beforeLog = readFileSync(logPath, "utf8");
        try {
            const create = await client.callTool({
                name: "device_create",
                arguments: {
                    backend: "android-emulator",
                    name: "Corrupt Inventory",
                    deviceId: "android-corrupt-inventory",
                    systemImage: "system-images;android-35;google_apis;x86_64",
                    createAvd: true,
                },
            });
            expect(create.isError).toBe(true);
            expect((create.content as Array<{ text?: string }>)[0].text).toContain("android-emulator-port-inventory-unavailable: owner-devices-state-invalid");
            expect(readFileSync(foreignStateFile, "utf8")).toBe("{");
            expect(readFileSync(logPath, "utf8")).toBe(beforeLog);
        } finally {
            rmSync(join(homeDir, ".ccc", "devices", "owners", foreignOwnerId), { recursive: true, force: true });
        }
    });

    it("waits for the broker-compatible global port lock before direct provider and state effects", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "android-emulator" } });
        const currentOwnerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        let releaseLock!: () => void;
        let lockEntered!: () => void;
        const gate = new Promise<void>((resolve) => { releaseLock = resolve; });
        const ready = new Promise<void>((resolve) => { lockEntered = resolve; });
        const lockFile = join(homeDir, ".ccc", "devices", "broker", "locks", "android-emulator-ports.mutation.lock");
        const lockHolder = withSharedMutationLockAsync(lockFile, async () => {
            lockEntered();
            await gate;
        });
        await ready;
        const avdName = `ccc-${currentOwnerId}-global-port-lock`;
        const beforeLog = readFileSync(logPath, "utf8");
        let settled = false;
        const createRequest = client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Global Port Lock",
                deviceId: "android-global-port-lock",
                avdName,
                port: 5680,
                systemImage: "system-images;android-35;google_apis;x86_64",
                createAvd: true,
            },
        }).then((result) => {
            settled = true;
            return result;
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 75));
            expect(settled).toBe(false);
            expect(readFileSync(logPath, "utf8")).toBe(beforeLog);

            releaseLock();
            await lockHolder;
            const create = await createRequest;
            expect(create.isError).not.toBe(true);
            expect(parseToolJson(create)).toEqual(expect.objectContaining({
                device: expect.objectContaining({ id: "android-global-port-lock", port: 5680 }),
            }));
            expect(readFileSync(logPath, "utf8")).toContain(`avdmanager create avd --name ${avdName}`);

            const deleted = await client.callTool({
                name: "device_delete",
                arguments: { deviceId: "android-global-port-lock", deleteAvd: true, confirmDestructive: true },
            });
            expect(deleted.isError).not.toBe(true);
        } finally {
            releaseLock();
            await lockHolder;
        }
    });

    it("rolls back a directly provisioned AVD when an external same-id create wins the state claim", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const stateRoot = join(homeDir, ".ccc", "devices", "owners", ownerId, "android");
        const statePath = join(stateRoot, "devices.json");
        const deviceId = "android-direct-create-race";
        const winner = {
            id: deviceId,
            name: "External winner",
            backend: "android-emulator",
            avdName: `ccc-${ownerId}-external-winner`,
            status: "stopped",
        };
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(join(homeDir, "fake-android-create-conflict-state.json"), JSON.stringify({ devices: [winner] }));
        writeFileSync(join(homeDir, "fake-android-create-conflict-state-path"), statePath);

        const losingAvd = `ccc-${ownerId}-direct-loser`;
        try {
            const create = await client.callTool({
                name: "device_create",
                arguments: {
                    backend: "android-emulator",
                    name: "Direct loser",
                    deviceId,
                    avdName: losingAvd,
                    systemImage: "system-images;android-35;google_apis;x86_64",
                    createAvd: true,
                },
            });
            expect(create.isError).toBe(true);
            expect((create.content as Array<{ text?: string }>)[0].text).toContain(`Device identity already exists for this owner (id: ${deviceId})`);
            expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ devices: [winner] });
            expect(readFileSync(logPath, "utf8")).not.toContain(`avdmanager delete avd --name ${losingAvd}`);
            expect(existsSync(join(homeDir, ".android", "avd", `${losingAvd}.avd`))).toBe(false);
            expect(existsSync(join(homeDir, ".android", "avd", `${losingAvd}.ini`))).toBe(false);
        } finally {
            writeFileSync(statePath, JSON.stringify({ devices: [] }));
            rmSync(join(homeDir, "fake-android-create-conflict-state.json"), { force: true });
            rmSync(join(homeDir, "fake-android-create-conflict-state-path"), { force: true });
        }
    });

    it("rolls back a started emulator when a non-cooperating same-id successor replaces owner state", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const stateRoot = join(homeDir, ".ccc", "devices", "owners", ownerId, "android");
        const statePath = join(stateRoot, "devices.json");
        const deviceId = "android-direct-start-race";
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Direct Start Race",
                deviceId,
                port: 5678,
            },
        });
        expect(create.isError).not.toBe(true);

        const successor = {
            id: deviceId,
            name: "External successor",
            backend: "android-emulator",
            avdName: `ccc-${ownerId}-external-start-successor`,
            port: 5680,
            serial: "emulator-5680",
            status: "stopped",
            generation: "successor",
        };
        writeFileSync(join(homeDir, "fake-android-start-conflict-state.json"), JSON.stringify({ devices: [successor] }));
        writeFileSync(join(homeDir, "fake-android-start-conflict-state-path"), statePath);
        const beforeLog = readFileSync(logPath, "utf8");
        try {
            const start = await client.callTool({
                name: "device_start",
                arguments: { deviceId, bootTimeoutMs: 5000 },
            });
            expect(start.isError).toBe(true);
            expect((start.content as Array<{ text?: string }>)[0].text).toContain("owner-device-state-conflict");
            expect((start.content as Array<{ text?: string }>)[0].text).toContain('"operation":"start-complete"');
            expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ devices: [successor] });

            const addedLog = readFileSync(logPath, "utf8").slice(beforeLog.length);
            expect(addedLog).toContain(`emulator -avd ccc-${ownerId}-direct-start-race -port 5678`);
            expect(addedLog).toContain("adb -s emulator-5678 emu kill");
        } finally {
            writeFileSync(statePath, JSON.stringify({ devices: [] }));
            rmSync(join(homeDir, "fake-android-start-conflict-state.json"), { force: true });
            rmSync(join(homeDir, "fake-android-start-conflict-state-path"), { force: true });
        }
    });

    it("fails and restores stopped state when the emulator exits during boot polling", { timeout: TIMEOUT }, async () => {
        const deviceId = "android-boot-process-exit";
        const emulatorPath = join(binDir, "emulator");
        const adbPath = join(binDir, "adb");
        const realAdbPath = join(binDir, "adb-before-boot-exit-test");
        const originalEmulator = readFileSync(emulatorPath, "utf8");
        const originalAdb = readFileSync(adbPath, "utf8");
        writeFileSync(realAdbPath, originalAdb);
        chmodSync(realAdbPath, 0o755);
        writeFileSync(emulatorPath, `#!/bin/sh
echo "emulator $*" >> "$FAKE_ANDROID_LOG"
if [ "$1" = "-list-avds" ]; then exit 0; fi
: > "$HOME/fake-android-boot-pending"
trap '/bin/rm -f "$HOME/fake-android-boot-pending"' EXIT
/bin/sleep 0.4
exit 17
`);
        writeFileSync(adbPath, `#!/bin/sh
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ] && [ "$5" = "sys.boot_completed" ] && [ -f "$HOME/fake-android-boot-pending" ]; then
  echo "adb $*" >> "$FAKE_ANDROID_LOG"
  echo "0"
  exit 0
fi
exec "${realAdbPath}" "$@"
`);

        try {
            const create = await client.callTool({
                name: "device_create",
                arguments: { backend: "android-emulator", name: "Boot Process Exit", deviceId, port: 5664 },
            });
            expect(create.isError).not.toBe(true);

            const start = await client.callTool({
                name: "device_start",
                arguments: { deviceId, bootTimeoutMs: 5000 },
            });
            expect(start.isError).toBe(true);
            const failure = parseToolJson(start) as {
                error: string;
                boot: { reason: string; exitCode: number };
                stateReverted: boolean;
            };
            expect(failure).toEqual(expect.objectContaining({
                error: "android-emulator-process-exited-during-boot",
                boot: expect.objectContaining({ reason: "emulator-process-exited", exitCode: 17 }),
                stateReverted: true,
            }));

            const status = await client.callTool({ name: "device_status", arguments: { deviceId } });
            expect(parseToolJson(status)).toEqual(expect.objectContaining({
                device: expect.objectContaining({ status: "stopped" }),
            }));
            const persisted = (parseToolJson(status) as { device: Record<string, unknown> }).device;
            expect(persisted.pid).toBeUndefined();
            expect(persisted.runtime).toBeUndefined();
            expect(persisted.lifecycle).toBeUndefined();
        } finally {
            writeFileSync(emulatorPath, originalEmulator);
            writeFileSync(adbPath, originalAdb);
            rmSync(realAdbPath, { force: true });
            rmSync(join(homeDir, "fake-android-boot-pending"), { force: true });
            await client.callTool({
                name: "device_delete",
                arguments: { deviceId, force: true, confirmDestructive: true },
            });
        }
    });

    it("force-deletes a running emulator only after stopping its ADB and owned process runtimes", { timeout: TIMEOUT }, async () => {
        const deviceId = "android-force-delete-running";
        const create = await client.callTool({
            name: "device_create",
            arguments: { backend: "android-emulator", name: "Force Delete Running", deviceId, port: 5666 },
        });
        expect(create.isError).not.toBe(true);
        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId, waitForBoot: false },
        });
        expect(start.isError).not.toBe(true);
        const pid = (parseToolJson(start) as { device: { pid: number } }).device.pid;
        const beforeLog = readFileSync(logPath, "utf8");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId, force: true, confirmDestructive: true },
        });
        expect(deleted.isError).not.toBe(true);
        expect(parseToolJson(deleted)).toEqual(expect.objectContaining({ deleted: deviceId }));
        expect(() => process.kill(pid, 0)).toThrow();
        expect(readFileSync(logPath, "utf8").slice(beforeLog.length)).toContain("adb -s emulator-5666 emu kill");
    });

    it("force-deletes stale stopped metadata without signaling an absent emulator", { timeout: TIMEOUT }, async () => {
        const deviceId = "android-force-delete-stale-stopped";
        const create = await client.callTool({
            name: "device_create",
            arguments: { backend: "android-emulator", name: "Force Delete Stale Stopped", deviceId, port: 5670 },
        });
        expect(create.isError).not.toBe(true);
        const beforeLog = readFileSync(logPath, "utf8");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId, force: true, confirmDestructive: true },
        });
        expect(deleted.isError).not.toBe(true);
        expect(parseToolJson(deleted)).toEqual(expect.objectContaining({ deleted: deviceId }));
        const addedLog = readFileSync(logPath, "utf8").slice(beforeLog.length);
        expect(addedLog).toContain("adb -s emulator-5670 get-state");
        expect(addedLog).not.toContain("adb -s emulator-5670 emu kill");
    });

    it("preserves a stopped-state AVD while ADB still observes its emulator", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "android-emulator" } });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const deviceId = "android-stale-stopped-active-avd";
        const avdName = `ccc-${ownerId}-stale-stopped-active-avd`;
        const port = 5672;
        const avdDataPath = join(homeDir, ".android", "avd", `${avdName}.avd`);
        const avdIniPath = join(homeDir, ".android", "avd", `${avdName}.ini`);
        const activeMarker = join(homeDir, `fake-adb-active-emulator-${port}`);
        const inventoryFailureMarker = join(homeDir, "fake-adb-devices-fail");
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Stale Stopped Active AVD",
                deviceId,
                avdName,
                port,
                systemImage: "system-images;android-35;google_apis;x86_64",
                createAvd: true,
            },
        });
        expect(create.isError).not.toBe(true);
        mkdirSync(avdDataPath, { recursive: true });
        writeFileSync(join(avdDataPath, "userdata-qemu.img"), "active-avd-data");
        writeFileSync(avdIniPath, `path=${avdDataPath}`);
        writeFileSync(activeMarker, "active");
        const beforeLog = readFileSync(logPath, "utf8");

        try {
            const blocked = await client.callTool({
                name: "device_delete",
                arguments: { deviceId, deleteAvd: true, confirmDestructive: true },
            });
            expect(blocked.isError).toBe(true);
            expect((blocked.content as Array<{ text?: string }>)[0]?.text)
                .toContain("android-avd-active-or-liveness-unverified");
            expect(existsSync(avdDataPath)).toBe(true);
            expect(existsSync(avdIniPath)).toBe(true);
            expect(readFileSync(logPath, "utf8").slice(beforeLog.length))
                .not.toContain(`avdmanager delete avd --name ${avdName}`);
            expect((parseToolJson(await client.callTool({
                name: "device_status",
                arguments: { deviceId },
            })) as { device: Record<string, unknown> }).device).not.toHaveProperty("avdRoot");

            rmSync(activeMarker, { force: true });
            writeFileSync(inventoryFailureMarker, "fail");
            const unverified = await client.callTool({
                name: "device_delete",
                arguments: { deviceId, deleteAvd: true, confirmDestructive: true },
            });
            expect(unverified.isError).toBe(true);
            expect((unverified.content as Array<{ text?: string }>)[0]?.text)
                .toContain("android-avd-active-or-liveness-unverified");
            expect(existsSync(avdDataPath)).toBe(true);
            expect(existsSync(avdIniPath)).toBe(true);
        } finally {
            rmSync(activeMarker, { force: true });
            rmSync(inventoryFailureMarker, { force: true });
            const deleted = await client.callTool({
                name: "device_delete",
                arguments: { deviceId, deleteAvd: true, confirmDestructive: true },
            });
            expect(deleted.isError).not.toBe(true);
        }
    });

    it("preserves running state and the AVD when force-delete cannot terminate the owned process", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "android-emulator" } });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const statePath = join(homeDir, ".ccc", "devices", "owners", ownerId, "android", "devices.json");
        const deviceId = "android-force-delete-stop-failure";
        const avdName = `ccc-${ownerId}-force-delete-stop-failure`;
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Force Delete Stop Failure",
                deviceId,
                avdName,
                port: 5668,
                systemImage: "system-images;android-35;google_apis;x86_64",
                createAvd: true,
            },
        });
        expect(create.isError).not.toBe(true);
        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId, waitForBoot: false },
        });
        expect(start.isError).not.toBe(true);

        const state = JSON.parse(readFileSync(statePath, "utf8")) as { devices: Array<Record<string, any>> };
        const original = structuredClone(state.devices.find((device) => device.id === deviceId));
        const corrupted = state.devices.find((device) => device.id === deviceId);
        corrupted.runtime.processIdentity.startToken = "linux:identity-mismatch";
        writeFileSync(statePath, JSON.stringify(state));
        const beforeLog = readFileSync(logPath, "utf8");

        try {
            const deleted = await client.callTool({
                name: "device_delete",
                arguments: { deviceId, force: true, deleteAvd: true, confirmDestructive: true },
            });
            expect(deleted.isError).toBe(true);
            const failure = parseToolJson(deleted) as {
                error: string;
                runtimeStop: { reason: string; exited: boolean };
                stateReverted: boolean;
            };
            expect(failure).toEqual(expect.objectContaining({
                error: "android-emulator-force-delete-stop-failed",
                runtimeStop: expect.objectContaining({ reason: "runtime-process-identity-mismatch", exited: false }),
                stateReverted: true,
            }));

            const persisted = (parseToolJson(await client.callTool({
                name: "device_status",
                arguments: { deviceId },
            })) as { device: Record<string, any> }).device;
            expect(persisted).toEqual(expect.objectContaining({
                status: "starting",
                pid: original.pid,
                runtime: corrupted.runtime,
            }));
            expect(readFileSync(logPath, "utf8").slice(beforeLog.length)).not.toContain(`avdmanager delete avd --name ${avdName}`);
        } finally {
            const currentState = JSON.parse(readFileSync(statePath, "utf8")) as { devices: Array<Record<string, any>> };
            const index = currentState.devices.findIndex((device) => device.id === deviceId);
            if (index >= 0) currentState.devices[index] = original;
            writeFileSync(statePath, JSON.stringify(currentState));
            await client.callTool({ name: "device_stop", arguments: { deviceId } });
            await client.callTool({
                name: "device_delete",
                arguments: { deviceId, deleteAvd: true, confirmDestructive: true },
            });
        }
    });

    it.runIf(process.platform !== "win32")("force-delete uses identity-fenced storage cleanup without avdmanager deletion", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({ name: "device_inventory", arguments: { backend: "android-emulator" } });
        const ownerId = (parseToolJson(inventory) as { ownerId: string }).ownerId;
        const deviceId = "android-force-delete-partial-stop";
        const avdName = `ccc-${ownerId}-force-delete-partial-stop`;
        const adbPath = join(binDir, "adb");
        const avdmanagerPath = join(binDir, "avdmanager");
        const realAdbPath = join(binDir, "adb-force-delete-real");
        const realAvdmanagerPath = join(binDir, "avdmanager-force-delete-real");
        const originalAdb = readFileSync(adbPath, "utf8");
        const originalAvdmanager = readFileSync(avdmanagerPath, "utf8");

        const created = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Force Delete Partial Stop",
                deviceId,
                avdName,
                port: 5670,
                systemImage: "system-images;android-35;google_apis;x86_64",
                createAvd: true,
            },
        });
        expect(created.isError).not.toBe(true);
        const started = await client.callTool({ name: "device_start", arguments: { deviceId, waitForBoot: false } });
        expect(started.isError).not.toBe(true);
        const pid = (parseToolJson(started) as { device: { pid: number } }).device.pid;

        writeFileSync(realAdbPath, originalAdb);
        writeFileSync(realAvdmanagerPath, originalAvdmanager);
        chmodSync(realAdbPath, 0o755);
        chmodSync(realAvdmanagerPath, 0o755);
        writeFileSync(join(homeDir, "fake-force-delete-kill-pid"), String(pid));
        writeFileSync(adbPath, `#!/bin/sh
if [ "$1" = "-s" ] && [ "$3" = "emu" ] && [ "$4" = "kill" ]; then
  /bin/kill "$(/bin/cat "$HOME/fake-force-delete-kill-pid")"
  status=$?
  /bin/rm -f "$HOME/fake-adb-active-$2"
  exit $status
fi
exec "${realAdbPath}" "$@"
`);
        writeFileSync(avdmanagerPath, `#!/bin/sh
if [ "$1" = "delete" ] && [ "$2" = "avd" ] && [ "$3" = "--name" ] && [ "$4" = "${avdName}" ]; then
  echo "injected AVD delete failure" >&2
  exit 19
fi
exec "${realAvdmanagerPath}" "$@"
`);
        chmodSync(adbPath, 0o755);
        chmodSync(avdmanagerPath, 0o755);

        try {
            const deleted = await client.callTool({
                name: "device_delete",
                arguments: { deviceId, force: true, deleteAvd: true, confirmDestructive: true },
            });
            expect(deleted.isError).not.toBe(true);
            expect(readFileSync(logPath, "utf8")).not.toContain(`avdmanager delete avd --name ${avdName}`);
            expect(existsSync(join(homeDir, ".android", "avd", `${avdName}.avd`))).toBe(false);
            expect(existsSync(join(homeDir, ".android", "avd", `${avdName}.ini`))).toBe(false);
        } finally {
            writeFileSync(adbPath, originalAdb);
            writeFileSync(avdmanagerPath, originalAvdmanager);
            chmodSync(adbPath, 0o755);
            chmodSync(avdmanagerPath, 0o755);
            rmSync(realAdbPath, { force: true });
            rmSync(realAvdmanagerPath, { force: true });
            rmSync(join(homeDir, "fake-force-delete-kill-pid"), { force: true });
            await client.callTool({
                name: "device_delete",
                arguments: { deviceId, deleteAvd: true, confirmDestructive: true },
            });
        }
    });

    it("rolls back a directly provisioned AVD when concurrent state growth exceeds the file limit", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const stateRoot = join(homeDir, ".ccc", "devices", "owners", ownerId, "android");
        const statePath = join(stateRoot, "devices.json");
        const nearLimitState = JSON.stringify({
            devices: [{ id: "concurrent-growth", payload: "x".repeat((256 * 1024) - 700) }],
        });
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(join(homeDir, "fake-android-create-conflict-state.json"), nearLimitState);
        writeFileSync(join(homeDir, "fake-android-create-conflict-state-path"), statePath);

        const losingAvd = `ccc-${ownerId}-direct-state-limit-loser`;
        try {
            await expect(client.callTool({
                name: "device_create",
                arguments: {
                    backend: "android-emulator",
                    name: "Direct state limit loser",
                    deviceId: "android-direct-state-limit-loser",
                    avdName: losingAvd,
                    systemImage: "system-images;android-35;google_apis;x86_64",
                    createAvd: true,
                },
            })).rejects.toThrow("owner-devices-file-too-large");
            expect(readFileSync(statePath, "utf8")).toBe(nearLimitState);
            expect(readFileSync(logPath, "utf8")).not.toContain(`avdmanager delete avd --name ${losingAvd}`);
            expect(existsSync(join(homeDir, ".android", "avd", `${losingAvd}.avd`))).toBe(false);
            expect(existsSync(join(homeDir, ".android", "avd", `${losingAvd}.ini`))).toBe(false);
        } finally {
            writeFileSync(statePath, JSON.stringify({ devices: [] }));
            rmSync(join(homeDir, "fake-android-create-conflict-state.json"), { force: true });
            rmSync(join(homeDir, "fake-android-create-conflict-state-path"), { force: true });
        }
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
            arguments: { deviceId: "android-metadata-system-image", confirmDestructive: true },
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

        const unsafeProvisioningCases = [
            {
                name: "Unsafe AVD Name",
                deviceId: "android-unsafe-avd-name",
                avdName: `ccc-${ownerId}-%PATH%`,
                systemImage: "system-images;android-35;google_apis;x86_64",
                expected: "Refusing to create non-owned Android AVD name",
            },
            {
                name: "Unsafe System Image",
                deviceId: "android-unsafe-system-image",
                avdName: `ccc-${ownerId}-unsafe-system-image`,
                systemImage: "system-images;android-35;%PATH%;x86_64",
                expected: "systemImage must be a system-images package identifier",
            },
            {
                name: "Unsafe Device Profile",
                deviceId: "android-unsafe-device-profile",
                avdName: `ccc-${ownerId}-unsafe-device-profile`,
                systemImage: "system-images;android-35;google_apis;x86_64",
                deviceProfile: "%PATH%",
                expected: "deviceProfile contains unsupported characters",
            },
        ];
        for (const unsafe of unsafeProvisioningCases) {
            const { expected, ...unsafeArguments } = unsafe;
            const rejected = await client.callTool({
                name: "device_create",
                arguments: {
                    backend: "android-emulator",
                    createAvd: true,
                    ...unsafeArguments,
                },
            });
            expect(rejected.isError).toBe(true);
            expect((rejected.content as Array<{ text?: string }>)[0].text).toContain(expected);
        }

        const metadataOnly = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Foreign Metadata",
                avdName: "foreign-avd",
            },
        });
        expect(metadataOnly.isError).not.toBe(true);

        const unsafeMetadataAvd = `ccc-${ownerId}-%PATH%`;
        const unsafeMetadata = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Unsafe Foreign Metadata",
                deviceId: "android-unsafe-foreign-metadata",
                avdName: unsafeMetadataAvd,
            },
        });
        expect(unsafeMetadata.isError).not.toBe(true);
        const beforeUnsafeDelete = readFileSync(logPath, "utf8");
        const unsafeDeleted = await client.callTool({
            name: "device_delete",
            arguments: {
                deviceId: "android-unsafe-foreign-metadata",
                deleteAvd: true,
                confirmDestructive: true,
            },
        });
        expect(unsafeDeleted.isError).toBe(true);
        expect((unsafeDeleted.content as Array<{ text?: string }>)[0]?.text)
            .toContain("Refusing to delete non-owned Android AVD name");
        expect(readFileSync(logPath, "utf8").slice(beforeUnsafeDelete.length))
            .not.toContain("avdmanager delete");
        expect((await client.callTool({
            name: "device_delete",
            arguments: {
                deviceId: "android-unsafe-foreign-metadata",
                confirmDestructive: true,
            },
        })).isError).not.toBe(true);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "android-foreign-metadata", bootTimeoutMs: 1000 },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("Refusing to start non-owned Android AVD name");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-foreign-metadata", deleteAvd: true, confirmDestructive: true },
        });
        expect(deleted.isError).toBe(true);
        expect((deleted.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete non-owned Android AVD name");

        const metadataDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-foreign-metadata", confirmDestructive: true },
        });
        expect(metadataDeleted.isError).not.toBe(true);

        const log = readFileSync(logPath, "utf-8");
        expect(log).not.toContain(`avdmanager create avd --name ${metadataOnlyAvd}`);
        expect(log).not.toContain("%PATH%");
        expect(log).not.toContain("emulator -avd foreign-avd");
    });

    it("bounds install helpers and rejects zero-exit adb launch diagnostics", { timeout: TIMEOUT }, async () => {
        const deviceId = "android-adb-result-validation";
        const adbPath = join(binDir, "adb");
        const originalAdb = readFileSync(adbPath, "utf8");
        const delegatedAdbPath = join(binDir, "adb-before-result-validation");
        writeFileSync(delegatedAdbPath, originalAdb);
        chmodSync(delegatedAdbPath, 0o755);
        writeFileSync(adbPath, `#!/bin/sh
if [ "$1" = "-s" ] && [ "$3" = "install" ] && [ "$5" = "/tmp/slow-install.apk" ]; then
  /bin/sleep 1
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "monkey" ] && [ "$6" = "com.example.missing" ]; then
  echo "No activities found to run, monkey aborted."
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "am" ] && [ "$7" = "com.example.missing/.MainActivity" ]; then
  echo "Error: Activity class com.example.missing/.MainActivity does not exist."
  exit 0
fi
exec "${delegatedAdbPath}" "$@"
`);
        chmodSync(adbPath, 0o755);

        try {
            const created = await client.callTool({
                name: "device_create",
                arguments: { backend: "android-emulator", name: "ADB Result Validation", deviceId, port: 5676 },
            });
            expect(created.isError, (created.content as Array<{ text?: string }>)[0]?.text).not.toBe(true);
            expect((await client.callTool({
                name: "device_start",
                arguments: { deviceId, waitForBoot: false },
            })).isError).not.toBe(true);

            const startedAt = Date.now();
            const timedOutInstall = await client.callTool({
                name: "device_install_app",
                arguments: { deviceId, path: "/tmp/slow-install.apk", helperTimeoutMs: 25 },
            });
            expect(timedOutInstall.isError).toBe(true);
            expect(Date.now() - startedAt).toBeLessThan(750);
            expect((timedOutInstall.content as Array<{ text?: string }>)[0]?.text).toMatch(/timed out|ETIMEDOUT/i);

            for (const arguments_ of [
                { deviceId, packageName: "com.example.missing" },
                { deviceId, component: "com.example.missing/.MainActivity" },
            ]) {
                const launch = await client.callTool({ name: "device_launch_app", arguments: arguments_ });
                expect(launch.isError).toBe(true);
                expect((launch.content as Array<{ text?: string }>)[0]?.text).toMatch(/No activities found|does not exist/i);
            }
        } finally {
            writeFileSync(adbPath, originalAdb);
            chmodSync(adbPath, 0o755);
            rmSync(delegatedAdbPath, { force: true });
            await client.callTool({
                name: "device_delete",
                arguments: { deviceId, force: true, confirmDestructive: true },
            });
        }
    });
});
