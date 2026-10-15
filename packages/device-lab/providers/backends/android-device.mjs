import { dumpAndroidUi, readAndroidUi, observeAndroidApp, presentAndroidTextWait, presentAndroidAppWait } from "./android-wait.mjs";
import { createDirectRecording } from "../adapters/direct-recording.mjs";
import { recordingInputError } from "../domain/direct-recording.mjs";
import { createAndroidPhysicalAttachment } from "../adapters/physical-attachment.mjs";
import { createAndroidEnvironment } from "../application/android-environment.mjs";
import { createAndroidAppManagement } from "../application/android-app-management.mjs";
import { createAndroidControlTransfer } from "../application/android-control-transfer.mjs";
import { androidControlObservation, androidNavigationKey, androidRotationCode, presentAndroidControlOutcome as renderAndroidControlOutcome } from "../adapters/android-control-transfer.mjs";
import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { createPhysicalStopApplication } from "../application/physical-stop.mjs";
import { createAndroidWirelessApplication } from "../application/android-wireless.mjs";
import { androidWifiSerial, androidWifiTransport } from "../domain/android-wireless.mjs";
import { androidHostDevices } from "../adapters/mobile-inventory.mjs";
import { createAndroidDeviceAccess } from "../application/android-device-access.mjs";
import { createWaitBudget } from "../wait-budget.mjs";
import { createHash, randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { androidDiscovery, appiumDiscovery, performAndroidAppEffect, presentAndroidAppOutcome, androidEnvironmentObservation, presentAndroidEnvironmentOutcome, observeAndroidScreenshot } from "./android.mjs";
import { run, runBuffer, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { validateGuestPath, validateLocalOutputPath } from "../policy/files.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { claimAndroidRealDevice, findAndroidRealDevice, readAndroidRealDevices, transitionAndroidRealDevice, updateAndroidRealDevice } from "../state/android-device-state.mjs";
import { withOwnerDeviceOperation } from "../state/device-store.mjs";
import { requiresOwnerDeviceOperation } from "../state/device-operation-policy.mjs";
import { signalOwnedRuntimeProcess } from "../state/process-identity.mjs";
import { claimPhysicalLease, heartbeatPhysicalLease, releasePhysicalLease, releasePhysicalLeaseWithMutation, startPhysicalLeaseHeartbeat } from "../state/physical-lease-store.mjs";
import { withTargetStatus } from "../status.mjs";
import { commitLocalOutputStage, createLocalOutputStage, stageLocalInputFile } from "../transfer-file.mjs";

/** Produce bounded evidence before any public consumption; pair credentials never enter it.
 * @param {string[]} args @param {import('../ports/android-wireless.mjs').AndroidWirelessCommandResult} result
 * @param {string} [pairingCode] @returns {import('../ports/android-wireless.mjs').AndroidWirelessEvidence} */
function wirelessEvidence(args, result, pairingCode) {
    /** @param {string|undefined} value */
    const redact = value => pairingCode ? value?.split(pairingCode).join("[redacted]") : value;
    return {
        provider: "adb",
        args: args.map((value, index) => pairingCode
            ? index === 2 ? "[redacted]" : value.split(pairingCode).join("[redacted]")
            : value),
        status: result.status,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
        signal: result.signal || null,
        error: redact(result.error?.message) || null,
    };
}
/** @type {import('../ports/android-wireless.mjs').AndroidWirelessPorts<{adb:string}>} */
const androidWirelessPorts = {
    discover() {
        const discovery = androidDiscovery();
        return discovery.adb ? { available: true, target: { adb: discovery.adb } } : { available: false };
    },
    listDevices: target => androidHostDevices(run(target.adb, ["devices", "-l"])),
    tcpip(target, serial, port, timeoutMs) {
        const args = ["-s", serial, "tcpip", String(port)];
        const result = runWithTimeout(target.adb, args, Math.max(1, Math.min(Number(timeoutMs || 15000), 30000)));
        return { ok: result.status === 0, evidence: wirelessEvidence(args, result) };
    },
    pair(target, endpoint, code, timeoutMs) {
        const pairingCode = String(code);
        const args = ["pair", endpoint, pairingCode];
        try {
            const result = runWithTimeout(target.adb, args, Math.max(1, Math.min(Number(timeoutMs || 15000), 30000)));
            return { ok: result.status === 0, evidence: wirelessEvidence(args, result, pairingCode) };
        } catch {
            // Argument-validation exceptions can include the credential in their stack.
            return { ok: false, evidence: wirelessEvidence(args, {
                status: null, stdout: "", stderr: "",
                error: { message: "android-wireless-pair-command-failed" },
            }, pairingCode) };
        }
    },
    connect(target, endpoint, timeoutMs) {
        const args = ["connect", endpoint];
        const result = runWithTimeout(target.adb, args, Math.max(1, Math.min(Number(timeoutMs || 15000), 30000)));
        return { ok: result.status === 0, evidence: wirelessEvidence(args, result) };
    },
};
const androidWireless = createAndroidWirelessApplication(androidWirelessPorts);

/** @param {import('../ports/android-wireless.mjs').AndroidWirelessOutcome|undefined} outcome */
function presentWireless(outcome) {
    if (!outcome) return undefined;
    if (outcome.kind === "status") return jsonResult({
        ok: true,
        backend: "android-device",
        provider: "adb",
        actions: ["status", "usb-tcpip", "pair", "connect"],
        hostDevices: outcome.hostDevices,
        notes: [
            "usb-tcpip requires a USB-connected Android device already trusted by adb",
            "pair requires an Android 11+ wireless debugging pairing host, port, and pairing code",
            "device_attach still claims the owner-scoped physical lease after the transport is visible",
        ],
    });
    const preparation = outcome.preparation ? { [outcome.preparation.kind]: outcome.preparation.evidence } : {};
    if (outcome.kind === "refused") return textResult(false, JSON.stringify({
        ok: false, error: outcome.error, ...outcome.detail, ...preparation,
    }, null, 2));
    if (outcome.kind === "command-failed") return textResult(false, JSON.stringify({
        ok: false, error: outcome.error, ...preparation, command: outcome.evidence,
    }, null, 2));
    return jsonResult({
        ok: true, backend: "android-device", action: outcome.action,
        ...(outcome.serial === undefined ? {} : { serial: outcome.serial }),
        ...(outcome.pairTarget === undefined ? {} : { pairTarget: outcome.pairTarget }),
        ...(outcome.target === undefined ? {} : { target: outcome.target }),
        ...preparation,
        ...(outcome.connection ? { connect: outcome.connection } : {}),
        stateMutated: false,
        ...(outcome.attachNext === undefined ? {} : { attachNext: outcome.attachNext }),
    });
}

const ANDROID_SCREENSHOT_TIMEOUT_MS = 30_000;
const ANDROID_SCREENSHOT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const ANDROID_TRANSFER_TIMEOUT_MS = 300_000;
const ANDROID_HELPER_MAX_TIMEOUT_MS = 300_000;

const physicalStop = createPhysicalStopApplication({
    backend: "android-device",
    find: findAndroidRealDevice,
    transition: transitionAndroidRealDevice,
    now,
    runtimeId: randomUUID,
    signalRecording: signalOwnedRuntimeProcess,
    discoverAdb: () => androidDiscovery().adb,
    stopAdbRecording(adb, serial) {
        // The selected native runner uses default UTF-8.
        const result = /** @type {{status:number|null,stdout:string,stderr:string}} */ (run(adb, ["-s", serial, "shell", "pkill", "-2", "screenrecord"]));
        return { ok: result.status === 0, detail: result.stderr || result.stdout || `exit ${result.status}` };
    },
    waitRecordingExit: waitForProcessExit,
});

const physicalAttachment = createAndroidPhysicalAttachment({
    readDevices:readAndroidRealDevices,findDevice:findAndroidRealDevice,claimDevice:claimAndroidRealDevice,transitionDevice:transitionAndroidRealDevice,
    owner:ownerId,deviceId:androidRealDeviceId,appiumPort:appiumPortForDevice,now,nonce:randomUUID,stop:physicalStop,
    claimLease:claimPhysicalLease,releaseLease:releasePhysicalLease,startHeartbeat:startPhysicalLeaseHeartbeat,releaseWithMutation:releasePhysicalLeaseWithMutation,
    discover:androidDiscovery,inventory:hostAndroidDevices,wifiSerial:androidWifiSerial,wifiTransport:androidWifiTransport,run,
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

const ANDROID_REAL_CAPABILITIES = [
    "device_list_files",
    "device_inventory", "device_attach", "device_detach", "device_start", "device_stop",
    "device_status", "device_wireless", "device_exec", "device_screenshot",
    "device_record_video_start", "device_record_video_stop", "device_record_video_status",
    "device_upload", "device_download",
    "device_install_app", "device_launch_app",
    "mobile_session_status", "mobile_dump_ui", "mobile_tap",
    "mobile_double_tap", "mobile_long_press", "mobile_swipe",
    "mobile_drag", "mobile_type_text", "mobile_key", "mobile_home",
    "mobile_back", "mobile_forward", "mobile_recents", "mobile_power",
    "mobile_lock", "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right",
    "mobile_set_orientation", "mobile_open_url", "mobile_install_app",
    "mobile_launch_app", "mobile_uninstall_app", "mobile_stop_app",
    "mobile_clear_app_data", "mobile_grant_permission", "mobile_revoke_permission",
    "mobile_set_clipboard", "mobile_get_clipboard", "mobile_wait_for_text",
    "mobile_wait_for_app", "mobile_screenshot",
];
const ANDROID_REAL_DEVICE_ID_TOOLS = new Set(ANDROID_REAL_CAPABILITIES.filter((name) => ![
    "device_inventory",
    "device_attach",
    "device_wireless",
].includes(name)));

export function androidRealBackend(discovery = androidDiscovery()) { return deviceObservation.backend(discovery); }

function now() {
    return new Date().toISOString();
}

function androidRealStateConflict(deviceId, operation, transition) {
    return textResult(false, JSON.stringify({
        ok: false,
        error: "owner-device-state-conflict",
        backend: "android-device",
        deviceId,
        operation,
        found: transition.found,
    }));
}

function claimAndroidRealLifecycle(deviceId, device, operation) {
    return physicalStop.claimLifecycle(deviceId, device, operation);
}

function currentAndroidRealLifecycleDevice(deviceId, lifecycle) {
    return physicalStop.currentLifecycleDevice(deviceId, lifecycle);
}

function abortAndroidRealLifecycle(deviceId, lifecycle, original) {
    return physicalStop.abortLifecycle(deviceId, lifecycle, original);
}

/** @returns {{ok:true,lease:object}|{ok:false,error:string}} */
function refreshAndroidRealDeviceLease(device) {
    if (!device?.id || !device?.serial || !device?.leaseClaimId || !device?.leaseClaimNonce) {
        return { ok: false, error: "Android physical device lease metadata is incomplete; clear stale owner metadata and attach the device again" };
    }
    const refreshed = heartbeatPhysicalLease("android-device", device.serial, device.id, {
        claimId: device.leaseClaimId,
        claimNonce: device.leaseClaimNonce,
    });
    if (!refreshed.ok) {
        return { ok: false, error: `Android physical device lease is not owned by this attachment: ${refreshed.error || "lease-conflict"}` };
    }
    return { ok: true, lease: refreshed.lease };
}

function androidRealDeviceId(nameOrSerial) {
    return `android-device-${slug(nameOrSerial)}`;
}

function appiumPortForDevice(id) {
    const hash = createHash("sha256").update(`${ownerId()}:android-device:${id}`).digest();
    return 24000 + (hash.readUInt16BE(0) % 8000);
}

function androidRealRecordingDir(device) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), "android-device", device.id, "recordings");
}

function androidRealRecordingLocalPath(device) {
    return join(androidRealRecordingDir(device), `recording-${Date.now()}.mp4`);
}

function hostAndroidDevices(discovery = androidDiscovery()) {
    if (!discovery.adb) return { available: false, missing: ["adb"], devices: [] };
    const r = run(discovery.adb, ["devices", "-l"]);
    return androidHostDevices(r);
}

function targetSerial(device) {
    return device.serial;
}

function adbArgsForDevice(device, args) {
    return ["-s", targetSerial(device), ...args];
}



function ensureAdbDevice(deviceId) {
    const device = findAndroidRealDevice(deviceId);
    if (!device) return { unknown: true };
    const lease = refreshAndroidRealDeviceLease(device);
    if (!lease.ok) return { error: lease.error };
    const discovery = androidDiscovery();
    if (!discovery.adb) return { error: "Android real-device backend missing prerequisites: adb" };
    return { device, adb: discovery.adb };
}

function adbTargetResult(target) {
    if (target.unknown) return undefined;
    if (target.error) return textResult(false, target.error);
    return null;
}

function backendHintAllows(args, backend) {
    return !args?.backend || args.backend === backend;
}

function androidHelperTimeoutMs(value, fallback = ANDROID_TRANSFER_TIMEOUT_MS) {
    const requested = Number(value);
    if (!Number.isFinite(requested) || requested <= 0) return fallback;
    return Math.min(ANDROID_HELPER_MAX_TIMEOUT_MS, Math.max(1, Math.trunc(requested)));
}

function runAdbDeviceCommand(device, adb, args, options = {}) {
    const r = options.timeoutMs
        ? runWithTimeout(adb, adbArgsForDevice(device, args), androidHelperTimeoutMs(options.timeoutMs))
        : run(adb, adbArgsForDevice(device, args));
    return r.status === 0
        ? { ok: true, stdout: r.stdout, stderr: r.stderr, status: r.status }
        : { ok: false, result: r };
}

function adbJsonResult(device, adb, args, payload, options = {}) {
    const r = runAdbDeviceCommand(device, adb, args, options);
    return r.ok ? jsonResult({ ...payload, stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r.result);
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

/** @type {import("../ports/direct-recording.mjs").DirectRecordingNative} */
const androidRealRecordingNative = {
    kind: "android-device",
    findDevice: id => findAndroidRealDevice(id),
    updateDevice: (id, update) => updateAndroidRealDevice(id, update),
    localPath: device => androidRealRecordingLocalPath(device),
    validateLocalOutputPath: (path, options) => validateLocalOutputPath(path, options),
    recordingDirectory: device => androidRealRecordingDir(device),
    resolveTarget(device) {
        const selected = ensureAdbDevice(device.id);
        if (selected.unknown) return { kind: "missing" };
        if (selected.error) return { kind: "failure", message: selected.error };
        return {
            kind: "ready",
            device: selected.device,
            target: { kind: "adb", executable: selected.adb, prefix: adbArgsForDevice(selected.device, []) },
        };
    },
    runCommand: command => command.timeoutMs === undefined
        ? run(command.executable, command.args)
        : runWithTimeout(command.executable, command.args, command.timeoutMs),
};
const androidRealRecording = createDirectRecording(androidRealRecordingNative);

/** @param {import("../domain/direct-recording.mjs").RecordingOutcome|undefined} outcome */
function presentAndroidRealRecording(outcome) {
    if (!outcome || outcome.kind === "missing") return undefined;
    if (outcome.kind === "failure") return textResult(false, outcome.message);
    if (outcome.kind === "native") return outcome.value;
    return jsonResult(outcome.value);
}

function stopVolatileProcesses(device, adb) {
    return physicalStop.cleanup(device, adb);
}

export function listAndroidRealDevices() { return deviceObservation.owned(); }

/** @typedef {ReturnType<typeof ensureAdbDevice>} AndroidControlTarget */
/** @typedef {ReturnType<typeof stageLocalInputFile>} AndroidControlInputStage */
/** @typedef {ReturnType<typeof createLocalOutputStage>} AndroidControlOutputStage */
/**
 * Project the native result while retaining the original allocated stage handle.
 * @template {AndroidControlInputStage | AndroidControlOutputStage} Stage
 * @param {Stage} stage
 * @returns {import('../ports/android-control-transfer.mjs').StageObservation<Stage>}
 */
function androidControlStageObservation(stage) {
    if (stage.ok && "cleanup" in stage && typeof stage.cleanup === "function"
        && "path" in stage && typeof stage.path === "string"
        && "stagedPath" in stage && typeof stage.stagedPath === "string") {
        return { ok: true, path: stage.path, stagedPath: stage.stagedPath, handle: stage };
    }
    if ("message" in stage && typeof stage.message === "string") {
        return { ok: false, message: stage.message };
    }
    throw new Error("Invalid native Android transfer stage result");
}

/** @param {ReturnType<typeof validateGuestPath> | ReturnType<typeof commitLocalOutputStage>} result
 * @returns {import('../ports/android-control-transfer.mjs').PathObservation} */
function androidControlPathObservation(result) {
    if (result.ok && "path" in result && typeof result.path === "string") {
        return { ok: true, path: result.path };
    }
    if ("message" in result && typeof result.message === "string") {
        return { ok: false, message: result.message };
    }
    throw new Error("Invalid native Android transfer path result");
}

/** @param {AndroidControlInputStage | AndroidControlOutputStage} stage @returns {undefined} */
function disposeAndroidControlStage(stage) {
    if ("cleanup" in stage && typeof stage.cleanup === "function") {
        stage.cleanup();
        return undefined;
    }
    throw new Error("Invalid native Android transfer stage handle");
}

/** @type {import('../ports/android-control-transfer.mjs').AndroidControlTransferPorts<AndroidControlTarget,AndroidControlInputStage,AndroidControlOutputStage>} */
const androidControlTransferPorts = {
    target(deviceId) {
        const target = ensureAdbDevice(deviceId);
        if (target.unknown) return { kind: "unknown" };
        if (target.error) return { kind: "refused", message: target.error };
        return { kind: "ready", target };
    },
    tap: (target, point) => androidControlObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "input", "tap", String(point.x), String(point.y)]))),
    swipe: (target, swipe) => androidControlObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "input", "swipe", String(swipe.x1), String(swipe.y1), String(swipe.x2), String(swipe.y2), String(swipe.durationMs)]))),
    typeText: (target, text) => androidControlObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "input", "text", String(text).replace(/\s/g, "%s")]))),
    key: (target, key) => androidControlObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "input", "keyevent", String(key)]))),
    navigate: (target, navigation) => androidControlObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "input", "keyevent", String(androidNavigationKey(navigation))]))),
    disableAutoRotation: target => androidControlObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "settings", "put", "system", "accelerometer_rotation", "0"]))),
    setOrientation: (target, orientation) => androidControlObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "settings", "put", "system", "user_rotation", androidRotationCode(orientation)]))),
    upload: (target, localPath, remotePath, timeoutMs) => androidControlObservation(runWithTimeout(target.adb, adbArgsForDevice(target.device, ["push", localPath, remotePath]), timeoutMs)),
    download: (target, remotePath, localPath, timeoutMs) => androidControlObservation(runWithTimeout(target.adb, adbArgsForDevice(target.device, ["pull", remotePath, localPath]), timeoutMs)),
    guestPath: (value, label) => {
        const policy = validateGuestPath(value, { label, platform: "posix" });
        return androidControlPathObservation(policy);
    },
    stageInput(value) {
        const stage = stageLocalInputFile(value, { label: "upload-local-path" });
        return androidControlStageObservation(stage);
    },
    stageOutput(value) {
        const stage = createLocalOutputStage(value, { label: "download-local-path" });
        return androidControlStageObservation(stage);
    },
    commitOutput(stage) {
        const result = commitLocalOutputStage(stage, { label: "download-local-path" });
        return androidControlPathObservation(result);
    },
    disposeInput: disposeAndroidControlStage,
    disposeOutput: disposeAndroidControlStage,
};
const androidControlTransfer = createAndroidControlTransfer(androidControlTransferPorts);

