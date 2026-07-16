import { createHash, randomUUID } from "crypto";
import { spawn } from "child_process";
import { commandPath, run, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { claimIosRealDevice, findIosRealDevice, readIosRealDevices, transitionIosRealDevice, updateIosRealDevice } from "../state/ios-device-state.mjs";
import { withOwnerDeviceOperation } from "../state/device-store.mjs";
import { requiresOwnerDeviceOperation } from "../state/device-operation-policy.mjs";
import { inspectProcessIdentity, refreshOwnedRuntimeProcessIdentity, signalOwnedRuntimeProcess, terminateOwnedRuntimeProcess, waitForProcessIdentity } from "../state/process-identity.mjs";
import { transitionAppiumGeneration } from "../state/runtime-generation.mjs";
import { claimPhysicalLease, heartbeatPhysicalLease, releasePhysicalLease, startPhysicalLeaseHeartbeat } from "../state/physical-lease-store.mjs";
import { withTargetStatus } from "../status.mjs";
import { fetchIosAppiumJson, iosAppiumDiscovery, iosDiscovery, normalizeIosOrientation } from "./ios-simulator.mjs";

const IOS_REAL_CAPABILITIES = [
    "device_inventory", "device_attach", "device_detach", "device_start", "device_stop",
    "device_status", "device_wireless", "mobile_session_status", "mobile_dump_ui",
    "device_screenshot", "device_install_app", "device_launch_app",
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

function iosRealStateConflict(deviceId, operation, transition) {
    return textResult(false, JSON.stringify({
        ok: false,
        error: "owner-device-state-conflict",
        backend: "ios-device",
        deviceId,
        operation,
        found: transition.found,
    }));
}

function claimIosRealLifecycle(deviceId, device, operation) {
    const lifecycle = { runtimeId: randomUUID(), operation, claimedAt: now() };
    const claimed = { ...device, lifecycle, status: operation === "detach" ? "detaching" : "stopping", updatedAt: now() };
    return { lifecycle, transition: transitionIosRealDevice(deviceId, device, claimed) };
}

function currentIosRealLifecycleDevice(deviceId, lifecycle) {
    const current = findIosRealDevice(deviceId);
    return current?.lifecycle?.runtimeId === lifecycle.runtimeId ? current : null;
}

function abortIosRealLifecycle(deviceId, lifecycle, original) {
    const current = currentIosRealLifecycleDevice(deviceId, lifecycle);
    if (!current) return { matched: false, found: Boolean(findIosRealDevice(deviceId)) };
    const restored = { ...current, status: original.status, updatedAt: now() };
    if (Object.prototype.hasOwnProperty.call(original, "lifecycle")) restored.lifecycle = original.lifecycle;
    else delete restored.lifecycle;
    return transitionIosRealDevice(deviceId, current, restored);
}

function refreshIosRealDeviceLease(device) {
    if (!device?.id || !device?.udid || !device?.leaseClaimId || !device?.leaseClaimNonce) {
        return { ok: false, error: "iOS physical device lease metadata is incomplete; clear stale owner metadata and attach the device again" };
    }
    const refreshed = heartbeatPhysicalLease("ios-device", device.udid, device.id, {
        claimId: device.leaseClaimId,
        claimNonce: device.leaseClaimNonce,
    });
    if (!refreshed.ok) {
        return { ok: false, error: `iOS physical device lease is not owned by this attachment: ${refreshed.error || "lease-conflict"}` };
    }
    return { ok: true, lease: refreshed.lease };
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
            const markers = matches.filter((value) => value !== udid && value !== version);
            const connection = markers.some((value) => /^(network|wifi|wi-fi)$/i.test(value.trim())) ? "wifi" : "usb";
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

function iosWirelessUnsupported(action, details = {}) {
    return textResult(false, JSON.stringify({
        ok: false,
        backend: "ios-device",
        action,
        error: "ios-wireless-pairing-requires-xcode-trust",
        message: "CCC can attach iOS Wi-Fi devices only after Apple trust and Xcode network pairing are already satisfied on the macOS host.",
        attachFlow: "Run device_inventory for backend ios-device, confirm the UDID is visible as a network device through xctrace, then call device_attach with connection=wifi.",
        ...details,
    }, null, 2));
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

function stoppedIosRealDevice(device) {
    return {
        ...device,
        status: "attached",
        pid: null,
        appium: null,
        recording: null,
        updatedAt: now(),
    };
}

async function stopVolatileProcesses(device) {
    signalOwnedRuntimeProcess(device.recording, "SIGINT");
    return stopOwnedAppium(device.appium, "iOS physical Appium");
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

async function terminateOwnedAppiumProcess(appium, label, timeoutMs = 1000) {
    return terminateOwnedRuntimeProcess({ ...appium, pid: appium?.serverPid }, label, { timeoutMs });
}

async function waitForAppium(url) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            await fetchIosAppiumJson(`${url}/status`, { method: "GET", timeoutMs: 1000 });
            return true;
        } catch {
            await sleep(250);
        }
    }
    return false;
}

async function appiumServerReady(appium) {
    if (!appium?.serverUrl) return false;
    try {
        await fetchIosAppiumJson(`${appium.serverUrl}/status`, { method: "GET" });
        return true;
    } catch {
        return false;
    }
}

async function appiumSessionReady(appium) {
    if (!appium?.sessionId || !await appiumServerReady(appium)) return false;
    try {
        await fetchIosAppiumJson(`${appium.serverUrl}/session/${appium.sessionId}`, { method: "GET" });
        return true;
    } catch {
        return false;
    }
}

async function deleteAppiumSession(appium) {
    if (!appium?.serverUrl || !appium?.sessionId) return;
    try {
        await fetchIosAppiumJson(`${appium.serverUrl}/session/${appium.sessionId}`, { method: "DELETE" });
    } catch {
        /* best effort cleanup */
    }
}

async function stopOwnedAppium(appium, label) {
    const ownsProcess = Boolean(appium?.runtimeId
        && appium.processOwner === "device-lab-mcp"
        && appium.startedBy === "direct-provider"
        && appium.serverPid
        && appium.processIdentity);
    if (!ownsProcess) {
        await deleteAppiumSession(appium);
        return { exited: true, signaled: false, reason: "appium-process-identity-missing" };
    }
    const runtime = { ...appium, pid: appium.serverPid };
    const observation = inspectProcessIdentity(runtime.processIdentity, runtime.pid);
    if (observation.status === "exited") return { exited: true, signaled: false, reason: "runtime-process-exited" };
    if (observation.status !== "match") {
        const reason = observation.status === "mismatch"
            ? "runtime-process-identity-mismatch"
            : "runtime-process-identity-unavailable";
        return { exited: false, signaled: false, reason, error: `${label} process identity could not be verified: ${reason}` };
    }
    await deleteAppiumSession(appium);
    return terminateOwnedAppiumProcess(runtime, label);
}

async function ensureIosRealAppiumSession(deviceId) {
    let device = findIosRealDevice(deviceId);
    if (!device) return { unknown: true };
    const lease = refreshIosRealDeviceLease(device);
    if (!lease.ok) return { error: lease.error };

    const discovery = iosAppiumDiscovery();
    if (!discovery.available) {
        return { error: `iOS real-device Appium/XCUITest layer missing prerequisites: ${discovery.missing.join(", ")}` };
    }

    const port = device.appiumPort || appiumPortForDevice(device.id);
    const serverUrl = `http://127.0.0.1:${port}`;

    if (await appiumSessionReady(device.appium)) {
        return { device, serverUrl: device.appium.serverUrl, sessionId: device.appium.sessionId };
    }

    const staleAppium = device.appium ?? null;
    const serverReady = await appiumServerReady(staleAppium);
    const ownedServer = Boolean(staleAppium?.runtimeId
        && staleAppium.processOwner === "device-lab-mcp"
        && staleAppium.startedBy === "direct-provider"
        && staleAppium.serverPid
        && staleAppium.processIdentity);
    const reusableServer = serverReady && !ownedServer;
    if (ownedServer) {
        const stopped = await stopOwnedAppium(staleAppium, "iOS physical stale Appium");
        if (!stopped.exited) return { error: stopped.error };
    }
    const stale = transitionAppiumGeneration(updateIosRealDevice, deviceId, staleAppium, null, now());
    if (!stale.committed && stale.device?.appium != null) {
        return { error: "iOS physical Appium state changed while reconciling a stale session" };
    }
    device = stale.device;

    const runtimeId = randomUUID();
    const child = reusableServer ? null : spawn(discovery.appium, ["server", "--port", String(port), "--base-path", "/"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
        windowsHide: true,
    });
    const processIdentity = child?.pid ? await waitForProcessIdentity(child.pid) : null;
    if (child?.pid && !processIdentity) {
        try { child.kill("SIGTERM"); } catch { /* startup child already exited */ }
        return { error: `iOS physical Appium process identity could not be established on ${serverUrl}` };
    }
    let startupRuntime = child?.pid ? { runtimeId, serverPid: child.pid, pid: child.pid, processIdentity } : null;
    let appium = null;
    if (child) {
        child.once("exit", () => {
            if (appium) transitionAppiumGeneration(updateIosRealDevice, deviceId, appium, null, now());
        });
        child.unref();
    }

    const ready = await waitForAppium(serverUrl);
    if (startupRuntime) startupRuntime = refreshOwnedRuntimeProcessIdentity(startupRuntime);
    if (!ready) {
        if (child?.pid) await terminateOwnedAppiumProcess(startupRuntime, "iOS physical Appium startup");
        return { error: `Appium server did not become ready on ${serverUrl}` };
    }

    let response;
    try {
        response = await fetchIosAppiumJson(`${serverUrl}/session`, {
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
        if (child?.pid) await terminateOwnedAppiumProcess(startupRuntime, "iOS physical Appium startup");
        return { error: `Appium session creation failed: ${error.message}` };
    }
    const sessionId = response?.value?.sessionId || response?.sessionId;
    if (!sessionId) {
        if (child?.pid) await terminateOwnedAppiumProcess(startupRuntime, "iOS physical Appium startup");
        return { error: "Appium did not return a session id" };
    }

    appium = {
        runtimeId,
        authority: "direct-provider",
        processOwner: child ? "device-lab-mcp" : "external",
        startedBy: child ? "direct-provider" : "existing-server",
        serverUrl,
        serverPid: child?.pid ?? null,
        processIdentity: startupRuntime?.processIdentity ?? null,
        sessionId,
        automationName: "XCUITest",
        physical: true,
        updatedAt: now(),
    };
    const committed = transitionAppiumGeneration(updateIosRealDevice, deviceId, null, appium, now());
    if (!committed.committed) {
        await deleteAppiumSession(appium);
        if (child?.pid) await terminateOwnedAppiumProcess(startupRuntime, "iOS physical Appium superseded startup");
        return { error: "iOS physical Appium state changed before the new session was committed" };
    }
    const updated = updateIosRealDevice(deviceId, (item) => item.appium?.runtimeId === runtimeId
        ? { ...item, appiumPort: port, updatedAt: now() }
        : item);
    if (child?.pid && !processIsAlive(child.pid)) {
        transitionAppiumGeneration(updateIosRealDevice, deviceId, appium, null, now());
        return { error: "iOS physical Appium exited before the new session became usable" };
    }

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
    let session;
    try {
        session = await withOwnerDeviceOperation("ios-device", deviceId, () => ensureIosRealAppiumSession(deviceId));
    } catch (error) {
        if (error?.code !== "shared-mutation-lock-timeout") throw error;
        return { result: textResult(false, `iOS physical Appium operation lock failed: ${error instanceof Error ? error.message : String(error)}`) };
    }
    if (session.unknown) return { unknown: true };
    if (session.error) return { result: textResult(false, session.error) };
    return { session };
}

async function postIosRealAppium(deviceId, path, body, provider = "appium-xcuitest") {
    const resolved = await iosRealAppiumSessionOrResult(deviceId);
    if (resolved.unknown || resolved.result) return resolved;
    const { session } = resolved;
    try {
        const response = await fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}${path}`, {
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
        const response = await fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}/source`, { method: "GET" });
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
    return readIosRealDevices().map((device) => withTargetStatus({ ...device, ownerId: ownerId() }));
}

async function handleIosRealToolUnlocked(name, args) {
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

        case "device_wireless": {
            const { backend = "ios-device", action = "status", udid } = args;
            if (backend !== "ios-device") return undefined;
            const discovery = iosRealDiscovery();
            if (!discovery.xcrun) {
                return iosWirelessUnsupported(action, { error: "ios-wireless-missing-xcrun", missing: ["xcrun"] });
            }
            const inventory = hostIosDevices(discovery);
            const devices = inventory.devices || [];
            const selected = udid ? devices.find((device) => device.udid === udid) || null : null;
            if (action === "status") {
                return jsonResult({
                    ok: true,
                    backend,
                    provider: "xcrun-xctrace",
                    supportedActions: ["status"],
                    unsupportedActions: ["pair", "connect", "usb-tcpip"],
                    inventory,
                    udid: udid || null,
                    selected,
                    networkVisible: selected ? selected.connection === "wifi" : devices.some((device) => device.connection === "wifi"),
                    attachFlow: "If the target UDID is visible as a network device, call device_attach with backend=ios-device, udid, and connection=wifi.",
                    notes: [
                        "Apple trust, Developer Mode, and Xcode network pairing must be completed on the macOS host",
                        "CCC does not bypass or automate the Trust This Computer prompt",
                        "Physical-device ownership is still claimed by device_attach or broker attach",
                    ],
                });
            }
            return iosWirelessUnsupported(action, {
                udid: udid || null,
                selected,
                networkVisible: selected ? selected.connection === "wifi" : false,
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
            const leaseClaimNonce = randomUUID();
            const lease = claimPhysicalLease("ios-device", udid, id, { claimNonce: leaseClaimNonce });
            if (!lease.ok) {
                return textResult(false, `iOS UDID is already attached or an attach is in progress: ${udid}`);
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
                leaseClaimId: lease.lease.claimId,
                leaseClaimNonce,
                status: "attached",
                creatable: false,
                attachable: true,
                attachedAt: now(),
                updatedAt: now(),
            };
            let claim;
            try {
                claim = claimIosRealDevice(device);
            } catch (error) {
                releasePhysicalLease("ios-device", udid, id, { claimId: lease.lease.claimId, claimNonce: leaseClaimNonce });
                throw error;
            }
            if (!claim.ok) {
                releasePhysicalLease("ios-device", udid, id, { claimId: lease.lease.claimId, claimNonce: leaseClaimNonce });
                return textResult(false, `Device identity already exists for this owner (${claim.field}: ${claim.value})`);
            }
            startPhysicalLeaseHeartbeat("ios-device", udid, id, { claimId: lease.lease.claimId, claimNonce: leaseClaimNonce });
            return jsonResult({ device: withTargetStatus(device) });
        }

        case "device_detach": {
            const { deviceId } = args;
            const devices = readIosRealDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            const claim = claimIosRealLifecycle(deviceId, device, "detach");
            if (!claim.transition.matched) return iosRealStateConflict(deviceId, "detach-claim", claim.transition);
            const stopped = await stopVolatileProcesses(device);
            if (!stopped.exited) {
                abortIosRealLifecycle(deviceId, claim.lifecycle, device);
                return textResult(false, stopped.error);
            }
            const current = currentIosRealLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) return iosRealStateConflict(deviceId, "detach", { found: Boolean(findIosRealDevice(deviceId)), matched: false });
            const transition = transitionIosRealDevice(deviceId, current, null);
            if (!transition.matched) return iosRealStateConflict(deviceId, "detach", transition);
            releasePhysicalLease("ios-device", device.udid, deviceId, {
                claimId: device.leaseClaimId,
                claimNonce: device.leaseClaimNonce,
            });
            return jsonResult({ detached: deviceId, physicalDevicePoweredOff: false });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device: withTargetStatus(device), started: false, alreadyAttached: true, physicalDevicePoweredOnByMcp: false });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const claim = claimIosRealLifecycle(deviceId, device, "stop");
            if (!claim.transition.matched) return iosRealStateConflict(deviceId, "stop-claim", claim.transition);
            const stopped = await stopVolatileProcesses(device);
            if (!stopped.exited) {
                abortIosRealLifecycle(deviceId, claim.lifecycle, device);
                return textResult(false, stopped.error);
            }
            const current = currentIosRealLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) return iosRealStateConflict(deviceId, "stop", { found: Boolean(findIosRealDevice(deviceId)), matched: false });
            const updated = stoppedIosRealDevice(current);
            delete updated.lifecycle;
            const transition = transitionIosRealDevice(deviceId, current, updated);
            if (!transition.matched) return iosRealStateConflict(deviceId, "stop", transition);
            return jsonResult({ device: withTargetStatus(updated), stopped: false, detached: false, physicalDevicePoweredOff: false });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const discovery = iosRealDiscovery();
            const host = discovery.xcrun ? hostIosDevices(discovery).devices.find((item) => item.udid === device.udid) || null : null;
            return jsonResult({ device: withTargetStatus(device), backend: iosRealBackend(), hostDevice: host, appium: appiumStatus(device) });
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
                source = await fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}/source`, { method: "GET" });
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
                screenshot = await fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}/screenshot`, { method: "GET" });
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
            const r = runWithTimeout(discovery.xcrun, ["devicectl", "device", "install", "app", "--device", device.udid, path], 300_000);
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
            const resolved = normalizeIosOrientation(orientation);
            if (!resolved) return textResult(false, "iOS real-device mobile_set_orientation requires portrait, landscape, reverse-portrait, or reverse-landscape");
            const posted = await postIosRealAppium(deviceId, "/orientation", { orientation: resolved.orientation });
            if (posted.unknown || posted.result?.isError) return posted.result;
            return jsonResult({ ...resolved, provider: "appium-xcuitest", physical: true });
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
                    const response = await fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}/execute/sync`, {
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

export async function handleIosRealTool(name, args) {
    if (!requiresOwnerDeviceOperation("ios-device", name)) return handleIosRealToolUnlocked(name, args);
    const attachesDevice = name === "device_attach";
    const deviceId = typeof args?.deviceId === "string"
        ? args.deviceId
        : attachesDevice && (args?.name || args?.udid)
            ? iosRealDeviceId(args.name || args.udid)
            : null;
    if (!deviceId) return handleIosRealToolUnlocked(name, args);
    if (!attachesDevice && !findIosRealDevice(deviceId)) return handleIosRealToolUnlocked(name, args);
    try {
        return await withOwnerDeviceOperation("ios-device", deviceId, () => {
            if (!attachesDevice) {
                const lease = refreshIosRealDeviceLease(findIosRealDevice(deviceId));
                if (!lease.ok) return textResult(false, lease.error);
            }
            return handleIosRealToolUnlocked(name, args);
        });
    } catch (error) {
        if (error?.code !== "shared-mutation-lock-timeout") throw error;
        return textResult(false, `iOS physical device operation lock failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
