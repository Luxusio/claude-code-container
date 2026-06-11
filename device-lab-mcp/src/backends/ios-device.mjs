import { createHash } from "crypto";
import { spawn } from "child_process";
import { commandPath, run } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findIosRealDevice, readIosRealDevices, updateIosRealDevice, writeIosRealDevices } from "../state/ios-device-state.mjs";
import { claimPhysicalLease, releasePhysicalLease } from "../state/physical-lease-store.mjs";
import { iosAppiumDiscovery, iosDiscovery } from "./ios-simulator.mjs";

const IOS_REAL_CAPABILITIES = [
    "device_inventory", "device_attach", "device_detach", "device_start", "device_stop",
    "device_status", "mobile_session_status", "mobile_dump_ui",
    "device_exec", "device_screenshot", "device_install_app", "device_launch_app",
    "mobile_install_app", "mobile_launch_app", "mobile_screenshot",
    "mobile_tap", "mobile_double_tap", "mobile_long_press", "mobile_swipe",
    "mobile_drag", "mobile_type_text", "mobile_key", "mobile_home",
    "mobile_lock", "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right",
    "mobile_set_orientation", "mobile_wait_for_text", "mobile_wait_for_app",
    "mobile_stop_app",
];

export function iosRealBackend() {
    const discovery = iosRealDiscovery();
    return {
        name: "ios-device",
        host: "macos-host-usb-xcode",
        creatable: false,
        attachable: true,
        available: discovery.available,
        lazy: true,
        status: discovery.available ? "available" : "missing-prerequisites",
        missing: discovery.missing,
        tools: { xcrun: discovery.xcrun, xcodebuild: discovery.xcodebuild },
        capabilities: IOS_REAL_CAPABILITIES,
    };
}

function iosRealDiscovery() {
    const ios = iosDiscovery();
    const xcodebuild = commandPath("xcodebuild");
    const missing = [...ios.missing];
    if (!xcodebuild) missing.push("xcodebuild");
    return {
        xcrun: ios.xcrun,
        xcodebuild,
        available: missing.length === 0,
        missing,
    };
}

function now() {
    return new Date().toISOString();
}

function iosRealDeviceId(nameOrUdid) {
    return `ios-device-${slug(nameOrUdid)}`;
}

function appiumPortForDevice(id) {
    const hash = createHash("sha256").update(`${ownerId()}:ios-device:${id}`).digest();
    return 32000 + (hash.readUInt16BE(0) % 6000);
}

function parseXctraceDevices(text) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.endsWith(":") && !line.includes("Simulator"))
        .map((line) => {
            const matches = [...line.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]);
            const udid = matches.find((value) => /^[A-Fa-f0-9-]{8,}$/.test(value));
            if (!udid) return null;
            const version = matches.find((value) => value !== udid && /\d/.test(value)) || null;
            const name = line.split(" (")[0].trim();
            if (!/\b(iPhone|iPad|iPod)\b/i.test(name)) return null;
            const connection = /\b(network|wifi|wi-fi)\b/i.test(line) ? "wifi" : "usb";
            return { name, udid, version, connection, raw: line };
        })
        .filter(Boolean);
}

function hostIosDevices(discovery = iosRealDiscovery()) {
    if (!discovery.xcrun) return { available: false, missing: ["xcrun"], devices: [] };
    const r = run(discovery.xcrun, ["xctrace", "list", "devices"]);
    if (r.status !== 0) {
        return {
            available: false,
            missing: [],
            devices: [],
            error: r.stderr || r.stdout || `exit ${r.status}`,
        };
    }
    return { available: true, missing: [], devices: parseXctraceDevices(r.stdout) };
}

function unsupported(tool) {
    return textResult(false, `iOS real devices do not support ${tool} through base simctl; use Appium/XCUITest or Xcode device tooling where available.`);
}

function unsupportedRealControl(tool) {
    return textResult(false, `iOS real devices do not support ${tool} through CCC because the action is unavailable or unsafe for physical devices.`);
}

function appiumStatus(device) {
    const discovery = iosAppiumDiscovery();
    return {
        deviceId: device.id,
        appium: discovery,
        session: device.appium || null,
        automationName: "XCUITest",
        lazy: true,
        physical: true,
    };
}

function clearVolatileMetadata(deviceId) {
    return updateIosRealDevice(deviceId, (item) => ({
        ...item,
        status: "attached",
        pid: null,
        appium: null,
        recording: null,
        updatedAt: now(),
    }));
}

