import assert from "assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { androidDiscovery } from "../../device-lab-mcp/src/backends/android.mjs";
import { parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.mjs";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.mjs";

export const name = "level 2 Android physical device ADB E2E";

function parsePayload(result) {
    return parseToolPayload(result);
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
    if (!discovery.adb) return { available: false, reason: "missing adb", discovery };
    const serial = (process.env.CCC_REAL_ANDROID_DEVICE_SERIAL || process.env.CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_SERIAL || "").trim();
    if (!serial) return { available: false, reason: "missing CCC_REAL_ANDROID_DEVICE_SERIAL", discovery };
    return { available: true, reason: "ready", discovery, serial };
}

export async function run(options = {}) {
    const cap = androidDeviceE2ECapability(options.level);
    if (!cap.available) return { status: "SKIP", reason: cap.reason, capability: cap };

    const appApk = (process.env.CCC_REAL_ANDROID_DEVICE_APK || process.env.CCC_REAL_ANDROID_APK || process.env.CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_APK || "").trim();
    const appPackage = (process.env.CCC_REAL_ANDROID_DEVICE_PACKAGE || process.env.CCC_REAL_ANDROID_PACKAGE || process.env.CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_PACKAGE || "").trim();
    const appPermission = (process.env.CCC_REAL_ANDROID_DEVICE_PERMISSION || process.env.CCC_REAL_ANDROID_PERMISSION || process.env.CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_PERMISSION || "").trim();
    const appArtifactReady = Boolean(appApk && appPackage);
    const strictProof = process.env.CCC_REAL_DEVICE_LAB_FAIL_ON_SKIP === "1";
    if (strictProof && (!appArtifactReady || !appPermission)) {
        return {
            status: "SKIP",
            reason: [
                !appArtifactReady ? "missing CCC_REAL_ANDROID_DEVICE_APK/CCC_REAL_ANDROID_DEVICE_PACKAGE" : "",
                !appPermission ? "missing CCC_REAL_ANDROID_DEVICE_PERMISSION" : "",
            ].filter(Boolean).join(", "),
        };
    }

    const suffix = Date.now();
    const deviceId = `android-device-real-e2e-${suffix}`;
    const tempDir = mkdtempSync(join(tmpdir(), "ccc-android-device-e2e-"));
    let attached = false;
    let recordingActive = false;

    return withDeviceLabMcp(async ({ callTool }) => {
        const direct = { backend: "android-device" };
        try {
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
            assert.strictEqual(status.hostState.status, 0);
            assert.strictEqual(status.hostState.stdout, "device");

            const start = parsePayload(await callTool("device_start", { ...direct, deviceId }));
            assert.strictEqual(start.alreadyAttached, true);

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
            assert.strictEqual(setClipboard.provider, "adb");
            assert.deepStrictEqual(setClipboard.clipboard, { set: true });

            const getClipboard = parsePayload(await callTool("mobile_get_clipboard", { ...direct, deviceId }));
            assert.strictEqual(getClipboard.provider, "adb");
            assert.deepStrictEqual(getClipboard.clipboard, { get: true });

            const mobileScreenshot = await callTool("mobile_screenshot", { ...direct, deviceId });
            assert.strictEqual(mobileScreenshot?.content?.[0]?.type, "image");
            assert.strictEqual(mobileScreenshot.content[0].mimeType, "image/png");
            assert.ok(String(mobileScreenshot.content[0].data || "").length > 64);

            const deviceScreenshot = await callTool("device_screenshot", { ...direct, deviceId });
            assert.strictEqual(deviceScreenshot?.content?.[0]?.type, "image");
            assert.strictEqual(deviceScreenshot.content[0].mimeType, "image/png");
            assert.ok(String(deviceScreenshot.content[0].data || "").length > 64);

            const recordStart = parsePayload(await callTool("device_record_video_start", { ...direct, deviceId, timeLimitSec: 10 }));
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
            assert.ok(existsSync(recordStop.recording.localPath));

            const uploadSource = join(tempDir, "upload.txt");
            const remotePath = `/sdcard/Download/ccc-android-device-e2e-${suffix}.txt`;
            const downloadTarget = join(tempDir, "download.txt");
            writeFileSync(uploadSource, `ccc-android-device-file-${suffix}`);
            const upload = parsePayload(await callTool("device_upload", { ...direct, deviceId, localPath: uploadSource, remotePath }));
            assert.strictEqual(upload.provider, "adb");
            assert.strictEqual(upload.uploaded.localPath, uploadSource);
            assert.strictEqual(upload.uploaded.remotePath, remotePath);

            const download = parsePayload(await callTool("device_download", { ...direct, deviceId, remotePath, localPath: downloadTarget }));
            assert.strictEqual(download.provider, "adb");
            assert.strictEqual(download.downloaded.remotePath, remotePath);
            assert.strictEqual(download.downloaded.localPath, downloadTarget);
            assert.strictEqual(readFileSync(downloadTarget, "utf-8"), `ccc-android-device-file-${suffix}`);
            try { await callTool("device_exec", { ...direct, deviceId, command: `rm -f ${remotePath}` }); } catch { /* preserve primary failure */ }

            let appCoverage = "skipped missing CCC_REAL_ANDROID_DEVICE_APK/CCC_REAL_ANDROID_DEVICE_PACKAGE";
            if (appArtifactReady) {
                const deviceInstall = parsePayload(await callTool("device_install_app", { ...direct, deviceId, path: appApk }));
                assert.strictEqual(deviceInstall.provider, "adb");
                assert.strictEqual(deviceInstall.installed, appApk);

                const deviceLaunch = parsePayload(await callTool("device_launch_app", { ...direct, deviceId, packageName: appPackage }));
                assert.strictEqual(deviceLaunch.provider, "adb");
                assert.strictEqual(deviceLaunch.launched, appPackage);

                const install = parsePayload(await callTool("mobile_install_app", { ...direct, deviceId, path: appApk }));
                assert.strictEqual(install.provider, "adb");
                assert.strictEqual(install.installed, appApk);

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
                assert.strictEqual(waitForApp.found, true);

                if (appPermission) {
                    const grant = parsePayload(await callTool("mobile_grant_permission", { ...direct, deviceId, packageName: appPackage, permission: appPermission }));
                    assert.deepStrictEqual(grant.permission, { packageName: appPackage, permission: appPermission, action: "grant" });
                    const revoke = parsePayload(await callTool("mobile_revoke_permission", { ...direct, deviceId, packageName: appPackage, permission: appPermission }));
                    assert.deepStrictEqual(revoke.permission, { packageName: appPackage, permission: appPermission, action: "revoke" });
                }

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
                appCoverage = appPermission ? "install-launch-wait-permission-stop-reset-clear-uninstall verified" : "install-launch-wait-stop-reset-clear-uninstall verified";
            }

            const stop = parsePayload(await callTool("device_stop", { ...direct, deviceId }));
            assert.strictEqual(stop.physicalDevicePoweredOff, false);

            const detach = parsePayload(await callTool("device_detach", { ...direct, deviceId }));
            attached = false;
            assert.strictEqual(detach.detached, deviceId);

            return {
                status: "PASS",
                detail: `device=${deviceId} serial=${cap.serial} app=${appCoverage}`,
                serial: cap.serial,
                deviceId,
                appCoverage,
            };
        } finally {
            if (recordingActive) {
                try { await callTool("device_record_video_stop", { ...direct, deviceId }); } catch { /* preserve primary failure */ }
            }
            if (attached) {
                try { await callTool("device_detach", { ...direct, deviceId }); } catch { /* preserve primary failure */ }
            }
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, providerMcpSessionOptions(options, "ccc-real-android-device-e2e"));
}