/** @type {import('../ports/mobile-app-management.mjs').AndroidAppManagementPorts<Extract<ReturnType<typeof ensureAdbDevice>,{device:unknown}>>} */
const androidAppManagementPorts = {
    variant: "physical",
    target(deviceId) {
        const target = ensureAdbDevice(deviceId);
        if (target.unknown) return { kind: "unknown" };
        if (target.error) return { kind: "refused", message: target.error };
        return { kind: "ready", target };
    },
    perform: (target, effect) => performAndroidAppEffect(target.adb, adbArgsForDevice(target.device, []), effect),
};
const androidAppManagement = createAndroidAppManagement(androidAppManagementPorts);

/** @type {import('../ports/android-device-access.mjs').AndroidPhysicalAccessPorts<NonNullable<ReturnType<typeof findAndroidRealDevice>>, {adbAvailable:boolean,native:ReturnType<typeof androidDiscovery>}>} */
const androidDeviceAccessPorts = {
    variant: "physical",
    device: id => findAndroidRealDevice(id),
    discovery: () => { const native=androidDiscovery(); return {adbAvailable:Boolean(native.adb),native}; },
    targetForDevice: (device,discovery) => ({device,native:{device,adb:discovery.native.adb}}),
    target(id) {
        const selected = ensureAdbDevice(id);
        if (selected.unknown) return { kind: "unknown" };
        if (selected.error) return { kind: "refused", message: selected.error };
        return { kind: "ready", target: {device:selected.device,native:selected} };
    },
    uiPath: device => `/sdcard/window-${device.id}.xml`,
    executeShell: (target,command) => {
        const diagnostic = run(target.native.adb, adbArgsForDevice(target.device,["shell",command]));
        return diagnostic.status === 0 ? {ok:true,value:undefined,diagnostic} : {ok:false,diagnostic};
    },
    dumpUi: (target,path,timeoutMs) => dumpAndroidUi(target.native.adb,adbArgsForDevice(target.device,[]),path,timeoutMs),
    readUi: (target,path,mode,timeoutMs) => readAndroidUi(target.native.adb,adbArgsForDevice(target.device,[]),path,mode,timeoutMs),
    observeApp: (target,packageName,timeoutMs) => observeAndroidApp(target.native.adb,adbArgsForDevice(target.device,[]),packageName,timeoutMs),
    capture: target => {
        const result = runBuffer(target.native.adb, adbArgsForDevice(target.device, ["exec-out", "screencap", "-p"]), {
            maxBuffer: ANDROID_SCREENSHOT_MAX_BUFFER_BYTES, timeout: ANDROID_SCREENSHOT_TIMEOUT_MS,
        });
        return observeAndroidScreenshot(result);
    },
    budget: (timeoutMs, intervalMs) => createWaitBudget(timeoutMs, intervalMs),
    refreshLease: device => { const lease = refreshAndroidRealDeviceLease(device); return lease.ok ? { ok: true } : { ok: false, message: lease.error }; },
    hostState: (device, discovery) => { const r = run(discovery.native.adb,["-s",device.serial,"get-state"]); return {stdout:(r.stdout||"").trim(),stderr:r.stderr,status:r.status}; },
};
const androidDeviceAccess = createAndroidDeviceAccess(androidDeviceAccessPorts);

