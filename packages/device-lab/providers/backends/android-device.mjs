import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { createPhysicalStopApplication } from "../application/physical-stop.mjs";
import { createAndroidWirelessApplication } from "../application/android-wireless.mjs";
import { androidWifiSerial, androidWifiTransport, androidWirelessDeviceList } from "../domain/android-wireless.mjs";
import { waitForAndroidText, waitForAndroidApp } from "./android-wait.mjs";
import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { androidDiscovery, androidScreenshotResult, appiumDiscovery } from "./android.mjs";
import { run, runBuffer, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { validateGuestPath, validateLocalOutputPath } from "../policy/files.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { claimAndroidRealDevice, findAndroidRealDevice, readAndroidRealDevices, transitionAndroidRealDevice, updateAndroidRealDevice } from "../state/android-device-state.mjs";
import { withOwnerDeviceOperation } from "../state/device-store.mjs";
import { requiresOwnerDeviceOperation } from "../state/device-operation-policy.mjs";
import { inspectProcessIdentity, readProcessIdentity, signalOwnedRuntimeProcess } from "../state/process-identity.mjs";
import { claimRecordingFinalization, recordingGenerationMatches, transitionRecordingGeneration } from "../state/runtime-generation.mjs";
import { claimPhysicalLease, heartbeatPhysicalLease, releasePhysicalLease, releasePhysicalLeaseWithMutation, startPhysicalLeaseHeartbeat } from "../state/physical-lease-store.mjs";
import { withTargetStatus } from "../status.mjs";
import { commitLocalOutputStage, createLocalOutputStage, stageLocalInputFile } from "../transfer-file.mjs";

// Native leaf steps retain timeout-runner selection before argument coercion.
const androidWireless = createAndroidWirelessApplication({
    discover: () => androidDiscovery(),
    listDevices: (discovery) => run(discovery.adb, ["devices", "-l"]),
    tcpip: (adb, argv, timeoutMs) => runWithTimeout(adb, argv, Math.max(1, Math.min(Number(timeoutMs || 15000), 30000))),
    pair: (adb, argv, timeoutMs) => runWithTimeout(adb, argv, Math.max(1, Math.min(Number(timeoutMs || 15000), 30000))),
    connect: (adb, argv, timeoutMs) => runWithTimeout(adb, argv, Math.max(1, Math.min(Number(timeoutMs || 15000), 30000))),
    selectJsonPublisher: () => jsonResult,
    selectTextPublisher: () => textResult,
});

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
    textResult,
    jsonResult,
    withTargetStatus,
    discoverAdb: () => androidDiscovery().adb,
    // The selected native runner uses default UTF-8; retain its raw result.
    stopAdbRecording: (adb, serial) => /** @type {import("../ports/physical-stop.mjs").PhysicalCommandResult} */ (run(adb, ["-s", serial, "shell", "pkill", "-2", "screenrecord"])),
    waitRecordingExit: waitForProcessExit,
});

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
    return androidWirelessDeviceList(r);
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

function adbLaunchSemanticFailure(result) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    return /(?:no activities found to run|monkey aborted|error:\s*(?:activity|unable to resolve intent)|activity class .* does not exist)/i.test(output);
}

function runAdbDeviceCommand(device, adb, args, options = {}) {
    const r = options.timeoutMs
        ? runWithTimeout(adb, adbArgsForDevice(device, args), androidHelperTimeoutMs(options.timeoutMs))
        : run(adb, adbArgsForDevice(device, args));
    const semanticFailure = options.validateLaunch === true && adbLaunchSemanticFailure(r);
    return r.status === 0 && !semanticFailure
        ? { ok: true, stdout: r.stdout, stderr: r.stderr, status: r.status }
        : { ok: false, result: r };
}

