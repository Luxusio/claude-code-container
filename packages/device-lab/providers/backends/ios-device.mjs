import { createIosObservationAccess } from "../application/ios-observation-access.mjs";
import { createIosWirelessApplication } from "../application/ios-wireless.mjs";
import { createIosControlTransfer } from "../application/ios-control-transfer.mjs";
import { createIosAppManagement } from "../application/ios-app-management.mjs";
import { createIosEnvironment } from "../application/ios-environment.mjs";
import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { createPhysicalStopApplication } from "../application/physical-stop.mjs";
import { createWaitBudget } from "../wait-budget.mjs";
import { createHash, randomUUID } from "crypto";
import { spawn } from "child_process";
import { commandPath, run, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult, truncateDiagnosticText } from "../responses.mjs";
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

/** @param {import("../ports/ios-wireless.mjs").IosWirelessDiscovery} [discovery]
 * @returns {import("../ports/ios-wireless.mjs").IosWirelessInventory} */
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

async function stopOwnedAppium(appium, label) { return observationAccess.stopOwnedAppium(appium, label); }

async function ensureIosRealAppiumSession(deviceId) { return observationAccess.ensureSession(deviceId); }

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

export function listIosRealDevices() { return deviceObservation.owned(); }

async function handleIosRealToolUnlocked(name, args) {
    const environment = iosEnvironment.request(name, args);
    if (environment?.kind === "json") return jsonResult(environment.payload);
    if (environment?.kind === "text") return textResult(false, environment.message);
    if (environment?.kind === "command-failure") return fail(environment.command);
    const outcome = await appManagement.request(name, args);
    if (outcome?.kind === "json") return jsonResult(outcome.payload);
    if (outcome?.kind === "text") return textResult(false, outcome.message);
    if (outcome?.kind === "command-failure") return fail(outcome.command);
    const access = await observationAccess.request(name, args);
    if (access !== undefined) return access;
    switch (name) {
        case "device_inventory": { const value=deviceObservation.inventory(args); return value === undefined ? undefined : jsonResult(value); }

        case "device_wireless": {
            const outcome = iosWireless.request(args);
            if (!outcome) return undefined;
            return outcome.kind === "json" ? jsonResult(outcome.payload) : textResult(false, outcome.message);
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

const iosEnvironment = createIosEnvironment({
    variant: "physical",
    device: id => findIosRealDevice(id),
});

const appManagement = createIosAppManagement({
    variant: "physical",
    device: id => findIosRealDevice(id),
    xcrun: () => iosRealDiscovery().xcrun,
    execute: (xcrun, args, timeoutMs) => timeoutMs === undefined ? run(xcrun, args) : runWithTimeout(xcrun, args, timeoutMs),
    session: async id => {
        let session;
        try {
            session = await withOwnerDeviceOperation("ios-device", id, () => ensureIosRealAppiumSession(id));
        } catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== "shared-mutation-lock-timeout") throw error;
            return { kind: "refused", message: `iOS physical Appium operation lock failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        if (session.unknown) return { kind: "unknown" };
        if (session.error) return { kind: "refused", message: session.error };
        return { kind: "ready", session };
    },
    request: (session, path, body) => fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}${path}`, { method: "POST", body: JSON.stringify(body) }),
});

const controlTransfer = createIosControlTransfer({
    kind: "physical",
    findDevice: id => findIosRealDevice(id),
    resolveSession: async id => {
        try {
            return await withOwnerDeviceOperation("ios-device", id, () => ensureIosRealAppiumSession(id));
        } catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== "shared-mutation-lock-timeout") throw error;
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

const iosWireless = createIosWirelessApplication({
    discover: () => iosRealDiscovery(),
    listDevices: discovery => hostIosDevices(discovery),
});

/** @param {string|null} executable @param {number} port
 * @returns {import('../ports/ios-observation-access.mjs').IosAccessChild} */
function spawnObservationAppium(executable, port) {
    const child = spawn(executable, ["server", "--port", String(port), "--base-path", "/"], {
        detached: true, stdio: "ignore", env: process.env, windowsHide: true,
    });
    return {
        pid: child.pid,
        onExit: operation => { child.once("exit", operation); return undefined; },
        unref: () => { child.unref(); return undefined; },
        abortStartup: () => { child.kill("SIGTERM"); return undefined; },
    };
}

/** @type {import('../ports/ios-observation-access.mjs').IosObservationAccessPorts<import('../ports/ios-observation-access.mjs').IosAccessDevice, import('../ports/ios-observation-access.mjs').IosAccessNativeResult>} */
const observationPorts = {
    kind: "physical",
    findDevice: id => findIosRealDevice(id),
    discovery: () => iosRealDiscovery(),
    appiumDiscovery: discovery => iosAppiumDiscovery(discovery),
    backend: discovery => iosRealBackend(discovery),
    targetStatus: device => withTargetStatus(device),
    withDeviceOperation: (id, operation) => withOwnerDeviceOperation("ios-device", id, operation),
    waitBudget: (timeoutMs, intervalMs) => createWaitBudget(timeoutMs, intervalMs),
    requestHttp: (url, options) => fetchIosAppiumJson(url, options),
    spawnServer: spawnObservationAppium,
    inspectRuntime: runtime => inspectProcessIdentity(runtime?.processIdentity, runtime?.pid),
    waitIdentity: (pid, timeoutMs) => waitForProcessIdentity(pid, timeoutMs),
    refreshRuntime: runtime => refreshOwnedRuntimeProcessIdentity(runtime),
    terminateRuntime: (runtime, label) => terminateOwnedAppiumProcess(runtime, label),
    isAlive: pid => processIsAlive(pid),
    publishAppium: (id, expected, replacement, timestamp) => transitionAppiumGeneration(updateIosRealDevice, id, expected, replacement, timestamp),
    updateAppiumPort: (id, runtimeId, port, timestamp) => updateIosRealDevice(id, item => item.appium?.runtimeId === runtimeId
        ? { ...item, appiumPort: port, updatedAt: timestamp } : item),
    timestamp: () => now(),
    runtimeId: () => randomUUID(),
    portForDevice: id => appiumPortForDevice(id),
    pause: milliseconds => sleep(milliseconds),
    diagnostic: (text, maximumBytes) => truncateDiagnosticText(text, maximumBytes),
    jsonResult: value => jsonResult(value),
    textResult: (ok, message) => textResult(ok, message),
    commandFailure: command => fail(command),
    imageResult: data => ({ content: [{ type: "image", data, mimeType: "image/png" }] }),
    hostDevices: discovery => hostIosDevices(discovery).devices,
    refreshLease: (device, budget) => refreshIosRealDeviceLease(device, budget),
    guardObservation: (id, original, session, budget) => { guardIosRealObservation(id, original, session, budget); return undefined; },
    checkObservation: (id, original, session) => { currentIosRealObservationDevice(id, original, session); return undefined; },
};

const observationAccess = createIosObservationAccess(observationPorts);
