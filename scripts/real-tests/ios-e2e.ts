import assert from "assert";
import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    iosAppiumDiscovery,
    iosDiscovery,
} from "../../device-lab-mcp/src/backends/ios-simulator.mjs";
import { parseContractToolPayload, parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";
import { findSimctlDevice, selectPhysicalIosDevice, simctlDevices, simctlJson } from "./providers/apple.ts";
import { iosRealDeviceE2EOptions, iosSimulatorE2EOptions } from "./typed-options.ts";

export { parseXctracePhysicalIosDevices } from "./providers/apple.ts";

function parsePayload(result) {
    return parseToolPayload(result);
}

function assertSimulatorMobileProvider(payload, operation) {
    assert.ok(["simctl", "broker-appium"].includes(payload?.provider), `${operation} returned unexpected provider: ${JSON.stringify(payload)}`);
}

function stableIosUiText(source) {
    const xml = String(source || "");
    const candidates = [...xml.matchAll(/\b(?:name|label|value|text)="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((text) => text && text !== "null" && !/^\s*$/.test(text));
    if (candidates[0]) return candidates[0];
    if (xml.includes("XCUIElementType")) return "XCUIElementType";
    return xml.trim().split(/\s+/).find(Boolean) || "hierarchy";
}

function commandPath(command) {
    const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
        encoding: "utf-8",
        env: process.env,
        windowsHide: true,
    });
    if (result.status !== 0) return null;
    return (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function run(command, args, timeoutMs = 30000) {
    return spawnSync(command, args, {
        encoding: "utf-8",
        env: process.env,
        timeout: timeoutMs,
        windowsHide: true,
    });
}

function cleanupSimulator(xcrun, udid) {
    if (!xcrun || !udid) return;
    run(xcrun, ["simctl", "shutdown", udid], 30000);
    run(xcrun, ["simctl", "delete", udid], 30000);
}

function availableRuntime(runtimes) {
    return (runtimes || [])
        .filter((runtime) => runtime?.identifier && runtime.isAvailable !== false && /CoreSimulator\.SimRuntime\.iOS/.test(runtime.identifier))
        .sort((a, b) => String(b.identifier).localeCompare(String(a.identifier)))[0] || null;
}

function preferredDeviceType(deviceTypes) {
    const types = (deviceTypes || []).filter((type) => type?.identifier);
    return types.find((type) => /iPhone-15/.test(type.identifier))
        || types.find((type) => /iPhone/.test(type.identifier))
        || types[0]
        || null;
}

function xcrunMissingToolDetail(result, tool) {
    const output = `${result.stderr || ""}\n${result.stdout || ""}`;
    if (new RegExp(`unable to find utility "${tool}"|not a developer tool`, "i").test(output)) return `missing ${tool}`;
    return null;
}

export function iosSimulatorE2ECapability(level = Number(process.env.CCC_TEST_LEVEL || "0")) {
    if (level < 2) return { available: false, reason: "CCC_TEST_LEVEL is below 2" };
    if (process.platform !== "darwin") return { available: false, reason: "not a macOS host" };
    const discovery = iosDiscovery();
    if (!discovery.xcrun) return { available: false, reason: "missing xcrun", discovery };
    const inventory = simctlJson(discovery.xcrun, ["list", "-j"]);
    if (inventory.error) return { available: false, reason: xcrunMissingToolDetail({ stderr: inventory.error }, "simctl") || inventory.error, discovery };
    const runtime = availableRuntime(inventory.value.runtimes);
    if (!runtime) return { available: false, reason: "no available iOS Simulator runtime", discovery };
    const deviceType = preferredDeviceType(inventory.value.devicetypes || inventory.value.deviceTypes);
    if (!deviceType) return { available: false, reason: "no available iOS Simulator device type", discovery };
    return { available: true, reason: "ready", discovery, runtime, deviceType };
}

export function iosRealDeviceE2ECapability(level = Number(process.env.CCC_TEST_LEVEL || "0")) {
    if (level < 2) return { available: false, reason: "CCC_TEST_LEVEL is below 2" };
    if (process.platform !== "darwin") return { available: false, reason: "not a macOS host" };
    const xcrun = commandPath("xcrun");
    const xcodebuild = commandPath("xcodebuild");
    if (!xcrun) return { available: false, reason: "missing xcrun" };
    const inventory = run(xcrun, ["xctrace", "list", "devices"]);
    if (inventory.status !== 0) return { available: false, reason: xcrunMissingToolDetail(inventory, "xctrace") || inventory.stderr || inventory.stdout || `exit ${inventory.status}` };
    const selected = selectPhysicalIosDevice(inventory.stdout, process.env.CCC_REAL_IOS_DEVICE_UDID);
    if (!selected.ok) return { available: false, reason: selected.reason, inventory: inventory.stdout, devices: selected.devices };
    return { available: true, reason: "ready", xcrun, xcodebuild, udid: selected.udid, autoSelected: selected.autoSelected, devices: selected.devices };
}

/** @param {{ level?: number; bootTimeoutMs?: number; [key: string]: unknown }} options */
export async function runIosSimulatorE2E(options: any = {}) {
    const typedOptions = iosSimulatorE2EOptions(options);
    const level = Number(typedOptions.level || process.env.CCC_TEST_LEVEL || "0");
    const cap = iosSimulatorE2ECapability(level);
    if (!cap.available) return { status: "SKIP", reason: cap.reason, capability: cap };
    const appPath = (process.env.CCC_REAL_IOS_SIMULATOR_APP || process.env.CCC_REAL_DEVICE_LAB_IOS_SIMULATOR_APP || "").trim();
    const appBundleId = (process.env.CCC_REAL_IOS_SIMULATOR_BUNDLE_ID || process.env.CCC_REAL_DEVICE_LAB_IOS_SIMULATOR_BUNDLE_ID || "").trim();
    const appArtifactReady = Boolean(appPath && appBundleId);
    const strictProof = process.env.CCC_REAL_DEVICE_LAB_FAIL_ON_SKIP === "1";
    const appiumForProof = iosAppiumDiscovery();
    if (strictProof && (!appArtifactReady || !appiumForProof.available)) {
        return {
            status: "SKIP",
            reason: [
                !appArtifactReady ? "missing CCC_REAL_IOS_SIMULATOR_APP/CCC_REAL_IOS_SIMULATOR_BUNDLE_ID" : "",
                !appiumForProof.available ? `missing iOS Appium/XCUITest prerequisites: ${appiumForProof.missing.join(", ")}` : "",
            ].filter(Boolean).join(", "),
        };
    }

    const suffix = `${Date.now()}-${randomBytes(3).toString("hex")}`;
    const deviceId = `ios-real-e2e-${suffix}`;
    const name = `Real iOS E2E ${suffix}`;
    const tempDir = mkdtempSync(join(tmpdir(), "ccc-ios-simulator-e2e-"));
    let created = false;
    let stopped = false;
    let deleted = false;
    let createdUdid = null;
    let appiumControls = "not-run";
    let recordingActive = false;
    const simulatorUdidsBefore = new Set(simctlDevices(cap.discovery.xcrun).map((device) => device?.udid).filter(Boolean));
    return withDeviceLabMcp(async ({ callTool }) => {
        const direct = { backend: "ios-simulator" };
        try {
            const create = parseContractToolPayload("device_create", await callTool("device_create", {
                ...direct,
                name,
                deviceId,
                deviceType: cap.deviceType.identifier,
                runtime: cap.runtime.identifier,
                createSimulator: true,
            }));
            created = true;
            const createdDevice = create.device;
            assert.strictEqual(createdDevice.id, deviceId);
            const createdCandidates = simctlDevices(cap.discovery.xcrun)
                .filter((device) => device?.udid && !simulatorUdidsBefore.has(device.udid));
            assert.strictEqual(createdCandidates.length, 1, `simctl expected one newly created simulator, found ${JSON.stringify(createdCandidates)}`);
            const [createdSimulator] = createdCandidates;
            createdUdid = createdSimulator.udid;

            const start = parseContractToolPayload("device_start", await callTool("device_start", {
                ...direct,
                deviceId,
                waitForBoot: true,
                bootTimeoutMs: typedOptions.bootTimeoutMs || 180000,
            }));
            const startedDevice = start.device;
            assert.strictEqual(startedDevice.id, deviceId);
            const bootStatus = run(cap.discovery.xcrun, ["simctl", "bootstatus", createdUdid, "-b"], typedOptions.bootTimeoutMs || 180000);
            assert.strictEqual(bootStatus.status, 0, bootStatus.stderr || bootStatus.stdout || `simctl bootstatus exited ${bootStatus.status}`);
            const bootedSimulator = findSimctlDevice(cap.discovery.xcrun, (device) => device?.udid === createdUdid);
            assert.strictEqual(bootedSimulator?.state, "Booted", JSON.stringify(bootedSimulator));

            const status = parseContractToolPayload("device_status", await callTool("device_status", { ...direct, deviceId }));
            const statusDevice = status.device;
            assert.strictEqual(statusDevice.id, deviceId);
            assert.strictEqual(statusDevice.status, "running");

            const exec = parsePayload(await callTool("device_exec", {
                ...direct,
                deviceId,
                command: "echo ccc-ios-simulator-e2e-ok",
            }));
            assert.match(exec.stdout, /ccc-ios-simulator-e2e-ok/);

            const session = parseContractToolPayload("mobile_session_status", await callTool("mobile_session_status", { ...direct, deviceId }));
            assert.strictEqual(session.deviceId, deviceId, JSON.stringify(session));

            const mobileScreenshot = await callTool("mobile_screenshot", { ...direct, deviceId });
            assert.strictEqual(mobileScreenshot?.content?.[0]?.type, "image");
            assert.ok(String(mobileScreenshot.content[0].data || "").length > 64);

            const openedUrl = parsePayload(await callTool("mobile_open_url", { ...direct, deviceId, url: "https://example.invalid" }));
            assertSimulatorMobileProvider(openedUrl, "mobile_open_url");
            assert.strictEqual(openedUrl.openedUrl, "https://example.invalid");

            const waitForSafari = parsePayload(await callTool("mobile_wait_for_app", {
                ...direct,
                deviceId,
                bundleId: "com.apple.mobilesafari",
                timeoutMs: 10000,
                intervalMs: 500,
            }));
            assertSimulatorMobileProvider(waitForSafari, "mobile_wait_for_app Safari");
            assert.strictEqual(waitForSafari.bundleId, "com.apple.mobilesafari");
            assert.strictEqual(waitForSafari.running, true, `mobile_wait_for_app Safari failed: ${JSON.stringify(waitForSafari)}`);

            const stopSafari = parsePayload(await callTool("mobile_stop_app", {
                ...direct,
                deviceId,
                bundleId: "com.apple.mobilesafari",
            }));
            assertSimulatorMobileProvider(stopSafari, "mobile_stop_app Safari");
            assert.strictEqual(stopSafari.stopped, "com.apple.mobilesafari");

            if (appArtifactReady) {
                const deviceInstall = parsePayload(await callTool("device_install_app", {
                    ...direct,
                    deviceId,
                    path: appPath,
                }));
                assert.strictEqual(deviceInstall.installed, appPath);

                const deviceLaunch = parsePayload(await callTool("device_launch_app", {
                    ...direct,
                    deviceId,
                    bundleId: appBundleId,
                }));
                assert.strictEqual(deviceLaunch.launched, appBundleId);

                const waitForInstalledApp = parsePayload(await callTool("mobile_wait_for_app", {
                    ...direct,
                    deviceId,
                    bundleId: appBundleId,
                    timeoutMs: 10000,
                    intervalMs: 500,
                }));
                assertSimulatorMobileProvider(waitForInstalledApp, "mobile_wait_for_app installed app");
                assert.strictEqual(waitForInstalledApp.bundleId, appBundleId);
                assert.strictEqual(waitForInstalledApp.running, true, `mobile_wait_for_app installed app failed: ${JSON.stringify(waitForInstalledApp)}`);

                const uploadSource = join(tempDir, "upload.txt");
                const remotePath = `Documents/ccc-ios-simulator-e2e-${suffix}.txt`;
                const downloadTarget = join(tempDir, "download.txt");
                writeFileSync(uploadSource, `ccc-ios-simulator-file-${suffix}`);
                const upload = parsePayload(await callTool("device_upload", {
                    ...direct,
                    deviceId,
                    bundleId: appBundleId,
                    localPath: uploadSource,
                    remotePath,
                }));
                assert.strictEqual(upload.provider, "simctl-app-container");
                assert.strictEqual(upload.uploaded.localPath, uploadSource);
                assert.strictEqual(upload.uploaded.remotePath, remotePath);
                assert.strictEqual(upload.uploaded.bundleId, appBundleId);

                const download = parsePayload(await callTool("device_download", {
                    ...direct,
                    deviceId,
                    bundleId: appBundleId,
                    remotePath,
                    localPath: downloadTarget,
                }));
                assert.strictEqual(download.provider, "simctl-app-container");
                assert.strictEqual(download.downloaded.remotePath, remotePath);
                assert.strictEqual(download.downloaded.localPath, downloadTarget);
                assert.strictEqual(download.downloaded.bundleId, appBundleId);
                assert.strictEqual(readFileSync(downloadTarget, "utf-8"), `ccc-ios-simulator-file-${suffix}`);

                const mobileStop = parsePayload(await callTool("mobile_stop_app", {
                    ...direct,
                    deviceId,
                    bundleId: appBundleId,
                }));
                assertSimulatorMobileProvider(mobileStop, "mobile_stop_app installed app");
                assert.strictEqual(mobileStop.stopped, appBundleId);

                const clearAppData = parsePayload(await callTool("mobile_clear_app_data", {
                    ...direct,
                    deviceId,
                    bundleId: appBundleId,
                    confirmDestructive: true,
                }));
                assert.strictEqual(clearAppData.provider, "simctl-app-container");
                assert.deepStrictEqual(clearAppData.reset, { bundleId: appBundleId, containerType: "data" });

                const mobileLaunch = parsePayload(await callTool("mobile_launch_app", {
                    ...direct,
                    deviceId,
                    bundleId: appBundleId,
                }));
                assert.strictEqual(mobileLaunch.launched, appBundleId);

                const mobileUninstall = parsePayload(await callTool("mobile_uninstall_app", {
                    ...direct,
                    deviceId,
                    bundleId: appBundleId,
                    confirmDestructive: true,
                }));
                assertSimulatorMobileProvider(mobileUninstall, "mobile_uninstall_app");
                assert.strictEqual(mobileUninstall.uninstalled, appBundleId);

                const mobileInstall = parsePayload(await callTool("mobile_install_app", {
                    ...direct,
                    deviceId,
                    path: appPath,
                }));
                assert.strictEqual(mobileInstall.installed, appPath);

                const deviceReset = parsePayload(await callTool("device_reset", {
                    ...direct,
                    deviceId,
                    bundleId: appBundleId,
                    confirmDestructive: true,
                }));
                assert.strictEqual(deviceReset.provider, "simctl-app-container");
                assert.deepStrictEqual(deviceReset.reset, { bundleId: appBundleId, containerType: "data" });

                const finalUninstall = parsePayload(await callTool("mobile_uninstall_app", {
                    ...direct,
                    deviceId,
                    bundleId: appBundleId,
                    confirmDestructive: true,
                }));
                assertSimulatorMobileProvider(finalUninstall, "mobile_uninstall_app final");
                assert.strictEqual(finalUninstall.uninstalled, appBundleId);
            }

            const location = parsePayload(await callTool("mobile_set_location", {
                ...direct,
                deviceId,
                latitude: 37.3349,
                longitude: -122.009,
            }));
            assertSimulatorMobileProvider(location, "mobile_set_location");
            assert.deepStrictEqual(location.location, { latitude: 37.3349, longitude: -122.009 });

            const grantPermission = parsePayload(await callTool("mobile_grant_permission", {
                ...direct,
                deviceId,
                bundleId: "com.apple.mobilesafari",
                service: "location",
            }));
            assertSimulatorMobileProvider(grantPermission, "mobile_grant_permission");
            assert.deepStrictEqual(grantPermission.permission, { bundleId: "com.apple.mobilesafari", service: "location", action: "grant" });

            const revokePermission = parsePayload(await callTool("mobile_revoke_permission", {
                ...direct,
                deviceId,
                bundleId: "com.apple.mobilesafari",
                service: "location",
            }));
            assertSimulatorMobileProvider(revokePermission, "mobile_revoke_permission");
            assert.deepStrictEqual(revokePermission.permission, { bundleId: "com.apple.mobilesafari", service: "location", action: "revoke" });

            const setClipboard = parsePayload(await callTool("mobile_set_clipboard", { ...direct, deviceId, text: "ccc-ios-clipboard-e2e-ok" }));
            assertSimulatorMobileProvider(setClipboard, "mobile_set_clipboard");
            const getClipboard = parsePayload(await callTool("mobile_get_clipboard", { ...direct, deviceId }));
            assertSimulatorMobileProvider(getClipboard, "mobile_get_clipboard");
            assert.match(getClipboard.text, /ccc-ios-clipboard-e2e-ok/);

            const recordStart = parsePayload(await callTool("device_record_video_start", { ...direct, deviceId }));
            recordingActive = true;
            assert.strictEqual(recordStart.recording.provider, "simctl-recordVideo");
            assert.strictEqual(recordStart.recording.active, true, `recording start failed: ${JSON.stringify(recordStart)}`);
            await new Promise((resolve) => setTimeout(resolve, 1000));

            const recordingStatus = parsePayload(await callTool("device_record_video_status", { ...direct, deviceId }));
            assert.strictEqual(recordingStatus.provider, "simctl-recordVideo");
            assert.strictEqual(recordingStatus.recording.active, true, `recording status failed: ${JSON.stringify(recordingStatus)}`);

            const recordStop = parsePayload(await callTool("device_record_video_stop", { ...direct, deviceId }));
            recordingActive = false;
            assert.strictEqual(recordStop.provider, "simctl-recordVideo");
            assert.strictEqual(recordStop.stopped, true, `recording stop failed: ${JSON.stringify(recordStop)}`);
            assert.strictEqual(recordStop.recording.active, false);
            assert.ok(existsSync(recordStop.recording.localPath));

            const appium = iosAppiumDiscovery();
            if (appium.available) {
                const dumpUi = parsePayload(await callTool("mobile_dump_ui", { ...direct, deviceId }));
                assert.strictEqual(dumpUi.provider, "appium-xcuitest");
                assert.ok(typeof dumpUi.source === "string");

                const tap = parsePayload(await callTool("mobile_tap", { ...direct, deviceId, x: 20, y: 20 }));
                assert.strictEqual(tap.provider, "appium-xcuitest");
                assert.deepStrictEqual(tap.tapped, { x: 20, y: 20 });

                const doubleTap = parsePayload(await callTool("mobile_double_tap", { ...direct, deviceId, x: 30, y: 30 }));
                assert.strictEqual(doubleTap.provider, "appium-xcuitest");
                assert.deepStrictEqual(doubleTap.doubleTapped, { x: 30, y: 30 });

                const longPress = parsePayload(await callTool("mobile_long_press", { ...direct, deviceId, x: 40, y: 40, durationMs: 300 }));
                assert.strictEqual(longPress.provider, "appium-xcuitest");
                assert.deepStrictEqual(longPress.longPressed, { x: 40, y: 40, durationMs: 300 });

                const swipe = parsePayload(await callTool("mobile_swipe", { ...direct, deviceId, x1: 80, y1: 120, x2: 80, y2: 80, durationMs: 200 }));
                assert.strictEqual(swipe.provider, "appium-xcuitest");
                assert.deepStrictEqual(swipe.swiped, { x1: 80, y1: 120, x2: 80, y2: 80, durationMs: 200 });

                const drag = parsePayload(await callTool("mobile_drag", { ...direct, deviceId, x1: 90, y1: 90, x2: 100, y2: 100, durationMs: 300 }));
                assert.strictEqual(drag.provider, "appium-xcuitest");
                assert.deepStrictEqual(drag.dragged, { x1: 90, y1: 90, x2: 100, y2: 100, durationMs: 300 });

                const home = parsePayload(await callTool("mobile_home", { ...direct, deviceId }));
                assert.strictEqual(home.provider, "appium-xcuitest");
                assert.strictEqual(home.home, true);

                const lock = parsePayload(await callTool("mobile_lock", { ...direct, deviceId }));
                assert.strictEqual(lock.provider, "appium-xcuitest");
                assert.strictEqual(lock.locked, true);

                const unlock = parsePayload(await callTool("mobile_unlock", { ...direct, deviceId }));
                assert.strictEqual(unlock.provider, "appium-xcuitest");
                assert.strictEqual(unlock.unlocked, true);

                const rotateLeft = parsePayload(await callTool("mobile_rotate_left", { ...direct, deviceId }));
                assert.strictEqual(rotateLeft.provider, "appium-xcuitest");
                assert.strictEqual(rotateLeft.orientation, "LANDSCAPE");

                const rotateRight = parsePayload(await callTool("mobile_rotate_right", { ...direct, deviceId }));
                assert.strictEqual(rotateRight.provider, "appium-xcuitest");
                assert.strictEqual(rotateRight.orientation, "PORTRAIT");

                const landscape = parsePayload(await callTool("mobile_set_orientation", { ...direct, deviceId, orientation: "landscape" }));
                assert.strictEqual(landscape.provider, "appium-xcuitest");
                assert.strictEqual(landscape.orientation, "LANDSCAPE");

                appiumControls = "verified";
            } else {
                appiumControls = `skipped missing ${appium.missing.join(", ")}`;
            }

            const screenshot = await callTool("device_screenshot", { ...direct, deviceId });
            assert.strictEqual(screenshot?.content?.[0]?.type, "image");
            assert.ok(String(screenshot.content[0].data || "").length > 64);

            const stop = parseContractToolPayload("device_stop", await callTool("device_stop", { ...direct, deviceId }));
            stopped = true;
            assert.strictEqual(stop.device.status, "stopped");
            const stoppedSimulator = findSimctlDevice(cap.discovery.xcrun, (device) => device?.udid === createdUdid);
            assert.strictEqual(stoppedSimulator?.state, "Shutdown", JSON.stringify(stoppedSimulator));

            const del = parseContractToolPayload("device_delete", await callTool("device_delete", {
                ...direct,
                deviceId,
                deleteSimulator: true,
                confirmDestructive: true,
            }));
            deleted = true;
            assert.strictEqual(del.deleted, deviceId);
            assert.strictEqual(findSimctlDevice(cap.discovery.xcrun, (device) => device?.udid === createdUdid), null, `simctl simulator survived delete: ${createdUdid}`);
            const listAfterDelete = parsePayload(await callTool("device_list"));
            assert.strictEqual(listAfterDelete.devices.some((device) => device.id === deviceId), false);

            return {
                status: "PASS",
                detail: `device=${deviceId} runtime=${cap.runtime.identifier} type=${cap.deviceType.identifier} appium=${appiumControls}`,
                runtime: cap.runtime.identifier,
                deviceType: cap.deviceType.identifier,
                deviceId,
                appiumControls,
                appArtifact: appArtifactReady ? "verified" : "skipped missing CCC_REAL_IOS_SIMULATOR_APP/CCC_REAL_IOS_SIMULATOR_BUNDLE_ID",
            };
        } finally {
            if (recordingActive) {
                try { await callTool("device_record_video_stop", { ...direct, deviceId }); } catch { /* preserve primary failure */ }
            }
            if (created && !stopped) {
                try { await callTool("device_stop", { ...direct, deviceId }); } catch { /* preserve primary failure */ }
            }
            if (created && !deleted) {
                try { await callTool("device_delete", { ...direct, deviceId, force: true, deleteSimulator: true, confirmDestructive: true }); } catch { /* preserve primary failure */ }
                cleanupSimulator(cap.discovery.xcrun, createdUdid);
                try { await callTool("device_delete", { ...direct, deviceId, force: true, confirmDestructive: true }); } catch { /* preserve primary failure */ }
            }
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, providerMcpSessionOptions(options, "ccc-real-ios-simulator-e2e"));
}

/** @param {{ level?: number; [key: string]: unknown }} options */
export async function runIosRealDeviceE2E(options: any = {}) {
    const typedOptions = iosRealDeviceE2EOptions(options);
    const level = Number(typedOptions.level || process.env.CCC_TEST_LEVEL || "0");
    const cap = iosRealDeviceE2ECapability(level);
    if (!cap.available) return { status: "SKIP", reason: cap.reason, capability: cap };
    const appPath = (process.env.CCC_REAL_IOS_DEVICE_APP || process.env.CCC_REAL_DEVICE_LAB_IOS_DEVICE_APP || "").trim();
    const appBundleId = (process.env.CCC_REAL_IOS_DEVICE_BUNDLE_ID || process.env.CCC_REAL_DEVICE_LAB_IOS_DEVICE_BUNDLE_ID || "").trim();
    const appArtifactReady = Boolean(appPath && appBundleId);
    const strictProof = process.env.CCC_REAL_DEVICE_LAB_FAIL_ON_SKIP === "1";
    const appiumForProof = iosAppiumDiscovery();
    if (strictProof && (!appBundleId || !appiumForProof.available)) {
        return {
            status: "SKIP",
            reason: [
                !appBundleId ? "missing CCC_REAL_IOS_DEVICE_BUNDLE_ID" : "",
                !appiumForProof.available ? `missing iOS real-device Appium/XCUITest prerequisites: ${appiumForProof.missing.join(", ")}` : "",
            ].filter(Boolean).join(", "),
        };
    }

    const suffix = `${Date.now()}-${randomBytes(3).toString("hex")}`;
    const deviceId = `ios-device-real-e2e-${suffix}`;
    let attached = false;
    let appiumControls = "not-run";
    let appCoverage = "skipped missing CCC_REAL_IOS_DEVICE_BUNDLE_ID";
    return withDeviceLabMcp(async ({ callTool }) => {
        const direct = { backend: "ios-device" };
        try {
            const attach = parsePayload(await callTool("device_attach", {
                ...direct,
                name: `Real iOS Device E2E ${suffix}`,
                deviceId,
                udid: cap.udid,
            }));
            attached = true;
            assert.strictEqual(attach.device.id, deviceId);
            assert.strictEqual(attach.device.udid, cap.udid);

            const status = parseContractToolPayload("device_status", await callTool("device_status", { ...direct, deviceId }));
            assert.strictEqual(status.device.id, deviceId);
            assert.strictEqual(status.device.udid, cap.udid);
            assert.ok(status.hostDevice);

            const start = parseContractToolPayload("device_start", await callTool("device_start", { ...direct, deviceId }));
            assert.strictEqual(start.alreadyAttached, true);

            const mobileSession = parseContractToolPayload("mobile_session_status", await callTool("mobile_session_status", { ...direct, deviceId }));
            assert.strictEqual(mobileSession.deviceId, deviceId);

            const appium = iosAppiumDiscovery();
            if (appium.available) {
                const dumpUi = parsePayload(await callTool("mobile_dump_ui", { ...direct, deviceId }));
                assert.strictEqual(dumpUi.provider, "appium-xcuitest");
                assert.strictEqual(dumpUi.physical, true);
                assert.ok(typeof dumpUi.source === "string");

                const mobileScreenshot = await callTool("mobile_screenshot", { ...direct, deviceId });
                assert.strictEqual(mobileScreenshot?.content?.[0]?.type, "image");
                assert.strictEqual(mobileScreenshot.content[0].mimeType, "image/png");
                assert.ok(String(mobileScreenshot.content[0].data || "").length > 64);

                const tap = parsePayload(await callTool("mobile_tap", { ...direct, deviceId, x: 20, y: 20 }));
                assert.strictEqual(tap.provider, "appium-xcuitest");
                assert.strictEqual(tap.physical, true);
                assert.deepStrictEqual(tap.tapped, { x: 20, y: 20 });

                const doubleTap = parsePayload(await callTool("mobile_double_tap", { ...direct, deviceId, x: 30, y: 30 }));
                assert.strictEqual(doubleTap.provider, "appium-xcuitest");
                assert.strictEqual(doubleTap.physical, true);
                assert.deepStrictEqual(doubleTap.doubleTapped, { x: 30, y: 30 });

                const longPress = parsePayload(await callTool("mobile_long_press", { ...direct, deviceId, x: 40, y: 40, durationMs: 300 }));
                assert.strictEqual(longPress.provider, "appium-xcuitest");
                assert.strictEqual(longPress.physical, true);
                assert.deepStrictEqual(longPress.longPressed, { x: 40, y: 40, durationMs: 300 });

                const swipe = parsePayload(await callTool("mobile_swipe", { ...direct, deviceId, x1: 80, y1: 120, x2: 80, y2: 80, durationMs: 200 }));
                assert.strictEqual(swipe.provider, "appium-xcuitest");
                assert.strictEqual(swipe.physical, true);
                assert.deepStrictEqual(swipe.swiped, { x1: 80, y1: 120, x2: 80, y2: 80, durationMs: 200 });

                const drag = parsePayload(await callTool("mobile_drag", { ...direct, deviceId, x1: 90, y1: 90, x2: 100, y2: 100, durationMs: 300 }));
                assert.strictEqual(drag.provider, "appium-xcuitest");
                assert.strictEqual(drag.physical, true);
                assert.deepStrictEqual(drag.dragged, { x1: 90, y1: 90, x2: 100, y2: 100, durationMs: 300 });

                const typeText = parsePayload(await callTool("mobile_type_text", { ...direct, deviceId, text: "ccc" }));
                assert.strictEqual(typeText.provider, "appium-xcuitest");
                assert.strictEqual(typeText.physical, true);
                assert.strictEqual(typeText.typed, true);

                const key = parsePayload(await callTool("mobile_key", { ...direct, deviceId, key: "a" }));
                assert.strictEqual(key.provider, "appium-xcuitest");
                assert.strictEqual(key.physical, true);
                assert.strictEqual(key.key, "a");

                const home = parsePayload(await callTool("mobile_home", { ...direct, deviceId }));
                assert.strictEqual(home.provider, "appium-xcuitest");
                assert.strictEqual(home.physical, true);
                assert.strictEqual(home.home, true);

                const lock = parsePayload(await callTool("mobile_lock", { ...direct, deviceId }));
                assert.strictEqual(lock.provider, "appium-xcuitest");
                assert.strictEqual(lock.physical, true);
                assert.strictEqual(lock.locked, true);

                const unlock = parsePayload(await callTool("mobile_unlock", { ...direct, deviceId }));
                assert.strictEqual(unlock.provider, "appium-xcuitest");
                assert.strictEqual(unlock.physical, true);
                assert.strictEqual(unlock.unlocked, true);

                const rotateLeft = parsePayload(await callTool("mobile_rotate_left", { ...direct, deviceId }));
                assert.strictEqual(rotateLeft.provider, "appium-xcuitest");
                assert.strictEqual(rotateLeft.physical, true);
                assert.strictEqual(rotateLeft.orientation, "LANDSCAPE");

                const rotateRight = parsePayload(await callTool("mobile_rotate_right", { ...direct, deviceId }));
                assert.strictEqual(rotateRight.provider, "appium-xcuitest");
                assert.strictEqual(rotateRight.physical, true);
                assert.strictEqual(rotateRight.orientation, "PORTRAIT");

                const landscape = parsePayload(await callTool("mobile_set_orientation", { ...direct, deviceId, orientation: "landscape" }));
                assert.strictEqual(landscape.provider, "appium-xcuitest");
                assert.strictEqual(landscape.physical, true);
                assert.strictEqual(landscape.orientation, "LANDSCAPE");

                const portrait = parsePayload(await callTool("mobile_set_orientation", { ...direct, deviceId, orientation: "portrait" }));
                assert.strictEqual(portrait.provider, "appium-xcuitest");
                assert.strictEqual(portrait.physical, true);
                assert.strictEqual(portrait.orientation, "PORTRAIT");

                const waitText = stableIosUiText(dumpUi.source);
                const waitForText = parsePayload(await callTool("mobile_wait_for_text", {
                    ...direct,
                    deviceId,
                    text: waitText,
                    timeoutMs: 5000,
                    intervalMs: 250,
                }));
                assert.strictEqual(waitForText.provider, "appium-xcuitest");
                assert.strictEqual(waitForText.physical, true);
                assert.strictEqual(waitForText.text, waitText);
                assert.strictEqual(waitForText.found, true);

                if (appBundleId) {
                    if (appArtifactReady) {
                        const install = parsePayload(await callTool("mobile_install_app", { ...direct, deviceId, path: appPath }));
                        assert.strictEqual(install.provider, "xcrun-devicectl");
                        assert.strictEqual(install.installed, appPath);
                    }

                    const launch = parsePayload(await callTool("mobile_launch_app", { ...direct, deviceId, bundleId: appBundleId }));
                    assert.strictEqual(launch.provider, "xcrun-devicectl");
                    assert.strictEqual(launch.launched, appBundleId);

                    const waitedApp = parsePayload(await callTool("mobile_wait_for_app", {
                        ...direct,
                        deviceId,
                        bundleId: appBundleId,
                        timeoutMs: 10000,
                        intervalMs: 500,
                    }));
                    assert.strictEqual(waitedApp.provider, "appium-xcuitest");
                    assert.strictEqual(waitedApp.physical, true);
                    assert.strictEqual(waitedApp.bundleId, appBundleId);
                    assert.strictEqual(waitedApp.found, true);

                    const stopApp = parsePayload(await callTool("mobile_stop_app", { ...direct, deviceId, bundleId: appBundleId }));
                    assert.strictEqual(stopApp.provider, "appium-xcuitest");
                    assert.strictEqual(stopApp.physical, true);
                    assert.strictEqual(stopApp.stopped, appBundleId);
                    appCoverage = appArtifactReady ? "install-launch-wait-stop verified" : "launch-wait-stop verified";
                }

                appiumControls = "verified";
            } else {
                appiumControls = `skipped missing ${appium.missing.join(", ")}`;
            }

            const stop = parseContractToolPayload("device_stop", await callTool("device_stop", { ...direct, deviceId }));
            assert.strictEqual(stop.physicalDevicePoweredOff, false);

            const detach = parsePayload(await callTool("device_detach", { ...direct, deviceId }));
            attached = false;
            assert.strictEqual(detach.detached, deviceId);
            const listAfterDetach = parsePayload(await callTool("device_list"));
            assert.strictEqual(listAfterDetach.devices.some((device) => device.id === deviceId), false);

            return {
                status: "PASS",
                detail: `device=${deviceId} udid=${cap.udid} appium=${appiumControls} app=${appCoverage}`,
                udid: cap.udid,
                deviceId,
                appiumControls,
                appCoverage,
            };
        } finally {
            if (attached) {
                try { await callTool("device_detach", { ...direct, deviceId }); } catch { /* preserve primary failure */ }
            }
        }
    }, providerMcpSessionOptions(options, "ccc-real-ios-device-e2e"));
}