/** @param {import('../ports/android-device-access.mjs').AndroidAccessOutcome|undefined} outcome */
function presentAndroidAccessOutcome(outcome) {
    if (!outcome) return undefined;
    if (outcome.kind === "refused") return textResult(false,outcome.message);
    if (outcome.kind === "native-failure") return fail(outcome.diagnostic);
    if (outcome.kind === "image") return {content:[{type:"image",data:outcome.data,mimeType:"image/png"}]};
    if (outcome.kind === "session") {
        const device = outcome.device;
        const facts = appiumDiscovery();
        const appium = {available:facts.available,missing:facts.missing,tools:{appium:facts.appium,adb:facts.adb}};
        return jsonResult({deviceId:device.id,appium,session:device.appium||null,lazy:true,automationName:"UiAutomator2"});
    }
    if (outcome.kind === "status") {
        const device = outcome.device, discovery = outcome.discovery.native;
        const facts = appiumDiscovery(discovery);
        const appium = {available:facts.available,missing:facts.missing,tools:{appium:facts.appium,adb:facts.adb}};
        return jsonResult({device:withTargetStatus(device),backend:androidRealBackend(discovery),hostState:outcome.hostState,appium:{deviceId:device.id,appium,session:device.appium||null,lazy:true,automationName:"UiAutomator2"}});
    }
    if (outcome.kind === "executed") { const r = outcome.diagnostic; return jsonResult({stdout:r.stdout,stderr:r.stderr,status:r.status}); }
    if (outcome.kind === "ui") { const r=outcome.dump; return jsonResult({provider:"adb-uiautomator",source:outcome.source,remotePath:outcome.remotePath,stdout:r.stdout,stderr:r.stderr}); }
    const result = outcome.kind === "text-wait" ? presentAndroidTextWait(outcome.result) : presentAndroidAppWait(outcome.result);
    if ("error" in result) return fail(result.error);
    return outcome.kind === "text-wait" ? jsonResult({...result,text:outcome.text,provider:"adb-uiautomator"}) : jsonResult({...result,packageName:outcome.packageName,provider:"adb"});
}

