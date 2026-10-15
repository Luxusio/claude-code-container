import { dumpAndroidUi, readAndroidUi, observeAndroidApp, presentAndroidTextWait, presentAndroidAppWait } from "./android-wait.mjs";
import { createDirectRecording } from "../adapters/direct-recording.mjs";
import { recordingInputError } from "../domain/direct-recording.mjs";
import { createAndroidEnvironment } from "../application/android-environment.mjs";
import { createAndroidAppManagement } from "../application/android-app-management.mjs";
import { createAndroidControlTransfer } from "../application/android-control-transfer.mjs";
import { createDeviceObservation } from "../application/device-observation.mjs";
import { androidHostAvds } from "../adapters/mobile-inventory.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { publicObservationAndroidDevice } from "../domain/device-observation.mjs";
import { createAndroidEmulatorLifecycle } from "../application/lifecycle/android-emulator-lifecycle.mjs";
import { createAndroidDeviceAccess } from "../application/android-device-access.mjs";
import { createWaitBudget } from "../wait-budget.mjs";
import { androidCreationChoices } from "./android-sdk-inventory.mjs";
import { spawn } from "child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "crypto";
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { commandPath, localBinPath, run, runBuffer, runWithInput, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { validateGuestPath, validateLocalOutputPath } from "../policy/files.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { resolveAndroidEmulatorPort, validAndroidEmulatorPort, withAndroidEmulatorPortAllocation } from "../state/android-emulator-port-allocation.mjs";
import { androidAvdHome, listOwnedAndroidAvdArtifacts, removeOwnedAndroidAvdArtifacts } from "../state/android-avd-storage.mjs";
import { readAndroidAvdIdentity } from "../state/android-avd-identity.mjs";
import { canonicalWindowsPowerShellPath } from "../state/windows-system-powershell.mjs";
import { claimAndroidDevice, findAndroidDevice, mutateAndroidDevices, readAndroidDevices, transitionAndroidDevice, updateAndroidDevice } from "../state/android-state.mjs";
import { withOwnerDeviceOperation } from "../state/device-store.mjs";
import { requiresOwnerDeviceOperation } from "../state/device-operation-policy.mjs";
import { refreshOwnedRuntimeProcessIdentity, signalOwnedRuntimeProcess, terminateOwnedRuntimeProcessTree, waitForProcessIdentity } from "../state/process-identity.mjs";
import { withTargetStatus } from "../status.mjs";
import { commitLocalOutputStage, createLocalOutputStage, stageLocalInputFile } from "../transfer-file.mjs";

/** @type {import('../ports/direct-recording.mjs').DirectRecordingNative} */
const recordingNative = {
    kind: 'android-emulator', findDevice: findAndroidDevice, updateDevice: updateAndroidDevice,
    localPath: androidRecordingLocalPath, validateLocalOutputPath, recordingDirectory: androidRecordingDir,
    resolveTarget(device) {
        const discovery = androidDiscovery();
        if (!discovery.adb) return { kind: 'failure', message: 'Android backend missing prerequisites: adb' };
        return { kind: 'ready', device, target: { kind: 'adb', executable: discovery.adb, prefix: adbArgsForDevice(device, []) } };
    },
    runCommand: command => command.timeoutMs === undefined
        ? run(command.executable, command.args)
        : runWithTimeout(command.executable, command.args, command.timeoutMs),
};
const directRecording = createDirectRecording(recordingNative);
/** @param {import('../domain/direct-recording.mjs').RecordingOutcome|undefined} outcome */
function presentRecordingOutcome(outcome) {
    if (!outcome || outcome.kind === 'missing') return undefined;
    if (outcome.kind === 'failure') return textResult(false, outcome.message);
    if (outcome.kind === 'native') return outcome.value;
    return jsonResult(outcome.value);
}


const ANDROID_SCREENSHOT_TIMEOUT_MS = 30_000;
const ANDROID_SCREENSHOT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const ANDROID_TRANSFER_TIMEOUT_MS = 300_000;
const ANDROID_HELPER_MAX_TIMEOUT_MS = 300_000;

function androidSdkCandidates() {
    const candidates = [];
    for (const key of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
        if (process.env[key]) candidates.push(process.env[key]);
    }
    candidates.push(
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : null,
        process.env.APPDATA ? join(process.env.APPDATA, "Android", "Sdk") : null,
        join(homedir(), "AppData", "Local", "Android", "Sdk"),
        join(homedir(), "Android/Sdk"),
        join(homedir(), "Library/Android/sdk"),
        "/opt/android-sdk",
        "/usr/local/android-sdk",
    );
    return candidates.filter(Boolean);
}

function findAndroidTool(name) {
    const fromPath = commandPath(name);
    if (fromPath) return fromPath;

    for (const sdk of androidSdkCandidates()) {
        const subdirs = androidToolSubdirs(sdk, name);
        for (const subdir of subdirs) {
            for (const executable of androidExecutableNames(name)) {
                const candidate = join(sdk, subdir, executable);
                if (existsSync(candidate)) return candidate;
            }
        }
    }
    return null;
}

function androidExecutableNames(name) {
    if (/\.(exe|bat|cmd)$/i.test(name)) return [name];
    return process.platform === "win32" ? [name, `${name}.exe`, `${name}.bat`, `${name}.cmd`] : [name];
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

export function androidDiscovery() { return deviceObservation.discovery(); }

function androidEmulatorHeadlessArgs(device, args = {}) {
    const headless = typeof args.headless === "boolean"
        ? args.headless
        : device?.headless !== false;
    return headless ? ["-no-window", "-no-audio"] : [];
}

const ANDROID_EMULATOR_NETSIM_NO_UI_ARGS = ["-netsim-args", "--no-cli-ui --no-web-ui"];

function androidEmulatorStartArgs(device, args = {}) {
    return [...androidEmulatorHeadlessArgs(device, args), ...ANDROID_EMULATOR_NETSIM_NO_UI_ARGS];
}

/** Native screenshot compatibility accepts a PNG even when the provider exits nonzero.
 * @returns {import('../ports/android-device-access.mjs').AndroidCaptureObservation} */
export function observeAndroidScreenshot(result) {
    const stdout = Buffer.from(result.stdout || []);
    const png = stdout.length >= 8 && [137,80,78,71,13,10,26,10].every((byte,index) => stdout[index] === byte);
    if (png || result.status === 0) return {kind:"image",data:stdout.toString("base64")};
    return {kind:"refused",message:`Error: ${result.stderr?.toString() || stdout.toString() || `exit ${result.status}`}`};
}
export function androidScreenshotResult(result) {
    return presentAndroidAccessOutcome(observeAndroidScreenshot(result));
}

export function appiumDiscovery(android = { adb: findAndroidTool("adb") }) {
    const appium = localBinPath("appium") || commandPath("appium");
    const missing = [];
    if (!appium) missing.push("appium");
    if (!android.adb) missing.push("adb");
    return { appium, adb: android.adb, available: missing.length === 0, missing };
}

export function androidBackend(discovery = androidDiscovery()) { return deviceObservation.backend(discovery); }

function appiumBackendStatus(android) {
    const discovery = appiumDiscovery(android);
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

function publicAndroidDevice(device) { return publicObservationAndroidDevice(withTargetStatus(device)); }

export function androidEmulatorPortsFromAdbDevices(output) {
    const ports = new Set();
    for (const line of String(output || "").split(/\r?\n/)) {
        const match = line.trim().match(/^emulator-(\d+)\s+/);
        if (!match) continue;
        const port = Number(match[1]);
        if (Number.isInteger(port)) ports.add(port);
    }
    return ports;
}

function liveAndroidEmulatorPortsForAllocation(discovery = androidDiscovery()) {
    if (!discovery.adb) return { ok: true, ports: new Set() };
    const result = run(discovery.adb, ["devices", "-l"]);
    if (result.status !== 0) {
        return {
            ok: false,
            error: "android-emulator-live-port-inventory-unavailable",
            detail: result.stderr || result.stdout || `adb-exit-${result.status}`,
        };
    }
    return { ok: true, ports: androidEmulatorPortsFromAdbDevices(result.stdout) };
}

function liveAndroidAvdNames(discovery) {
    if (!discovery.adb) return { ok: false, error: "android-emulator-runtime-inventory-unavailable" };
    const inventory = run(discovery.adb, ["devices", "-l"]);
    if (inventory.status !== 0) {
        return { ok: false, error: "android-emulator-runtime-inventory-unavailable" };
    }
    const emulatorLines = String(inventory.stdout || "").split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^emulator-\d+\s+/.test(line));
    if (emulatorLines.some((line) => !/^emulator-\d+\s+device\b/.test(line))) {
        return { ok: false, error: "android-emulator-runtime-target-unavailable" };
    }
    const names = new Set();
    for (const line of emulatorLines) {
        const serial = /^(emulator-\d+)/.exec(line)?.[1];
        if (!serial) return { ok: false, error: "android-emulator-runtime-identity-unavailable" };
        const identity = readAndroidAvdIdentity(serial, args => run(discovery.adb, args));
        if (!identity.ok) {
            return { ok: false, error: "android-emulator-runtime-identity-unavailable" };
        }
        names.add(identity.name);
    }
    return { ok: true, names };
}

function androidAvdProcessState(avdName) {
    if (!isSafeProvisionedAvdName(avdName)) return { ok: false, active: false };
    const powershell = process.platform === "win32" ? canonicalWindowsPowerShellPath() : null;
    if (process.platform === "win32" && !powershell) return { ok: false, active: false };
    const result = process.platform === "win32"
        ? run(powershell, [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(emulator|qemu-system-.*)\\.exe$' } | ForEach-Object { [string]$_.CommandLine }",
        ])
        : run("/bin/ps", ["-eo", "args="]);
    if (result.status !== 0) return { ok: false, active: false };
    const escaped = avdName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp(`(?:^|\\s)(?:-avd(?:\\s+|=)["']?${escaped}(?=["'\\s]|$)|@${escaped}(?=\\s|$))`);
    return {
        ok: true,
        active: String(result.stdout || "").split(/\r?\n/).some((line) => matcher.test(line)),
    };
}

function androidRecordingDir(device) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), "android", device.id, "recordings");
}

