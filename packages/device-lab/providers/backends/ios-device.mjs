import { createIosControlTransfer } from "../application/ios-control-transfer.mjs";
import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { createPhysicalStopApplication } from "../application/physical-stop.mjs";
import { createWaitBudget } from "../wait-budget.mjs";
import { createHash, randomUUID } from "crypto";
import { spawn } from "child_process";
import { commandPath, run, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { claimIosRealDevice, findIosRealDevice, readIosRealDevices, transitionIosRealDevice, updateIosRealDevice } from "../state/ios-device-state.mjs";
import { withOwnerDeviceOperation } from "../state/device-store.mjs";
import { requiresOwnerDeviceOperation } from "../state/device-operation-policy.mjs";
import { inspectProcessIdentity, refreshOwnedRuntimeProcessIdentity, signalOwnedRuntimeProcess, terminateOwnedRuntimeProcess, waitForProcessIdentity } from "../state/process-identity.mjs";
import { appiumGenerationMatches, transitionAppiumGeneration } from "../state/runtime-generation.mjs";
import { claimPhysicalLease, heartbeatPhysicalLease, releasePhysicalLease, releasePhysicalLeaseWithMutation, startPhysicalLeaseHeartbeat } from "../state/physical-lease-store.mjs";
import { withTargetStatus } from "../status.mjs";
import { fetchIosAppiumJson, iosAppiumDiscovery, iosDiscovery } from "./ios-simulator.mjs";

const physicalStop = createPhysicalStopApplication({
    backend: "ios-device",
    find: findIosRealDevice,
    transition: transitionIosRealDevice,
    now,
    runtimeId: randomUUID,
    signalRecording: signalOwnedRuntimeProcess,
    textResult,
    jsonResult,
    withTargetStatus,
    waitRecordingExit: waitForOwnedRuntimeExit,
    stopOwnedAppium,
});

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

export function iosRealBackend(discovery = iosRealDiscovery()) { return deviceObservation.backend(discovery); }

export function iosRealDiscovery(ios = iosDiscovery()) { return deviceObservation.discovery(ios); }

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
    return physicalStop.claimLifecycle(deviceId, device, operation);
}

function currentIosRealLifecycleDevice(deviceId, lifecycle) {
    return physicalStop.currentLifecycleDevice(deviceId, lifecycle);
}

function abortIosRealLifecycle(deviceId, lifecycle, original, actual = {}) {
    return physicalStop.abortLifecycle(deviceId, lifecycle, original, actual);
}

