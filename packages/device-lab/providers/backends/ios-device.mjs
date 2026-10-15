import { performIosControl } from "../adapters/ios-control-transfer.mjs";
import { createIosPhysicalAttachment } from "../adapters/physical-attachment.mjs";
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
import { fetchIosAppiumJson, performIosAppiumEffect, iosAppiumDiscovery, iosDiscovery } from "./ios-simulator.mjs";

const physicalStop = createPhysicalStopApplication({
    backend: "ios-device",
    find: findIosRealDevice,
    transition: transitionIosRealDevice,
    now,
    runtimeId: randomUUID,
    signalRecording: signalOwnedRuntimeProcess,
    waitRecordingExit: waitForOwnedRuntimeExit,
    stopOwnedAppium,
});

const physicalAttachment = createIosPhysicalAttachment({
    readDevices:readIosRealDevices,findDevice:findIosRealDevice,claimDevice:claimIosRealDevice,transitionDevice:transitionIosRealDevice,
    owner:ownerId,deviceId:iosRealDeviceId,appiumPort:appiumPortForDevice,now,nonce:randomUUID,stop:physicalStop,
    claimLease:claimPhysicalLease,releaseLease:releasePhysicalLease,startHeartbeat:startPhysicalLeaseHeartbeat,releaseWithMutation:releasePhysicalLeaseWithMutation,
    discover:iosRealDiscovery,inventory:hostIosDevices,
});

/** @param {kind:string} outcome */


/** @param {import('../ports/physical-attachment.mjs').AttachmentOutcome} outcome */
function presentAttachment(outcome) {
    if (outcome.kind === 'missing') return undefined;
    if (outcome.kind === 'error') return textResult(false,outcome.message);
    if (outcome.kind === 'command-failure') return fail(outcome.command);
    if (outcome.kind === 'conflict') return textResult(false,JSON.stringify({ok:false,error:'owner-device-state-conflict',backend:outcome.backend,deviceId:outcome.deviceId,operation:outcome.operation,found:outcome.found}));
    if (outcome.kind === 'attached') return jsonResult({device:withTargetStatus(outcome.device)});
    return jsonResult({detached:outcome.deviceId,physicalDevicePoweredOff:false});
}

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

async function stopOwnedAppium(appium, label) { return createObservationAccess().stopOwnedAppium(appium, label); }