function androidLauncherDir(device) {
    if (typeof device?.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(device.id)) {
        throw new Error("android-launcher-device-id-invalid");
    }
    return join(homedir(), ".ccc/devices/owners", ownerId(), "android", device.id, "tools");
}

function ensureAndroidLauncherDirectory(directory) {
    const home = resolve(homedir());
    const target = resolve(directory);
    const child = relative(home, target);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new Error("android-launcher-path-outside-home");
    }
    let current = home;
    try {
        for (const segment of ["", ...(child ? child.split(sep) : [])]) {
            if (segment) {
                current = join(current, segment);
                try {
                    mkdirSync(current, { mode: 0o700 });
                } catch (error) {
                    if (error?.code !== "EEXIST") throw error;
                }
            }
            const stat = lstatSync(current);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("android-launcher-directory-invalid");
        }
    } catch (error) {
        if (error?.message === "android-launcher-directory-invalid") throw error;
        throw new Error("android-launcher-directory-unavailable", { cause: error });
    }
}

function quoteWindowsCommandArg(value) {
    if (!/[ \t"&|<>^]/.test(value)) return value;
    return `"${value.replace(/(["^&|<>])/g, "^$1")}"`;
}

export function androidWindowsHiddenLauncherScript(executable, args) {
    const commandLine = [quoteWindowsCommandArg(executable), ...args.map(quoteWindowsCommandArg)].join(" ");
    const hiddenCommand = `%ComSpec% /d /s /c "${commandLine} >NUL 2>NUL"`;
    return [
        "Set Shell = CreateObject(\"WScript.Shell\")",
        `Shell.Run "${hiddenCommand.replace(/"/g, "\"\"")}", 0, True`,
        "",
    ].join("\r\n");
}

export function materializeAndroidWindowsHiddenLauncher(device, executable, args, options = {}) {
    const launcherDir = androidLauncherDir(device);
    ensureAndroidLauncherDirectory(launcherDir);
    const content = Buffer.from(androidWindowsHiddenLauncherScript(executable, args), "utf8");
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const randomId = options.randomId?.() ?? randomUUID().replace(/-/g, "");
        if (!/^[a-f0-9]{32}$/.test(randomId)) throw new Error("android-launcher-random-id-invalid");
        const launcherPath = join(launcherDir, `ccc-android-emulator-${randomId}.vbs`);
        let descriptor = null;
        let created = false;
        try {
            descriptor = openSync(launcherPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
            created = true;
            let offset = 0;
            while (offset < content.length) {
                const count = writeSync(descriptor, content, offset, content.length - offset);
                if (count <= 0) throw new Error("android-launcher-write-failed");
                offset += count;
            }
            try { fchmodSync(descriptor, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
            const opened = fstatSync(descriptor);
            const current = lstatSync(launcherPath);
            ensureAndroidLauncherDirectory(launcherDir);
            if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
                || opened.nlink !== 1 || current.nlink !== 1
                || opened.size !== content.length || current.size !== content.length
                || (opened.dev !== 0 && current.dev !== 0 && opened.dev !== current.dev)
                || (opened.ino !== 0 && current.ino !== 0 && opened.ino !== current.ino)) {
                throw new Error("android-launcher-file-invalid");
            }
            closeSync(descriptor);
            return launcherPath;
        } catch (error) {
            if (descriptor !== null) closeSync(descriptor);
            if (created) {
                try { unlinkSync(launcherPath); } catch { /* remove only a launcher created by this attempt */ }
            }
            if (error?.code === "EEXIST") continue;
            if (error?.message?.startsWith("android-launcher-")) throw error;
            throw new Error("android-launcher-create-failed", { cause: error });
        }
    }
    throw new Error("android-launcher-create-failed");
}

export function removeAndroidWindowsHiddenLauncher(path) {
    if (!path) return;
    try { unlinkSync(path); } catch { /* launcher cleanup is best-effort */ }
}

export function scheduleAndroidWindowsHiddenLauncherCleanup(path, child, delayMs = 60_000) {
    let removed = false;
    const cleanup = () => {
        if (removed) return;
        removed = true;
        removeAndroidWindowsHiddenLauncher(path);
    };
    child.once("close", cleanup);
    const timer = setTimeout(cleanup, delayMs);
    timer.unref?.();
}

async function spawnAndroidEmulator(discovery, device, emulatorArgs) {
    if (process.platform === "win32") {
        const launcherPath = materializeAndroidWindowsHiddenLauncher(device, discovery.emulator, emulatorArgs);
        let child;
        try {
            child = spawn("wscript.exe", ["//B", launcherPath], {
                detached: true,
                stdio: "ignore",
                env: process.env,
                windowsHide: true,
            });
        } catch (error) {
            removeAndroidWindowsHiddenLauncher(launcherPath);
            throw error;
        }
        scheduleAndroidWindowsHiddenLauncherCleanup(launcherPath, child);
        await once(child, "spawn");
        child.unref();
        return child;
    }

    const child = spawn(discovery.emulator, emulatorArgs, {
        detached: true,
        stdio: "ignore",
        env: process.env,
        windowsHide: true,
    });
    await once(child, "spawn");
    child.unref();
    return child;
}

function androidRecordingLocalPath(device) {
    return join(androidRecordingDir(device), `recording-${Date.now()}.mp4`);
}

function adbArgsForDevice(device, args) {
    const serial = androidSerial(device);
    return serial ? ["-s", serial, ...args] : args;
}



function ensureAdbDevice(deviceId) {
    const device = findAndroidDevice(deviceId);
    if (!device) return { unknown: true };
    const discovery = androidDiscovery();
    if (!discovery.adb) return { error: "Android backend missing prerequisites: adb" };
    return { device, adb: discovery.adb };
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

function adbTargetResult(target) {
    if (target.unknown) return undefined;
    if (target.error) return textResult(false, target.error);
    return null;
}

function backendHintAllows(args, backend) {
    return !args?.backend || args.backend === backend;
}

function ownerAvdPrefix() {
    return `ccc-${ownerId()}-`;
}

function isOwnedAvdName(avdName) {
    return isSafeProvisionedAvdName(avdName);
}

function isSafeProvisionedAvdName(avdName) {
    return typeof avdName === "string"
        && avdName.length <= 128
        && new RegExp(`^${ownerAvdPrefix()}[A-Za-z0-9._-]+$`).test(avdName);
}

function deleteOwnedAndroidAvd(avdName, options = {}) {
    if (!isSafeProvisionedAvdName(avdName)) {
        return { ok: false, error: "android-avd-name-not-owner-scoped" };
    }
    try {
        const artifacts = removeOwnedAndroidAvdArtifacts(avdName, ownerId(), {
            root: options.avdRoot,
            verifyInactive: options.verifyInactive,
        });
        return {
            ok: true,
            artifactsRemoved: artifacts.removed,
        };
    } catch {
        return {
            ok: false,
            error: "android-avd-artifact-cleanup-failed",
        };
    }
}

function approvedAndroidAvdRoot(recordedRoot) {
    if (typeof recordedRoot !== "string" || !recordedRoot) return null;
    const approved = resolve(androidAvdHome());
    const recorded = resolve(recordedRoot);
    const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    return normalize(approved) === normalize(recorded) ? approved : null;
}

function androidAvdIsInactive(discovery, device) {
    if (!isSafeProvisionedAvdName(device?.avdName)) return false;
    const live = liveAndroidAvdNames(discovery);
    if (!live.ok || live.names.has(device.avdName)) return false;
    const processState = androidAvdProcessState(device.avdName);
    return processState.ok && !processState.active;
}

function isSafeSystemImage(systemImage) {
    return typeof systemImage === "string"
        && systemImage.length <= 256
        && /^system-images;[A-Za-z0-9._-]+;[A-Za-z0-9._-]+;[A-Za-z0-9._-]+$/.test(systemImage);
}

function isSafeDeviceProfile(deviceProfile) {
    return typeof deviceProfile === "string"
        && deviceProfile.length <= 128
        && deviceProfile.trim() === deviceProfile
        && /^[A-Za-z0-9._ -]+$/.test(deviceProfile);
}



function androidEmulatorProcessExit(child) {
    if (!child || (child.exitCode === null && child.signalCode === null)) return null;
    return {
        reason: "emulator-process-exited",
        exitCode: child.exitCode,
        signal: child.signalCode,
    };
}

async function waitForAndroidBoot(discovery, device, timeoutMs, child = null) {
    if (!discovery.adb) return { ready: false, skipped: true, reason: "adb missing" };
    const serial = androidSerial(device);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        const processExit = androidEmulatorProcessExit(child);
        if (processExit) return { ready: false, skipped: false, ...processExit };
        const adbArgs = serial
            ? ["-s", serial, "shell", "getprop", "sys.boot_completed"]
            : ["shell", "getprop", "sys.boot_completed"];
        const r = run(discovery.adb, adbArgs);
        await sleep(0);
        const processExitAfterPoll = androidEmulatorProcessExit(child);
        if (processExitAfterPoll) return { ready: false, skipped: false, ...processExitAfterPoll };
        if (r.status === 0 && r.stdout.trim() === "1") return { ready: true };
        await sleep(250);
    }
    return { ready: false, skipped: false, reason: "timeout" };
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

/** @param {import('../ports/lifecycle/android-emulator-lifecycle.mjs').AndroidEmulatorLifecycleOutcome|undefined} outcome */
function presentAndroidLifecycleOutcome(outcome) {
    if (!outcome) return undefined;
    switch (outcome.kind) {
        case "refused": return textResult(false, outcome.message);
        case "native-failure": return fail(outcome.diagnostic);
        case "identity-unavailable": return textResult(false,JSON.stringify({ok:false,error:"android-emulator-process-identity-unavailable",backend:"android-emulator",deviceId:outcome.deviceId,termination:outcome.termination,stateReverted:outcome.stateReverted,runtimeStatePreserved:outcome.runtimeStatePreserved}));
        case "boot-process-exited": return textResult(false,JSON.stringify({ok:false,error:"android-emulator-process-exited-during-boot",backend:"android-emulator",deviceId:outcome.deviceId,boot:outcome.boot,rollback:outcome.rollback,stateReverted:outcome.stateReverted}));
        case "runtime-stop-failed": return textResult(false,JSON.stringify({ok:false,error:"android-emulator-process-stop-failed",backend:"android-emulator",deviceId:outcome.deviceId,runtimeStop:outcome.runtimeStop}));
        case "force-delete-stop-failed": return textResult(false,JSON.stringify({ok:false,error:"android-emulator-force-delete-stop-failed",backend:"android-emulator",deviceId:outcome.deviceId,adbStop:outcome.adbStop,runtimeStop:outcome.runtimeStop,stateReverted:outcome.stateReverted}));
        case "conflict": return textResult(false, JSON.stringify({ ok: false, error: "owner-device-state-conflict", backend: "android-emulator", deviceId: outcome.deviceId, operation: outcome.operation, found: outcome.found, ...(outcome.rollback ? { rollback: outcome.rollback } : {}) }));
        case "created": case "stopped": return jsonResult({ device: publicAndroidDevice(outcome.device) });
        case "started": return jsonResult({ device: publicAndroidDevice(outcome.device), boot: outcome.boot });
        case "deleted": return jsonResult({ deleted: outcome.deviceId, avdDeleted: outcome.avdDeleted });
    }
}

async function terminateFreshAndroidEmulatorProcessTree(child) {
    if (!child?.pid) return { ok: false, exited: false, reason: "spawned-process-pid-missing" };
    if (process.platform === "win32") {
        const result = run("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 10_000 });
        const exited = await waitForProcessExit(child.pid, 3000);
        return { ok: result.status === 0 && exited, exited, method: "taskkill-tree", status: result.status, stderr: result.stderr, stdout: result.stdout };
    }
    let error = null;
    try {
        process.kill(-child.pid, "SIGTERM");
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
    }
    let exited = await waitForProcessExit(child.pid, 1000);
    if (!exited) {
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
        }
        exited = await waitForProcessExit(child.pid, 3000);
    }
    return { ok: exited, exited, method: "process-group", ...(error ? { error } : {}) };
}




export function listAndroidDevices() { return deviceObservation.owned(); }

const androidEmulatorLifecycle = createAndroidEmulatorLifecycle({
    provisionAndroidAvd(discovery, input) {
        const args = ["create", "avd", "--name", input.avdName, "--package", input.systemImage, "--force"];
        if (input.deviceProfile) args.push("--device", input.deviceProfile);
        const diagnostic = runWithInput(discovery.native.avdmanager, args, "no\n", { timeout: 300_000 });
        return { ok: diagnostic.status === 0, diagnostic };
    },
    launchAndroidEmulator(discovery, device, input) {
        return spawnAndroidEmulator(discovery.native, device, ["-avd", device.avdName, ...(device.port ? ["-port", String(device.port)] : []), ...androidEmulatorStartArgs(device, input)]);
    },
    observeAndroidEmulator(discovery, device) {
        const serial = androidSerial(device);
        return { live: Boolean(discovery.native.adb && serial && run(discovery.native.adb, ["-s", serial, "get-state"]).status === 0) };
    },
    stopAndroidEmulator(discovery, device) {
        const serial = androidSerial(device);
        if (!discovery.native.adb || !serial) return null;
        const command = run(discovery.native.adb, ["-s", serial, "emu", "kill"]);
        return { ok: command.status === 0, diagnostic: { status: command.status, stdout: command.stdout, stderr: command.stderr } };
    },
    stopAndroidRecorder(discovery, device) {
        const serial = androidSerial(device);
        if (discovery.native.adb && serial) run(discovery.native.adb, ["-s", serial, "shell", "pkill", "-2", "screenrecord"]);
    },
    androidAvdHome,
    androidAvdIsInactive: (discovery,device) => androidAvdIsInactive(discovery.native,device),
    androidDeviceId,
    androidDiscovery: () => {
        const native = androidDiscovery();
        return {available:native.available,missing:native.missing,provisioningAvailable:native.provisioningAvailable,provisioningMissing:native.provisioningMissing,adbAvailable:Boolean(native.adb),native};
    },
    appiumPortForDevice,
    androidEmulatorSerial: port => `emulator-${port}`,
    approvedAndroidAvdRoot,
    claimAndroidDevice,
    deleteOwnedAndroidAvd,
    findAndroidDevice,
    isOwnedAvdName,
    isSafeDeviceProfile,
    isSafeProvisionedAvdName,
    isSafeSystemImage,
    listOwnedAndroidAvdArtifacts,
    liveAndroidEmulatorPortsForAllocation: discovery => liveAndroidEmulatorPortsForAllocation(discovery?.native),
    ownerAvdPrefix,
    ownerId,
    readAndroidDevices,
    refreshOwnedRuntimeProcessIdentity,
    resolveAndroidEmulatorPort,
    signalAndroidRecorder: runtime => signalOwnedRuntimeProcess(runtime,"SIGINT"),
    slug,
    terminateFreshAndroidEmulatorProcessTree,
    terminateOwnedRuntimeProcessTree,
    transitionAndroidDevice,
    waitForAndroidBoot: (discovery,device,timeoutMs,child) => waitForAndroidBoot(discovery.native,device,timeoutMs,child),
    waitForProcessExit,
    waitForProcessIdentity,
    runtimeId: () => randomUUID(),
    wallTimestamp: () => new Date().toISOString(),
});

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
    variant: "emulator",
    target(deviceId) {
        const target = ensureAdbDevice(deviceId);
        if (target.unknown) return { kind: "unknown" };
        if (target.error) return { kind: "refused", message: target.error };
        return { kind: "ready", target };
    },
    tap: (target, point) => run(target.adb, adbArgsForDevice(target.device, ["shell", "input", "tap", String(point.x), String(point.y)])),
    swipe: (target, swipe) => run(target.adb, adbArgsForDevice(target.device, ["shell", "input", "swipe", String(swipe.x1), String(swipe.y1), String(swipe.x2), String(swipe.y2), String(swipe.durationMs)])),
    typeText: (target, text) => run(target.adb, adbArgsForDevice(target.device, ["shell", "input", "text", String(text).replace(/\s/g, "%s")])),
    key: (target, key) => run(target.adb, adbArgsForDevice(target.device, ["shell", "input", "keyevent", String(key)])),
    disableAutoRotation: target => run(target.adb, adbArgsForDevice(target.device, ["shell", "settings", "put", "system", "accelerometer_rotation", "0"])),
    setRotation: (target, rotation) => run(target.adb, adbArgsForDevice(target.device, ["shell", "settings", "put", "system", "user_rotation", rotation])),
    upload: (target, localPath, remotePath, timeoutMs) => runWithTimeout(target.adb, adbArgsForDevice(target.device, ["push", localPath, remotePath]), timeoutMs),
    download: (target, remotePath, localPath, timeoutMs) => runWithTimeout(target.adb, adbArgsForDevice(target.device, ["pull", remotePath, localPath]), timeoutMs),
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

/** @param {import('../ports/mobile-app-management.mjs').AndroidAppEffect} effect */
function androidAppArguments(effect) {
    switch (effect.kind) {
        case "install": return effect.replace ? ["install", "-r", effect.path] : ["install", effect.path];
        case "launch-component": return ["shell", "am", "start", "-n", effect.component];
        case "launch-package": return ["shell", "monkey", "-p", effect.packageName, "1"];
        case "uninstall": return ["uninstall", effect.packageName];
        case "stop": return ["shell", "am", "force-stop", effect.packageName];
        case "clear-data": return ["shell", "pm", "clear", effect.packageName];
        case "permission": return ["shell", "pm", effect.action, effect.packageName, effect.permission];
        case "open-url": return ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", effect.url];
    }
}

/** Shared native recipe; prefix was resolved from the guarded native device.
 * @param {string} adb @param {string[]} prefix
 * @param {import('../ports/mobile-app-management.mjs').AndroidAppEffect} effect
 * @returns {import('../ports/mobile-app-management.mjs').AndroidAppCommandObservation} */
export function performAndroidAppEffect(adb, prefix, effect) {
    const args = [...prefix, ...androidAppArguments(effect)];
    const command = effect.kind === "install" && effect.helperTimeoutMs
        ? runWithTimeout(adb, args, androidHelperTimeoutMs(effect.helperTimeoutMs))
        : run(adb, args);
    const launch = effect.kind === "launch-component" || effect.kind === "launch-package";
    const launchFailed = launch && /(?:no activities found to run|monkey aborted|error:\s*(?:activity|unable to resolve intent)|activity class .* does not exist)/i.test(`${command.stdout || ""}\n${command.stderr || ""}`);
    return { kind: command.status === 0 && !launchFailed ? "succeeded" : "failed", command };
}

/** @type {import('../ports/mobile-app-management.mjs').AndroidAppManagementPorts<Extract<ReturnType<typeof ensureAdbDevice>,{device:unknown}>>} */
const androidAppManagementPorts = {
    variant: "emulator",
    target(deviceId) {
        const target = ensureAdbDevice(deviceId);
        if (target.unknown) return { kind: "unknown" };
        if (target.error) return { kind: "refused", message: target.error };
        return { kind: "ready", target };
    },
    perform: (target, effect) => performAndroidAppEffect(target.adb, adbArgsForDevice(target.device, []), effect),
};
const androidAppManagement = createAndroidAppManagement(androidAppManagementPorts);

/** @type {import('../ports/android-device-access.mjs').AndroidEmulatorAccessPorts<NonNullable<ReturnType<typeof findAndroidDevice>>, {adbAvailable:boolean,native:ReturnType<typeof androidDiscovery>}>} */
const androidDeviceAccessPorts = {
    variant: "emulator",
    device: id => findAndroidDevice(id),
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
        return jsonResult({deviceId:device.id,device:publicAndroidDevice(device),provider:"adb",appium,session:device.appium||null,lazy:true});
    }
    if (outcome.kind === "status") {
        const device = outcome.device, discovery = outcome.discovery.native;
        const facts = appiumDiscovery(discovery);
        const appium = {available:facts.available,missing:facts.missing,tools:{appium:facts.appium,adb:facts.adb}};
        return jsonResult({device:publicAndroidDevice(device),backend:androidBackend(discovery),appium,automation:{deviceId:device.id,provider:"adb",session:device.appium||null,lazy:true}});
    }
    if (outcome.kind === "executed") { const r = outcome.diagnostic; return jsonResult({stdout:r.stdout,stderr:r.stderr,status:r.status}); }
    if (outcome.kind === "ui") { const r=outcome.dump; return jsonResult({provider:"adb-uiautomator",source:outcome.source,remotePath:outcome.remotePath,stdout:r.stdout,stderr:r.stderr}); }
    const result = outcome.kind === "text-wait" ? presentAndroidTextWait(outcome.result) : presentAndroidAppWait(outcome.result);
    if ("error" in result) return fail(result.error);
    return outcome.kind === "text-wait" ? jsonResult({...result,text:outcome.text,provider:"adb-uiautomator"}) : jsonResult({...result,packageName:outcome.packageName,provider:"adb"});
}

/** @param {import('../ports/mobile-environment.mjs').EnvironmentCommandReceipt} command
 * @returns {import('../ports/mobile-environment.mjs').EnvironmentCommandObservation} */
export function androidEnvironmentObservation(command) {
    return { kind: command.status === 0 ? "succeeded" : "failed", command };
}

/** @type {import('../ports/mobile-environment.mjs').AndroidEmulatorEnvironmentPorts<Extract<ReturnType<typeof ensureAdbDevice>,{device:unknown}>>} */
const androidEnvironmentPorts = {
    variant: "emulator",
    target(deviceId) {
        const target = ensureAdbDevice(deviceId);
        if (target.unknown) return { kind: "unknown" };
        if (target.error) return { kind: "refused", message: target.error };
        return { kind: "ready", target };
    },
    setLocation(target, location) {
        const serial = androidSerial(target.device);
        if (!serial) return { kind: "unavailable" };
        const args = ["-s", serial, "emu", "geo", "fix", String(location.longitude), String(location.latitude)];
        if (location.altitude !== undefined) args.push(String(location.altitude));
        return androidEnvironmentObservation(run(target.adb, args));
    },
    setBattery(target, setting) {
        const field = setting.setting === "charging" ? "ac" : setting.setting;
        const value = setting.setting === "charging" ? setting.value ? "1" : "0" : String(setting.value);
        return androidEnvironmentObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "dumpsys", "battery", "set", field, value])));
    },
    tryAirplaneMode: (target, enabled) => androidEnvironmentObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "cmd", "connectivity", "airplane-mode", enabled ? "enable" : "disable"]))),
    setAirplaneSetting: (target, enabled) => androidEnvironmentObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "settings", "put", "global", "airplane_mode_on", enabled ? "1" : "0"]))),
    broadcastAirplaneMode: (target, enabled) => androidEnvironmentObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", enabled ? "true" : "false"]))),
    setRadio: (target, setting, enabled) => androidEnvironmentObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "svc", setting, enabled ? "enable" : "disable"]))),
    writeClipboard: (target, text) => androidEnvironmentObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "cmd", "clipboard", "set", text]))),
    readClipboard: target => androidEnvironmentObservation(run(target.adb, adbArgsForDevice(target.device, ["shell", "cmd", "clipboard", "get"]))),
};
const androidEnvironment = createAndroidEnvironment(androidEnvironmentPorts);