function refreshIosRealDeviceLease(device, waitBudget) {
    if (!device?.id || !device?.udid || !device?.leaseClaimId || !device?.leaseClaimNonce) {
        return { ok: false, error: "iOS physical device lease metadata is incomplete; clear stale owner metadata and attach the device again" };
    }
    const refreshed = heartbeatPhysicalLease("ios-device", device.udid, device.id, {
        claimId: device.leaseClaimId,
        claimNonce: device.leaseClaimNonce,
        waitBudget,
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
        .filter((device) => device !== null);
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

function appiumStatus(device, ios) {
    const discovery = iosAppiumDiscovery(ios);
    return {
        deviceId: device.id,
        appium: discovery,
        session: device.appium || null,
        automationName: "XCUITest",
        lazy: true,
        physical: true,
    };
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOwnedRuntimeExit(runtime, timeoutMs = 3000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
        const observation = inspectProcessIdentity(runtime?.processIdentity, runtime?.pid);
        if (observation.status === "exited" || observation.status === "mismatch") return true;
        if (Date.now() >= deadline) break;
        await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    const finalObservation = inspectProcessIdentity(runtime?.processIdentity, runtime?.pid);
    return finalObservation.status === "exited" || finalObservation.status === "mismatch";
}

function stopVolatileProcesses(device) {
    return physicalStop.cleanup(device);
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

async function appiumSessionReady(appium, serverReady) {
    if (!appium?.sessionId || !serverReady) return false;
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

    const serverReady = await appiumServerReady(device.appium);
    if (await appiumSessionReady(device.appium, serverReady)) {
        return { device, serverUrl: device.appium.serverUrl, sessionId: device.appium.sessionId };
    }

    const staleAppium = device.appium ?? null;
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
    const processIdentity = child?.pid ? await waitForProcessIdentity(child.pid, 1000) : null;
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

    const ready = (reusableServer && staleAppium.serverUrl === serverUrl) || await waitForAppium(serverUrl);
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

function currentIosRealObservationDevice(deviceId, attachment, session) {
    const current = findIosRealDevice(deviceId);
    if (!current || current.udid !== attachment.udid
        || current.leaseClaimId !== attachment.leaseClaimId
        || current.leaseClaimNonce !== attachment.leaseClaimNonce
        || current.lifecycle?.runtimeId !== attachment.lifecycle?.runtimeId
        || !appiumGenerationMatches(session.device?.appium, current.appium)
        || current.appium?.serverUrl !== session.serverUrl
        || current.appium?.sessionId !== session.sessionId) {
        throw new Error("iOS physical attachment or Appium session changed during observation; retry the wait");
    }
    return current;
}

function guardIosRealObservation(deviceId, attachment, session, budget) {
    const current = currentIosRealObservationDevice(deviceId, attachment, session);
    const lease = refreshIosRealDeviceLease(current, budget);
    if (!lease.ok) throw new Error(lease.error);
    currentIosRealObservationDevice(deviceId, attachment, session);
}


function requirePathArg(path, toolName) {
    if (!path) return textResult(false, `iOS real-device ${toolName} requires path`);
    return null;
}

function requireBundleIdArg(bundleId, toolName) {
    if (!bundleId) return textResult(false, `iOS real-device ${toolName} requires bundleId`);
    return null;
}

export function listIosRealDevices() { return deviceObservation.owned(); }

async function handleIosRealToolUnlocked(name, args) {
    switch (name) {
        case "device_inventory": { const value=deviceObservation.inventory(args); return value === undefined ? undefined : jsonResult(value); }


        case "device_wireless": {
            const { backend = "ios-device", action = "status", udid } = args;
            if (backend !== "ios-device") return undefined;
            if (action !== "status") return iosWirelessUnsupported(action, { udid: udid || null });
            const discovery = iosRealDiscovery();
            if (!discovery.xcrun) {
                return iosWirelessUnsupported(action, { error: "ios-wireless-missing-xcrun", missing: ["xcrun"] });
            }
            const inventory = hostIosDevices(discovery);
            if (!inventory.available) return textResult(false, JSON.stringify({
                ok: false, backend, action, error: "ios-wireless-inventory-failed",
                detail: inventory.error || inventory.missing.join(", "),
            }));
            const devices = inventory.devices || [];
            const selected = udid ? devices.find((device) => device.udid === udid) || null : null;
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
                abortIosRealLifecycle(deviceId, claim.lifecycle, device, stopped.recordingStopped
                    ? { recording: { ...device.recording, active: false, endedAt: now() } }
                    : {});
                return textResult(false, stopped.error);
            }
            const current = currentIosRealLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) return iosRealStateConflict(deviceId, "detach", { found: Boolean(findIosRealDevice(deviceId)), matched: false });
            let released;
            try {
                released = releasePhysicalLeaseWithMutation("ios-device", device.udid, deviceId, {
                    claimId: device.leaseClaimId,
                    claimNonce: device.leaseClaimNonce,
                }, () => {
                    const transition = transitionIosRealDevice(deviceId, current, null);
                    if (!transition.matched) return { ok: false, transition };
                    return {
                        ok: true,
                        transition,
                        rollback() {
                            const restored = claimIosRealDevice(current);
                            if (!restored.ok) throw new Error(`ios-device-detach-state-rollback-failed:${restored.error}`);
                        },
                    };
                });
            } catch (error) {
                abortIosRealLifecycle(deviceId, claim.lifecycle, device);
                return textResult(false, `iOS physical device detach could not commit lease release; owner state and physical lease were preserved for retry: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!released.ok) {
                if (released.error === "physical-lease-release-mutation-rejected") {
                    return iosRealStateConflict(deviceId, "detach", released.mutation?.transition || { found: Boolean(findIosRealDevice(deviceId)), matched: false });
                }
                abortIosRealLifecycle(deviceId, claim.lifecycle, device);
                return textResult(false, `iOS physical device detach lease release was rejected (${released.error || "lease-conflict"}); owner state and physical lease were preserved for retry.`);
            }
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
            return physicalStop.stop(deviceId);
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const discovery = iosRealDiscovery();
            const host = discovery.xcrun ? hostIosDevices(discovery).devices.find((item) => item.udid === device.udid) || null : null;
            return jsonResult({ device: withTargetStatus(device), backend: iosRealBackend(discovery), hostDevice: host, appium: appiumStatus(device, discovery) });
        }

        case "mobile_session_status": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ deviceId, ...appiumStatus(device) });
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

        case "mobile_tap":
        case "mobile_double_tap":
        case "mobile_long_press":
        case "mobile_swipe":
        case "mobile_drag":
        case "mobile_type_text":
        case "mobile_key":
        case "mobile_home":
        case "mobile_lock":
        case "mobile_unlock":
        case "mobile_rotate_left":
        case "mobile_rotate_right":
        case "mobile_set_orientation":
            return controlTransfer.handle(name, args);

        case "mobile_wait_for_text": {
            const { deviceId, text, timeoutMs, intervalMs } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            if (!text) return textResult(false, "iOS real-device wait-for-text requires text");
            const resolved = await iosRealAppiumSessionOrResult(deviceId);
            if (resolved.unknown) return undefined;
            if (resolved.result) return resolved.result;
            const { session } = resolved;
            const budget = createWaitBudget(timeoutMs, intervalMs);
            let lastSource = "";
            let observed = false;
            while (budget.remaining() > 0) {
                try {
                    guardIosRealObservation(deviceId, device, session, budget);
                    const allowance = budget.requestTimeout(5000);
                    if (!allowance) throw new Error("Appium observation budget exhausted before request");
                    const response = await fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}/source`, {
                        method: "GET", timeoutMs: allowance,
                    });
                    currentIosRealObservationDevice(deviceId, device, session);
                    if (budget.remaining() <= 0) throw new Error("Appium observation timed out");
                    observed = true;
                    lastSource = String((response?.value ?? response?.source ?? response) || "");
                    if (lastSource.includes(text)) return jsonResult({ found: true, text, source: lastSource, provider: "appium-xcuitest", physical: true });
                } catch (error) {
                    return textResult(false, `Appium source request failed: ${error.message}`);
                }
                await budget.pause();
            }
            if (!observed) return textResult(false, "Appium observation budget exhausted before request");
            return jsonResult({ found: false, text, source: lastSource, timeoutMs: budget.timeoutMs, provider: "appium-xcuitest", physical: true });
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
            const budget = createWaitBudget(timeoutMs, intervalMs);
            let lastActiveApp = null;
            let observed = false;
            while (budget.remaining() > 0) {
                try {
                    guardIosRealObservation(deviceId, device, session, budget);
                    const allowance = budget.requestTimeout(5000);
                    if (!allowance) throw new Error("Appium observation budget exhausted before request");
                    const response = await fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}/execute/sync`, {
                        method: "POST",
                        timeoutMs: allowance,
                        body: JSON.stringify({ script: "mobile: activeAppInfo", args: [] }),
                    });
                    currentIosRealObservationDevice(deviceId, device, session);
                    if (budget.remaining() <= 0) throw new Error("Appium observation timed out");
                    observed = true;
                    lastActiveApp = response?.value ?? response;
                    if (lastActiveApp?.bundleId === bundleId || lastActiveApp?.bundleID === bundleId) {
                        return jsonResult({ found: true, bundleId, activeApp: lastActiveApp, provider: "appium-xcuitest", physical: true });
                    }
                } catch (error) {
                    return textResult(false, `iOS real-device Appium active app request failed: ${error.message}`);
                }
                await budget.pause();
            }
            if (!observed) return textResult(false, "Appium observation budget exhausted before request");
            return jsonResult({ found: false, bundleId, activeApp: lastActiveApp, timeoutMs: budget.timeoutMs, provider: "appium-xcuitest", physical: true });
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

const deviceObservation = createDeviceObservation({ kind: "ios-device", ownerId: () => ownerId(), now: () => Date.now(), readPhysicalLeases: backend => observationPhysicalLeases(backend), capabilities: IOS_REAL_CAPABILITIES, simulatorPrerequisites: () => iosDiscovery(), executable: name => commandPath(name), records: () => readIosRealDevices(), hostResult: xcrun => { const result = run(xcrun, ["xctrace", "list", "devices"]); return { ...result, devices: result.status === 0 ? parseXctraceDevices(result.stdout) : [] }; } });

const controlTransfer = createIosControlTransfer({
    kind: "physical",
    findDevice: id => findIosRealDevice(id),
    resolveSession: async id => {
        try {
            return await withOwnerDeviceOperation("ios-device", id, () => ensureIosRealAppiumSession(id));
        } catch (error) {
            if (error?.code !== "shared-mutation-lock-timeout") throw error;
            return { error: `iOS physical Appium operation lock failed: ${error instanceof Error ? error.message : String(error)}` };
        }
    },
    requestSession: (session, path, body) => fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
    }),
    jsonResult: value => jsonResult(value),
    textResult: (ok, message) => textResult(ok, message),
});