function adbJsonResult(device, adb, args, payload, options = {}) {
    const r = runAdbDeviceCommand(device, adb, args, options);
    return r.ok ? jsonResult({ ...payload, stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r.result);
}

function appiumStatus(device, android) {
    const discovery = appiumDiscovery(android);
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

function reconcileAndroidRealRecording(device) {
    if (!device?.recording?.active || !device.recording.pid) return device;
    const observation = device.recording.processIdentity
        ? inspectProcessIdentity(device.recording.processIdentity, device.recording.pid)
        : null;
    const recorderIsCurrent = observation
        ? observation.status === "match" || observation.status === "unavailable"
        : processIsAlive(device.recording.pid);
    if (recorderIsCurrent) return device;
    const expected = device.recording;
    const pending = { ...expected, active: false, endedAt: now() };
    return updateAndroidRealDevice(device.id, (item) => recordingGenerationMatches(expected, item.recording)
        ? { ...item, recording: pending, updatedAt: now() }
        : item) || device;
}

function monitorAndroidRealRecordingExit(deviceId, recording) {
    return () => {
        transitionRecordingGeneration(updateAndroidRealDevice, deviceId, recording, {
            ...recording,
            active: false,
            endedAt: now(),
        }, now());
    };
}


function stopVolatileProcesses(device, adb) {
    return physicalStop.cleanup(device, adb);
}

export function listAndroidRealDevices() { return deviceObservation.owned(); }

async function handleAndroidRealToolUnlocked(name, args) {
    if (!backendHintAllows(args, "android-device")) return undefined;
    if (args?.backend === "android-device" && ANDROID_REAL_DEVICE_ID_TOOLS.has(name) && typeof args?.deviceId === "string" && !findAndroidRealDevice(args.deviceId)) {
        return textResult(false, JSON.stringify({ ok: false, error: "device-not-found", backend: "android-device", deviceId: args.deviceId }, null, 2));
    }
    switch (name) {
        case "device_inventory": { const value=deviceObservation.inventory(args); return value === undefined ? undefined : jsonResult(value); }


        case "device_wireless": {
            return androidWireless.handle(args);
        }

        case "device_attach": {
            const { backend, name: deviceName, deviceId, serial, connection = "usb", host, port = 5555 } = args;
            if (backend !== "android-device") return undefined;
            let resolvedSerial = serial;
            const leaseClaimNonce = randomUUID();
            let lease = null;
            const releaseClaimedLease = (hardwareId, id) => lease?.lease && releasePhysicalLease("android-device", hardwareId, id, {
                claimId: lease.lease.claimId,
                claimNonce: leaseClaimNonce,
            });

            const discovery = androidDiscovery();
            if (!discovery.adb) return textResult(false, "Android real-device backend missing prerequisites: adb");
            const devices = readAndroidRealDevices();
            if (connection === "wifi") {
                resolvedSerial = serial ? androidWifiSerial(serial, port) : androidWifiSerial(host, port);
                if (!host && !serial) return textResult(false, "Android Wi-Fi attach requires host or serial in host:port form");
                const connectTarget = resolvedSerial;
                if (!connectTarget) return textResult(false, "Android Wi-Fi attach requires a valid host and port");
                const id = deviceId || androidRealDeviceId(deviceName || connectTarget);
                if (devices.some((device) => device.id === id)) return textResult(false, `Device already exists for this owner: ${id}`);
                if (devices.some((device) => device.serial === connectTarget)) return textResult(false, `Android serial already attached for this owner: ${connectTarget}`);
                lease = claimPhysicalLease("android-device", connectTarget, id, { claimNonce: leaseClaimNonce });
                if (!lease.ok) {
                    return textResult(false, `Android serial is already attached or an attach is in progress: ${connectTarget}`);
                }
                const connect = run(discovery.adb, ["connect", connectTarget]);
                if (connect.status !== 0) {
                    releaseClaimedLease(connectTarget, id);
                    return fail(connect);
                }
                resolvedSerial = connectTarget;
            }
            if (!resolvedSerial) return textResult(false, "Android real-device attach requires serial");
            if (String(resolvedSerial).startsWith("emulator-")) return textResult(false, `Refusing to attach emulator serial through android-device backend: ${resolvedSerial}`);
            const inventory = hostAndroidDevices(discovery);
            const hostDevice = inventory.devices.find((device) => device.serial === resolvedSerial);
            if (!hostDevice) {
                if (connection === "wifi") releaseClaimedLease(resolvedSerial, deviceId || androidRealDeviceId(deviceName || resolvedSerial));
                return textResult(false, `Android device is not visible to adb: ${resolvedSerial}`);
            }
            if (hostDevice.state !== "device") {
                if (connection === "wifi") releaseClaimedLease(resolvedSerial, deviceId || androidRealDeviceId(deviceName || resolvedSerial));
                return textResult(false, `Android device ${resolvedSerial} is not attachable; adb state is ${hostDevice.state}`);
            }

            const id = deviceId || androidRealDeviceId(deviceName || resolvedSerial);
            if (devices.some((device) => device.id === id)) return textResult(false, `Device already exists for this owner: ${id}`);
            if (devices.some((device) => device.serial === resolvedSerial)) return textResult(false, `Android serial already attached for this owner: ${resolvedSerial}`);
            if (connection !== "wifi") {
                lease = claimPhysicalLease("android-device", resolvedSerial, id, { claimNonce: leaseClaimNonce });
                if (!lease.ok) {
                    return textResult(false, `Android serial is already attached or an attach is in progress: ${resolvedSerial}`);
                }
            }
            const resolvedConnection = hostDevice.connection || connection;

            const device = {
                id,
                name: deviceName || resolvedSerial,
                backend,
                kind: "mobile",
                platform: "android",
                physical: true,
                ownerId: ownerId(),
                serial: resolvedSerial,
                connection: resolvedConnection,
                transport: resolvedConnection === "wifi"
                    ? androidWifiTransport(resolvedSerial, host, port)
                    : { type: "usb", host: null, port: null },
                hostDetails: hostDevice.details,
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
                claim = claimAndroidRealDevice(device);
            } catch (error) {
                releaseClaimedLease(resolvedSerial, id);
                throw error;
            }
            if (!claim.ok) {
                releaseClaimedLease(resolvedSerial, id);
                return textResult(false, `Device identity already exists for this owner (${claim.field}: ${claim.value})`);
            }
            startPhysicalLeaseHeartbeat("android-device", resolvedSerial, id, {
                claimId: lease.lease.claimId,
                claimNonce: leaseClaimNonce,
            });
            return jsonResult({ device: withTargetStatus(device) });
        }

        case "device_detach": {
            const { deviceId } = args;
            const devices = readAndroidRealDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            const claim = claimAndroidRealLifecycle(deviceId, device, "detach");
            if (!claim.transition.matched) return androidRealStateConflict(deviceId, "detach-claim", claim.transition);
            const discovery = androidDiscovery();
            const stopped = await stopVolatileProcesses(device, discovery.adb);
            if (!stopped.exited) {
                abortAndroidRealLifecycle(deviceId, claim.lifecycle, device);
                return textResult(false, stopped.error);
            }
            const current = currentAndroidRealLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) return androidRealStateConflict(deviceId, "detach", { found: Boolean(findAndroidRealDevice(deviceId)), matched: false });
            let released;
            try {
                released = releasePhysicalLeaseWithMutation("android-device", device.serial, deviceId, {
                    claimId: device.leaseClaimId,
                    claimNonce: device.leaseClaimNonce,
                }, () => {
                    const transition = transitionAndroidRealDevice(deviceId, current, null);
                    if (!transition.matched) return { ok: false, transition };
                    return {
                        ok: true,
                        transition,
                        rollback() {
                            const restored = claimAndroidRealDevice(current);
                            if (!restored.ok) throw new Error(`android-device-detach-state-rollback-failed:${restored.error}`);
                        },
                    };
                });
            } catch (error) {
                abortAndroidRealLifecycle(deviceId, claim.lifecycle, device);
                return textResult(false, `Android physical device detach could not commit lease release; owner state and physical lease were preserved for retry: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!released.ok) {
                if (released.error === "physical-lease-release-mutation-rejected") {
                    return androidRealStateConflict(deviceId, "detach", released.mutation?.transition || { found: Boolean(findAndroidRealDevice(deviceId)), matched: false });
                }
                abortAndroidRealLifecycle(deviceId, claim.lifecycle, device);
                return textResult(false, `Android physical device detach lease release was rejected (${released.error || "lease-conflict"}); owner state and physical lease were preserved for retry.`);
            }
            return jsonResult({ detached: deviceId, physicalDevicePoweredOff: false });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findAndroidRealDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device: withTargetStatus(device), started: false, alreadyAttached: true, physicalDevicePoweredOnByMcp: false });
        }

        case "device_stop": {
            const { deviceId } = args;
            return physicalStop.stop(deviceId);
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findAndroidRealDevice(deviceId);
            if (!device) return undefined;
            const lease = refreshAndroidRealDeviceLease(device);
            if (!lease.ok) return textResult(false, lease.error);
            const discovery = androidDiscovery();
            let hostState = null;
            if (discovery.adb) {
                const r = run(discovery.adb, ["-s", device.serial, "get-state"]);
                hostState = { stdout: r.stdout.trim(), stderr: r.stderr, status: r.status };
            }
            return jsonResult({ device: withTargetStatus(device), backend: androidRealBackend(discovery), hostState, appium: appiumStatus(device, discovery) });
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
            const r = runBuffer(target.adb, adbArgsForDevice(target.device, ["exec-out", "screencap", "-p"]), {
                maxBuffer: ANDROID_SCREENSHOT_MAX_BUFFER_BYTES,
                timeout: ANDROID_SCREENSHOT_TIMEOUT_MS,
            });
            return androidScreenshotResult(r);
        }

        case "device_record_video_status": {
            const { deviceId } = args;
            const found = findAndroidRealDevice(deviceId);
            const device = reconcileAndroidRealRecording(found);
            if (!device) return undefined;
            return jsonResult({ deviceId, recording: device.recording || null, provider: "adb-screenrecord" });
        }

        case "device_record_video_start": {
            const { deviceId, remotePath, localPath, timeLimitSec = 180 } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const device = reconcileAndroidRealRecording(target.device);
            if (device.recording) {
                const state = device.recording.active ? "already active" : "pending finalization";
                return textResult(false, `Android real-device recording ${state} for ${deviceId}`);
            }

            const resolvedRemotePath = remotePath || `/sdcard/ccc-${device.id}-recording.mp4`;
            const resolvedLocalPath = localPath || androidRealRecordingLocalPath(device);
            const localPolicy = validateLocalOutputPath(resolvedLocalPath, { label: "recording-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const safeLocalPath = localPolicy.path;
            mkdirSync(androidRealRecordingDir(device), { recursive: true });
            mkdirSync(dirname(safeLocalPath), { recursive: true });
            const child = spawn(target.adb, adbArgsForDevice(device, ["shell", "screenrecord", "--time-limit", String(timeLimitSec), resolvedRemotePath]), {
                detached: true,
                stdio: "ignore",
                env: process.env,
                windowsHide: true,
            });
            let recording = null;
            const runtimeId = randomUUID();
            let exited = false;
            child.once("exit", () => {
                exited = true;
                if (recording) monitorAndroidRealRecordingExit(deviceId, recording)();
            });
            const startError = await waitForRecorderProcess(child, "Android real-device screenrecord");
            if (startError) return startError;
            const processIdentity = readProcessIdentity(child.pid);
            if (!processIdentity) {
                try { child.kill("SIGINT"); } catch { /* recorder already exited */ }
                return textResult(false, `Android real-device recorder process identity could not be established for ${deviceId}.`);
            }
            recording = {
                active: true,
                provider: "adb-screenrecord",
                runtimeId,
                pid: child.pid,
                processIdentity,
                remotePath: resolvedRemotePath,
                localPath: safeLocalPath,
                timeLimitSec,
                startedAt: now(),
            };
            child.unref();
            const committed = transitionRecordingGeneration(updateAndroidRealDevice, deviceId, device.recording ?? null, recording, now());
            if (!committed.committed) {
                try { child.kill("SIGINT"); } catch { /* recorder already exited */ }
                return textResult(false, `Android real-device recording state changed while starting for ${deviceId}; the new recorder was stopped.`);
            }
            if (exited || !processIsAlive(child.pid)) {
                transitionRecordingGeneration(updateAndroidRealDevice, deviceId, recording, null, now());
                return textResult(false, `Android real-device recorder exited before its state was committed for ${deviceId}.`);
            }
            return jsonResult({ deviceId, recording: committed.device.recording });
        }

        case "device_record_video_stop": {
            const { deviceId, localPath } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const device = reconcileAndroidRealRecording(target.device);
            if (!device.recording) return textResult(false, `No Android real-device recording active for ${deviceId}`);

            const resolvedLocalPath = localPath || device.recording.localPath || androidRealRecordingLocalPath(device);
            const localPolicy = validateLocalOutputPath(resolvedLocalPath, { label: "recording-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const safeLocalPath = localPolicy.path;
            const previous = device.recording;
            if (previous.active) {
                const recorderSignal = signalOwnedRuntimeProcess(previous, "SIGINT");
                run(target.adb, adbArgsForDevice(device, ["shell", "pkill", "-2", "screenrecord"]));
                if (recorderSignal.signaled) {
                    const exited = await waitForProcessExit(previous.pid, 3000);
                    if (!exited) return textResult(false, `Android real-device recording did not exit within 3000ms for ${deviceId}; state remains active.`);
                }
            }
            const claimed = claimRecordingFinalization(updateAndroidRealDevice, deviceId, previous, { localPath: safeLocalPath }, now());
            if (!claimed.committed || !claimed.device?.recording) {
                return textResult(false, `Android real-device recording state changed while stopping for ${deviceId}; successor state was preserved.`);
            }
            const pending = claimed.device.recording;
            mkdirSync(androidRealRecordingDir(device), { recursive: true });
            mkdirSync(dirname(safeLocalPath), { recursive: true });
            const localStage = createLocalOutputStage(safeLocalPath, { label: "recording-local-path" });
            if (!localStage.ok) return textResult(false, localStage.message);
            try {
                const pull = runWithTimeout(target.adb, adbArgsForDevice(device, ["pull", pending.remotePath, localStage.stagedPath]), ANDROID_TRANSFER_TIMEOUT_MS);
                if (pull.status !== 0) {
                    return textResult(false, `Error: ${pull.stderr || pull.stdout || `exit ${pull.status}`}. Android real-device recording remains pending finalization for ${deviceId}.`);
                }
                const committed = commitLocalOutputStage(localStage, { label: "recording-local-path", minBytes: 1 });
                if (!committed.ok) {
                    return textResult(false, `${committed.message}. Android real-device recording remains pending finalization for ${deviceId}.`);
                }
                const cleared = transitionRecordingGeneration(updateAndroidRealDevice, deviceId, pending, null, now());
                if (!cleared.committed) {
                    return textResult(false, `Android real-device recording state changed while stopping for ${deviceId}; successor state and remote artifact were preserved.`);
                }
                runWithTimeout(target.adb, adbArgsForDevice(device, ["shell", "rm", "-f", pending.remotePath]), ANDROID_TRANSFER_TIMEOUT_MS);
                return jsonResult({
                    deviceId,
                    provider: "adb-screenrecord",
                    stopped: true,
                    recording: { ...pending, active: false, localPath: safeLocalPath, stoppedAt: now() },
                    stdout: pull.stdout,
                    stderr: pull.stderr,
                    status: pull.status,
                });
            } finally {
                localStage.cleanup();
            }
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
            const remotePolicy = validateGuestPath(remotePath, { label: "upload-remote-path", platform: "posix" });
            if (!remotePolicy.ok) return textResult(false, remotePolicy.message);
            const localStage = stageLocalInputFile(localPath, { label: "upload-local-path" });
            if (!localStage.ok) return textResult(false, localStage.message);
            try {
                const r = runWithTimeout(target.adb, adbArgsForDevice(target.device, ["push", localStage.stagedPath, remotePolicy.path]), ANDROID_TRANSFER_TIMEOUT_MS);
                return r.status === 0
                    ? jsonResult({ uploaded: { localPath: localStage.path, remotePath: remotePolicy.path }, provider: "adb", stdout: r.stdout, stderr: r.stderr, status: r.status })
                    : fail(r);
            } finally {
                localStage.cleanup();
            }
        }

        case "device_download": {
            const { deviceId, remotePath, localPath } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const remotePolicy = validateGuestPath(remotePath, { label: "download-remote-path", platform: "posix" });
            if (!remotePolicy.ok) return textResult(false, remotePolicy.message);
            const localStage = createLocalOutputStage(localPath, { label: "download-local-path" });
            if (!localStage.ok) return textResult(false, localStage.message);
            try {
                const r = runWithTimeout(target.adb, adbArgsForDevice(target.device, ["pull", remotePolicy.path, localStage.stagedPath]), ANDROID_TRANSFER_TIMEOUT_MS);
                if (r.status !== 0) return fail(r);
                const committed = commitLocalOutputStage(localStage, { label: "download-local-path" });
                if (!committed.ok) return textResult(false, committed.message);
                return jsonResult({ downloaded: { remotePath: remotePolicy.path, localPath: committed.path }, provider: "adb", stdout: r.stdout, stderr: r.stderr, status: r.status });
            } finally {
                localStage.cleanup();
            }
        }

        case "device_install_app": {
            const { deviceId, path, replace = true, helperTimeoutMs } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, replace ? ["install", "-r", path] : ["install", path], { installed: path, provider: "adb" }, { timeoutMs: helperTimeoutMs });
        }

        case "device_launch_app": {
            const { deviceId, packageName, component } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (component) return adbJsonResult(target.device, target.adb, ["shell", "am", "start", "-n", component], { launched: component, provider: "adb" }, { validateLaunch: true });
            if (!packageName) return textResult(false, "Android app launch requires packageName or component");
            return adbJsonResult(target.device, target.adb, ["shell", "monkey", "-p", packageName, "1"], { launched: packageName, provider: "adb" }, { validateLaunch: true });
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
            return jsonResult({ deviceId, ...appiumStatus(device) });
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

        case "mobile_install_app": return handleAndroidRealTool("device_install_app", { deviceId: args.deviceId, path: args.path, helperTimeoutMs: args.helperTimeoutMs });
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
            const r = runAdbDeviceCommand(target.device, target.adb, ["shell", "cmd", "clipboard", "get"]);
            return r.ok ? jsonResult({ text: r.stdout, stderr: r.stderr, status: r.status, provider: "adb" }) : fail(r.result);
        }

        case "mobile_wait_for_text": {
            const { deviceId, text, timeoutMs, intervalMs } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!text) return textResult(false, "Android wait-for-text requires text");
            const result = await waitForAndroidText(target.adb, adbArgsForDevice(target.device, []), `/sdcard/window-${target.device.id}.xml`, text, timeoutMs, intervalMs);
            return result.error ? fail(result.error) : jsonResult({ ...result, text, provider: "adb-uiautomator" });
        }

        case "mobile_wait_for_app": {
            const { deviceId, packageName, timeoutMs, intervalMs } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!packageName) return textResult(false, "Android wait-for-app requires packageName");
            const result = await waitForAndroidApp(target.adb, adbArgsForDevice(target.device, []), packageName, timeoutMs, intervalMs);
            return result.error ? fail(result.error) : jsonResult({ ...result, packageName, provider: "adb" });
        }

        default:
            return undefined;
    }
}

export async function handleAndroidRealTool(name, args) {
    if (name === "device_record_video_start" && backendHintAllows(args, "android-device")
        && (args?.backend === "android-device" || findAndroidRealDevice(args?.deviceId))
        && args?.timeLimitSec !== undefined
        && (!Number.isInteger(args.timeLimitSec) || args.timeLimitSec < 1 || args.timeLimitSec > 180)) {
        return textResult(false, "Android recording timeLimitSec must be an integer from 1 to 180");
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

const deviceObservation = createDeviceObservation({ kind: "android-device", ownerId: () => ownerId(), now: () => Date.now(), readPhysicalLeases: backend => observationPhysicalLeases(backend), capabilities: ANDROID_REAL_CAPABILITIES, androidPrerequisites: () => androidDiscovery(), records: () => readAndroidRealDevices(), hostResult: adb => androidWirelessDeviceList(run(adb, ["devices", "-l"])) });