/** @param {import('../ports/mobile-environment.mjs').EnvironmentOutcome|undefined} outcome */
export function presentAndroidEnvironmentOutcome(outcome) {
    if (!outcome) return undefined;
    if (outcome.kind === "refused") return textResult(false, outcome.message);
    if (outcome.kind === "command-failure") return fail(outcome.command);
    switch (outcome.kind) {
        case "location-set": return jsonResult({ location: { latitude: outcome.location.latitude, longitude: outcome.location.longitude, altitude: outcome.location.altitude ?? null }, provider: "adb-emulator", stdout: outcome.command.stdout, stderr: outcome.command.stderr, status: outcome.command.status });
        case "battery-set": return jsonResult({ battery: { level: outcome.battery.level ?? null, status: outcome.battery.status ?? null, charging: outcome.battery.charging ?? null }, results: outcome.commands.map(command => ({ stdout: command.stdout, stderr: command.stderr, status: command.status })), provider: "adb" });
        case "airplane-set": return jsonResult({ airplaneMode: outcome.enabled, provider: "adb", method: outcome.route === "modern" ? "connectivity-shell" : "legacy-broadcast", stdout: outcome.command.stdout, stderr: outcome.command.stderr, status: outcome.command.status });
        case "network-set": return jsonResult({ network: { wifi: outcome.network.wifi ?? null, data: outcome.network.data ?? null, airplaneMode: outcome.network.airplaneMode ?? null }, provider: "adb" });
        case "network-failure": {
            const detail = outcome.stage === "airplane-setting" ? "airplaneMode.setting" : outcome.stage === "airplane-broadcast" ? "airplaneMode.broadcast" : outcome.stage;
            const applied = outcome.applied?.map(setting => setting === "airplane-setting" ? "airplaneMode.setting" : setting === "airplane" ? "airplaneMode" : setting);
            return jsonResult({ ok: false, error: "android-network-command-failed", detail, ...(applied === undefined ? {} : { applied }), status: outcome.command.status, stderr: outcome.command.stderr, ...(outcome.stage === "wifi" || outcome.stage === "data" ? { stdout: outcome.command.stdout } : {}) });
        }
        case "clipboard-set": return jsonResult({ clipboard: { set: true }, provider: "adb", stdout: outcome.command.stdout, stderr: outcome.command.stderr, status: outcome.command.status });
        case "clipboard-read": return jsonResult({ text: outcome.command.stdout, stderr: outcome.command.stderr, status: outcome.command.status, provider: "adb" });
        case "missing-prerequisites": return undefined;
    }
}

