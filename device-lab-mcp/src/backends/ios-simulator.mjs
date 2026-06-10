import { spawn } from "child_process";
import { createHash } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, isAbsolute, join, normalize } from "path";
import { commandPath, localBinPath, run, runWithInput, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findIosDevice, readIosDevices, updateIosDevice, writeIosDevices } from "../state/ios-state.mjs";

export function iosDiscovery() {
    const xcrun = commandPath("xcrun");
    const missing = [];
    if (!xcrun) missing.push("xcrun");
    return {
        xcrun,
        available: missing.length === 0,
        missing,
    };
}

export function iosAppiumDiscovery() {
    const ios = iosDiscovery();
    const appium = localBinPath("appium") || commandPath("appium");
    const xcuitestDriver = localBinPath("appium-xcuitest-driver") || commandPath("appium-xcuitest-driver");
    const xcodebuild = commandPath("xcodebuild");
    const missing = [...ios.missing];
    if (!appium) missing.push("appium");
    if (!xcuitestDriver) missing.push("appium-xcuitest-driver");
    if (!xcodebuild) missing.push("xcodebuild");
    return {
        appium,
        xcuitestDriver,
        xcodebuild,
        xcrun: ios.xcrun,
        available: missing.length === 0,
        missing,
    };
}

export function iosBackend() {
    const discovery = iosDiscovery();
    return {
        name: "ios-simulator",
        host: "macos-host",
        creatable: true,
        available: discovery.available,
        lazy: true,
        status: discovery.available ? "available" : "missing-prerequisites",
        missing: discovery.missing,
        tools: { xcrun: discovery.xcrun },
        capabilities: [
            "device_inventory",
            "device_create",
            "device_delete",
            "device_start",
            "device_stop",
            "device_status",
            "device_exec",
            "device_screenshot",
            "device_record_video_start",
            "device_record_video_stop",
            "device_record_video_status",
            "device_upload",
            "device_download",
            "device_reset",
            "device_install_app",
            "device_launch_app",
            "mobile_open_url",
            "mobile_install_app",
            "mobile_launch_app",
            "mobile_screenshot",
            "mobile_session_status",
            "mobile_dump_ui",
            "mobile_uninstall_app",
            "mobile_stop_app",
            "mobile_clear_app_data",
            "mobile_grant_permission",
            "mobile_revoke_permission",
            "mobile_set_location",
            "mobile_set_clipboard",
            "mobile_get_clipboard",
            "mobile_wait_for_app",
        ],
    };
}

function iosDeviceId(name) {
    return `ios-${slug(name)}`;
}

function simctlTarget(device) {
    return device.udid || device.simulatorName || device.name || device.id;
}

function iosRecordingDir(device) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), "ios", device.id, "recordings");
}

function iosRecordingLocalPath(device) {
    return join(iosRecordingDir(device), `recording-${Date.now()}.mp4`);
}

function appiumPortForIosDevice(id) {
    const hash = createHash("sha256").update(`${ownerId()}:ios:${id}`).digest();
    return 30000 + (hash.readUInt16BE(0) % 10000);
}

function ownerSimulatorPrefix() {
    return `ccc-${ownerId()}-`;
}

function isOwnedSimulatorName(name) {
    return typeof name === "string" && name.startsWith(ownerSimulatorPrefix());
}

function missingPrereqResult(discovery) {
    return textResult(false, `iOS Simulator backend missing prerequisites: ${discovery.missing.join(", ")}`);
}

function unsupportedMobileResult(tool) {
    return textResult(false, `iOS Simulator does not support ${tool} through base simctl; use Appium/XCUITest support when available.`);
}

function unsupportedIosResult(tool, reason) {
    return textResult(false, `iOS Simulator ${tool} is not supported through base simctl in this slice: ${reason}`);
}

function iosAppiumStatus(device) {
    return {
        deviceId: device.id,
        appium: iosAppiumDiscovery(),
        session: device.appium || null,
        automationName: "XCUITest",
        lazy: true,
    };
}

function missingIosAppiumResult(discovery) {
    return textResult(false, `iOS Appium/XCUITest layer missing prerequisites: ${discovery.missing.join(", ")}`);
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRecorderProcess(child, label) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => done(null), 150);
        child.once("error", (error) => done(textResult(false, `${label} recorder failed to start: ${error.message}`)));
        child.once("exit", (code, signal) => done(textResult(false, `${label} recorder exited before it was ready: ${signal || `exit ${code}`}`)));
    });
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

