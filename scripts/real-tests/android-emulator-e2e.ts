import assert from "assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import {
    androidBackend,
    androidDiscovery,
} from "../../device-lab-mcp/src/backends/android.mjs";
import { materializeAndroidAppFixture } from "./android-app-fixture.ts";
import { realProviderTempRoot } from "./helpers.ts";
import { parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";

function parsePayload(result) {
    return parseToolPayload(result);
}

function assertProvider(payload, expected, operation) {
    const diagnostic = JSON.stringify(payload);
    assert.strictEqual(
        payload?.provider,
        expected,
        `${operation} expected provider ${expected}: ${diagnostic.length > 1200 ? `${diagnostic.slice(0, 1197)}...` : diagnostic}`,
    );
}

function assertReportedLocalPath(actual, expected, brokerOnly) {
    if (brokerOnly) {
        assert.ok(String(actual || "").replace(/\\/g, "/").endsWith(`/${basename(expected)}`));
        return;
    }
    assert.strictEqual(actual, expected);
}

const DESTRUCTIVE_ANDROID_CAPABILITIES = new Set([
    "mobile_power",
    "mobile_set_network",
    "mobile_toggle_airplane_mode",
]);

function deviceFromPayload(payload, operation) {
    const launch = payload?.launch;
    const lastAttempt = Array.isArray(payload?.attempts) ? payload.attempts.at(-1) : null;
    const diagnostic = [
        payload?.error,
        launch?.error,
        launch?.detail,
        launch?.command,
        lastAttempt?.error,
    ].filter(Boolean).join(": ");
    assert.ok(
        payload?.device && typeof payload.device === "object",
        `${operation} returned no device${diagnostic ? `: ${diagnostic}` : ` (keys: ${Object.keys(payload || {}).join(", ") || "none"})`}`,
    );
    return payload.device;
}

function stableAndroidUiText(source) {
    const xml = String(source || "");
    const candidates = [...xml.matchAll(/\btext="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((text) => text && text !== "null" && !/^\s*$/.test(text));
    return candidates[0] || "hierarchy";
}

function sdkCandidates(discovery) {
    return [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : null,
        process.env.APPDATA ? join(process.env.APPDATA, "Android", "Sdk") : null,
        join(homedir(), "AppData", "Local", "Android", "Sdk"),
        join(homedir(), "Android", "Sdk"),
        join(homedir(), "Library", "Android", "sdk"),
        "/opt/android-sdk",
        "/usr/local/android-sdk",
        sdkRootFromTool(discovery?.adb),
        sdkRootFromTool(discovery?.emulator),
        sdkRootFromTool(discovery?.avdmanager),
    ].filter(Boolean).map((candidate) => resolve(candidate));
}

function sdkRootFromTool(toolPath) {
    if (!toolPath) return null;
    const dir = dirname(toolPath);
    if (basename(dir) === "platform-tools" || basename(dir) === "emulator") return dirname(dir);
    if (basename(dir) === "bin" && basename(dirname(dirname(dir))) === "cmdline-tools") return dirname(dirname(dirname(dir)));
    if (basename(dir) === "bin" && basename(dirname(dir)) === "tools") return dirname(dirname(dir));
    return null;
}

function listInstalledSystemImages(discovery) {
    const seen = new Set();
    const images = [];
    for (const sdk of sdkCandidates(discovery)) {
        if (seen.has(sdk)) continue;
        seen.add(sdk);
        const root = join(sdk, "system-images");
        let platforms = [];
        try {
            platforms = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        } catch {
            continue;
        }
        for (const platform of platforms) {
            let tags = [];
            try {
                tags = readdirSync(join(root, platform), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
            } catch {
                continue;
            }
            for (const tag of tags) {
                let abis = [];
                try {
                    abis = readdirSync(join(root, platform, tag), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
                } catch {
                    continue;
                }
                for (const abi of abis) {
                    const imageRoot = join(root, platform, tag, abi);
                    if (!existsSync(join(imageRoot, "system.img")) && !existsSync(join(imageRoot, "package.xml"))) continue;
                    images.push({
                        sdk,
                        platform,
                        tag,
                        abi,
                        package: `system-images;${platform};${tag};${abi}`,
                    });
                }
            }
        }
    }
    return images.sort(compareSystemImages);
}

function compareSystemImages(a, b) {
    const apiA = Number(a.platform.match(/^android-(\d+)$/)?.[1] || 0);
    const apiB = Number(b.platform.match(/^android-(\d+)$/)?.[1] || 0);
    return imageScore(b, apiB) - imageScore(a, apiA);
}

function imageScore(image, api) {
    const preferredAbi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
    const abiScore = image.abi === preferredAbi ? 1000 : image.abi.includes("x86") ? 700 : 100;
    const tagScore = image.tag === "google_apis" ? 80
        : image.tag === "google_apis_playstore" ? 70
            : image.tag.includes("atd") ? 60
                : image.tag === "default" ? 50
                    : 0;
    return api * 10_000 + abiScore + tagScore;
}

export function androidEmulatorE2ECapability(level = Number(process.env.CCC_TEST_LEVEL || "0")) {
    if (level < 2) return { available: false, reason: "CCC_TEST_LEVEL is below 2" };
    const discovery = androidDiscovery();
    if (!discovery.available) return { available: false, reason: `missing ${discovery.missing.join(", ")}`, discovery };
    if (!discovery.provisioningAvailable) return { available: false, reason: `missing ${discovery.provisioningMissing.join(", ")}`, discovery };
    const images = listInstalledSystemImages(discovery);
    if (images.length === 0) return { available: false, reason: "no installed Android SDK system image found", discovery };
    return { available: true, reason: "ready", discovery, systemImage: images[0], imageCount: images.length };
}

export function androidEmulatorAppSelection(env = process.env) {
    const app = {
        path: (env.CCC_REAL_ANDROID_APK || env.CCC_REAL_DEVICE_LAB_ANDROID_APK || "").trim(),
        packageName: (env.CCC_REAL_ANDROID_PACKAGE || env.CCC_REAL_DEVICE_LAB_ANDROID_PACKAGE || "").trim(),
        permission: (env.CCC_REAL_ANDROID_PERMISSION || env.CCC_REAL_DEVICE_LAB_ANDROID_PERMISSION || "").trim(),
    };
    const supplied = Object.values(app).filter(Boolean).length;
    if (supplied === 0) return { available: true, reason: "use deterministic fixture", source: "fixture", app: null };
    const missing = [
        !app.path ? "CCC_REAL_ANDROID_APK" : "",
        !app.packageName ? "CCC_REAL_ANDROID_PACKAGE" : "",
        !app.permission ? "CCC_REAL_ANDROID_PERMISSION" : "",
        app.path && !existsSync(app.path) ? `APK file not found: ${app.path}` : "",
    ].filter(Boolean);
    return missing.length > 0
        ? { available: false, reason: `external Android app proof is incomplete before emulator mutation: ${missing.join(", ")}`, source: "external", app }
        : { available: true, reason: "external app ready", source: "external", app };
}

export function androidEmulatorCreateRequest({ name, deviceId, systemImage }) {
    return {
        backend: "android-emulator",
        name,
        deviceId,
        systemImage,
        createAvd: true,
    };
}

export async function runAndroidEmulatorE2E(options: any = {}) {
    const cap = options.brokerOnly === true
        ? {
            available: Boolean(options.systemImage),
            reason: options.systemImage ? "host broker capability supplied" : "brokerOnly requires systemImage",
            discovery: { adb: null },
            systemImage: options.systemImage ? { package: options.systemImage } : null,
        }
        : androidEmulatorE2ECapability(options.level);
    if (!cap.available) return { status: "SKIP", reason: cap.reason, capability: cap };
    const appSelection = androidEmulatorAppSelection();
    if (!appSelection.available) return { status: "SKIP", reason: appSelection.reason, capability: cap };
    const stamp = Date.now();
    const deviceId = `android-real-e2e-${stamp}`;
    const name = `Real Android E2E ${stamp}`;
    const tempDir = mkdtempSync(join(realProviderTempRoot(options), "ccc-android-emulator-e2e-"));
    const app = appSelection.source === "external" ? appSelection.app : materializeAndroidAppFixture(tempDir);
    const appApk = app.path;
    const appPackage = app.packageName;
    const appPermission = app.permission;
    const advertisedCapabilities = androidBackend().capabilities;
    const calledCapabilities = new Set();
    let created = false;
    let stopped = false;
    let deleted = false;
    let recordingActive = false;
    let primaryFailure = null;
    let currentStep = "start MCP session";

    return withDeviceLabMcp(async ({ callTool: rawCallTool }) => {
        const callTool = async (tool, args) => {
            currentStep = tool;
            if (advertisedCapabilities.includes(tool)) calledCapabilities.add(tool);
            return rawCallTool(tool, args);
        };
        const direct = { backend: "android-emulator" };
        try {
            const createdPayload = parsePayload(await callTool("device_create", androidEmulatorCreateRequest({
                name,
                deviceId,
                systemImage: cap.systemImage.package,
            })));
            created = createdPayload?.ok === true;
            const createdDevice = deviceFromPayload(createdPayload, "device_create");
            assert.strictEqual(createdDevice.id, deviceId);
            assert.ok(Number.isInteger(createdDevice.port));
            assert.strictEqual(createdDevice.provisioned, true);

            const inventory = parsePayload(await callTool("device_inventory", direct));
            const inventoryDevices = inventory.devices || inventory.result?.devices;
            assert.ok(Array.isArray(inventoryDevices));
            assert.ok(inventoryDevices.some((device) => device.id === deviceId));

            const started = parsePayload(await callTool("device_start", {
                ...direct,
                deviceId,
                waitForBoot: true,
                bootTimeoutMs: options.bootTimeoutMs || 180000,
            }));
            const startedDevice = deviceFromPayload(started, "device_start");
            assert.strictEqual(startedDevice.id, deviceId);
            assert.strictEqual(startedDevice.status, "running");
            assert.strictEqual(started.boot.ready, true);

            const status = parsePayload(await callTool("device_status", { ...direct, deviceId }));
            const statusDevice = deviceFromPayload(status, "device_status");
            assert.strictEqual(statusDevice.id, deviceId);
            assert.strictEqual(statusDevice.status, "running");

            const exec = parsePayload(await callTool("device_exec", {
                ...direct,
                deviceId,
                command: "echo ccc-adb-e2e-ok",
            }));
            assert.match(exec.stdout, /ccc-adb-e2e-ok/);

            const uploadSource = join(tempDir, "upload.txt");
            const remotePath = `/data/local/tmp/ccc-android-emulator-e2e-${stamp}.txt`;
            const downloadTarget = join(tempDir, "download.txt");
            writeFileSync(uploadSource, `ccc-android-emulator-file-${stamp}`);
            const upload = parsePayload(await callTool("device_upload", { ...direct, deviceId, localPath: uploadSource, remotePath }));
            assert.strictEqual(upload.provider, "adb");
            assertReportedLocalPath(upload.uploaded.localPath, uploadSource, options.brokerOnly);
            assert.strictEqual(upload.uploaded.remotePath, remotePath);

            const download = parsePayload(await callTool("device_download", { ...direct, deviceId, remotePath, localPath: downloadTarget }));
            assert.strictEqual(download.provider, "adb");
            assert.strictEqual(download.downloaded.remotePath, remotePath);
            assertReportedLocalPath(download.downloaded.localPath, downloadTarget, options.brokerOnly);
            assert.strictEqual(readFileSync(downloadTarget, "utf-8"), `ccc-android-emulator-file-${stamp}`);
            try {
                await callTool("device_exec", { ...direct, deviceId, command: `rm -f ${remotePath}` });
            } catch {
                // Preserve the primary failure if best-effort remote cleanup fails.
            }

            const home = parsePayload(await callTool("mobile_home", { ...direct, deviceId }));
            assert.strictEqual(home.status, 0);

            const session = parsePayload(await callTool("mobile_session_status", { ...direct, deviceId }));
            const sessionResult = session.result || session;
            assert.strictEqual(sessionResult.authority, "host-broker");
            assert.strictEqual(sessionResult.device.id, deviceId);

            const ui = parsePayload(await callTool("mobile_dump_ui", { ...direct, deviceId }));
            assertProvider(ui, "adb-uiautomator", "mobile_dump_ui");
            assert.ok(typeof ui.source === "string");

            const waitText = stableAndroidUiText(ui.source);
            const waitedText = parsePayload(await callTool("mobile_wait_for_text", {
                ...direct,
                deviceId,
                text: waitText,
                timeoutMs: 5000,
                intervalMs: 250,
            }));
            assertProvider(waitedText, "adb-uiautomator", "mobile_wait_for_text");
            assert.strictEqual(waitedText.text, waitText);
            assert.strictEqual(waitedText.found, true);

            const tap = parsePayload(await callTool("mobile_tap", { ...direct, deviceId, x: 20, y: 20 }));
            assert.strictEqual(tap.status, 0);

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

            const typeText = parsePayload(await callTool("mobile_type_text", { ...direct, deviceId, text: "ccc-e2e" }));
            assert.strictEqual(typeText.provider, "adb");
            assert.strictEqual(typeText.typed, true);

            const back = parsePayload(await callTool("mobile_key", { ...direct, deviceId, keyCode: 4 }));
            assert.strictEqual(back.provider, "adb");
            assert.strictEqual(back.status, 0);

            const mobileBack = parsePayload(await callTool("mobile_back", { ...direct, deviceId }));
            assert.strictEqual(mobileBack.provider, "adb");
            assert.strictEqual(mobileBack.back, true);

            const forward = parsePayload(await callTool("mobile_forward", { ...direct, deviceId }));
            assert.strictEqual(forward.provider, "adb");
            assert.strictEqual(forward.forward, true);

            const recents = parsePayload(await callTool("mobile_recents", { ...direct, deviceId }));
            assert.strictEqual(recents.provider, "adb");
            assert.strictEqual(recents.recents, true);

            const lock = parsePayload(await callTool("mobile_lock", { ...direct, deviceId }));
            assert.strictEqual(lock.provider, "adb");
            assert.strictEqual(lock.locked, true);

            const unlock = parsePayload(await callTool("mobile_unlock", { ...direct, deviceId }));
            assert.strictEqual(unlock.provider, "adb");
            assert.strictEqual(unlock.unlocked, true);

            const rotateLeft = parsePayload(await callTool("mobile_rotate_left", { ...direct, deviceId }));
            assert.strictEqual(rotateLeft.provider, "adb");
            assert.strictEqual(rotateLeft.orientation, "landscape");

            const rotateRight = parsePayload(await callTool("mobile_rotate_right", { ...direct, deviceId }));
            assert.strictEqual(rotateRight.provider, "adb");
            assert.strictEqual(rotateRight.orientation, "reverse-landscape");

            const portrait = parsePayload(await callTool("mobile_set_orientation", { ...direct, deviceId, orientation: "portrait" }));
            assert.strictEqual(portrait.provider, "adb");
            assert.strictEqual(portrait.orientation, "portrait");

            const openedUrl = parsePayload(await callTool("mobile_open_url", { ...direct, deviceId, url: "https://example.invalid" }));
            assert.strictEqual(openedUrl.provider, "adb");
            assert.strictEqual(openedUrl.openedUrl, "https://example.invalid");

            const location = parsePayload(await callTool("mobile_set_location", { ...direct, deviceId, latitude: 37.422, longitude: -122.084, altitude: 5 }));
            assert.strictEqual(location.provider, "adb-emulator");
            assert.deepStrictEqual(location.location, { latitude: 37.422, longitude: -122.084, altitude: 5 });

            const battery = parsePayload(await callTool("mobile_set_battery", { ...direct, deviceId, level: 77, charging: true, status: 2, confirmDestructive: true }));
            assert.strictEqual(battery.provider, "adb");
            assert.deepStrictEqual(battery.battery, { level: 77, status: 2, charging: true });

            {
                const deviceInstall = parsePayload(await callTool("device_install_app", {
                    ...direct,
                    deviceId,
                    path: appApk,
                    replace: true,
                }));
                assertReportedLocalPath(deviceInstall.installed, appApk, options.brokerOnly);
                assert.strictEqual(deviceInstall.provider, "adb");

                const deviceLaunch = parsePayload(await callTool("device_launch_app", {
                    ...direct,
                    deviceId,
                    packageName: appPackage,
                }));
                assert.strictEqual(deviceLaunch.provider, "adb");
                assert.strictEqual(deviceLaunch.launched, appPackage);

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
                assert.match(String(waitForApp.pid), /^\d+$/);

                {
                    const grantPermission = parsePayload(await callTool("mobile_grant_permission", {
                        ...direct,
                        deviceId,
                        packageName: appPackage,
                        permission: appPermission,
                    }));
                    assert.strictEqual(grantPermission.provider, "adb");
                    assert.deepStrictEqual(grantPermission.permission, {
                        packageName: appPackage,
                        permission: appPermission,
                        action: "grant",
                    });

                    const revokePermission = parsePayload(await callTool("mobile_revoke_permission", {
                        ...direct,
                        deviceId,
                        packageName: appPackage,
                        permission: appPermission,
                    }));
                    assert.strictEqual(revokePermission.provider, "adb");
                    assert.deepStrictEqual(revokePermission.permission, {
                        packageName: appPackage,
                        permission: appPermission,
                        action: "revoke",
                    });
                }

                const mobileStop = parsePayload(await callTool("mobile_stop_app", {
                    ...direct,
                    deviceId,
                    packageName: appPackage,
                }));
                assert.strictEqual(mobileStop.provider, "adb");
                assert.strictEqual(mobileStop.stopped, appPackage);

                const deviceReset = parsePayload(await callTool("device_reset", {
                    ...direct,
                    deviceId,
                    packageName: appPackage,
                    confirmDestructive: true,
                }));
                assert.strictEqual(deviceReset.provider, "adb");
                assert.deepStrictEqual(deviceReset.reset, { packageName: appPackage });

                const clearAppData = parsePayload(await callTool("mobile_clear_app_data", {
                    ...direct,
                    deviceId,
                    packageName: appPackage,
                    confirmDestructive: true,
                }));
                assert.strictEqual(clearAppData.provider, "adb");
                assert.deepStrictEqual(clearAppData.reset, { packageName: appPackage });

                const mobileLaunch = parsePayload(await callTool("mobile_launch_app", {
                    ...direct,
                    deviceId,
                    packageName: appPackage,
                }));
                assert.strictEqual(mobileLaunch.provider, "adb");
                assert.strictEqual(mobileLaunch.launched, appPackage);

                const mobileUninstall = parsePayload(await callTool("mobile_uninstall_app", {
                    ...direct,
                    deviceId,
                    packageName: appPackage,
                    confirmDestructive: true,
                }));
                assert.strictEqual(mobileUninstall.provider, "adb");
                assert.strictEqual(mobileUninstall.uninstalled, appPackage);

                const mobileInstall = parsePayload(await callTool("mobile_install_app", {
                    ...direct,
                    deviceId,
                    path: appApk,
                }));
                assertReportedLocalPath(mobileInstall.installed, appApk, options.brokerOnly);
                assert.strictEqual(mobileInstall.provider, "adb");

                const finalUninstall = parsePayload(await callTool("mobile_uninstall_app", {
                    ...direct,
                    deviceId,
                    packageName: appPackage,
                    confirmDestructive: true,
                }));
                assert.strictEqual(finalUninstall.provider, "adb");
                assert.strictEqual(finalUninstall.uninstalled, appPackage);
            }

            if (options.destructive === true) {
                const powerToggleOff = parsePayload(await callTool("mobile_power", { ...direct, deviceId }));
                assert.strictEqual(powerToggleOff.provider, "adb");
                assert.strictEqual(powerToggleOff.power, true);

                const powerToggleOn = parsePayload(await callTool("mobile_power", { ...direct, deviceId }));
                assert.strictEqual(powerToggleOn.provider, "adb");
                assert.strictEqual(powerToggleOn.power, true);

                const unlockAfterPower = parsePayload(await callTool("mobile_unlock", { ...direct, deviceId }));
                assert.strictEqual(unlockAfterPower.provider, "adb");
                assert.strictEqual(unlockAfterPower.unlocked, true);

                const network = parsePayload(await callTool("mobile_set_network", {
                    ...direct,
                    deviceId,
                    wifi: true,
                    data: true,
                    confirmDestructive: true,
                }));
                assert.strictEqual(network.provider, "adb");
                assert.deepStrictEqual(network.network, { wifi: true, data: true });

                const airplaneOn = parsePayload(await callTool("mobile_toggle_airplane_mode", {
                    ...direct,
                    deviceId,
                    enabled: true,
                    confirmDestructive: true,
                }));
                assert.strictEqual(airplaneOn.provider, "adb");
                assert.strictEqual(airplaneOn.airplaneMode, true);

                const airplaneOff = parsePayload(await callTool("mobile_toggle_airplane_mode", {
                    ...direct,
                    deviceId,
                    enabled: false,
                    confirmDestructive: true,
                }));
                assert.strictEqual(airplaneOff.provider, "adb");
                assert.strictEqual(airplaneOff.airplaneMode, false);
            }

            const recordingPath = join(tempDir, "recording.mp4");
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

            const mobileFlow = parsePayload(await callTool("mobile_run_flow", {
                steps: [
                    { tool: "mobile_session_status", arguments: { ...direct, deviceId } },
                    { tool: "mobile_home", arguments: { ...direct, deviceId } },
                ],
            }));
            assert.strictEqual(mobileFlow.ok, true);
            assert.strictEqual(mobileFlow.results.length, 2);

            const recordStop = parsePayload(await callTool("device_record_video_stop", { ...direct, deviceId }));
            recordingActive = false;
            assert.strictEqual(recordStop.provider, "adb-screenrecord");
            assert.strictEqual(recordStop.stopped, true);
            assert.strictEqual(recordStop.recording.active, false);
            assertReportedLocalPath(recordStop.recording.localPath, recordingPath, options.brokerOnly);
            assert.ok(existsSync(recordingPath));
            assert.ok(readFileSync(recordingPath).length > 0);

            const mobileScreenshot = await callTool("mobile_screenshot", { ...direct, deviceId });
            assert.strictEqual(mobileScreenshot?.content?.[0]?.type, "image");
            assert.ok(String(mobileScreenshot.content[0].data || "").length > 64);

            const setClipboard = parsePayload(await callTool("mobile_set_clipboard", { ...direct, deviceId, text: "ccc-clipboard-e2e-ok" }));
            assertProvider(setClipboard, "broker-appium", "mobile_set_clipboard");
            const getClipboard = parsePayload(await callTool("mobile_get_clipboard", { ...direct, deviceId }));
            assertProvider(getClipboard, "broker-appium", "mobile_get_clipboard");
            assert.match(getClipboard.text, /ccc-clipboard-e2e-ok/);

            const screenshot = await callTool("device_screenshot", { ...direct, deviceId });
            assert.strictEqual(screenshot?.content?.[0]?.type, "image");
            assert.ok(String(screenshot.content[0].data || "").length > 64);

            const stoppedPayload = parsePayload(await callTool("device_stop", { ...direct, deviceId }));
            stopped = true;
            assert.strictEqual(deviceFromPayload(stoppedPayload, "device_stop").status, "stopped");

            const deletedPayload = parsePayload(await callTool("device_delete", {
                ...direct,
                deviceId,
                deleteAvd: true,
                confirmDestructive: true,
            }));
            deleted = true;
            assert.strictEqual(deletedPayload.deleted, deviceId);
            assert.strictEqual(deletedPayload.avdDeleted, true);

            const expectedCapabilities = options.destructive === true
                ? advertisedCapabilities
                : advertisedCapabilities.filter((tool) => !DESTRUCTIVE_ANDROID_CAPABILITIES.has(tool));
            assert.deepStrictEqual(
                expectedCapabilities.filter((tool) => !calledCapabilities.has(tool)),
                [],
                "Android emulator real E2E did not call every advertised capability",
            );

            return {
                status: "PASS",
                systemImage: cap.systemImage.package,
                port: createdDevice.port,
                appArtifact: "verified",
                appPermission: "verified",
                appSource: appSelection.source,
                appPackage,
                verifiedCapabilities: [...calledCapabilities].sort(),
            };
        } catch (error) {
            const failure = new Error(`${currentStep}: ${error instanceof Error ? error.message : String(error)}`);
            primaryFailure = failure;
            throw failure;
        } finally {
            const cleanupErrors = [];
            if (recordingActive) {
                try {
                    await callTool("device_record_video_stop", { ...direct, deviceId });
                } catch (error) {
                    cleanupErrors.push(`recording stop: ${error.message}`);
                }
            }
            if (created && !stopped) {
                try {
                    await callTool("device_stop", { ...direct, deviceId });
                } catch (error) {
                    cleanupErrors.push(`device stop: ${error.message}`);
                }
            }
            if (created && !deleted) {
                try {
                    await callTool("device_delete", { ...direct, deviceId, force: true, deleteAvd: true, confirmDestructive: true });
                } catch (error) {
                    cleanupErrors.push(`device/AVD delete: ${error.message}`);
                }
            }
            try {
                rmSync(tempDir, { recursive: true, force: true });
            } catch (error) {
                cleanupErrors.push(`temporary artifact removal: ${error.message}`);
            }
            if (cleanupErrors.length > 0) {
                throw new Error(`Android emulator E2E cleanup failed: ${cleanupErrors.join("; ")}${primaryFailure ? `; primary failure: ${primaryFailure.message}` : ""}`);
            }
        }
    }, providerMcpSessionOptions(options, "ccc-real-android-emulator-e2e"));
}