function stopVolatileProcesses(device) {
    if (device.recording?.pid) {
        try { process.kill(device.recording.pid, "SIGINT"); } catch { /* ignore stale recorder */ }
    }
    if (device.appium?.serverPid) {
        try { process.kill(device.appium.serverPid); } catch { /* ignore stale appium */ }
    }
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        if (!processIsAlive(pid)) return true;
        await sleep(50);
    }
    return !processIsAlive(pid);
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

async function ensureIosRealAppiumSession(deviceId) {
    const device = findIosRealDevice(deviceId);
    if (!device) return { unknown: true };

    const discovery = iosAppiumDiscovery();
    if (!discovery.available) {
        return { error: `iOS real-device Appium/XCUITest layer missing prerequisites: ${discovery.missing.join(", ")}` };
    }

    const port = device.appiumPort || appiumPortForDevice(device.id);
    const serverUrl = `http://127.0.0.1:${port}`;

    if (device.appium?.sessionId && device.appium?.serverUrl) {
        try {
            await fetchJson(`${device.appium.serverUrl}/status`, { method: "GET" });
            await fetchJson(`${device.appium.serverUrl}/session/${device.appium.sessionId}`, { method: "GET" });
            return { device, serverUrl: device.appium.serverUrl, sessionId: device.appium.sessionId };
        } catch {
            if (device.appium.serverPid) {
                try { process.kill(device.appium.serverPid, "SIGINT"); } catch { /* ignore stale appium */ }
                await waitForProcessExit(device.appium.serverPid, 1000);
            }
            updateIosRealDevice(deviceId, (item) => ({
                ...item,
                appium: null,
                updatedAt: now(),
            }));
        }
    }

    const child = spawn(discovery.appium, ["server", "--port", String(port), "--base-path", "/"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
    });
    child.unref();

    const cleanupChild = () => {
        if (child.pid) {
            try { process.kill(child.pid, "SIGINT"); } catch { /* ignore startup cleanup */ }
        }
    };

    const ready = await waitForAppium(serverUrl);
    if (!ready) {
        cleanupChild();
        return { error: `Appium server did not become ready on ${serverUrl}` };
    }

    let response;
    try {
        response = await fetchJson(`${serverUrl}/session`, {
            method: "POST",
            body: JSON.stringify({
                capabilities: {
                    alwaysMatch: {
                        platformName: "iOS",
                        "appium:automationName": "XCUITest",
                        "appium:deviceName": device.name || device.id,
                        "appium:udid": device.udid,
                        "appium:realDevice": true,
                    },
                },
            }),
        });
    } catch (error) {
        cleanupChild();
        return { error: `Appium session creation failed: ${error.message}` };
    }
    const sessionId = response?.value?.sessionId || response?.sessionId;
    if (!sessionId) {
        cleanupChild();
        return { error: "Appium did not return a session id" };
    }

    const updated = updateIosRealDevice(deviceId, (item) => ({
        ...item,
        appiumPort: port,
        appium: {
            serverUrl,
            serverPid: child.pid,
            sessionId,
            automationName: "XCUITest",
            physical: true,
            updatedAt: now(),
        },
        updatedAt: now(),
    }));

    return { device: updated, serverUrl, sessionId };
}

function appiumPointerActions(type, steps) {
    return {
        actions: [{
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: steps,
        }],
        gesture: type,
    };
}

async function iosRealAppiumSessionOrResult(deviceId) {
    const session = await ensureIosRealAppiumSession(deviceId);
    if (session.unknown) return { unknown: true };
    if (session.error) return { result: textResult(false, session.error) };
    return { session };
}

async function postIosRealAppium(deviceId, path, body, provider = "appium-xcuitest") {
    const resolved = await iosRealAppiumSessionOrResult(deviceId);
    if (resolved.unknown || resolved.result) return resolved;
    const { session } = resolved;
    try {
        const response = await fetchJson(`${session.serverUrl}/session/${session.sessionId}${path}`, {
            method: "POST",
            body: JSON.stringify(body),
        });
        return { result: jsonResult({ provider, physical: true, sessionId: session.sessionId, response: response?.value ?? response }) };
    } catch (error) {
        return { result: textResult(false, `iOS real-device Appium request failed: ${error.message}`) };
    }
}

async function iosRealAppiumSource(deviceId) {
    const resolved = await iosRealAppiumSessionOrResult(deviceId);
    if (resolved.unknown || resolved.result) return resolved;
    const { session } = resolved;
    try {
        const response = await fetchJson(`${session.serverUrl}/session/${session.sessionId}/source`, { method: "GET" });
        return { session, source: response?.value ?? response?.source ?? response };
    } catch (error) {
        return { result: textResult(false, `Appium source request failed: ${error.message}`) };
    }
}