/** @param {import('../ports/mobile-app-management.mjs').AndroidAppOutcome | undefined} outcome
 * @param {import('../ports/mobile-app-management.mjs').AndroidAppVariant} variant @param {string} name */
export function presentAndroidAppOutcome(outcome, variant, name) {
    if (!outcome) return undefined;
    if (outcome.kind === "refused") return textResult(false, outcome.message);
    if (outcome.kind === "command-failure") return fail(outcome.command);
    const effect = outcome.effect;
    let payload;
    switch (effect.kind) {
        case "install": payload = { installed: effect.path }; break;
        case "launch-component": payload = { launched: effect.component }; break;
        case "launch-package": payload = { launched: effect.packageName }; break;
        case "uninstall": payload = { uninstalled: effect.packageName }; break;
        case "stop": payload = variant === "physical" ? { packageName: effect.packageName } : { stopped: effect.packageName }; break;
        case "clear-data": payload = variant === "physical" && name === "mobile_clear_app_data" ? { packageName: effect.packageName } : { reset: { packageName: effect.packageName } }; break;
        case "permission": payload = { permission: { packageName: effect.packageName, permission: effect.permission, action: effect.action } }; break;
        case "open-url": payload = { openedUrl: effect.url }; break;
    }
    return jsonResult({ ...payload, provider: "adb", stdout: outcome.command.stdout, stderr: outcome.command.stderr, status: outcome.command.status });
}


