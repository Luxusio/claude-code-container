import assert from "assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { androidDiscovery } from "../../device-lab-mcp/src/backends/android.mjs";
import { materializeAndroidAppFixture } from "./android-app-fixture.ts";
import { parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";

export const name = "level 2 Android physical device ADB E2E";
const ANDROID_DEVICE_INSTALL_TIMEOUT_MS = 120_000;

export function androidDevicePayload(payload) {
    const normalized = payload?.result && typeof payload.result === "object" ? payload.result : payload;
    if (normalized?.ok === false) {
        throw new Error([normalized.error, normalized.body?.detail].filter(Boolean).join(": ") || "Android device broker operation failed");
    }
    return normalized;
}

export function androidDeviceStatusCommand(payload) {
    return payload?.hostState || payload?.execution?.command || null;
}

export function androidDeviceStartSucceeded(payload) {
    if (payload?.alreadyAttached === true) return true;
    return payload?.device?.status === "attached"
        && payload?.execution?.command?.status === 0
        && String(payload.execution.command.stdout || "").trim() === "device";
}

export function androidDeviceStopPreservedPhysicalDevice(payload) {
    if (payload?.physicalDevicePoweredOff === false) return true;
    return payload?.providerCommand?.mode === "noop"
        && payload?.execution?.command?.status === 0
        && /does not power off or disconnect/i.test(String(payload.execution.command.stdout || payload.providerCommand.reason || ""));
}

export function androidDeviceReportedPathMatches(actual, expected) {
    return String(actual || "").replace(/\\/g, "/").endsWith(`/${basename(expected)}`);
}

function parsePayload(result) {
    return androidDevicePayload(parseToolPayload(result));
}

function stableAndroidUiText(source) {
    const xml = String(source || "");
    const candidates = [...xml.matchAll(/\btext="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((text) => text && text !== "null" && !/^\s*$/.test(text));
    return candidates[0] || "hierarchy";
}

export function androidDeviceE2ECapability(level = Number(process.env.CCC_TEST_LEVEL || "0")) {
    if (level < 2) return { available: false, reason: "CCC_TEST_LEVEL is below 2" };
    const discovery = androidDiscovery();
    const serial = (process.env.CCC_REAL_ANDROID_DEVICE_SERIAL || process.env.CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_SERIAL || "").trim();
    if (!serial) return { available: false, reason: "missing CCC_REAL_ANDROID_DEVICE_SERIAL", discovery };
    return { available: true, reason: "ready", discovery, serial };
}

export function androidDeviceE2EPrerequisites(env = process.env) {
    const app = {
        path: (env.CCC_REAL_ANDROID_DEVICE_APK || env.CCC_REAL_ANDROID_APK || env.CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_APK || "").trim(),
        packageName: (env.CCC_REAL_ANDROID_DEVICE_PACKAGE || env.CCC_REAL_ANDROID_PACKAGE || env.CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_PACKAGE || "").trim(),
        permission: (env.CCC_REAL_ANDROID_DEVICE_PERMISSION || env.CCC_REAL_ANDROID_PERMISSION || env.CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_PERMISSION || "").trim(),
    };
    const supplied = Object.values(app).filter(Boolean).length;
    if (supplied === 0) return { available: true, reason: "use deterministic fixture", source: "fixture", app: null };
    const missing = [
        !app.path ? "CCC_REAL_ANDROID_DEVICE_APK" : "",
        !app.packageName ? "CCC_REAL_ANDROID_DEVICE_PACKAGE" : "",
        !app.permission ? "CCC_REAL_ANDROID_DEVICE_PERMISSION" : "",
        app.path && !existsSync(app.path) ? `APK file not found: ${app.path}` : "",
    ].filter(Boolean);
    return missing.length > 0
        ? { available: false, reason: `external physical Android app proof is incomplete before device mutation: ${missing.join(", ")}`, source: "external", app }
        : { available: true, reason: "external app ready", source: "external", app };
}

export function prepareAndroidDeviceApp(appSelection, tempDir, materialize = materializeAndroidAppFixture) {
    try {
        return appSelection.source === "external" ? appSelection.app : materialize(tempDir);
    } catch (error) {
        rmSync(tempDir, { recursive: true, force: true });
        throw error;
    }
}

export async function run(options: any = {}) {
    const cap = androidDeviceE2ECapability(options.level);
    if (!cap.available) return { status: "SKIP", reason: cap.reason, capability: cap };
    const appSelection = androidDeviceE2EPrerequisites();
    if (!appSelection.available) return { status: "SKIP", reason: appSelection.reason, capability: cap };

    const suffix = Date.now();
    const deviceId = `android-device-real-e2e-${suffix}`;
    const artifactRoot = resolve("results", "device-lab-real");
    mkdirSync(artifactRoot, { recursive: true });
    const tempDir = mkdtempSync(join(artifactRoot, "android-device-e2e-"));
    const app = prepareAndroidDeviceApp(appSelection, tempDir);
    const { path: appApk, packageName: appPackage, permission: appPermission } = app;
    const recordingPath = join(tempDir, `recording-${suffix}.mp4`);
    let attached = false;
    let recordingActive = false;
    let primaryFailure = null;

    return withDeviceLabMcp(async ({ callTool }) => {
        const direct = { backend: "android-device" };
        try {
            const inventory = parsePayload(await callTool("device_inventory", direct));
            const hostDevices = Array.isArray(inventory.hostDevices)
                ? inventory.hostDevices
                : inventory.hostDevices?.devices;
            assert.ok(Array.isArray(hostDevices));
            assert.ok(hostDevices.some((device) => device.serial === cap.serial));

            const wireless = parsePayload(await callTool("device_wireless", direct));
            assert.strictEqual(wireless.provider, "adb");
            assert.deepStrictEqual(
                ["status", "usb-tcpip", "pair", "connect"].filter((action) => !wireless.actions?.includes(action)),
                [],
                "Android physical wireless status did not advertise every supported action",
            );
            const wirelessHostDevices = Array.isArray(wireless.hostDevices)
                ? wireless.hostDevices
                : wireless.hostDevices?.devices;
            assert.ok(Array.isArray(wirelessHostDevices));
            assert.ok(wirelessHostDevices.some((device) => device.serial === cap.serial && device.state === "device"));

            const attach = parsePayload(await callTool("device_attach", {
                ...direct,
                name: `Real Android Device E2E ${suffix}`,
                deviceId,
                serial: cap.serial,
            }));
            attached = true;
            assert.strictEqual(attach.device.id, deviceId);
            assert.strictEqual(attach.device.serial, cap.serial);

            const status = parsePayload(await callTool("device_status", { ...direct, deviceId }));
            assert.strictEqual(status.device.id, deviceId);
            assert.strictEqual(status.device.serial, cap.serial);
            const statusCommand = androidDeviceStatusCommand(status);
            assert.strictEqual(statusCommand?.status, 0);
            assert.strictEqual(String(statusCommand?.stdout || "").trim(), "device");

            const start = parsePayload(await callTool("device_start", { ...direct, deviceId }));
            assert.strictEqual(androidDeviceStartSucceeded(start), true);

            const exec = parsePayload(await callTool("device_exec", {
                ...direct,
                deviceId,
                command: "echo ccc-android-device-e2e-ok",
            }));
            assert.strictEqual(exec.status, 0);
            assert.match(exec.stdout, /ccc-android-device-e2e-ok/);

            const session = parsePayload(await callTool("mobile_session_status", { ...direct, deviceId }));
            assert.strictEqual(session.deviceId, deviceId);

            const ui = parsePayload(await callTool("mobile_dump_ui", { ...direct, deviceId }));
            assert.strictEqual(ui.provider, "adb-uiautomator");
            assert.ok(typeof ui.source === "string");

            const waitText = stableAndroidUiText(ui.source);
            const waitForText = parsePayload(await callTool("mobile_wait_for_text", {
                ...direct,
                deviceId,
                text: waitText,
                timeoutMs: 5000,
                intervalMs: 250,
            }));
            assert.strictEqual(waitForText.provider, "adb-uiautomator");
            assert.strictEqual(waitForText.text, waitText);
            assert.strictEqual(waitForText.found, true);

            const tap = parsePayload(await callTool("mobile_tap", { ...direct, deviceId, x: 20, y: 20 }));
            assert.strictEqual(tap.provider, "adb");
            assert.deepStrictEqual(tap.tapped, { x: 20, y: 20 });

            const doubleTap = parsePayload(await callTool("mobile_double_tap", { ...direct, deviceId, x: 30, y: 30 }));
            assert.strictEqual(doubleTap.provider, "adb");
            assert.deepStrictEqual(doubleTap.doubleTapped, { x: 30, y: 30 });

            const longPress = parsePayload(await callTool("mobile_long_press", { ...direct, deviceId, x: 40, y: 40, durationMs: 300 }));
            assert.strictEqual(longPress.provider, "adb");
            assert.deepStrictEqual(longPress.longPressed, { x: 40, y: 40, durationMs: 300 });

            const swipe = parsePayload(await callTool("mobile_swipe", { ...direct, deviceId, x1: 80, y1: 120, x2: 80, y2: 80, durationMs: 200 }));
            assert.strictEqual(swipe.provider, "adb");
            assert.deepStrictEqual(swipe.swiped, { x1: 80, y1: 120, x2: 80, y2: 80, durationMs: 200 });

            const drag = parsePayload(await callTool("mobile_drag", { ...direct, deviceId, x1: 90, y1: 90, x2: 100, y2: 100, durationMs: 300 }));
            assert.strictEqual(drag.provider, "adb");
            assert.deepStrictEqual(drag.dragged, { x1: 90, y1: 90, x2: 100, y2: 100, durationMs: 300 });

            const typeText = parsePayload(await callTool("mobile_type_text", { ...direct, deviceId, text: "ccc" }));
            assert.strictEqual(typeText.provider, "adb");
            assert.strictEqual(typeText.typed, true);

            const key = parsePayload(await callTool("mobile_key", { ...direct, deviceId, keyCode: 4 }));
            assert.strictEqual(key.provider, "adb");
            assert.strictEqual(key.key, 4);

            const home = parsePayload(await callTool("mobile_home", { ...direct, deviceId }));
            assert.strictEqual(home.provider, "adb");
            assert.strictEqual(home.key, 3);

            const back = parsePayload(await callTool("mobile_back", { ...direct, deviceId }));
            assert.strictEqual(back.provider, "adb");
            assert.strictEqual(back.key, 4);

            const forward = parsePayload(await callTool("mobile_forward", { ...direct, deviceId }));
            assert.strictEqual(forward.provider, "adb");
            assert.strictEqual(forward.key, 125);

            const recents = parsePayload(await callTool("mobile_recents", { ...direct, deviceId }));
            assert.strictEqual(recents.provider, "adb");
            assert.strictEqual(recents.key, 187);

            const power = parsePayload(await callTool("mobile_power", { ...direct, deviceId }));
            assert.strictEqual(power.provider, "adb");
            assert.strictEqual(power.key, 26);

            const lock = parsePayload(await callTool("mobile_lock", { ...direct, deviceId }));
            assert.strictEqual(lock.provider, "adb");
            assert.strictEqual(lock.key, 223);

            const unlock = parsePayload(await callTool("mobile_unlock", { ...direct, deviceId }));
            assert.strictEqual(unlock.provider, "adb");
            assert.strictEqual(unlock.key, 224);

            const portrait = parsePayload(await callTool("mobile_set_orientation", { ...direct, deviceId, orientation: "portrait" }));
            assert.strictEqual(portrait.provider, "adb");
            assert.strictEqual(portrait.orientation, "portrait");

            const rotateLeft = parsePayload(await callTool("mobile_rotate_left", { ...direct, deviceId }));
            assert.strictEqual(rotateLeft.provider, "adb");
            assert.strictEqual(rotateLeft.orientation, "landscape");

            const rotateRight = parsePayload(await callTool("mobile_rotate_right", { ...direct, deviceId }));
            assert.strictEqual(rotateRight.provider, "adb");
            assert.strictEqual(rotateRight.orientation, "reverse-landscape");

            const openedUrl = parsePayload(await callTool("mobile_open_url", { ...direct, deviceId, url: "https://example.invalid/" }));
            assert.strictEqual(openedUrl.provider, "adb");
            assert.strictEqual(openedUrl.openedUrl, "https://example.invalid/");

            const setClipboard = parsePayload(await callTool("mobile_set_clipboard", { ...direct, deviceId, text: "ccc-android-device-clipboard" }));
            assert.strictEqual(setClipboard.provider, "broker-appium");
            assert.ok(setClipboard.requests >= 1);

            const getClipboard = parsePayload(await callTool("mobile_get_clipboard", { ...direct, deviceId }));
            assert.strictEqual(getClipboard.provider, "broker-appium");
            assert.ok(getClipboard.requests >= 1);
            assert.strictEqual(getClipboard.text, "ccc-android-device-clipboard");

            const mobileScreenshot = await callTool("mobile_screenshot", { ...direct, deviceId });
            assert.strictEqual(mobileScreenshot?.content?.[0]?.type, "image");
            assert.strictEqual(mobileScreenshot.content[0].mimeType, "image/png");
            assert.ok(String(mobileScreenshot.content[0].data || "").length > 64);

            const deviceScreenshot = await callTool("device_screenshot", { ...direct, deviceId });
            assert.strictEqual(deviceScreenshot?.content?.[0]?.type, "image");
            assert.strictEqual(deviceScreenshot.content[0].mimeType, "image/png");
            assert.ok(String(deviceScreenshot.content[0].data || "").length > 64);

            const recordStart = parsePayload(await callTool("device_record_video_start", {
                ...direct,
                deviceId,
                localPath: recordingPath,
                timeLimitSec: 10,
            }));
            recordingActive = true;
            assert.strictEqual(recordStart.recording.provider, "adb-screenrecord");
            assert.strictEqual(recordStart.recording.active, true);
            await new Promise((resolve) => setTimeout(resolve, 1000));

            const recordingStatus = parsePayload(await callTool("device_record_video_status", { ...direct, deviceId }));
            assert.strictEqual(recordingStatus.provider, "adb-screenrecord");
            assert.strictEqual(recordingStatus.recording.active, true);

            const recordStop = parsePayload(await callTool("device_record_video_stop", { ...direct, deviceId }));
            recordingActive = false;
            assert.strictEqual(recordStop.provider, "adb-screenrecord");
            assert.strictEqual(recordStop.stopped, true);
            assert.strictEqual(recordStop.recording.active, false);
            assert.strictEqual(androidDeviceReportedPathMatches(recordStop.recording.localPath, recordingPath), true);
            assert.ok(existsSync(recordingPath));
            assert.ok(readFileSync(recordingPath).length > 0);

            const uploadSource = join(tempDir, "upload.txt");
            const remotePath = `/sdcard/Download/ccc-android-device-e2e-${suffix}.txt`;
            const downloadTarget = join(tempDir, "download.txt");
            writeFileSync(uploadSource, `ccc-android-device-file-${suffix}`);
            const upload = parsePayload(await callTool("device_upload", { ...direct, deviceId, localPath: uploadSource, remotePath }));
            assert.strictEqual(upload.provider, "adb");
            assert.strictEqual(androidDeviceReportedPathMatches(upload.uploaded.localPath, uploadSource), true);
            assert.strictEqual(upload.uploaded.remotePath, remotePath);

            const download = parsePayload(await callTool("device_download", { ...direct, deviceId, remotePath, localPath: downloadTarget }));
            assert.strictEqual(download.provider, "adb");
            assert.strictEqual(download.downloaded.remotePath, remotePath);
            assert.strictEqual(androidDeviceReportedPathMatches(download.downloaded.localPath, downloadTarget), true);
            assert.strictEqual(readFileSync(downloadTarget, "utf-8"), `ccc-android-device-file-${suffix}`);
            try { await callTool("device_exec", { ...direct, deviceId, command: `rm -f ${remotePath}` }); } catch { /* preserve primary failure */ }

            {
                const deviceInstall = parsePayload(await callTool("device_install_app", {
                    ...direct,
                    deviceId,
                    path: appApk,
                    helperTimeoutMs: ANDROID_DEVICE_INSTALL_TIMEOUT_MS,
                }));
                assert.strictEqual(deviceInstall.provider, "adb");
                assert.strictEqual(androidDeviceReportedPathMatches(deviceInstall.installed, appApk), true);

                const deviceLaunch = parsePayload(await callTool("device_launch_app", { ...direct, deviceId, packageName: appPackage }));
                assert.strictEqual(deviceLaunch.provider, "adb");
                assert.strictEqual(deviceLaunch.launched, appPackage);

                const install = parsePayload(await callTool("mobile_install_app", {
                    ...direct,
                    deviceId,
                    path: appApk,
                    helperTimeoutMs: ANDROID_DEVICE_INSTALL_TIMEOUT_MS,
                }));
                assert.strictEqual(install.provider, "adb");
                assert.strictEqual(androidDeviceReportedPathMatches(install.installed, appApk), true);

                const launch = parsePayload(await callTool("mobile_launch_app", { ...direct, deviceId, packageName: appPackage }));
                assert.strictEqual(launch.provider, "adb");
                assert.strictEqual(launch.launched, appPackage);

                const waitForApp = parsePayload(await callTool("mobile_wait_for_app", {
                    ...direct,
                    deviceId,
                    packageName: appPackage,
                    timeoutMs: 10000,
                    intervalMs: 500,
                }));
                assert.strictEqual(waitForApp.provider, "adb");
                assert.strictEqual(waitForApp.packageName, appPackage);
                assert.strictEqual(waitForApp.running, true);
                assert.ok(String(waitForApp.pid || "").trim());

                const grant = parsePayload(await callTool("mobile_grant_permission", { ...direct, deviceId, packageName: appPackage, permission: appPermission }));
                assert.deepStrictEqual(grant.permission, { packageName: appPackage, permission: appPermission, action: "grant" });
                const revoke = parsePayload(await callTool("mobile_revoke_permission", { ...direct, deviceId, packageName: appPackage, permission: appPermission }));
                assert.deepStrictEqual(revoke.permission, { packageName: appPackage, permission: appPermission, action: "revoke" });

                const stopApp = parsePayload(await callTool("mobile_stop_app", { ...direct, deviceId, packageName: appPackage }));
                assert.strictEqual(stopApp.provider, "adb");
                assert.strictEqual(stopApp.packageName, appPackage);

                const reset = parsePayload(await callTool("device_reset", { ...direct, deviceId, packageName: appPackage, confirmDestructive: true }));
                assert.strictEqual(reset.provider, "adb");
                assert.deepStrictEqual(reset.reset, { packageName: appPackage });

                const clearAppData = parsePayload(await callTool("mobile_clear_app_data", { ...direct, deviceId, packageName: appPackage, confirmDestructive: true }));
                assert.strictEqual(clearAppData.provider, "adb");
                assert.strictEqual(clearAppData.packageName, appPackage);

                const uninstall = parsePayload(await callTool("mobile_uninstall_app", { ...direct, deviceId, packageName: appPackage, confirmDestructive: true }));
                assert.strictEqual(uninstall.provider, "adb");
                assert.strictEqual(uninstall.uninstalled, appPackage);
            }

            const stop = parsePayload(await callTool("device_stop", { ...direct, deviceId }));
            assert.strictEqual(androidDeviceStopPreservedPhysicalDevice(stop), true);

            const detach = parsePayload(await callTool("device_detach", { ...direct, deviceId }));
            attached = false;
            assert.strictEqual(detach.detached, deviceId);

            return {
                status: "PASS",
                detail: `device=${deviceId} serial=${cap.serial} app=${appSelection.source}:install-launch-wait-permission-stop-reset-clear-uninstall verified wireless=status-actions-device verified`,
                serial: cap.serial,
                deviceId,
                appCoverage: "install-launch-wait-permission-stop-reset-clear-uninstall verified",
                wirelessCoverage: "status-actions-device verified",
            };
        } catch (error) {
            primaryFailure = error;
            throw error;
        } finally {
            const cleanupErrors = [];
            if (recordingActive) {
                try { await callTool("device_record_video_stop", { ...direct, deviceId }); } catch (error) {
                    cleanupErrors.push(`recording stop: ${error.message}`);
                }
            }
            if (attached) {
                try { await callTool("device_detach", { ...direct, deviceId }); } catch (error) {
                    cleanupErrors.push(`device detach: ${error.message}`);
                }
            }
            try {
                rmSync(tempDir, { recursive: true, force: true });
            } catch (error) {
                cleanupErrors.push(`temporary artifact removal: ${error.message}`);
            }
            if (cleanupErrors.length > 0) {
                throw new Error(`Android physical-device E2E cleanup failed: ${cleanupErrors.join("; ")}${primaryFailure ? `; primary failure: ${primaryFailure.message}` : ""}`);
            }
        }
    }, providerMcpSessionOptions(options, "ccc-real-android-device-e2e"));
}
