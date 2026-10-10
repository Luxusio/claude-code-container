import { createAndroidControlTransfer } from "../application/android-control-transfer.mjs";
import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { publicObservationAndroidDevice } from "../domain/device-observation.mjs";
import { createAndroidEmulatorLifecycle } from "../application/lifecycle/android-emulator-lifecycle.mjs";
import { waitForAndroidText, waitForAndroidApp } from "./android-wait.mjs";
import { androidCreationChoices } from "./android-sdk-inventory.mjs";
import { spawn } from "child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "crypto";
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { commandPath, localBinPath, run, runBuffer, runWithInput, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { validateGuestPath, validateLocalOutputPath } from "../policy/files.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { resolveAndroidEmulatorPort, validAndroidEmulatorPort, withAndroidEmulatorPortAllocation } from "../state/android-emulator-port-allocation.mjs";
import { androidAvdHome, listOwnedAndroidAvdArtifacts, removeOwnedAndroidAvdArtifacts } from "../state/android-avd-storage.mjs";
import { readAndroidAvdIdentity } from "../state/android-avd-identity.mjs";
import { claimAndroidDevice, findAndroidDevice, mutateAndroidDevices, readAndroidDevices, transitionAndroidDevice, updateAndroidDevice } from "../state/android-state.mjs";
import { withOwnerDeviceOperation } from "../state/device-store.mjs";
import { requiresOwnerDeviceOperation } from "../state/device-operation-policy.mjs";
import { inspectProcessIdentity, readProcessIdentity, refreshOwnedRuntimeProcessIdentity, signalOwnedRuntimeProcess, terminateOwnedRuntimeProcessTree, waitForProcessIdentity } from "../state/process-identity.mjs";
import { claimRecordingFinalization, recordingGenerationMatches, transitionRecordingGeneration } from "../state/runtime-generation.mjs";
import { withTargetStatus } from "../status.mjs";
import { commitLocalOutputStage, createLocalOutputStage, stageLocalInputFile } from "../transfer-file.mjs";

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

function isPngBuffer(value) {
    const buffer = Buffer.from(value || []);
    return buffer.length >= 8
        && buffer[0] === 0x89
        && buffer[1] === 0x50
        && buffer[2] === 0x4e
        && buffer[3] === 0x47
        && buffer[4] === 0x0d
        && buffer[5] === 0x0a
        && buffer[6] === 0x1a
        && buffer[7] === 0x0a;
}

export function androidScreenshotResult(result) {
    const stdout = Buffer.from(result.stdout || []);
    if (stdout.length > 0 && isPngBuffer(stdout)) {
        return { content: [{ type: "image", data: stdout.toString("base64"), mimeType: "image/png" }] };
    }
    if (result.status !== 0) {
        return textResult(false, `Error: ${result.stderr?.toString() || stdout.toString() || `exit ${result.status}`}`);
    }
    return { content: [{ type: "image", data: stdout.toString("base64"), mimeType: "image/png" }] };
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
    const result = process.platform === "win32"
        ? run("powershell.exe", [
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

function setAndroidAirplaneMode(target, enabled) {
    const modern = runAdbDeviceCommand(target.device, target.adb, ["shell", "cmd", "connectivity", "airplane-mode", enabled ? "enable" : "disable"]);
    if (modern.ok) return jsonResult({ airplaneMode: enabled, provider: "adb", method: "connectivity-shell", stdout: modern.stdout, stderr: modern.stderr, status: modern.status });
    const put = runAdbDeviceCommand(target.device, target.adb, ["shell", "settings", "put", "global", "airplane_mode_on", enabled ? "1" : "0"]);
    if (!put.ok) return jsonResult({ ok: false, error: "android-network-command-failed", detail: "airplaneMode.setting", status: put.result.status, stderr: put.result.stderr });
    const broadcast = runAdbDeviceCommand(target.device, target.adb, ["shell", "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", enabled ? "true" : "false"]);
    if (!broadcast.ok) return jsonResult({ ok: false, error: "android-network-command-failed", detail: "airplaneMode.broadcast", applied: ["airplaneMode.setting"], status: broadcast.result.status, stderr: broadcast.result.stderr });
    return jsonResult({ airplaneMode: enabled, provider: "adb", method: "legacy-broadcast", stdout: broadcast.stdout, stderr: broadcast.stderr, status: broadcast.status });
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

function androidLifecycleConflict(deviceId, operation, transition, rollback = null) {
    return textResult(false, JSON.stringify({
        ok: false,
        error: "owner-device-state-conflict",
        backend: "android-emulator",
        deviceId,
        operation,
        found: transition.found,
        ...(rollback ? { rollback } : {}),
    }));
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

function reconcileAndroidRecording(device) {
    if (!device?.recording?.active || !device.recording.pid) return device;
    const observation = device.recording.processIdentity
        ? inspectProcessIdentity(device.recording.processIdentity, device.recording.pid)
        : null;
    const recorderIsCurrent = observation
        ? observation.status === "match" || observation.status === "unavailable"
        : processIsAlive(device.recording.pid);
    if (recorderIsCurrent) return device;
    const expected = device.recording;
    const pending = { ...expected, active: false, endedAt: new Date().toISOString() };
    return updateAndroidDevice(device.id, (item) => recordingGenerationMatches(expected, item.recording)
        ? { ...item, recording: pending, updatedAt: new Date().toISOString() }
        : item) || device;
}

function monitorAndroidRecordingExit(deviceId, recording) {
    return () => {
        transitionRecordingGeneration(updateAndroidDevice, deviceId, recording, {
            ...recording,
            active: false,
            endedAt: new Date().toISOString(),
        });
    };
}

function dumpAndroidUiWithAdb(device, adb) {
    const remotePath = `/sdcard/window-${device.id}.xml`;
    const dump = run(adb, adbArgsForDevice(device, ["shell", "uiautomator", "dump", remotePath]));
    if (dump.status !== 0) return { error: dump };

    let read = run(adb, adbArgsForDevice(device, ["exec-out", "cat", remotePath]));
    if (read.status !== 0) {
        read = run(adb, adbArgsForDevice(device, ["shell", "cat", remotePath]));
    }
    if (read.status !== 0) return { error: read };

    return {
        source: read.stdout,
        remotePath,
        dump,
        read,
    };
}



export function listAndroidDevices() { return deviceObservation.owned(); }

const androidEmulatorLifecycle = createAndroidEmulatorLifecycle({
    androidAvdHome,
    androidAvdIsInactive,
    androidDeviceId,
    androidDiscovery,
    androidEmulatorStartArgs,
    androidLifecycleConflict,
    androidSerial,
    appiumPortForDevice,
    approvedAndroidAvdRoot,
    claimAndroidDevice,
    deleteOwnedAndroidAvd,
    fail,
    findAndroidDevice,
    isOwnedAvdName,
    isSafeDeviceProfile,
    isSafeProvisionedAvdName,
    isSafeSystemImage,
    jsonResult,
    listOwnedAndroidAvdArtifacts,
    liveAndroidEmulatorPortsForAllocation,
    ownerAvdPrefix,
    ownerId,
    publicAndroidDevice,
    readAndroidDevices,
    refreshOwnedRuntimeProcessIdentity,
    resolveAndroidEmulatorPort,
    run,
    runWithInput,
    signalOwnedRuntimeProcess,
    slug,
    spawnAndroidEmulator,
    terminateFreshAndroidEmulatorProcessTree,
    terminateOwnedRuntimeProcessTree,
    textResult,
    transitionAndroidDevice,
    waitForAndroidBoot,
    waitForProcessExit,
    waitForProcessIdentity,
    runtimeId: () => randomUUID(),
    wallTimestamp: () => new Date().toISOString(),
});

/** @typedef {ReturnType<typeof ensureAdbDevice>} AndroidControlTarget */
/** @typedef {ReturnType<typeof stageLocalInputFile>} AndroidControlInputStage */
/** @typedef {ReturnType<typeof createLocalOutputStage>} AndroidControlOutputStage */
/** @type {import('../ports/android-control-transfer.mjs').AndroidControlTransferPorts<AndroidControlTarget,AndroidControlInputStage,AndroidControlOutputStage>} */
const androidControlTransferPorts = {
    variant: "emulator",
    target(deviceId) {
        const target = ensureAdbDevice(deviceId);
        if (target.unknown) return { kind: "unknown" };
        if (target.error) return { kind: "refused", message: target.error };
        return { kind: "ready", target };
    },
    execute: (target, args) => run(target.adb, adbArgsForDevice(target.device, args)),
    transfer: (target, args, timeoutMs) => runWithTimeout(target.adb, adbArgsForDevice(target.device, args), timeoutMs),
    guestPath: (value, label) => {
        const policy = validateGuestPath(value, { label, platform: "posix" });
        return policy.ok ? { ok: true, path: policy.path } : { ok: false, message: policy.message };
    },
    stageInput(value) {
        const stage = stageLocalInputFile(value, { label: "upload-local-path" });
        return stage.ok
            ? { ok: true, path: stage.path, stagedPath: stage.stagedPath, handle: stage }
            : { ok: false, message: stage.message };
    },
    stageOutput(value) {
        const stage = createLocalOutputStage(value, { label: "download-local-path" });
        return stage.ok
            ? { ok: true, path: stage.path, stagedPath: stage.stagedPath, handle: stage }
            : { ok: false, message: stage.message };
    },
    commitOutput(stage) {
        const result = commitLocalOutputStage(stage, { label: "download-local-path" });
        return result.ok ? { ok: true, path: result.path } : { ok: false, message: result.message };
    },
    disposeInput(stage) { stage.cleanup(); return undefined; },
    disposeOutput(stage) { stage.cleanup(); return undefined; },
};
const androidControlTransfer = createAndroidControlTransfer(androidControlTransferPorts);

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
            return androidEmulatorLifecycle.create(args);
        }

        case "device_delete": {
            return androidEmulatorLifecycle.delete(args);
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;
            const discovery = androidDiscovery();
            return jsonResult({ device: publicAndroidDevice(device), backend: androidBackend(discovery), appium: appiumBackendStatus(discovery), automation: { deviceId, provider: "adb", session: device.appium || null, lazy: true } });
        }

        case "device_start": {
            return androidEmulatorLifecycle.start(args);
        }

        case "device_stop": {
            return androidEmulatorLifecycle.stop(args);
        }

        case "device_exec": {
            const { deviceId, command } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;

            const discovery = androidDiscovery();
            if (!discovery.adb) return textResult(false, "Android backend missing prerequisites: adb");

            const r = run(discovery.adb, adbArgsForDevice(device, ["shell", command]));
            return r.status === 0 ? jsonResult({ stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "device_screenshot": {
            const { deviceId } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;

            const discovery = androidDiscovery();
            if (!discovery.adb) return textResult(false, "Android backend missing prerequisites: adb");

            const r = runBuffer(discovery.adb, adbArgsForDevice(device, ["exec-out", "screencap", "-p"]), {
                maxBuffer: ANDROID_SCREENSHOT_MAX_BUFFER_BYTES,
                timeout: ANDROID_SCREENSHOT_TIMEOUT_MS,
            });
            return androidScreenshotResult(r);
        }

        case "device_record_video_status": {
            const { deviceId } = args;
            const found = findAndroidDevice(deviceId);
            const device = reconcileAndroidRecording(found);
            if (!device) return undefined;
            return jsonResult({ deviceId, recording: device.recording || null, provider: "adb-screenrecord" });
        }

        case "device_record_video_start": {
            const { deviceId, remotePath, localPath, timeLimitSec = 180 } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;
            if (device.recording) {
                const state = device.recording.active ? "already active" : "pending finalization";
                return textResult(false, `Android recording ${state} for ${deviceId}`);
            }

            const discovery = androidDiscovery();
            if (!discovery.adb) return textResult(false, "Android backend missing prerequisites: adb");

            const resolvedRemotePath = remotePath || `/sdcard/ccc-${device.id}-recording.mp4`;
            const resolvedLocalPath = localPath || androidRecordingLocalPath(device);
            const localPolicy = validateLocalOutputPath(resolvedLocalPath, { label: "recording-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const safeLocalPath = localPolicy.path;
            mkdirSync(androidRecordingDir(device), { recursive: true });
            mkdirSync(dirname(safeLocalPath), { recursive: true });
            const child = spawn(discovery.adb, adbArgsForDevice(device, ["shell", "screenrecord", "--time-limit", String(timeLimitSec), resolvedRemotePath]), {
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
                if (recording) monitorAndroidRecordingExit(deviceId, recording)();
            });
            const startError = await waitForRecorderProcess(child, "Android screenrecord");
            if (startError) return startError;
            const processIdentity = readProcessIdentity(child.pid);
            if (!processIdentity) {
                try { child.kill("SIGINT"); } catch { /* recorder already exited */ }
                return textResult(false, `Android recorder process identity could not be established for ${deviceId}.`);
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
                startedAt: new Date().toISOString(),
            };
            child.unref();
            const committed = transitionRecordingGeneration(updateAndroidDevice, deviceId, device.recording ?? null, recording);
            if (!committed.committed) {
                try { child.kill("SIGINT"); } catch { /* recorder already exited */ }
                return textResult(false, `Android recording state changed while starting for ${deviceId}; the new recorder was stopped.`);
            }
            if (exited || !processIsAlive(child.pid)) {
                transitionRecordingGeneration(updateAndroidDevice, deviceId, recording, null);
                return textResult(false, `Android recorder exited before its state was committed for ${deviceId}.`);
            }
            return jsonResult({ deviceId, recording: committed.device.recording });
        }

        case "device_record_video_stop": {
            const { deviceId, localPath } = args;
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;
            if (!device.recording) return textResult(false, `No Android recording active for ${deviceId}`);

            const discovery = androidDiscovery();
            if (!discovery.adb) return textResult(false, "Android backend missing prerequisites: adb");

            const resolvedLocalPath = localPath || device.recording.localPath || androidRecordingLocalPath(device);
            const localPolicy = validateLocalOutputPath(resolvedLocalPath, { label: "recording-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const safeLocalPath = localPolicy.path;
            const previous = device.recording;
            if (previous.active) {
                const recorderSignal = signalOwnedRuntimeProcess(previous, "SIGINT");
                run(discovery.adb, adbArgsForDevice(device, ["shell", "pkill", "-2", "screenrecord"]));
                if (recorderSignal.signaled) {
                    const exited = await waitForProcessExit(previous.pid, 3000);
                    if (!exited) return textResult(false, `Android recording did not exit within 3000ms for ${deviceId}; state remains active.`);
                }
            }
            const claimed = claimRecordingFinalization(updateAndroidDevice, deviceId, previous, { localPath: safeLocalPath });
            if (!claimed.committed || !claimed.device?.recording) {
                return textResult(false, `Android recording state changed while stopping for ${deviceId}; successor state was preserved.`);
            }
            const pending = claimed.device.recording;
            mkdirSync(androidRecordingDir(device), { recursive: true });
            mkdirSync(dirname(safeLocalPath), { recursive: true });
            const localStage = createLocalOutputStage(safeLocalPath, { label: "recording-local-path" });
            if (!localStage.ok) return textResult(false, localStage.message);
            try {
                const pull = runWithTimeout(discovery.adb, adbArgsForDevice(device, ["pull", pending.remotePath, localStage.stagedPath]), ANDROID_TRANSFER_TIMEOUT_MS);
                if (pull.status !== 0) {
                    return textResult(false, `Error: ${pull.stderr || pull.stdout || `exit ${pull.status}`}. Android recording remains pending finalization for ${deviceId}.`);
                }
                const committed = commitLocalOutputStage(localStage, { label: "recording-local-path", minBytes: 1 });
                if (!committed.ok) {
                    return textResult(false, `${committed.message}. Android recording remains pending finalization for ${deviceId}.`);
                }
                const cleared = transitionRecordingGeneration(updateAndroidDevice, deviceId, pending, null);
                const updated = cleared.device;
                if (!cleared.committed) {
                    return textResult(false, `Android recording state changed while stopping for ${deviceId}; successor state and remote artifact were preserved.`);
                }
                runWithTimeout(discovery.adb, adbArgsForDevice(device, ["shell", "rm", "-f", pending.remotePath]), ANDROID_TRANSFER_TIMEOUT_MS);
                return jsonResult({
                    deviceId,
                    stopped: true,
                    provider: "adb-screenrecord",
                    recording: { ...pending, active: false, localPath: safeLocalPath, stoppedAt: new Date().toISOString() },
                    device: updated,
                    stdout: pull.stdout,
                    stderr: pull.stderr,
                    status: pull.status,
                });
            } finally {
                localStage.cleanup();
            }
        }

        case "device_upload":
        case "device_download":
            return presentAndroidControlOutcome(androidControlTransfer.request(name, args));

        case "device_install_app": {
            const { deviceId, path, replace = true, helperTimeoutMs } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const installArgs = replace ? ["install", "-r", path] : ["install", path];
            return adbJsonResult(target.device, target.adb, installArgs, { installed: path, provider: "adb" }, { timeoutMs: helperTimeoutMs });
        }

        case "device_launch_app": {
            const { deviceId, packageName, component } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (component) {
                return adbJsonResult(target.device, target.adb, ["shell", "am", "start", "-n", component], { launched: component, provider: "adb" }, { validateLaunch: true });
            }
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
            const device = findAndroidDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({
                deviceId,
                device: publicAndroidDevice(device),
                provider: "adb",
                appium: appiumBackendStatus(),
                session: device.appium || null,
                lazy: true,
            });
        }

        case "mobile_dump_ui": {
            const { deviceId } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;

            const dump = dumpAndroidUiWithAdb(target.device, target.adb);
            if (dump.error) return fail(dump.error);
            return jsonResult({
                provider: "adb-uiautomator",
                source: dump.source,
                remotePath: dump.remotePath,
                stdout: dump.dump.stdout,
                stderr: dump.dump.stderr,
            });
        }

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

        case "mobile_rotate_left": {
            const { deviceId } = args;
            return handleAndroidTool("mobile_set_orientation", { deviceId, orientation: "landscape" });
        }

        case "mobile_rotate_right": {
            const { deviceId } = args;
            return handleAndroidTool("mobile_set_orientation", { deviceId, orientation: "reverse-landscape" });
        }

        case "mobile_open_url": {
            const { deviceId, url } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return adbJsonResult(target.device, target.adb, ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], { openedUrl: url, provider: "adb" });
        }

        case "mobile_install_app": {
            const { deviceId, path, helperTimeoutMs } = args;
            return handleAndroidTool("device_install_app", { deviceId, path, helperTimeoutMs });
        }

        case "mobile_launch_app": {
            const { deviceId, packageName, component } = args;
            return handleAndroidTool("device_launch_app", { deviceId, packageName, component });
        }

        case "mobile_uninstall_app": {
            const { deviceId, packageName } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!packageName) return textResult(false, "Android app uninstall requires packageName");
            return adbJsonResult(target.device, target.adb, ["uninstall", packageName], { uninstalled: packageName, provider: "adb" });
        }

        case "mobile_stop_app": {
            const { deviceId, packageName } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (!packageName) return textResult(false, "Android app stop requires packageName");
            return adbJsonResult(target.device, target.adb, ["shell", "am", "force-stop", packageName], { stopped: packageName, provider: "adb" });
        }

        case "mobile_clear_app_data": {
            const { deviceId, packageName } = args;
            return handleAndroidTool("device_reset", { deviceId, packageName });
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

        case "mobile_set_location": {
            const { deviceId, latitude, longitude, altitude } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const serial = androidSerial(target.device);
            if (!serial) return textResult(false, "Android location requires an emulator serial or port");
            const geoArgs = ["-s", serial, "emu", "geo", "fix", String(longitude), String(latitude)];
            if (altitude !== undefined) geoArgs.push(String(altitude));
            const r = run(target.adb, geoArgs);
            return r.status === 0 ? jsonResult({ location: { latitude, longitude, altitude: altitude ?? null }, provider: "adb-emulator", stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "mobile_set_battery": {
            const { deviceId, level, charging, status } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            const commands = [];
            if (level !== undefined) commands.push(["shell", "dumpsys", "battery", "set", "level", String(level)]);
            if (status !== undefined) commands.push(["shell", "dumpsys", "battery", "set", "status", String(status)]);
            if (charging !== undefined) commands.push(["shell", "dumpsys", "battery", "set", "ac", charging ? "1" : "0"]);
            if (commands.length === 0) return textResult(false, "Android battery control requires level, status, or charging");
            const results = [];
            for (const command of commands) {
                const r = runAdbDeviceCommand(target.device, target.adb, command);
                if (!r.ok) return fail(r.result);
                results.push({ stdout: r.stdout, stderr: r.stderr, status: r.status });
            }
            return jsonResult({ battery: { level: level ?? null, status: status ?? null, charging: charging ?? null }, results, provider: "adb" });
        }

        case "mobile_set_network": {
            const { deviceId, wifi, data, airplaneMode } = args;
            const fields = ["airplaneMode", "wifi", "data"];
            if (!fields.some(key => args[key] !== undefined) || fields.some(key => args[key] !== undefined && typeof args[key] !== "boolean")) {
                return textResult(false, "Android network control requires boolean wifi, data or airplaneMode");
            }
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            if (airplaneMode !== undefined) {
                const result = setAndroidAirplaneMode(target, airplaneMode);
                if (result.isError) return result;
            }
            const commands = [];
            if (wifi !== undefined) commands.push(["wifi", ["shell", "svc", "wifi", wifi ? "enable" : "disable"]]);
            if (data !== undefined) commands.push(["data", ["shell", "svc", "data", data ? "enable" : "disable"]]);
            const applied = airplaneMode === undefined ? [] : ["airplaneMode"];
            for (const [setting, command] of commands) {
                const r = runAdbDeviceCommand(target.device, target.adb, command);
                if (!r.ok) return jsonResult({ ok: false, error: "android-network-command-failed", detail: setting, applied, status: r.result.status, stderr: r.result.stderr, stdout: r.result.stdout });
                applied.push(setting);
            }
            return jsonResult({ network: { wifi: wifi ?? null, data: data ?? null, airplaneMode: airplaneMode ?? null }, provider: "adb" });
        }

        case "mobile_toggle_airplane_mode": {
            const { deviceId, enabled } = args;
            const target = ensureAdbDevice(deviceId);
            const unavailable = adbTargetResult(target);
            if (unavailable !== null) return unavailable;
            return setAndroidAirplaneMode(target, enabled);
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
        && args?.timeLimitSec !== undefined
        && (!Number.isInteger(args.timeLimitSec) || args.timeLimitSec < 1 || args.timeLimitSec > 180)) {
        return textResult(false, "Android recording timeLimitSec must be an integer from 1 to 180");
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
    ], executable: name => findAndroidTool(name), records: () => readAndroidDevices(), avdResult: emulator => run(emulator, ["-list-avds"]), creationFacts: facts => androidCreationChoices(facts, androidSdkCandidates()) });
