import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync } from "fs";
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
        const subdir = name === "emulator" ? "emulator" : "platform-tools";
        const candidate = join(sdk, subdir, name);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

export function androidDiscovery() {
    const adb = findAndroidTool("adb");
    const emulator = findAndroidTool("emulator");
    const missing = [];
    if (!adb) missing.push("adb");
    if (!emulator) missing.push("emulator");
    return { adb, emulator, available: missing.length === 0, missing };
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
        tools: { adb: discovery.adb, emulator: discovery.emulator },
        capabilities: [
            "device_create", "device_delete", "device_start", "device_stop",
            "device_status", "device_exec", "device_screenshot",
            "mobile_session_status", "mobile_dump_ui", "mobile_tap",
            "mobile_type_text", "mobile_back",
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

async function ensureAppiumSession(deviceId) {
    const device = findAndroidDevice(deviceId);
    if (!device) return { error: `Unknown device for this owner: ${deviceId}` };

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
        case "device_create": {
            const { backend, name: deviceName, deviceId, avdName, port } = args;
            if (backend !== "android-emulator") return undefined;

            const id = deviceId || androidDeviceId(deviceName);
            const devices = readAndroidDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const device = {
                id,
                name: deviceName,
                backend,
                kind: "mobile",
                platform: "android",
                ownerId: ownerId(),
                avdName: avdName || `ccc-${ownerId()}-${slug(deviceName)}`,
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
            const { deviceId, force = false } = args;
            const devices = readAndroidDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }
            writeAndroidDevices(devices.filter((item) => item.id !== deviceId));
            return jsonResult({ deleted: deviceId });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device, backend: androidBackend(), appium: appiumBackendStatus() });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;

            const discovery = androidDiscovery();
            if (!discovery.available) {
                return textResult(false, `Android backend missing prerequisites: ${discovery.missing.join(", ")}`);
            }

            const child = spawn(discovery.emulator, ["-avd", device.avdName], {
                detached: true,
                stdio: "ignore",
                env: process.env,
            });
            child.unref();

            const updated = updateAndroidDevice(deviceId, (item) => ({
                ...item,
                status: "starting",
                pid: child.pid,
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: updated });
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

            const serial = androidSerial(device);
            const adbArgs = serial ? ["-s", serial, "shell", command] : ["shell", command];
            const r = run(discovery.adb, adbArgs);
            return r.status === 0 ? jsonResult({ stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "device_screenshot": {
            const { deviceId } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;

            const discovery = androidDiscovery();
            if (!discovery.adb) return textResult(false, "Android backend missing prerequisites: adb");

            const serial = androidSerial(device);
            const adbArgs = serial ? ["-s", serial, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"];
            const r = runBuffer(discovery.adb, adbArgs);
            if (r.status !== 0) {
                return textResult(false, `Error: ${r.stderr?.toString() || r.stdout?.toString() || `exit ${r.status}`}`);
            }
            return { content: [{ type: "image", data: Buffer.from(r.stdout).toString("base64"), mimeType: "image/png" }] };
        }

        case "mobile_session_status": {
            const { deviceId } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return textResult(false, `Unknown device for this owner: ${deviceId}`);
            return jsonResult({ deviceId, appium: appiumBackendStatus(), session: device.appium || null, lazy: true });
        }

        case "mobile_dump_ui": {
            const { deviceId } = args;
            const session = await ensureAppiumSession(deviceId);
            if (session.error) return textResult(false, session.error);
            const payload = await fetchJson(`${session.serverUrl}/session/${session.sessionId}/source`, { method: "GET" });
            return jsonResult({ source: payload.value ?? payload });
        }

        case "mobile_tap": {
            const { deviceId, x, y } = args;
            const session = await ensureAppiumSession(deviceId);
            if (session.error) return textResult(false, session.error);
            await fetchJson(`${session.serverUrl}/session/${session.sessionId}/actions`, {
                method: "POST",
                body: JSON.stringify({
                    actions: [{
                        type: "pointer",
                        id: "finger1",
                        parameters: { pointerType: "touch" },
                        actions: [
                            { type: "pointerMove", duration: 0, x, y },
                            { type: "pointerDown", button: 0 },
                            { type: "pause", duration: 50 },
                            { type: "pointerUp", button: 0 },
                        ],
                    }],
                }),
            });
            return jsonResult({ tapped: { x, y } });
        }

        case "mobile_type_text": {
            const { deviceId, text } = args;
            const session = await ensureAppiumSession(deviceId);
            if (session.error) return textResult(false, session.error);
            await fetchJson(`${session.serverUrl}/session/${session.sessionId}/keys`, {
                method: "POST",
                body: JSON.stringify({ text, value: Array.from(text) }),
            });
            return jsonResult({ typed: true });
        }

        case "mobile_back": {
            const { deviceId } = args;
            const session = await ensureAppiumSession(deviceId);
            if (session.error) return textResult(false, session.error);
            await fetchJson(`${session.serverUrl}/session/${session.sessionId}/back`, {
                method: "POST",
                body: JSON.stringify({}),
            });
            return jsonResult({ back: true });
        }

        default:
            return undefined;
    }
}