/** @param {import('../ports/android-control-transfer.mjs').AndroidControlOutcome | undefined} outcome */
function presentAndroidControlOutcome(outcome) {
    if (!outcome) return undefined;
    if (outcome.kind === "json") return jsonResult(outcome.payload);
    if (outcome.kind === "text") return textResult(false, outcome.message);
    return fail(outcome.command);
}

async function handleAndroidToolUnlocked(name, args) {
    if (!backendHintAllows(args, "android-emulator")) return undefined;
    switch (name) {
        case "device_inventory": { const value=deviceObservation.inventory(args); return value === undefined ? undefined : jsonResult(value); }


        case "device_create": {
            return presentAndroidLifecycleOutcome(await androidEmulatorLifecycle.create(args));
        }

        case "device_delete": {
            return presentAndroidLifecycleOutcome(await androidEmulatorLifecycle.delete(args));
        }

        case "device_status":
            return presentAndroidAccessOutcome(androidDeviceAccess.request(name, args));

        case "device_start": {
            return presentAndroidLifecycleOutcome(await androidEmulatorLifecycle.start(args));
        }

        case "device_stop": {
            return presentAndroidLifecycleOutcome(await androidEmulatorLifecycle.stop(args));
        }

        case "device_exec":
            return presentAndroidAccessOutcome(androidDeviceAccess.request(name, args));

        case "device_screenshot":
            return presentAndroidAccessOutcome(androidDeviceAccess.request(name, args));

        case "device_record_video_status":
        case "device_record_video_start":
        case "device_record_video_stop":
            return presentRecordingOutcome(await directRecording.request(name, args));


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
            return presentAndroidAppOutcome(androidAppManagement.request(name, args), "emulator", name);

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

        case "mobile_screenshot": {
            const { deviceId } = args;
            return handleAndroidTool("device_screenshot", { deviceId });
        }

        default:
            return undefined;
    }
}

