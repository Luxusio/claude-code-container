import { createHash } from "crypto";
import { androidDiscovery, appiumDiscovery } from "./android.mjs";
import { run, runBuffer } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findAndroidRealDevice, readAndroidRealDevices, updateAndroidRealDevice, writeAndroidRealDevices } from "../state/android-device-state.mjs";
import { claimPhysicalLease, releasePhysicalLease } from "../state/physical-lease-store.mjs";

const ANDROID_REAL_CAPABILITIES = [
    "device_inventory", "device_attach", "device_detach", "device_start", "device_stop",
    "device_status", "device_exec", "device_screenshot",
    "device_upload", "device_download", "device_reset",
    "device_install_app", "device_launch_app",
    "mobile_session_status", "mobile_dump_ui", "mobile_tap",
    "mobile_double_tap", "mobile_long_press", "mobile_swipe",
    "mobile_drag", "mobile_type_text", "mobile_key", "mobile_home",
    "mobile_back", "mobile_forward", "mobile_recents", "mobile_power",
    "mobile_lock", "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right",
    "mobile_set_orientation", "mobile_open_url", "mobile_install_app",
    "mobile_launch_app", "mobile_uninstall_app", "mobile_stop_app",
    "mobile_clear_app_data", "mobile_grant_permission", "mobile_revoke_permission",
    "mobile_set_battery", "mobile_set_network",
    "mobile_toggle_airplane_mode", "mobile_set_clipboard",
    "mobile_get_clipboard", "mobile_wait_for_text", "mobile_wait_for_app",
    "mobile_screenshot",
];

export function androidRealBackend() {
    const discovery = androidDiscovery();
    const missing = discovery.adb ? [] : ["adb"];
    return {
        name: "android-device",
        host: "host-usb-adb",
        creatable: false,
        attachable: true,
        available: missing.length === 0,
        lazy: true,
        status: missing.length === 0 ? "available" : "missing-prerequisites",
        missing,
        tools: { adb: discovery.adb },
        capabilities: ANDROID_REAL_CAPABILITIES,
    };
}

function now() {
    return new Date().toISOString();
}

function androidRealDeviceId(nameOrSerial) {
    return `android-device-${slug(nameOrSerial)}`;
}

function appiumPortForDevice(id) {
    const hash = createHash("sha256").update(`${ownerId()}:android-device:${id}`).digest();
    return 24000 + (hash.readUInt16BE(0) % 8000);
}

function parseAdbDevices(text) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("List of devices"))
        .map((line) => {
            const [serial, state, ...detailParts] = line.split(/\s+/);
            const details = Object.fromEntries(detailParts.map((part) => {
                const index = part.indexOf(":");
                return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, true];
            }));
            return { serial, state: state || "unknown", details, emulator: serial?.startsWith("emulator-") || false };
        })
        .filter((device) => device.serial);
}

function hostAndroidDevices(discovery = androidDiscovery()) {
    if (!discovery.adb) return { available: false, missing: ["adb"], devices: [] };
    const r = run(discovery.adb, ["devices", "-l"]);
    if (r.status !== 0) {
        return {
            available: false,
            missing: [],
            devices: [],
            error: r.stderr || r.stdout || `exit ${r.status}`,
        };
    }
    return { available: true, missing: [], devices: parseAdbDevices(r.stdout) };
}

function targetSerial(device) {
    return device.serial;
}

function adbArgsForDevice(device, args) {
    return ["-s", targetSerial(device), ...args];
}

function adbTextValue(text) {
    return String(text).replace(/\s/g, "%s");
}

function orientationRotation(orientation) {
    const rotations = {
        portrait: "0",
        landscape: "1",
        "reverse-portrait": "2",
        "reverse-landscape": "3",
    };
    return rotations[orientation] || null;
}

function ensureAdbDevice(deviceId) {
    const device = findAndroidRealDevice(deviceId);
    if (!device) return { unknown: true };
    const discovery = androidDiscovery();
    if (!discovery.adb) return { error: "Android real-device backend missing prerequisites: adb" };
    return { device, adb: discovery.adb };
}

