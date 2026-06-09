import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { commandPath, localBinPath, run, runBuffer } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findAndroidDevice, readAndroidDevices, updateAndroidDevice, writeAndroidDevices } from "../state/android-state.mjs";

function androidSdkCandidates() {
    const candidates = [];
    for (const key of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
        if (process.env[key]) candidates.push(process.env[key]);
    }
    candidates.push(
        join(homedir(), "Android/Sdk"),
        join(homedir(), "Library/Android/sdk"),
        "/opt/android-sdk",
        "/usr/local/android-sdk",
    );
    return candidates;
}

function findAndroidTool(name) {
    const fromPath = commandPath(name);
    if (fromPath) return fromPath;

    for (const sdk of androidSdkCandidates()) {
        const subdirs = androidToolSubdirs(sdk, name);
        for (const subdir of subdirs) {
            const candidate = join(sdk, subdir, name);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

function androidToolSubdirs(sdk, name) {
    if (name === "emulator") return ["emulator"];
    if (name === "avdmanager") {
        const cmdlineToolSubdirs = [];
        const cmdlineTools = join(sdk, "cmdline-tools");
        try {
            for (const entry of readdirSync(cmdlineTools, { withFileTypes: true })) {
                if (entry.isDirectory()) cmdlineToolSubdirs.push(`cmdline-tools/${entry.name}/bin`);
            }
        } catch {
            /* ignore absent SDK command-line tools directory */
        }
        return ["cmdline-tools/latest/bin", ...cmdlineToolSubdirs, "cmdline-tools/bin", "tools/bin"];
    }
    return ["platform-tools"];
}

export function androidDiscovery() {
    const adb = findAndroidTool("adb");
    const emulator = findAndroidTool("emulator");
    const avdmanager = findAndroidTool("avdmanager");
    const missing = [];
    if (!adb) missing.push("adb");
    if (!emulator) missing.push("emulator");
    const provisioningMissing = [];
    if (!avdmanager) provisioningMissing.push("avdmanager");
    return {
        adb,
        emulator,
        avdmanager,
        available: missing.length === 0,
        missing,
        provisioningAvailable: provisioningMissing.length === 0,
        provisioningMissing,
    };
}

export function appiumDiscovery() {
    const appium = localBinPath("appium") || commandPath("appium");
    const android = androidDiscovery();
    const missing = [];
    if (!appium) missing.push("appium");
    if (!android.adb) missing.push("adb");
    return { appium, adb: android.adb, available: missing.length === 0, missing };
}

export function androidBackend() {
    const discovery = androidDiscovery();
    return {
        name: "android-emulator",
        host: "host-or-container",
        creatable: true,
        available: discovery.available,
        lazy: true,
        status: discovery.available ? "available" : "missing-prerequisites",
        missing: discovery.missing,
        tools: { adb: discovery.adb, emulator: discovery.emulator, avdmanager: discovery.avdmanager },
        provisioning: {
            available: discovery.provisioningAvailable,
            missing: discovery.provisioningMissing,
        },
        capabilities: [
            "device_inventory", "device_create", "device_delete", "device_start", "device_stop",
            "device_status", "device_exec", "device_screenshot",
            "device_upload", "device_download", "device_reset",
            "device_install_app", "device_launch_app",
            "mobile_session_status", "mobile_dump_ui", "mobile_tap",
            "mobile_double_tap", "mobile_long_press", "mobile_swipe",
            "mobile_type_text", "mobile_key", "mobile_home", "mobile_back",
            "mobile_forward", "mobile_recents", "mobile_power", "mobile_lock",
            "mobile_unlock", "mobile_open_url", "mobile_install_app",
            "mobile_launch_app", "mobile_uninstall_app", "mobile_stop_app",
            "mobile_clear_app_data", "mobile_screenshot",
        ],
    };
}

function appiumBackendStatus() {
    const discovery = appiumDiscovery();
    return {
        available: discovery.available,
        missing: discovery.missing,
        tools: { appium: discovery.appium, adb: discovery.adb },
    };
}

function androidDeviceId(name) {
    return `android-${slug(name)}`;
}

function appiumPortForDevice(id) {
    const hash = createHash("sha256").update(`${ownerId()}:${id}`).digest();
    return 20000 + (hash.readUInt16BE(0) % 10000);
}

function androidSerial(device) {
    return device.serial || (device.port ? `emulator-${device.port}` : undefined);
}

function adbArgsForDevice(device, args) {
    const serial = androidSerial(device);
    return serial ? ["-s", serial, ...args] : args;
}

function adbTextValue(text) {
    return String(text).replace(/\s/g, "%s");
}

function ensureAdbDevice(deviceId) {
    const device = findAndroidDevice(deviceId);
    if (!device) return { unknown: true };
    const discovery = androidDiscovery();
    if (!discovery.adb) return { error: "Android backend missing prerequisites: adb" };
    return { device, adb: discovery.adb };
}

function runAdbDeviceCommand(device, adb, args) {
    const r = run(adb, adbArgsForDevice(device, args));
    return r.status === 0 ? { ok: true, stdout: r.stdout, stderr: r.stderr, status: r.status } : { ok: false, result: r };
}

function adbJsonResult(device, adb, args, payload) {
    const r = runAdbDeviceCommand(device, adb, args);
    return r.ok ? jsonResult({ ...payload, stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r.result);
}

function adbTargetResult(target) {
    if (target.unknown) return undefined;
    if (target.error) return textResult(false, target.error);
    return null;
}

function ownerAvdPrefix() {
    return `ccc-${ownerId()}-`;
}

function isOwnedAvdName(avdName) {
    return typeof avdName === "string" && avdName.startsWith(ownerAvdPrefix());
}

function listHostAvds(discovery = androidDiscovery()) {
    if (!discovery.emulator) return { available: false, missing: ["emulator"], avds: [] };
    const r = run(discovery.emulator, ["-list-avds"]);
    if (r.status !== 0) {
        return {
            available: false,
            missing: [],
            avds: [],
            error: r.stderr || r.stdout || `exit ${r.status}`,
        };
    }
    return {
        available: true,
        missing: [],
        avds: r.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    };
}

async function waitForAndroidBoot(discovery, device, timeoutMs) {
    if (!discovery.adb) return { ready: false, skipped: true, reason: "adb missing" };
    const serial = androidSerial(device);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        const adbArgs = serial
            ? ["-s", serial, "shell", "getprop", "sys.boot_completed"]
            : ["shell", "getprop", "sys.boot_completed"];
        const r = run(discovery.adb, adbArgs);
        if (r.status === 0 && r.stdout.trim() === "1") return { ready: true };
        await sleep(250);
    }
    return { ready: false, skipped: false, reason: "timeout" };
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
    });
    const text = await response.text();
    let payload = {};
    if (text) {
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
    return payload;
}

async function waitForAppium(url) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            await fetchJson(`${url}/status`, { method: "GET" });
            return true;
        } catch {
            await sleep(250);
        }
    }
    return false;
}