function reconcileIosRecording(device) {
    if (!device?.recording?.active || !device.recording.pid || processIsAlive(device.recording.pid)) return device;
    return updateIosDevice(device.id, (item) => ({
        ...item,
        recording: null,
        updatedAt: now(),
    })) || { ...device, recording: null };
}

function monitorIosRecordingExit(deviceId, pid) {
    return () => {
        const current = findIosDevice(deviceId);
        if (current?.recording?.active && current.recording.pid === pid) {
            updateIosDevice(deviceId, (item) => ({
                ...item,
                recording: null,
                updatedAt: now(),
            }));
        }
    };
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

async function waitForIosApp(xcrun, device, bundleId, timeoutMs = 10000, intervalMs = 500) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let last = null;
    while (Date.now() <= deadline) {
        const r = run(xcrun, ["simctl", "spawn", simctlTarget(device), "pgrep", "-f", bundleId]);
        last = r;
        if (r.status === 0 && r.stdout.trim()) {
            return { running: true, pid: r.stdout.trim(), stdout: r.stdout, stderr: r.stderr, status: r.status };
        }
        await sleep(Math.max(50, intervalMs));
    }
    return { running: false, timeoutMs, stdout: last?.stdout || "", stderr: last?.stderr || "", status: last?.status ?? null };
}