function adbTargetResult(target) {
    if (target.unknown) return undefined;
    if (target.error) return textResult(false, target.error);
    return null;
}

function runAdbDeviceCommand(device, adb, args) {
    const r = run(adb, adbArgsForDevice(device, args));
    return r.status === 0 ? { ok: true, stdout: r.stdout, stderr: r.stderr, status: r.status } : { ok: false, result: r };
}

function adbJsonResult(device, adb, args, payload) {
    const r = runAdbDeviceCommand(device, adb, args);
    return r.ok ? jsonResult({ ...payload, stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r.result);
}

function appiumStatus(device) {
    const discovery = appiumDiscovery();
    return {
        deviceId: device.id,
        appium: { available: discovery.available, missing: discovery.missing, tools: { appium: discovery.appium, adb: discovery.adb } },
        session: device.appium || null,
        lazy: true,
        automationName: "UiAutomator2",
    };
}

function dumpAndroidUiWithAdb(device, adb) {
    const remotePath = `/sdcard/window-${device.id}.xml`;
    const dump = run(adb, adbArgsForDevice(device, ["shell", "uiautomator", "dump", remotePath]));
    if (dump.status !== 0) return { error: dump };

    let read = run(adb, adbArgsForDevice(device, ["exec-out", "cat", remotePath]));
    if (read.status !== 0) read = run(adb, adbArgsForDevice(device, ["shell", "cat", remotePath]));
    if (read.status !== 0) return { error: read };

    return { source: read.stdout, remotePath, dump, read };
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAndroidText(device, adb, text, timeoutMs = 10000, intervalMs = 500) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let lastSource = "";
    while (Date.now() <= deadline) {
        const dump = dumpAndroidUiWithAdb(device, adb);
        if (!dump.error) {
            lastSource = dump.source;
            if (dump.source.includes(text)) return { found: true, source: dump.source, remotePath: dump.remotePath };
        }
        await sleep(Math.max(50, intervalMs));
    }
    return { found: false, source: lastSource, timeoutMs };
}

async function waitForAndroidApp(device, adb, packageName, timeoutMs = 10000, intervalMs = 500) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let last = null;
    while (Date.now() <= deadline) {
        const r = run(adb, adbArgsForDevice(device, ["shell", "pidof", packageName]));
        last = r;
        if (r.status === 0 && r.stdout.trim()) {
            return { running: true, pid: r.stdout.trim(), stdout: r.stdout, stderr: r.stderr, status: r.status };
        }
        await sleep(Math.max(50, intervalMs));
    }
    return { running: false, timeoutMs, stdout: last?.stdout || "", stderr: last?.stderr || "", status: last?.status ?? null };
}

function clearVolatileMetadata(deviceId) {
    return updateAndroidRealDevice(deviceId, (item) => ({
        ...item,
        status: "attached",
        pid: null,
        appium: null,
        recording: null,
        updatedAt: now(),
    }));
}

function stopVolatileProcesses(device, adb) {
    if (device.recording?.pid) {
        try { process.kill(device.recording.pid, "SIGINT"); } catch { /* ignore stale recorder */ }
    }
    if (device.recording?.active && adb && device.serial) {
        run(adb, ["-s", device.serial, "shell", "pkill", "-2", "screenrecord"]);
    }
    if (device.appium?.serverPid) {
        try { process.kill(device.appium.serverPid); } catch { /* ignore stale appium */ }
    }
}

export function listAndroidRealDevices() {
    return readAndroidRealDevices().map((device) => ({ ...device, ownerId: ownerId() }));
}