function requirePathArg(path, toolName) {
    if (!path) return textResult(false, `iOS real-device ${toolName} requires path`);
    return null;
}

function requireBundleIdArg(bundleId, toolName) {
    if (!bundleId) return textResult(false, `iOS real-device ${toolName} requires bundleId`);
    return null;
}

export function listIosRealDevices() {
    return readIosRealDevices().map((device) => ({ ...device, ownerId: ownerId() }));
}

export async function handleIosRealTool(name, args) {
    switch (name) {
        case "device_inventory": {
            const { backend = "ios-device" } = args;
            if (backend !== "ios-device") return undefined;
            const discovery = iosRealDiscovery();
            return jsonResult({
                backend,
                ownerId: ownerId(),
                devices: listIosRealDevices(),
                hostDevices: hostIosDevices(discovery),
                discovery,
            });
        }

        case "device_attach": {
            const { backend, name: deviceName, deviceId, udid, connection, host, port } = args;
            if (backend !== "ios-device") return undefined;
            if (!udid) return textResult(false, "iOS real-device attach requires udid");
            const discovery = iosRealDiscovery();
            if (!discovery.xcrun) return textResult(false, "iOS real-device backend missing prerequisites: xcrun");
            const inventory = hostIosDevices(discovery);
            const hostDevice = inventory.devices.find((device) => device.udid === udid);
            if (!hostDevice) return textResult(false, `iOS device is not visible to xctrace: ${udid}`);
            if (connection === "wifi" && hostDevice.connection !== "wifi") {
                return textResult(false, `iOS Wi-Fi attach requires the device to be paired for network use and visible to xctrace as a network device: ${udid}`);
            }
            const resolvedConnection = connection || hostDevice.connection || "usb";

            const id = deviceId || iosRealDeviceId(deviceName || hostDevice.name || udid);
            const devices = readIosRealDevices();
            if (devices.some((device) => device.id === id)) return textResult(false, `Device already exists for this owner: ${id}`);
            if (devices.some((device) => device.udid === udid)) return textResult(false, `iOS UDID already attached for this owner: ${udid}`);
            const lease = claimPhysicalLease("ios-device", udid, id);
            if (!lease.ok) {
                return textResult(false, `iOS UDID is already attached by another CCC owner: ${udid}`);
            }

            const device = {
                id,
                name: deviceName || hostDevice.name || udid,
                backend,
                kind: "mobile",
                platform: "ios",
                physical: true,
                ownerId: ownerId(),
                udid,
                connection: resolvedConnection,
                transport: {
                    type: resolvedConnection,
                    host: resolvedConnection === "wifi" ? host || null : null,
                    port: resolvedConnection === "wifi" ? port || null : null,
                    visibleVia: "xctrace",
                },
                hostDetails: hostDevice,
                appiumPort: appiumPortForDevice(id),
                appium: null,
                recording: null,
                status: "attached",
                creatable: false,
                attachable: true,
                attachedAt: now(),
                updatedAt: now(),
            };
            writeIosRealDevices([...devices, device]);
            return jsonResult({ device });
        }

        case "device_detach": {
            const { deviceId } = args;
            const devices = readIosRealDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            stopVolatileProcesses(device);
            writeIosRealDevices(devices.filter((item) => item.id !== deviceId));
            releasePhysicalLease("ios-device", device.udid, deviceId);
            return jsonResult({ detached: deviceId, physicalDevicePoweredOff: false });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device, started: false, alreadyAttached: true, physicalDevicePoweredOnByMcp: false });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            stopVolatileProcesses(device);
            const updated = clearVolatileMetadata(deviceId);
            return jsonResult({ device: updated, stopped: false, detached: false, physicalDevicePoweredOff: false });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const discovery = iosRealDiscovery();
            const host = discovery.xcrun ? hostIosDevices(discovery).devices.find((item) => item.udid === device.udid) || null : null;
            return jsonResult({ device, backend: iosRealBackend(), hostDevice: host, appium: appiumStatus(device) });
        }

        case "mobile_session_status": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            return jsonResult(appiumStatus(device));
        }

        case "device_exec": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            return unsupported(name);
        }

        case "mobile_dump_ui": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const session = await ensureIosRealAppiumSession(deviceId);
            if (session.unknown) return undefined;
            if (session.error) return textResult(false, session.error);
            let source;
            try {
                source = await fetchJson(`${session.serverUrl}/session/${session.sessionId}/source`, { method: "GET" });
            } catch (error) {
                return textResult(false, `Appium source request failed: ${error.message}`);
            }
            return jsonResult({
                provider: "appium-xcuitest",
                physical: true,
                source: source?.value ?? source?.source ?? source,
                sessionId: session.sessionId,
                serverUrl: session.serverUrl,
            });
        }

        case "device_screenshot":
        case "mobile_screenshot": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const session = await ensureIosRealAppiumSession(deviceId);
            if (session.unknown) return undefined;
            if (session.error) return textResult(false, session.error);
            let screenshot;
            try {
                screenshot = await fetchJson(`${session.serverUrl}/session/${session.sessionId}/screenshot`, { method: "GET" });
            } catch (error) {
                return textResult(false, `Appium screenshot request failed: ${error.message}`);
            }
            const data = screenshot?.value || screenshot?.screenshot;
            if (!data) return textResult(false, "Appium did not return screenshot data");
            return { content: [{ type: "image", data, mimeType: "image/png" }] };
        }

        case "device_install_app":
        case "mobile_install_app": {
            const { deviceId, path } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const missing = requirePathArg(path, name);
            if (missing) return missing;
            const discovery = iosRealDiscovery();
            if (!discovery.xcrun) return textResult(false, "iOS real-device backend missing prerequisites: xcrun");
            const r = run(discovery.xcrun, ["devicectl", "device", "install", "app", "--device", device.udid, path]);
            return r.status === 0 ? jsonResult({ installed: path, udid: device.udid, provider: "xcrun-devicectl", stdout: r.stdout, stderr: r.stderr }) : fail(r);
        }

        case "device_launch_app":
        case "mobile_launch_app": {
            const { deviceId, bundleId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const missing = requireBundleIdArg(bundleId, name);
            if (missing) return missing;
            const discovery = iosRealDiscovery();
            if (!discovery.xcrun) return textResult(false, "iOS real-device backend missing prerequisites: xcrun");
            const r = run(discovery.xcrun, ["devicectl", "device", "process", "launch", "--device", device.udid, bundleId]);
            return r.status === 0 ? jsonResult({ launched: bundleId, udid: device.udid, provider: "xcrun-devicectl", stdout: r.stdout, stderr: r.stderr }) : fail(r);
        }

        case "mobile_tap": {
            const { deviceId, x, y } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const posted = await postIosRealAppium(deviceId, "/actions", appiumPointerActions("tap", [
                { type: "pointerMove", duration: 0, x, y },
                { type: "pointerDown", button: 0 },
                { type: "pointerUp", button: 0 },
            ]));
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ tapped: { x, y }, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_double_tap": {
            const { deviceId, x, y } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const posted = await postIosRealAppium(deviceId, "/actions", appiumPointerActions("doubleTap", [
                { type: "pointerMove", duration: 0, x, y },
                { type: "pointerDown", button: 0 },
                { type: "pointerUp", button: 0 },
                { type: "pause", duration: 80 },
                { type: "pointerDown", button: 0 },
                { type: "pointerUp", button: 0 },
            ]));
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ doubleTapped: { x, y }, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_long_press": {
            const { deviceId, x, y, durationMs = 700 } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const posted = await postIosRealAppium(deviceId, "/actions", appiumPointerActions("longPress", [
                { type: "pointerMove", duration: 0, x, y },
                { type: "pointerDown", button: 0 },
                { type: "pause", duration: durationMs },
                { type: "pointerUp", button: 0 },
            ]));
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ longPressed: { x, y, durationMs }, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_swipe":
        case "mobile_drag": {
            const { deviceId, x1, y1, x2, y2, durationMs = name === "mobile_drag" ? 700 : 300 } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const posted = await postIosRealAppium(deviceId, "/actions", appiumPointerActions(name === "mobile_drag" ? "drag" : "swipe", [
                { type: "pointerMove", duration: 0, x: x1, y: y1 },
                { type: "pointerDown", button: 0 },
                { type: "pointerMove", duration: durationMs, x: x2, y: y2 },
                { type: "pointerUp", button: 0 },
            ]));
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ [name === "mobile_drag" ? "dragged" : "swiped"]: { x1, y1, x2, y2, durationMs }, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_type_text": {
            const { deviceId, text } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const posted = await postIosRealAppium(deviceId, "/keys", { text: String(text), value: [...String(text)] });
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ typed: true, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_key": {
            const { deviceId, key, keyCode } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const resolvedKey = key ?? keyCode;
            if (resolvedKey === undefined || resolvedKey === null || resolvedKey === "") return textResult(false, "mobile_key requires key or keyCode");
            const posted = await postIosRealAppium(deviceId, "/keys", { text: String(resolvedKey), value: [String(resolvedKey)] });
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ key: resolvedKey, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_home": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const posted = await postIosRealAppium(deviceId, "/execute/sync", { script: "mobile: pressButton", args: [{ name: "home" }] });
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ home: true, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_lock": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const posted = await postIosRealAppium(deviceId, "/execute/sync", { script: "mobile: lock", args: [] });
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ locked: true, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_unlock": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const posted = await postIosRealAppium(deviceId, "/execute/sync", { script: "mobile: unlock", args: [] });
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ unlocked: true, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_rotate_left": {
            const { deviceId } = args;
            return handleIosRealTool("mobile_set_orientation", { deviceId, orientation: "LANDSCAPE" });
        }

        case "mobile_rotate_right": {
            const { deviceId } = args;
            return handleIosRealTool("mobile_set_orientation", { deviceId, orientation: "PORTRAIT" });
        }

        case "mobile_set_orientation": {
            const { deviceId, orientation } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const resolved = String(orientation || "").toUpperCase();
            if (!["PORTRAIT", "LANDSCAPE"].includes(resolved)) return textResult(false, "iOS real-device mobile_set_orientation requires PORTRAIT or LANDSCAPE");
            const posted = await postIosRealAppium(deviceId, "/orientation", { orientation: resolved });
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ orientation: resolved, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_wait_for_text": {
            const { deviceId, text, timeoutMs = 10000, intervalMs = 500 } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            if (!text) return textResult(false, "iOS real-device wait-for-text requires text");
            const deadline = Date.now() + Math.max(0, timeoutMs);
            let lastSource = "";
            while (Date.now() <= deadline) {
                const resolved = await iosRealAppiumSource(deviceId);
                if (resolved.unknown) return undefined;
                if (resolved.result) return resolved.result;
                lastSource = String(resolved.source || "");
                if (lastSource.includes(text)) return jsonResult({ found: true, text, source: lastSource, provider: "appium-xcuitest", physical: true });
                await sleep(Math.max(50, intervalMs));
            }
            return jsonResult({ found: false, text, source: lastSource, timeoutMs, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_wait_for_app": {
            const { deviceId, bundleId, timeoutMs = 10000, intervalMs = 500 } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            if (!bundleId) return textResult(false, "iOS real-device wait-for-app requires bundleId");
            const resolved = await iosRealAppiumSessionOrResult(deviceId);
            if (resolved.unknown) return undefined;
            if (resolved.result) return resolved.result;
            const { session } = resolved;
            const deadline = Date.now() + Math.max(0, timeoutMs);
            let lastActiveApp = null;
            while (Date.now() <= deadline) {
                try {
                    const response = await fetchJson(`${session.serverUrl}/session/${session.sessionId}/execute/sync`, {
                        method: "POST",
                        body: JSON.stringify({ script: "mobile: activeAppInfo", args: [] }),
                    });
                    lastActiveApp = response?.value ?? response;
                    if (lastActiveApp?.bundleId === bundleId || lastActiveApp?.bundleID === bundleId) {
                        return jsonResult({ found: true, bundleId, activeApp: lastActiveApp, provider: "appium-xcuitest", physical: true });
                    }
                } catch (error) {
                    return textResult(false, `iOS real-device Appium active app request failed: ${error.message}`);
                }
                await sleep(Math.max(50, intervalMs));
            }
            return jsonResult({ found: false, bundleId, activeApp: lastActiveApp, timeoutMs, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_stop_app": {
            const { deviceId, bundleId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const missing = requireBundleIdArg(bundleId, name);
            if (missing) return missing;
            const posted = await postIosRealAppium(deviceId, "/execute/sync", { script: "mobile: terminateApp", args: [{ bundleId }] });
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ stopped: bundleId, provider: "appium-xcuitest", physical: true });
        }

        case "mobile_back":
        case "mobile_forward":
        case "mobile_recents":
        case "mobile_power":
        case "mobile_uninstall_app":
        case "mobile_clear_app_data":
        case "mobile_grant_permission":
        case "mobile_revoke_permission":
        case "mobile_set_location":
        case "mobile_set_battery":
        case "mobile_set_network":
        case "mobile_toggle_airplane_mode":
        case "mobile_set_clipboard":
        case "mobile_get_clipboard":
        case "mobile_open_url": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            return unsupportedRealControl(name);
        }

        default:
            return undefined;
    }
}