/** @type {import('../ports/mobile-environment.mjs').AndroidPhysicalEnvironmentPorts<Extract<ReturnType<typeof ensureAdbDevice>,{device:unknown}>>} */
const androidEnvironmentPorts = {
    variant: "physical",
    target(deviceId) {
        const target = ensureAdbDevice(deviceId);
        if (target.unknown) return { kind: "unknown" };
        if (target.error) return { kind: "refused", message: target.error };
        return { kind: "ready", target };
    },
    writeClipboard: (target, text) => androidEnvironmentObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "cmd", "clipboard", "set", text]))),
    readClipboard: target => androidEnvironmentObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "cmd", "clipboard", "get"]))),
    device: deviceId => findAndroidRealDevice(deviceId),
};
const androidEnvironment = createAndroidEnvironment(androidEnvironmentPorts);

/** @param {import('../ports/android-control-transfer.mjs').AndroidControlOutcome | undefined} outcome */
function presentAndroidControlOutcome(outcome) {
    return renderAndroidControlOutcome(outcome,"physical",{jsonResult,textResult,fail});
}

async function handleAndroidRealToolUnlocked(name, args) {
    if (!backendHintAllows(args, "android-device")) return undefined;
    if (args?.backend === "android-device" && ANDROID_REAL_DEVICE_ID_TOOLS.has(name) && typeof args?.deviceId === "string" && !findAndroidRealDevice(args.deviceId)) {
        return textResult(false, JSON.stringify({ ok: false, error: "device-not-found", backend: "android-device", deviceId: args.deviceId }, null, 2));
    }
    switch (name) {
        case "device_inventory": { const value=deviceObservation.inventory(args); return value === undefined ? undefined : jsonResult(value); }


        case "device_wireless": {
            return presentWireless(androidWireless.handle(args));
        }

        case "device_attach":
            return presentAttachment(physicalAttachment.attach(args));
        case "device_detach":
            return presentAttachment(await physicalAttachment.detach(args.deviceId));

        case "device_start": {
            const { deviceId } = args;
            const device = findAndroidRealDevice(deviceId);
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

        case "device_status":
            return presentAndroidAccessOutcome(androidDeviceAccess.request(name, args));

        case "device_exec":
            return presentAndroidAccessOutcome(androidDeviceAccess.request(name, args));

        case "device_screenshot":
            return presentAndroidAccessOutcome(androidDeviceAccess.request(name, args));

        case "device_record_video_status":
        case "device_record_video_start":
        case "device_record_video_stop":
            return presentAndroidRealRecording(await androidRealRecording.request(name, args));

        case "mobile_screenshot": {
            const { deviceId } = args;
            return handleAndroidRealTool("device_screenshot", { deviceId });
        }

        case "device_upload":
        case "device_download":
            return presentAndroidControlOutcome(androidControlTransfer.request(name, args));

        case "device_install_app":
        case "device_launch_app":
        case "device_reset":
        case "mobile_open_url":
        case "mobile_install_app":
        case "mobile_launch_app":
        case "mobile_uninstall_app":
        case "mobile_stop_app":
        case "mobile_clear_app_data":
        case "mobile_grant_permission":
        case "mobile_revoke_permission":
            return presentAndroidAppOutcome(androidAppManagement.request(name, args), "physical", name);

        case "mobile_session_status":
            return presentAndroidAccessOutcome(androidDeviceAccess.request(name, args));

        case "mobile_dump_ui":
            return presentAndroidAccessOutcome(androidDeviceAccess.request(name, args));

        case "mobile_tap":
        case "mobile_double_tap":
        case "mobile_long_press":
        case "mobile_swipe":
        case "mobile_drag":
        case "mobile_type_text":
        case "mobile_key":
        case "mobile_back":
        case "mobile_home":
        case "mobile_forward":
        case "mobile_recents":
        case "mobile_power":
        case "mobile_lock":
        case "mobile_unlock":
            return presentAndroidControlOutcome(androidControlTransfer.request(name, args));

        case "mobile_set_orientation":
        case "mobile_rotate_left":
        case "mobile_rotate_right":
            return presentAndroidControlOutcome(androidControlTransfer.request(name, args));

        case "mobile_set_location":
        case "mobile_set_battery":
        case "mobile_set_network":
        case "mobile_toggle_airplane_mode":
        case "mobile_set_clipboard":
        case "mobile_get_clipboard":
            return presentAndroidEnvironmentOutcome(androidEnvironment.request(name, args));

        case "mobile_wait_for_text":
            return presentAndroidAccessOutcome(await androidDeviceAccess.waitFor(name, args));

        case "mobile_wait_for_app":
            return presentAndroidAccessOutcome(await androidDeviceAccess.waitFor(name, args));

        default:
            return undefined;
    }
}

export async function handleAndroidRealTool(name, args) {
    if (name === "device_record_video_start" && backendHintAllows(args, "android-device")
        && (args?.backend === "android-device" || findAndroidRealDevice(args?.deviceId))
        && recordingInputError("android-device", args?.timeLimitSec)) {
        return textResult(false, recordingInputError("android-device", args?.timeLimitSec));
    }
    if (!requiresOwnerDeviceOperation("android-device", name)) return handleAndroidRealToolUnlocked(name, args);
    const attachesDevice = name === "device_attach";
    const deviceId = typeof args?.deviceId === "string"
        ? args.deviceId
        : attachesDevice && (args?.name || args?.serial || args?.host)
            ? androidRealDeviceId(args.name || args.serial || `${args.host}:${args.port || 5555}`)
            : null;
    if (!deviceId) return handleAndroidRealToolUnlocked(name, args);
    if (!attachesDevice && !findAndroidRealDevice(deviceId)) return handleAndroidRealToolUnlocked(name, args);
    try {
        return await withOwnerDeviceOperation("android-device", deviceId, () => {
            if (!attachesDevice) {
                const lease = refreshAndroidRealDeviceLease(findAndroidRealDevice(deviceId));
                if (!lease.ok) return textResult(false, lease.error);
            }
            return handleAndroidRealToolUnlocked(name, args);
        });
    } catch (error) {
        if (error?.code !== "shared-mutation-lock-timeout") throw error;
        return textResult(false, `Android physical device operation lock failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const deviceObservation = createDeviceObservation({ kind: "android-device", ownerId: () => ownerId(), now: () => Date.now(), readPhysicalLeases: backend => observationPhysicalLeases(backend), capabilities: ANDROID_REAL_CAPABILITIES, androidPrerequisites: () => androidDiscovery(), records: () => readAndroidRealDevices(), hostDevices: adb => androidHostDevices(run(adb, ["devices", "-l"])) });