function dumpAndroidUiWithAdb(device, adb) {
    const remotePath = `/sdcard/window-${device.id}.xml`;
    const dump = run(adb, adbArgsForDevice(device, ["shell", "uiautomator", "dump", remotePath]));
    if (dump.status !== 0) return { error: dump };

    let read = run(adb, adbArgsForDevice(device, ["exec-out", "cat", remotePath]));
    if (read.status !== 0) {
        read = run(adb, adbArgsForDevice(device, ["shell", "cat", remotePath]));
    }
    if (read.status !== 0) return { error: read };

    return {
        source: read.stdout,
        remotePath,
        dump,
        read,
    };
}

async function ensureAppiumSession(deviceId) {
    const device = findAndroidDevice(deviceId);
    if (!device) return { unknown: true };

    const discovery = appiumDiscovery();
    if (!discovery.available) {
        return { error: `Appium Android layer missing prerequisites: ${discovery.missing.join(", ")}` };
    }

    const port = device.appiumPort || appiumPortForDevice(device.id);
    const serverUrl = `http://127.0.0.1:${port}`;

    if (device.appium?.sessionId && device.appium?.serverUrl) {
        try {
            await fetchJson(`${device.appium.serverUrl}/status`, { method: "GET" });
            await fetchJson(`${device.appium.serverUrl}/session/${device.appium.sessionId}`, { method: "GET" });
            return { device, serverUrl: device.appium.serverUrl, sessionId: device.appium.sessionId };
        } catch {
            updateAndroidDevice(deviceId, (item) => ({
                ...item,
                appium: null,
                updatedAt: new Date().toISOString(),
            }));
        }
    }

    const child = spawn(discovery.appium, ["server", "--port", String(port), "--base-path", "/"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
    });
    child.unref();

    const ready = await waitForAppium(serverUrl);
    if (!ready) return { error: `Appium server did not become ready on ${serverUrl}` };

    const serial = androidSerial(device);
    const response = await fetchJson(`${serverUrl}/session`, {
        method: "POST",
        body: JSON.stringify({
            capabilities: {
                alwaysMatch: {
                    platformName: "Android",
                    "appium:automationName": "UiAutomator2",
                    "appium:deviceName": device.name || device.id,
                    ...(serial ? { "appium:udid": serial } : {}),
                    ...(device.avdName ? { "appium:avd": device.avdName } : {}),
                },
            },
        }),
    });
    const sessionId = response?.value?.sessionId || response?.sessionId;
    if (!sessionId) return { error: "Appium did not return a session id" };

    const updated = updateAndroidDevice(deviceId, (item) => ({
        ...item,
        appiumPort: port,
        appium: {
            serverUrl,
            serverPid: child.pid,
            sessionId,
            updatedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
    }));

    return { device: updated, serverUrl, sessionId };
}

export function listAndroidDevices() {
    return readAndroidDevices().map((device) => ({ ...device, ownerId: ownerId() }));
}

export async function handleAndroidTool(name, args) {
    switch (name) {
        case "device_inventory": {
            const { backend = "android-emulator" } = args;
            if (backend !== "android-emulator") return undefined;

            const discovery = androidDiscovery();
            return jsonResult({
                backend,
                ownerId: ownerId(),
                devices: listAndroidDevices(),
                hostAvds: listHostAvds(discovery),
                discovery,
            });
        }

        case "device_create": {
            const { backend, name: deviceName, deviceId, avdName, port, systemImage, deviceProfile, createAvd = false } = args;
            if (backend !== "android-emulator") return undefined;

            const id = deviceId || androidDeviceId(deviceName);
            const devices = readAndroidDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const resolvedAvdName = avdName || `${ownerAvdPrefix()}${slug(deviceName)}`;
            const shouldCreateAvd = Boolean(createAvd);
            if (shouldCreateAvd && !isOwnedAvdName(resolvedAvdName)) {
                return textResult(false, `Refusing to create non-owned Android AVD name: ${resolvedAvdName}`);
            }
            if (shouldCreateAvd) {
                const discovery = androidDiscovery();
                if (!discovery.provisioningAvailable) {
                    return textResult(false, `Android AVD provisioning missing prerequisites: ${discovery.provisioningMissing.join(", ")}`);
                }
                if (!systemImage) return textResult(false, "Android AVD provisioning requires systemImage");
                const avdArgs = ["create", "avd", "--name", resolvedAvdName, "--package", systemImage, "--force"];
                if (deviceProfile) avdArgs.push("--device", deviceProfile);
                const r = run(discovery.avdmanager, avdArgs);
                if (r.status !== 0) return fail(r);
            }

            const device = {
                id,
                name: deviceName,
                backend,
                kind: "mobile",
                platform: "android",
                ownerId: ownerId(),
                avdName: resolvedAvdName,
                systemImage: systemImage || null,
                deviceProfile: deviceProfile || null,
                provisioned: shouldCreateAvd,
                port: port || null,
                serial: port ? `emulator-${port}` : null,
                appiumPort: appiumPortForDevice(id),
                appium: null,
                status: "stopped",
                creatable: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            devices.push(device);
            writeAndroidDevices(devices);
            return jsonResult({ device });
        }

        case "device_delete": {
            const { deviceId, force = false, deleteAvd = false } = args;
            const devices = readAndroidDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }
            if (deleteAvd) {
                if (!isOwnedAvdName(device.avdName)) {
                    return textResult(false, `Refusing to delete non-owned Android AVD name: ${device.avdName}`);
                }
                const discovery = androidDiscovery();
                if (!discovery.provisioningAvailable) {
                    return textResult(false, `Android AVD provisioning missing prerequisites: ${discovery.provisioningMissing.join(", ")}`);
                }
                const r = run(discovery.avdmanager, ["delete", "avd", "--name", device.avdName]);
                if (r.status !== 0) return fail(r);
            }
            writeAndroidDevices(devices.filter((item) => item.id !== deviceId));
            return jsonResult({ deleted: deviceId, avdDeleted: Boolean(deleteAvd) });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device, backend: androidBackend(), appium: appiumBackendStatus() });
        }

        case "device_start": {
            const { deviceId, waitForBoot = true, bootTimeoutMs = 60000 } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;

            const discovery = androidDiscovery();
            if (!discovery.available) {
                return textResult(false, `Android backend missing prerequisites: ${discovery.missing.join(", ")}`);
            }
            if (!isOwnedAvdName(device.avdName)) {
                return textResult(false, `Refusing to start non-owned Android AVD name: ${device.avdName}`);
            }

            const child = spawn(discovery.emulator, ["-avd", device.avdName], {
                detached: true,
                stdio: "ignore",
                env: process.env,
            });
            child.unref();

            const starting = updateAndroidDevice(deviceId, (item) => ({
                ...item,
                status: "starting",
                pid: child.pid,
                updatedAt: new Date().toISOString(),
            }));

            if (!waitForBoot) return jsonResult({ device: starting, boot: { ready: false, skipped: true } });

            const boot = await waitForAndroidBoot(discovery, starting, bootTimeoutMs);
            const updated = updateAndroidDevice(deviceId, (item) => ({
                ...item,
                status: boot.ready ? "running" : "starting",
                bootReady: boot.ready,
                lastBootCheck: boot,
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: updated, boot });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;

            const discovery = androidDiscovery();
            const serial = androidSerial(device);
            if (discovery.adb && serial) run(discovery.adb, ["-s", serial, "emu", "kill"]);
            if (device.pid) {
                try { process.kill(device.pid); } catch { /* ignore stale pid */ }
            }
            if (device.appium?.serverPid) {
                try { process.kill(device.appium.serverPid); } catch { /* ignore stale pid */ }
            }

            const updated = updateAndroidDevice(deviceId, (item) => ({
                ...item,
                status: "stopped",
                pid: null,
                appium: null,
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: updated });
        }

        case "device_exec": {
            const { deviceId, command } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;

            const discovery = androidDiscovery();
            if (!discovery.adb) return textResult(false, "Android backend missing prerequisites: adb");

            const r = run(discovery.adb, adbArgsForDevice(device, ["shell", command]));
            return r.status === 0 ? jsonResult({ stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "device_screenshot": {
            const { deviceId } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;

            const discovery = androidDiscovery();
            if (!discovery.adb) return textResult(false, "Android backend missing prerequisites: adb");

            const r = runBuffer(discovery.adb, adbArgsForDevice(device, ["exec-out", "screencap", "-p"]));
            if (r.status !== 0) {
                return textResult(false, `Error: ${r.stderr?.toString() || r.stdout?.toString() || `exit ${r.status}`}`);
            }
            return { content: [{ type: "image", data: Buffer.from(r.stdout).toString("base64"), mimeType: "image/png" }] };
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
            const installArgs = replace ? ["install", "-r", path] : ["install", path];
            return adbJsonResult(target.device, target.adb, installArgs, { installed: path, provider: "adb" });
        }

        case "device_launch_app": {
            const { deviceId, packageName, component } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (component) {
                return adbJsonResult(target.device, target.adb, ["shell", "am", "start", "-n", component], { launched: component, provider: "adb" });
            }
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
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ deviceId, appium: appiumBackendStatus(), session: device.appium || null, lazy: true });
        }

        case "mobile_dump_ui": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;

            const dump = dumpAndroidUiWithAdb(target.device, target.adb);
            if (dump.error) return fail(dump.error);
            return jsonResult({
                provider: "adb-uiautomator",
                source: dump.source,
                remotePath: dump.remotePath,
                stdout: dump.dump.stdout,
                stderr: dump.dump.stderr,
            });
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

        case "mobile_swipe": {
            const { deviceId, x1, y1, x2, y2, durationMs = 300 } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(durationMs)], { swiped: { x1, y1, x2, y2, durationMs }, provider: "adb" });
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
            if (resolvedKey === undefined || resolvedKey === null || resolvedKey === "") {
                return textResult(false, "mobile_key requires key or keyCode");
            }
            return adbJsonResult(target.device, target.adb, ["shell", "input", "keyevent", String(resolvedKey)], { key: resolvedKey, provider: "adb" });
        }

        case "mobile_back": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "keyevent", "4"], { back: true, provider: "adb" });
        }

        case "mobile_home": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "keyevent", "3"], { home: true, provider: "adb" });
        }

        case "mobile_forward": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "keyevent", "125"], { forward: true, provider: "adb" });
        }

        case "mobile_recents": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "keyevent", "187"], { recents: true, provider: "adb" });
        }

        case "mobile_power": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "keyevent", "26"], { power: true, provider: "adb" });
        }

        case "mobile_lock": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "keyevent", "223"], { locked: true, provider: "adb" });
        }

        case "mobile_unlock": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "input", "keyevent", "224"], { unlocked: true, provider: "adb" });
        }

        case "mobile_open_url": {
            const { deviceId, url } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], { openedUrl: url, provider: "adb" });
        }

        case "mobile_install_app": {
            const { deviceId, path } = args;
            return handleAndroidTool("device_install_app", { deviceId, path });
        }

        case "mobile_launch_app": {
            const { deviceId, packageName, component } = args;
            return handleAndroidTool("device_launch_app", { deviceId, packageName, component });
        }

        case "mobile_uninstall_app": {
            const { deviceId, packageName } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!packageName) return textResult(false, "Android app uninstall requires packageName");
            return adbJsonResult(target.device, target.adb, ["uninstall", packageName], { uninstalled: packageName, provider: "adb" });
        }

        case "mobile_stop_app": {
            const { deviceId, packageName } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!packageName) return textResult(false, "Android app stop requires packageName");
            return adbJsonResult(target.device, target.adb, ["shell", "am", "force-stop", packageName], { stopped: packageName, provider: "adb" });
        }

        case "mobile_clear_app_data": {
            const { deviceId, packageName } = args;
            return handleAndroidTool("device_reset", { deviceId, packageName });
        }

        case "mobile_screenshot": {
            const { deviceId } = args;
            return handleAndroidTool("device_screenshot", { deviceId });
        }

        default:
            return undefined;
    }
}