export async function handleAndroidRealTool(name, args) {
    switch (name) {
        case "device_inventory": {
            const { backend = "android-device" } = args;
            if (backend !== "android-device") return undefined;
            const discovery = androidDiscovery();
            return jsonResult({
                backend,
                ownerId: ownerId(),
                devices: listAndroidRealDevices(),
                hostDevices: hostAndroidDevices(discovery),
                discovery: { adb: discovery.adb, available: Boolean(discovery.adb), missing: discovery.adb ? [] : ["adb"] },
            });
        }

        case "device_attach": {
            const { backend, name: deviceName, deviceId, serial } = args;
            if (backend !== "android-device") return undefined;
            if (!serial) return textResult(false, "Android real-device attach requires serial");
            if (String(serial).startsWith("emulator-")) return textResult(false, `Refusing to attach emulator serial through android-device backend: ${serial}`);

            const discovery = androidDiscovery();
            if (!discovery.adb) return textResult(false, "Android real-device backend missing prerequisites: adb");
            const inventory = hostAndroidDevices(discovery);
            const hostDevice = inventory.devices.find((device) => device.serial === serial);
            if (!hostDevice) return textResult(false, `Android device is not visible to adb: ${serial}`);
            if (hostDevice.state !== "device") return textResult(false, `Android device ${serial} is not attachable; adb state is ${hostDevice.state}`);

            const id = deviceId || androidRealDeviceId(deviceName || serial);
            const devices = readAndroidRealDevices();
            if (devices.some((device) => device.id === id)) return textResult(false, `Device already exists for this owner: ${id}`);
            if (devices.some((device) => device.serial === serial)) return textResult(false, `Android serial already attached for this owner: ${serial}`);
            const lease = claimPhysicalLease("android-device", serial, id);
            if (!lease.ok) {
                return textResult(false, `Android serial is already attached by another CCC owner: ${serial}`);
            }

            const device = {
                id,
                name: deviceName || serial,
                backend,
                kind: "mobile",
                platform: "android",
                physical: true,
                ownerId: ownerId(),
                serial,
                hostDetails: hostDevice.details,
                appiumPort: appiumPortForDevice(id),
                appium: null,
                recording: null,
                status: "attached",
                creatable: false,
                attachable: true,
                attachedAt: now(),
                updatedAt: now(),
            };
            writeAndroidRealDevices([...devices, device]);
            return jsonResult({ device });
        }

        case "device_detach": {
            const { deviceId } = args;
            const devices = readAndroidRealDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            const discovery = androidDiscovery();
            stopVolatileProcesses(device, discovery.adb);
            writeAndroidRealDevices(devices.filter((item) => item.id !== deviceId));
            releasePhysicalLease("android-device", device.serial, deviceId);
            return jsonResult({ detached: deviceId, physicalDevicePoweredOff: false });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findAndroidRealDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device, started: false, alreadyAttached: true, physicalDevicePoweredOnByMcp: false });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findAndroidRealDevice(deviceId);
            if (!device) return undefined;
            const discovery = androidDiscovery();
            stopVolatileProcesses(device, discovery.adb);
            const updated = clearVolatileMetadata(deviceId);
            return jsonResult({ device: updated, stopped: false, detached: false, physicalDevicePoweredOff: false });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findAndroidRealDevice(deviceId);
            if (!device) return undefined;
            const discovery = androidDiscovery();
            let hostState = null;
            if (discovery.adb) {
                const r = run(discovery.adb, ["-s", device.serial, "get-state"]);
                hostState = { stdout: r.stdout.trim(), stderr: r.stderr, status: r.status };
            }
            return jsonResult({ device, backend: androidRealBackend(), hostState, appium: appiumStatus(device) });
        }

        case "device_exec": {
            const { deviceId, command } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const r = run(target.adb, adbArgsForDevice(target.device, ["shell", command]));
            return r.status === 0 ? jsonResult({ stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "device_screenshot": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const r = runBuffer(target.adb, adbArgsForDevice(target.device, ["exec-out", "screencap", "-p"]));
            if (r.status !== 0) return textResult(false, `Error: ${r.stderr?.toString() || r.stdout?.toString() || `exit ${r.status}`}`);
            return { content: [{ type: "image", data: Buffer.from(r.stdout).toString("base64"), mimeType: "image/png" }] };
        }

        case "mobile_screenshot": {
            const { deviceId } = args;
            return handleAndroidRealTool("device_screenshot", { deviceId });
        }

        case "device_upload": {
            const { deviceId, localPath, remotePath } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["push", localPath, remotePath], { uploaded: { localPath, remotePath }, provider: "adb" });
        }

        case "device_download": {
            const { deviceId, remotePath, localPath } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["pull", remotePath, localPath], { downloaded: { remotePath, localPath }, provider: "adb" });
        }

        case "device_install_app": {
            const { deviceId, path, replace = true } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, replace ? ["install", "-r", path] : ["install", path], { installed: path, provider: "adb" });
        }

        case "device_launch_app": {
            const { deviceId, packageName, component } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (component) return adbJsonResult(target.device, target.adb, ["shell", "am", "start", "-n", component], { launched: component, provider: "adb" });
            if (!packageName) return textResult(false, "Android app launch requires packageName or component");
            return adbJsonResult(target.device, target.adb, ["shell", "monkey", "-p", packageName, "1"], { launched: packageName, provider: "adb" });
        }

        case "device_reset": {
            const { deviceId, packageName } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!packageName) return textResult(false, "Android reset requires packageName to clear app data");
            return adbJsonResult(target.device, target.adb, ["shell", "pm", "clear", packageName], { reset: { packageName }, provider: "adb" });
        }

        case "mobile_session_status": {
            const { deviceId } = args;
            const device = findAndroidRealDevice(deviceId);
            if (!device) return undefined;
            return jsonResult(appiumStatus(device));
        }

        case "mobile_dump_ui": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const dump = dumpAndroidUiWithAdb(target.device, target.adb);
            if (dump.error) return fail(dump.error);
            return jsonResult({ provider: "adb-uiautomator", source: dump.source, remotePath: dump.remotePath, stdout: dump.dump.stdout, stderr: dump.dump.stderr });
        }

        case "mobile_tap": {
            const { deviceId, x, y } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "tap", String(x), String(y)], { tapped: { x, y }, provider: "adb" });
        }

        case "mobile_double_tap": {
            const { deviceId, x, y } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const first = runAdbDeviceCommand(target.device, target.adb, ["shell", "input", "tap", String(x), String(y)]);
            if (!first.ok) return fail(first.result);
            const second = runAdbDeviceCommand(target.device, target.adb, ["shell", "input", "tap", String(x), String(y)]);
            return second.ok ? jsonResult({ doubleTapped: { x, y }, provider: "adb" }) : fail(second.result);
        }

        case "mobile_long_press": {
            const { deviceId, x, y, durationMs = 700 } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "swipe", String(x), String(y), String(x), String(y), String(durationMs)], { longPressed: { x, y, durationMs }, provider: "adb" });
        }

        case "mobile_swipe":
        case "mobile_drag": {
            const { deviceId, x1, y1, x2, y2, durationMs = name === "mobile_drag" ? 700 : 300 } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(durationMs)], { [name === "mobile_drag" ? "dragged" : "swiped"]: { x1, y1, x2, y2, durationMs }, provider: "adb" });
        }

        case "mobile_type_text": {
            const { deviceId, text } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "text", adbTextValue(text)], { typed: true, provider: "adb" });
        }

        case "mobile_key": {
            const { deviceId, key, keyCode } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const resolvedKey = keyCode ?? key;
            if (resolvedKey === undefined || resolvedKey === null || resolvedKey === "") return textResult(false, "mobile_key requires key or keyCode");
            return adbJsonResult(target.device, target.adb, ["shell", "input", "keyevent", String(resolvedKey)], { key: resolvedKey, provider: "adb" });
        }

        case "mobile_back": return handleAndroidRealTool("mobile_key", { deviceId: args.deviceId, keyCode: 4 });
        case "mobile_home": return handleAndroidRealTool("mobile_key", { deviceId: args.deviceId, keyCode: 3 });
        case "mobile_forward": return handleAndroidRealTool("mobile_key", { deviceId: args.deviceId, keyCode: 125 });
        case "mobile_recents": return handleAndroidRealTool("mobile_key", { deviceId: args.deviceId, keyCode: 187 });
        case "mobile_power": return handleAndroidRealTool("mobile_key", { deviceId: args.deviceId, keyCode: 26 });
        case "mobile_lock": return handleAndroidRealTool("mobile_key", { deviceId: args.deviceId, keyCode: 223 });
        case "mobile_unlock": return handleAndroidRealTool("mobile_key", { deviceId: args.deviceId, keyCode: 224 });

        case "mobile_set_orientation": {
            const { deviceId, orientation } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const rotation = orientationRotation(orientation);
            if (rotation === null) return textResult(false, `Unsupported Android orientation: ${orientation}`);
            const accelerometer = runAdbDeviceCommand(target.device, target.adb, ["shell", "settings", "put", "system", "accelerometer_rotation", "0"]);
            if (!accelerometer.ok) return fail(accelerometer.result);
            return adbJsonResult(target.device, target.adb, ["shell", "settings", "put", "system", "user_rotation", rotation], { orientation, rotation, provider: "adb" });
        }

        case "mobile_rotate_left": return handleAndroidRealTool("mobile_set_orientation", { deviceId: args.deviceId, orientation: "landscape" });
        case "mobile_rotate_right": return handleAndroidRealTool("mobile_set_orientation", { deviceId: args.deviceId, orientation: "reverse-landscape" });

        case "mobile_open_url": {
            const { deviceId, url } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], { openedUrl: url, provider: "adb" });
        }

        case "mobile_install_app": return handleAndroidRealTool("device_install_app", { deviceId: args.deviceId, path: args.path });
        case "mobile_launch_app": return handleAndroidRealTool("device_launch_app", { deviceId: args.deviceId, packageName: args.packageName, component: args.component });

        case "mobile_uninstall_app": {
            const { deviceId, packageName } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!packageName) return textResult(false, "Android app uninstall requires packageName");
            return adbJsonResult(target.device, target.adb, ["uninstall", packageName], { uninstalled: packageName, provider: "adb" });
        }

        case "mobile_stop_app":
        case "mobile_clear_app_data": {
            const { deviceId, packageName } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!packageName) return textResult(false, `Android ${name} requires packageName`);
            const adbArgs = name === "mobile_stop_app" ? ["shell", "am", "force-stop", packageName] : ["shell", "pm", "clear", packageName];
            return adbJsonResult(target.device, target.adb, adbArgs, { packageName, provider: "adb" });
        }

        case "mobile_grant_permission":
        case "mobile_revoke_permission": {
            const { deviceId, packageName, permission } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!packageName || !permission) return textResult(false, `Android ${name} requires packageName and permission`);
            const action = name === "mobile_grant_permission" ? "grant" : "revoke";
            return adbJsonResult(target.device, target.adb, ["shell", "pm", action, packageName, permission], { permission: { packageName, permission, action }, provider: "adb" });
        }

        case "mobile_set_location":
        case "mobile_set_battery":
        case "mobile_set_network":
        case "mobile_toggle_airplane_mode": {
            const { deviceId } = args;
            const device = findAndroidRealDevice(deviceId);
            if (!device) return undefined;
            return textResult(false, `Android real devices do not support ${name} safely through the base ADB layer; use an emulator or a dedicated device-farm controller.`);
        }

        case "mobile_set_clipboard": {
            const { deviceId, text } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "cmd", "clipboard", "set", String(text)], { clipboard: { set: true }, provider: "adb" });
        }

        case "mobile_get_clipboard": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "cmd", "clipboard", "get"], { clipboard: { get: true }, provider: "adb" });
        }

        case "mobile_wait_for_text": {
            const { deviceId, text, timeoutMs, intervalMs } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!text) return textResult(false, "Android wait-for-text requires text");
            return jsonResult({ ...(await waitForAndroidText(target.device, target.adb, text, timeoutMs, intervalMs)), text, provider: "adb-uiautomator" });
        }

        case "mobile_wait_for_app": {
            const { deviceId, packageName, timeoutMs, intervalMs } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!packageName) return textResult(false, "Android wait-for-app requires packageName");
            return jsonResult({ ...(await waitForAndroidApp(target.device, target.adb, packageName, timeoutMs, intervalMs)), packageName, provider: "adb" });
        }

        default:
            return undefined;
    }
}