export async function handleAndroidTool(name, args) {
    if (name === "device_create" && !backendHintAllows(args, "android-emulator")) return undefined;
    if (name === "device_record_video_start" && backendHintAllows(args, "android-emulator")
        && (args?.backend === "android-emulator" || findAndroidDevice(args?.deviceId))
        && recordingInputError("android-emulator", args?.timeLimitSec)) {
        return textResult(false, recordingInputError("android-emulator", args?.timeLimitSec));
    }
    if (!requiresOwnerDeviceOperation("android", name)) return handleAndroidToolUnlocked(name, args);
    const createsDevice = name === "device_create";
    const deviceId = typeof args?.deviceId === "string"
        ? args.deviceId
        : createsDevice && typeof args?.name === "string"
            ? androidDeviceId(args.name)
            : null;
    if (!deviceId) return handleAndroidToolUnlocked(name, args);
    if (!createsDevice && !findAndroidDevice(deviceId)) return handleAndroidToolUnlocked(name, args);
    try {
        const fencesAndroidPort = createsDevice || name === "device_start";
        return await withOwnerDeviceOperation("android", deviceId, () => fencesAndroidPort
            ? withAndroidEmulatorPortAllocation(() => handleAndroidToolUnlocked(name, args))
            : handleAndroidToolUnlocked(name, args));
    } catch (error) {
        if (error?.code !== "shared-mutation-lock-timeout") throw error;
        return textResult(false, `Android device operation lock failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const deviceObservation = createDeviceObservation({ kind: "android-emulator", ownerId: () => ownerId(), now: () => Date.now(), readPhysicalLeases: backend => observationPhysicalLeases(backend), capabilities: [
        "device_list_files",
        "device_inventory", "device_create", "device_delete", "device_start", "device_stop",
        "device_status", "device_exec", "device_screenshot",
        "device_record_video_start", "device_record_video_stop", "device_record_video_status",
        "device_upload", "device_download",
        "device_install_app", "device_launch_app",
        "mobile_session_status", "mobile_dump_ui", "mobile_tap",
        "mobile_double_tap", "mobile_long_press", "mobile_swipe",
        "mobile_drag",
        "mobile_type_text", "mobile_key", "mobile_home", "mobile_back",
        "mobile_forward", "mobile_recents", "mobile_power", "mobile_lock",
        "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right",
        "mobile_set_orientation", "mobile_open_url", "mobile_install_app",
        "mobile_launch_app", "mobile_uninstall_app", "mobile_stop_app",
        "mobile_clear_app_data", "mobile_grant_permission", "mobile_revoke_permission",
        "mobile_set_location", "mobile_set_battery", "mobile_set_network",
        "mobile_toggle_airplane_mode", "mobile_set_clipboard",
        "mobile_get_clipboard", "mobile_wait_for_text", "mobile_wait_for_app",
        "mobile_screenshot",
    ], executable: name => findAndroidTool(name), records: () => readAndroidDevices(), hostAvds: emulator => androidHostAvds(run(emulator, ["-list-avds"])), creationFacts: facts => androidCreationChoices(facts, androidSdkCandidates()) });