async function ensureIosRealAppiumSession(deviceId) { return createObservationAccess().ensureSession(deviceId); }

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
    if (environment?.kind === "refused") return textResult(false, environment.message);
    const outcome = await createAppManagement().request(name, args);
    if (outcome?.kind === "json") return jsonResult(outcome.payload);
    if (outcome?.kind === "text") return textResult(false, outcome.message);
    if (outcome?.kind === "command-failure") return fail(outcome.command);
    const access = await createObservationAccess().request(name, args);
    if (access !== undefined) return access;
    switch (name) {
        case "device_inventory": { const value=deviceObservation.inventory(args); return value === undefined ? undefined : jsonResult(value); }

        case "device_wireless": {
            const outcome = iosWireless.request(args);
            if (!outcome) return undefined;
            return outcome.kind === "json" ? jsonResult(outcome.payload) : textResult(false, outcome.message);
        }

        case "device_attach":
            return presentAttachment(physicalAttachment.attach(args));
        case "device_detach":
            return presentAttachment(await physicalAttachment.detach(args.deviceId));

        case "device_start": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device: withTargetStatus(device), started: false, alreadyAttached: true, physicalDevicePoweredOnByMcp: false });
        }

        case "device_stop": {
            const { deviceId } = args;
            const outcome = await physicalStop.stop(deviceId);
            if (outcome.kind === "missing") return undefined;
            if (outcome.kind === "failure") return textResult(false, outcome.error);
            if (outcome.kind === "conflict") return textResult(false, JSON.stringify({
                ok: false, error: "owner-device-state-conflict", backend: outcome.backend,
                deviceId: outcome.deviceId, operation: outcome.operation, found: outcome.found,
            }));
            return jsonResult({ device: withTargetStatus(outcome.device), stopped: false, detached: false, physicalDevicePoweredOff: false });
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
            return presentIosNativeOutcome(await controlTransfer.handle(name, args));










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

const deviceObservation = createDeviceObservation({ kind: "ios-device", ownerId: () => ownerId(), now: () => Date.now(), readPhysicalLeases: backend => observationPhysicalLeases(backend), capabilities: IOS_REAL_CAPABILITIES, simulatorPrerequisites: () => iosDiscovery(), executable: name => commandPath(name), records: () => readIosRealDevices(), hostDevices: xcrun => hostIosDevices({ xcrun }) });

const iosEnvironment = createIosEnvironment({
    variant: "physical",
    device: id => findIosRealDevice(id),
});

function createAppManagement() {
    /** @type {string|null} */
    let xcrun = null;
    return createIosAppManagement({
        variant: "physical",
        device: id => findIosRealDevice(id),
        available: () => { xcrun = iosRealDiscovery().xcrun; return Boolean(xcrun); },
        perform: (device, effect) => {
            const args = effect.kind === "install" ? ["devicectl", "device", "install", "app", "--device", device.udid, effect.path]
                : ["devicectl", "device", "process", "launch", "--device", device.udid, effect.bundleId];
            const command = effect.kind === "install" ? runWithTimeout(xcrun, args, 300000) : run(xcrun, args);
            return { kind: command.status === 0 ? "succeeded" : "failed", command };
        },
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
        terminateApp: async (session, bundleId) => {
            try {
                await fetchIosAppiumJson(`${session.serverUrl}/session/${session.sessionId}/execute/sync`, { method: "POST", body: JSON.stringify({ script: "mobile: terminateApp", args: [{ bundleId }] }) });
                return { kind: "succeeded" };
            } catch (error) { return { kind: "failed", message: error !== null && typeof error === "object" && "message" in error ? String(error.message) : String(error) }; }
        },
    });
}

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
    performControl: (session, command) => performIosControl(fetchIosAppiumJson, session, command),
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

function createObservationAccess() {
    /** @type {string|null} */
    let appium = null;
    /** @type {import('../ports/ios-observation-access.mjs').IosObservationAccessPorts<import('../ports/ios-observation-access.mjs').IosAccessDevice, import('../responses.mjs').IosAccessNativeResult>} */
    const observationPorts = {
        kind: "physical",
        findDevice: id => findIosRealDevice(id),
        discovery: () => iosRealDiscovery(),
        appiumDiscovery: discovery => {
            const observed = iosAppiumDiscovery(/** @type {ReturnType<typeof iosDiscovery>|undefined} */ (discovery));
            appium = observed.appium;
            return observed;
        },
        backend: discovery => iosRealBackend(/** @type {ReturnType<typeof iosRealDiscovery>} */ (discovery)),
        targetStatus: device => withTargetStatus(device),
        withDeviceOperation: (id, operation) => withOwnerDeviceOperation("ios-device", id, operation),
        waitBudget: (timeoutMs, intervalMs) => createWaitBudget(timeoutMs, intervalMs),
        appiumEffect: performIosAppiumEffect,
        spawnServer: port => spawnObservationAppium(appium, port),
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
        serverUrlForPort: port => `http://127.0.0.1:${port}`,
        portForDevice: id => appiumPortForDevice(id),
        pause: milliseconds => sleep(milliseconds),
        diagnostic: (text, maximumBytes) => truncateDiagnosticText(text, maximumBytes),
        jsonResult: value => jsonResult(value),
        textResult: (ok, message) => textResult(ok, message),
        commandFailure: command => fail(command),
        imageResult: data => ({ content: [{ type: "image", data, mimeType: "image/png" }] }),
        hostDevices: discovery => hostIosDevices(/** @type {ReturnType<typeof iosRealDiscovery>} */ (discovery)).devices,
        refreshLease: (device, budget) => refreshIosRealDeviceLease(device, budget),
        guardObservation: (id, original, session, budget) => { guardIosRealObservation(id, original, session, budget); return undefined; },
        checkObservation: (id, original, session) => { currentIosRealObservationDevice(id, original, session); return undefined; },
    };

    return createIosObservationAccess(observationPorts);
}

function presentIosNativeOutcome(outcome) {
    if (outcome === undefined) return undefined;
    if (outcome.kind === "json") return jsonResult(outcome.payload);
    if (outcome.kind === "command-failure") return fail(outcome.receipt);
    return textResult(false,outcome.message);
}