async function ensureIosAppiumSession(deviceId) {
    const device = findIosDevice(deviceId);
    if (!device) return { unknown: true };

    const discovery = iosAppiumDiscovery();
    if (!discovery.available) {
        return { error: `iOS Appium/XCUITest layer missing prerequisites: ${discovery.missing.join(", ")}` };
    }

    const port = device.appiumPort || appiumPortForIosDevice(device.id);
    const serverUrl = `http://127.0.0.1:${port}`;

    if (device.appium?.sessionId && device.appium?.serverUrl) {
        try {
            await fetchJson(`${device.appium.serverUrl}/status`, { method: "GET" });
            await fetchJson(`${device.appium.serverUrl}/session/${device.appium.sessionId}`, { method: "GET" });
            return { device, serverUrl: device.appium.serverUrl, sessionId: device.appium.sessionId };
        } catch {
            updateIosDevice(deviceId, (item) => ({
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

    const ready = await waitForAppium(serverUrl);
    if (!ready) return { error: `Appium server did not become ready on ${serverUrl}` };

    const response = await fetchJson(`${serverUrl}/session`, {
        method: "POST",
        body: JSON.stringify({
            capabilities: {
                alwaysMatch: {
                    platformName: "iOS",
                    "appium:automationName": "XCUITest",
                    "appium:deviceName": device.simulatorName || device.name || device.id,
                    ...(device.udid ? { "appium:udid": device.udid } : {}),
                },
            },
        }),
    });
    const sessionId = response?.value?.sessionId || response?.sessionId;
    if (!sessionId) return { error: "Appium did not return a session id" };

    const updated = updateIosDevice(deviceId, (item) => ({
        ...item,
        appiumPort: port,
        appium: {
            serverUrl,
            serverPid: child.pid,
            sessionId,
            automationName: "XCUITest",
            updatedAt: now(),
        },
        updatedAt: now(),
    }));

    return { device: updated, serverUrl, sessionId };
}

function now() {
    return new Date().toISOString();
}

function iosContainerType(value) {
    return value || "data";
}

function resolveIosAppContainer(xcrun, device, bundleId, containerType = "data") {
    const r = run(xcrun, ["simctl", "get_app_container", simctlTarget(device), bundleId, containerType]);
    if (r.status !== 0) return { error: r };
    const containerRoot = r.stdout.trim();
    if (!containerRoot) return { error: { ...r, status: 1, stderr: "simctl get_app_container returned an empty path" } };
    return { containerRoot };
}

function pathInsideContainer(containerRoot, requestedPath) {
    const stripped = String(requestedPath || "").replace(/^[/\\]+/, "");
    const relativePath = normalize(stripped);
    if (!relativePath || relativePath === "." || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${"/"}`) || relativePath.startsWith(`..${"\\"}`)) {
        return { error: `Refusing path outside iOS app container: ${requestedPath}` };
    }
    return { path: join(containerRoot, relativePath), relativePath };
}

function realPathIsInside(parent, child) {
    return child === parent || child.startsWith(`${parent}/`);
}

function ensureContainerPathForWrite(containerRoot, targetPath) {
    try {
        const root = realpathSync(containerRoot);
        mkdirSync(dirname(targetPath), { recursive: true });
        const parent = realpathSync(dirname(targetPath));
        if (!realPathIsInside(root, parent)) return { error: "Resolved iOS app container path escapes the container" };
        if (existsSync(targetPath)) {
            const existing = realpathSync(targetPath);
            if (!realPathIsInside(root, existing)) return { error: "Resolved iOS app container path escapes the container" };
        }
        return { root };
    } catch (error) {
        return { error: `Unable to resolve iOS app container path: ${error.message}` };
    }
}

function ensureContainerPathForRead(containerRoot, sourcePath) {
    try {
        const root = realpathSync(containerRoot);
        const source = realpathSync(sourcePath);
        if (!realPathIsInside(root, source)) return { error: "Resolved iOS app container path escapes the container" };
        return { root, source };
    } catch (error) {
        return { error: `Unable to resolve iOS app container path: ${error.message}` };
    }
}

function clearDirectoryContents(path) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        rmSync(join(path, entry.name), { recursive: true, force: true });
    }
}

function simctlJson(xcrun, args) {
    const r = run(xcrun, ["simctl", ...args]);
    if (r.status !== 0) return { error: r };
    try {
        return { value: JSON.parse(r.stdout || "{}") };
    } catch {
        return { error: { ...r, stderr: `Invalid simctl JSON: ${r.stdout}` } };
    }
}

function hostSimulatorInventory(discovery = iosDiscovery()) {
    if (!discovery.available) {
        return {
            available: false,
            missing: discovery.missing,
            devices: {},
            runtimes: [],
            deviceTypes: [],
        };
    }
    const listed = simctlJson(discovery.xcrun, ["list", "-j"]);
    if (listed.error) {
        return {
            available: false,
            missing: [],
            devices: {},
            runtimes: [],
            deviceTypes: [],
            error: listed.error.stderr || listed.error.stdout || `exit ${listed.error.status}`,
        };
    }
    return {
        available: true,
        missing: [],
        devices: listed.value.devices || {},
        runtimes: listed.value.runtimes || [],
        deviceTypes: listed.value.devicetypes || listed.value.deviceTypes || [],
    };
}

function findRuntimeDevice(simctlList, udid) {
    if (!udid || !simctlList?.devices) return null;
    for (const devices of Object.values(simctlList.devices)) {
        const match = devices.find((device) => device.udid === udid);
        if (match) return match;
    }
    return null;
}

function normalizeSimState(state) {
    if (!state) return "unknown";
    return String(state).toLowerCase() === "booted" ? "booted" : "stopped";
}

function reconcileIosDevice(device) {
    const discovery = iosDiscovery();
    if (!discovery.available || !device.udid) return device;

    const listed = simctlJson(discovery.xcrun, ["list", "devices", "-j"]);
    if (listed.error) return device;

    const simulator = findRuntimeDevice(listed.value, device.udid);
    if (!simulator) return device;

    const status = normalizeSimState(simulator.state);
    if (status === device.status && simulator.name === device.simulatorName) return device;

    return updateIosDevice(device.id, (item) => ({
        ...item,
        simulatorName: simulator.name || item.simulatorName,
        status,
        updatedAt: now(),
    })) || device;
}

export function listIosDevices() {
    return readIosDevices().map((device) => ({ ...reconcileIosDevice(device), ownerId: ownerId() }));
}

export async function handleIosTool(name, args) {
    switch (name) {
        case "device_inventory": {
            const { backend = "ios-simulator" } = args;
            if (backend !== "ios-simulator") return undefined;

            const discovery = iosDiscovery();
            return jsonResult({
                backend,
                ownerId: ownerId(),
                devices: listIosDevices(),
                hostSimulators: hostSimulatorInventory(discovery),
                discovery,
            });
        }

        case "device_create": {
            const { backend, name: deviceName, deviceId, simulatorName, deviceType, runtime, udid, createSimulator = false } = args;
            if (backend !== "ios-simulator") return undefined;

            const id = deviceId || iosDeviceId(deviceName);
            const devices = readIosDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const simulatorDisplayName = simulatorName || `${ownerSimulatorPrefix()}${slug(deviceName)}`;
            let createdUdid = udid || null;
            let provisioning = "definition-only";
            if (createSimulator) {
                if (!isOwnedSimulatorName(simulatorDisplayName)) {
                    return textResult(false, `Refusing to create non-owned iOS Simulator name: ${simulatorDisplayName}`);
                }
                if (!deviceType || !runtime) {
                    return textResult(false, "iOS Simulator provisioning requires deviceType and runtime");
                }
                const discovery = iosDiscovery();
                if (!discovery.available) return missingPrereqResult(discovery);
                const r = run(discovery.xcrun, ["simctl", "create", simulatorDisplayName, deviceType, runtime]);
                if (r.status !== 0) return fail(r);
                createdUdid = r.stdout.trim();
                provisioning = "created";
            }

            const device = {
                id,
                name: deviceName,
                backend,
                kind: "mobile",
                platform: "ios",
                ownerId: ownerId(),
                simulatorName: simulatorDisplayName,
                deviceType: deviceType || null,
                runtime: runtime || null,
                udid: createdUdid,
                appiumPort: appiumPortForIosDevice(id),
                appium: null,
                status: "stopped",
                creatable: true,
                provisioning,
                createdAt: now(),
                updatedAt: now(),
            };
            devices.push(device);
            writeIosDevices(devices);
            return jsonResult({ device });
        }

        case "device_delete": {
            const { deviceId, force = false, deleteSimulator = false } = args;
            const devices = readIosDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }

            if (deleteSimulator) {
                if (!isOwnedSimulatorName(device.simulatorName)) {
                    return textResult(false, `Refusing to delete non-owned iOS Simulator name: ${device.simulatorName}`);
                }
                const discovery = iosDiscovery();
                if (!discovery.available) return missingPrereqResult(discovery);
                if (!device.udid) return textResult(false, `Cannot delete iOS Simulator without udid: ${deviceId}`);
                if (force && device.status !== "stopped") {
                    run(discovery.xcrun, ["simctl", "shutdown", device.udid]);
                }
                const r = run(discovery.xcrun, ["simctl", "delete", device.udid]);
                if (r.status !== 0 && !String(r.stderr || r.stdout).includes("Invalid device")) return fail(r);
            }

            writeIosDevices(devices.filter((item) => item.id !== deviceId));
            return jsonResult({ deleted: deviceId, simulatorDeleted: Boolean(deleteSimulator) });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device: reconcileIosDevice(device), backend: iosBackend() });
        }

        case "device_start": {
            const { deviceId, waitForBoot = true, bootTimeoutMs = 60000 } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) {
                return missingPrereqResult(discovery);
            }
            if (!isOwnedSimulatorName(device.simulatorName)) {
                return textResult(false, `Refusing to start non-owned iOS Simulator name: ${device.simulatorName}`);
            }

            const target = simctlTarget(device);
            const r = run(discovery.xcrun, ["simctl", "boot", target]);
            if (r.status !== 0 && !String(r.stderr || r.stdout).includes("Unable to boot device in current state: Booted")) {
                return fail(r);
            }

            let boot = { ready: true, skipped: true };
            if (waitForBoot) {
                const bootstatus = runWithTimeout(discovery.xcrun, ["simctl", "bootstatus", target, "-b"], bootTimeoutMs);
                boot = {
                    ready: bootstatus.status === 0,
                    skipped: false,
                    status: bootstatus.status,
                    stdout: bootstatus.stdout,
                    stderr: bootstatus.stderr,
                };
                if (bootstatus.error) boot.error = bootstatus.error;
            }

            const updated = updateIosDevice(deviceId, (item) => ({
                ...item,
                status: boot.ready ? "booted" : "starting",
                bootReady: boot.ready,
                lastBootCheck: boot,
                updatedAt: now(),
            }));
            return jsonResult({ device: updated, boot });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (device.recording?.pid) {
                try { process.kill(device.recording.pid, "SIGINT"); } catch { /* ignore stale recorder */ }
                await waitForProcessExit(device.recording.pid, 1000);
            }
            if (discovery.available) {
                run(discovery.xcrun, ["simctl", "shutdown", simctlTarget(device)]);
            }
            if (device.appium?.serverPid) {
                try { process.kill(device.appium.serverPid); } catch { /* ignore stale pid */ }
            }

            const updated = updateIosDevice(deviceId, (item) => ({
                ...item,
                status: "stopped",
                appium: null,
                recording: null,
                updatedAt: now(),
            }));
            return jsonResult({ device: updated });
        }

        case "device_exec": {
            const { deviceId, command } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const r = run(discovery.xcrun, ["simctl", "spawn", simctlTarget(device), "/bin/sh", "-lc", command]);
            return r.status === 0 ? jsonResult({ stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "device_screenshot": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) {
                return missingPrereqResult(discovery);
            }

            const ssPath = join(tmpdir(), `device_lab_ios_${Date.now()}.png`);
            const r = run(discovery.xcrun, ["simctl", "io", simctlTarget(device), "screenshot", ssPath]);
            if (r.status !== 0) return fail(r);
            const base64 = readFileSync(ssPath).toString("base64");
            try { unlinkSync(ssPath); } catch { /* ignore */ }
            return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
        }

        case "device_record_video_status": {
            const { deviceId } = args;
            const found = findIosDevice(deviceId);
            const device = reconcileIosRecording(found);
            if (!device) return undefined;
            return jsonResult({ deviceId, recording: device.recording || null, provider: "simctl-recordVideo" });
        }

        case "device_record_video_start": {
            const { deviceId, localPath } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (device.recording?.active) return textResult(false, `iOS Simulator recording already active for ${deviceId}`);

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const resolvedLocalPath = localPath || iosRecordingLocalPath(device);
            mkdirSync(iosRecordingDir(device), { recursive: true });
            mkdirSync(dirname(resolvedLocalPath), { recursive: true });
            const child = spawn(discovery.xcrun, ["simctl", "io", simctlTarget(device), "recordVideo", resolvedLocalPath], {
                detached: true,
                stdio: "ignore",
                env: process.env,
            });
            const startError = await waitForRecorderProcess(child, "iOS Simulator recordVideo");
            if (startError) return startError;
            child.once("exit", monitorIosRecordingExit(deviceId, child.pid));
            child.unref();
            const recording = {
                active: true,
                provider: "simctl-recordVideo",
                pid: child.pid,
                localPath: resolvedLocalPath,
                startedAt: now(),
            };
            const updated = updateIosDevice(deviceId, (item) => ({
                ...item,
                recording,
                updatedAt: now(),
            }));
            return jsonResult({ deviceId, recording: updated.recording });
        }

        case "device_record_video_stop": {
            const { deviceId, localPath } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!device.recording?.active) return textResult(false, `No iOS Simulator recording active for ${deviceId}`);

            if (device.recording.pid) {
                try { process.kill(device.recording.pid, "SIGINT"); } catch { /* ignore stale recorder */ }
                const exited = await waitForProcessExit(device.recording.pid, 3000);
                if (!exited) return textResult(false, `iOS Simulator recording did not exit within 3000ms for ${deviceId}; state remains active.`);
            }
            const previous = device.recording;
            const resolvedLocalPath = previous.localPath || localPath || iosRecordingLocalPath(device);
            const updated = updateIosDevice(deviceId, (item) => ({
                ...item,
                recording: null,
                updatedAt: now(),
            }));
            return jsonResult({
                deviceId,
                stopped: true,
                provider: "simctl-recordVideo",
                recording: { ...previous, active: false, localPath: resolvedLocalPath, stoppedAt: now() },
                device: updated,
            });
        }

        case "device_upload": {
            const { deviceId, localPath, remotePath, bundleId, containerType } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!isOwnedSimulatorName(device.simulatorName)) return textResult(false, `Refusing iOS Simulator upload for non-owned simulator name: ${device.simulatorName}`);
            if (!bundleId) return textResult(false, "iOS Simulator upload requires bundleId to resolve an app container");
            if (!localPath || !remotePath) return textResult(false, "iOS Simulator upload requires localPath and remotePath");
            if (!existsSync(localPath)) return textResult(false, `iOS Simulator upload localPath does not exist: ${localPath}`);

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const type = iosContainerType(containerType);
            const container = resolveIosAppContainer(discovery.xcrun, device, bundleId, type);
            if (container.error) return fail(container.error);
            const target = pathInsideContainer(container.containerRoot, remotePath);
            if (target.error) return textResult(false, target.error);
            const containment = ensureContainerPathForWrite(container.containerRoot, target.path);
            if (containment.error) return textResult(false, containment.error);
            copyFileSync(localPath, target.path);
            return jsonResult({
                uploaded: { localPath, remotePath: target.relativePath, bundleId, containerType: type },
                containerRoot: container.containerRoot,
                provider: "simctl-app-container",
            });
        }

        case "device_download": {
            const { deviceId, remotePath, localPath, bundleId, containerType } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!isOwnedSimulatorName(device.simulatorName)) return textResult(false, `Refusing iOS Simulator download for non-owned simulator name: ${device.simulatorName}`);
            if (!bundleId) return textResult(false, "iOS Simulator download requires bundleId to resolve an app container");
            if (!remotePath || !localPath) return textResult(false, "iOS Simulator download requires remotePath and localPath");

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const type = iosContainerType(containerType);
            const container = resolveIosAppContainer(discovery.xcrun, device, bundleId, type);
            if (container.error) return fail(container.error);
            const source = pathInsideContainer(container.containerRoot, remotePath);
            if (source.error) return textResult(false, source.error);
            if (!existsSync(source.path)) return textResult(false, `iOS Simulator download remotePath does not exist in app container: ${source.relativePath}`);
            const containment = ensureContainerPathForRead(container.containerRoot, source.path);
            if (containment.error) return textResult(false, containment.error);
            mkdirSync(dirname(localPath), { recursive: true });
            copyFileSync(source.path, localPath);
            return jsonResult({
                downloaded: { remotePath: source.relativePath, localPath, bundleId, containerType: type },
                containerRoot: container.containerRoot,
                provider: "simctl-app-container",
            });
        }

        case "device_reset": {
            const { deviceId, bundleId, containerType, eraseSimulator = false } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            if (eraseSimulator) {
                if (!isOwnedSimulatorName(device.simulatorName)) {
                    return textResult(false, `Refusing to erase non-owned iOS Simulator name: ${device.simulatorName}`);
                }
                const r = run(discovery.xcrun, ["simctl", "erase", simctlTarget(device)]);
                if (r.status !== 0) return fail(r);
                const updated = updateIosDevice(deviceId, (item) => ({
                    ...item,
                    status: "stopped",
                    bootReady: false,
                    lastReset: { eraseSimulator: true, resetAt: now(), stdout: r.stdout, stderr: r.stderr },
                    updatedAt: now(),
                }));
                return jsonResult({ reset: { eraseSimulator: true }, device: updated, stdout: r.stdout, stderr: r.stderr, provider: "simctl" });
            }

            if (!bundleId) return textResult(false, "iOS Simulator reset requires bundleId or eraseSimulator=true");
            if (!isOwnedSimulatorName(device.simulatorName)) return textResult(false, `Refusing iOS Simulator reset for non-owned simulator name: ${device.simulatorName}`);
            const type = iosContainerType(containerType);
            const container = resolveIosAppContainer(discovery.xcrun, device, bundleId, type);
            if (container.error) return fail(container.error);
            const containment = ensureContainerPathForRead(container.containerRoot, container.containerRoot);
            if (containment.error) return textResult(false, containment.error);
            clearDirectoryContents(container.containerRoot);
            const updated = updateIosDevice(deviceId, (item) => ({
                ...item,
                lastReset: { bundleId, containerType: type, containerRoot: container.containerRoot, resetAt: now() },
                updatedAt: now(),
            }));
            return jsonResult({ reset: { bundleId, containerType: type }, containerRoot: container.containerRoot, device: updated, provider: "simctl-app-container" });
        }

        case "mobile_screenshot": {
            const { deviceId } = args;
            return handleIosTool("device_screenshot", { deviceId });
        }

        case "mobile_session_status": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return jsonResult(iosAppiumStatus(device));
        }

        case "mobile_dump_ui": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const session = await ensureIosAppiumSession(deviceId);
            if (session.unknown) return undefined;
            if (session.error) return textResult(false, session.error);

            const source = await fetchJson(`${session.serverUrl}/session/${session.sessionId}/source`, { method: "GET" });
            return jsonResult({
                provider: "appium-xcuitest",
                source: source?.value ?? source?.source ?? source,
                sessionId: session.sessionId,
                serverUrl: session.serverUrl,
            });
        }

        case "mobile_open_url": {
            const { deviceId, url } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const r = run(discovery.xcrun, ["simctl", "openurl", simctlTarget(device), url]);
            return r.status === 0 ? jsonResult({ openedUrl: url, provider: "simctl", stdout: r.stdout, stderr: r.stderr }) : fail(r);
        }

        case "device_install_app": {
            const { deviceId, path } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const r = run(discovery.xcrun, ["simctl", "install", simctlTarget(device), path]);
            return r.status === 0 ? jsonResult({ installed: path, stdout: r.stdout, stderr: r.stderr }) : fail(r);
        }

        case "mobile_install_app": {
            const { deviceId, path } = args;
            return handleIosTool("device_install_app", { deviceId, path });
        }

        case "device_launch_app": {
            const { deviceId, bundleId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const r = run(discovery.xcrun, ["simctl", "launch", simctlTarget(device), bundleId]);
            return r.status === 0 ? jsonResult({ launched: bundleId, stdout: r.stdout, stderr: r.stderr }) : fail(r);
        }

        case "mobile_launch_app": {
            const { deviceId, bundleId } = args;
            return handleIosTool("device_launch_app", { deviceId, bundleId });
        }

        case "mobile_uninstall_app":
        case "mobile_stop_app":
        case "mobile_clear_app_data": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return unsupportedMobileResult(name);
        }

        case "mobile_grant_permission":
        case "mobile_revoke_permission": {
            const { deviceId, bundleId, service } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!bundleId || !service) return textResult(false, `iOS Simulator ${name} requires bundleId and service`);

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const action = name === "mobile_grant_permission" ? "grant" : "revoke";
            const r = run(discovery.xcrun, ["simctl", "privacy", simctlTarget(device), action, service, bundleId]);
            return r.status === 0 ? jsonResult({ permission: { bundleId, service, action }, stdout: r.stdout, stderr: r.stderr, provider: "simctl" }) : fail(r);
        }

        case "mobile_set_location": {
            const { deviceId, latitude, longitude } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const r = run(discovery.xcrun, ["simctl", "location", simctlTarget(device), "set", `${latitude},${longitude}`]);
            return r.status === 0 ? jsonResult({ location: { latitude, longitude }, stdout: r.stdout, stderr: r.stderr, provider: "simctl" }) : fail(r);
        }

        case "mobile_set_clipboard": {
            const { deviceId, text } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const r = runWithInput(discovery.xcrun, ["simctl", "pbcopy", simctlTarget(device)], String(text));
            return r.status === 0 ? jsonResult({ clipboard: { set: true }, stdout: r.stdout, stderr: r.stderr, provider: "simctl" }) : fail(r);
        }

        case "mobile_get_clipboard": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const r = run(discovery.xcrun, ["simctl", "pbpaste", simctlTarget(device)]);
            return r.status === 0 ? jsonResult({ text: r.stdout, stderr: r.stderr, status: r.status, provider: "simctl" }) : fail(r);
        }

        case "mobile_wait_for_app": {
            const { deviceId, bundleId, timeoutMs, intervalMs } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            if (!bundleId) return textResult(false, "iOS Simulator wait-for-app requires bundleId");

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const result = await waitForIosApp(discovery.xcrun, device, bundleId, timeoutMs, intervalMs);
            return jsonResult({ ...result, bundleId, provider: "simctl" });
        }

        case "mobile_tap":
        case "mobile_double_tap":
        case "mobile_long_press":
        case "mobile_swipe":
        case "mobile_drag":
        case "mobile_type_text":
        case "mobile_key":
        case "mobile_home":
        case "mobile_back":
        case "mobile_forward":
        case "mobile_recents":
        case "mobile_power":
        case "mobile_lock":
        case "mobile_unlock":
        case "mobile_rotate_left":
        case "mobile_rotate_right":
        case "mobile_set_orientation":
        case "mobile_set_battery":
        case "mobile_set_network":
        case "mobile_toggle_airplane_mode":
        case "mobile_wait_for_text": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return unsupportedMobileResult(name);
        }

        default:
            return undefined;
    }
}
