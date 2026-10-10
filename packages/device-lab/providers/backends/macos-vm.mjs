import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { observationMacosHelper, observationMacosStartArgs } from "../domain/device-observation.mjs";
import { createMacosVmLifecycleApplication } from "../application/lifecycle/macos-vm-lifecycle.mjs";
import { macosProviderInstanceReferenced, managedProviderResource, snapshotProviderInstances, restoreRecoveryProviderInstances } from "../domain/lifecycle/macos-vm-lifecycle.mjs";
import { MACOS_WINDOW_JXA } from "./macos-window-focus.mjs";
import { createDesktopControlTransfer } from "../application/desktop-control-transfer.mjs";
import { commandPath, run, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { validateGuestPath, validateLocalOutputPath, validateLocalReferencePath } from "../policy/files.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { screenshotFileResult } from "../screenshot-file.mjs";
import { claimMacosDevice, findMacosDevice, readMacosDevices, transitionMacosDevice, updateMacosDevice } from "../state/macos-state.mjs";
import { withOwnerDeviceOperation, withOwnerDeviceOperations } from "../state/device-store.mjs";
import { requiresOwnerDeviceOperation } from "../state/device-operation-policy.mjs";
import { inspectProcessIdentity, readProcessIdentity, signalOwnedRuntimeProcess } from "../state/process-identity.mjs";
import { claimRecordingFinalization, recordingGenerationMatches, transitionRecordingGeneration } from "../state/runtime-generation.mjs";
import { commitLocalOutputStage, createLocalOutputStage, stageLocalInputFile } from "../transfer-file.mjs";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import {
    closeSync,
    constants as fsConstants,
    existsSync,
    fchmodSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

const PROVIDERS = [
    {
        name: "tart",
        command: "tart",
        startArgs: (instance, options = {}) => observationMacosStartArgs("tart", instance, options),
        stopArgs: (instance) => ["stop", instance],
        deleteArgs: (instance) => ["delete", instance],
    },
    {
        name: "vz",
        command: "vz",
        startArgs: (instance) => observationMacosStartArgs("vz", instance),
        stopArgs: (instance) => ["stop", instance],
        deleteArgs: (instance) => ["delete", instance],
    },
    {
        name: "utmctl",
        command: "utmctl",
        startArgs: (instance) => observationMacosStartArgs("utmctl", instance),
        stopArgs: (instance) => ["stop", instance],
        deleteArgs: (instance) => ["delete", instance],
    },
];

const MACOS_PROVIDER_TIMEOUTS = {
    clone: 600000,
    delete: 60000,
    stop: 60000,
    ip: 10000,
};
const MACOS_HELPER_TIMEOUT_MS = 30000;
const MACOS_LIFECYCLE_CLAIM_TTL_MS = 15 * 60 * 1000;
const tartFeatureCache = new Map();

// Lazy native leaf selection retains imported-callee timing and bare calls.
const macosVmLifecycle = createMacosVmLifecycleApplication({
    get read() { return readMacosDevices; },
    get find() { return findMacosDevice; },
    get claim() { return claimMacosDevice; },
    get transition() { return transitionMacosDevice; },
    get owner() { return ownerId; },
    get deviceId() { return macosDeviceId; },
    get runtimeId() { return randomUUID; },
    get claimTtlMs() { return macosLifecycleClaimTtlMs; },
    get validateSshKey() { return validateMacosSshKeyPath; },
    get helperMetadata() { return macosHelperMetadata; },
    get providerPlan() { return macosProviderPlan; },
    get tartPlan() { return tartProviderPlan; },
    get publicDevice() { return deviceWithPlan; },
    get providerCommand() { return runProviderCommand; },
    get commandTimedOut() { return providerCommandTimedOut; },
    get supportsFeature() { return tartSupportsFeature; },
    get waitProviderStart() { return waitForProviderStart; },
    get waitBoot() { return waitForMacosBoot; },
    get waitGuestHelper() { return waitForMacosGuestHelper; },
    get provisionHelper() { return provisionMacosGuestHelper; },
    get signalRecording() { return signalOwnedRuntimeProcess; },
    get waitRecordingExit() { return waitForOwnedRecordingExit; },
    get sshBridge() { return sshBridge; },
    get sshBaseArgs() { return sshBaseArgs; },
    get shellQuote() { return shellQuote; },
    get sshCommandOptions() { return sshCommandOptions; },
    get helperCommand() { return runHelperCommand; },
    get textResult() { return textResult; },
    get jsonResult() { return jsonResult; },
    get fail() { return fail; },
    timestamp: () => new Date().toISOString(),
    now: () => Date.now(),
    get parseLifecycleClaimedAt() {
        const clock = Date;
        const parse = clock.parse;
        /** @param {string} value */
        return (value) => {
            // Property lookup precedes argument evaluation; only the native call
            // happens here, retaining its receiver and noncallability error.
            const Date = { parse };
            if (typeof parse !== "function") return Date.parse(value);
            return Reflect.apply(parse, clock, [value]);
        };
    },
    get tartStartArgs() { return providerByName("tart").startArgs; },
    get spawn() {
        const launch = spawn;
        return (command, args) => launch(command, args, {
            detached: true,
            stdio: "ignore",
            env: process.env,
            windowsHide: true,
        });
    },
});


function macosProviderTimeoutMs(kind) {
    const envKey = `CCC_MACOS_VM_${kind.toUpperCase()}_TIMEOUT_MS`;
    const value = Number(process.env[envKey] || MACOS_PROVIDER_TIMEOUTS[kind] || 30000);
    return Number.isFinite(value) && value > 0 ? value : MACOS_PROVIDER_TIMEOUTS[kind] || 30000;
}

function runProviderCommand(command, args, kind) {
    return runWithTimeout(command, args, macosProviderTimeoutMs(kind));
}

function providerCommandTimedOut(result) {
    return result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM" || result?.signal === "SIGKILL";
}

function tartSupportsFeature(command, feature) {
    const key = `${command}:${feature}`;
    if (tartFeatureCache.has(key)) return tartFeatureCache.get(key);
    const result = runWithTimeout(command, ["run", "--help"], 5000);
    const supported = result.status === 0 && `${result.stdout || ""}\n${result.stderr || ""}`.includes(feature);
    tartFeatureCache.set(key, supported);
    return supported;
}

function macosHelperTimeoutMs(value) {
    const parsed = Number(value || process.env.CCC_MACOS_VM_HELPER_TIMEOUT_MS || MACOS_HELPER_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : MACOS_HELPER_TIMEOUT_MS;
}

function runHelperCommand(command, args, timeoutMs, options = {}) {
    return runWithTimeout(command, args, macosHelperTimeoutMs(timeoutMs), options);
}



function macosDiscovery() { return deviceObservation.discovery(); }

export function macosBackend(discovery = macosDiscovery()) { return deviceObservation.backend(discovery); }

function macosDeviceId(name) {
    return `macos-${slug(name)}`;
}

function macosSnapshotId(name) {
    return `snapshot-${slug(name)}`;
}

function macosWorkspaceDir(device) {
    if (typeof device?.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(device.id)) {
        throw new Error("macos-workspace-device-id-invalid");
    }
    const owner = ownerId();
    if (typeof owner !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(owner)) {
        throw new Error("macos-workspace-owner-id-invalid");
    }
    return join(homedir(), ".ccc/devices/owners", owner, "macos", device.id);
}

function macosToolsDir(device) {
    return join(macosWorkspaceDir(device), "tools");
}

function macosRecordingDir(device) {
    return join(macosWorkspaceDir(device), "recordings");
}

function macosRecordingLocalPath(device) {
    return join(macosRecordingDir(device), `recording-${Date.now()}.mov`);
}

function ensureMacosDirectory(directory) {
    const home = resolve(homedir());
    const target = resolve(directory);
    const child = relative(home, target);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new Error("macos-workspace-path-outside-home");
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
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("macos-workspace-directory-invalid");
        }
    } catch (error) {
        if (error?.message === "macos-workspace-directory-invalid") throw error;
        throw new Error("macos-workspace-directory-unavailable", { cause: error });
    }
}

function ensureMacosWorkspace(device) {
    ensureMacosDirectory(macosToolsDir(device));
    ensureMacosDirectory(macosRecordingDir(device));
}

function writeMacosExecutableArtifact(path, value, options = {}) {
    const directory = dirname(path);
    ensureMacosDirectory(directory);
    const content = Buffer.from(value, "utf8");
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const randomId = options.randomId?.() ?? randomUUID().replace(/-/g, "");
        if (!/^[a-f0-9]{32}$/.test(randomId)) throw new Error("macos-artifact-random-id-invalid");
        const temporaryPath = join(directory, `.${basename(path)}.${randomId}.tmp`);
        let descriptor = null;
        let created = false;
        let renamed = false;
        try {
            descriptor = openSync(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o700);
            created = true;
            let offset = 0;
            while (offset < content.length) {
                const count = writeSync(descriptor, content, offset, content.length - offset);
                if (count <= 0) throw new Error("macos-artifact-write-failed");
                offset += count;
            }
            try { fchmodSync(descriptor, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
            const opened = fstatSync(descriptor);
            const current = lstatSync(temporaryPath);
            ensureMacosDirectory(directory);
            if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
                || opened.nlink !== 1 || current.nlink !== 1
                || opened.size !== content.length || current.size !== content.length
                || (opened.dev !== 0 && current.dev !== 0 && opened.dev !== current.dev)
                || (opened.ino !== 0 && current.ino !== 0 && opened.ino !== current.ino)) {
                throw new Error("macos-artifact-file-invalid");
            }
            closeSync(descriptor);
            descriptor = null;
            ensureMacosDirectory(directory);
            renameSync(temporaryPath, path);
            renamed = true;
            const installed = lstatSync(path);
            if (!installed.isFile() || installed.isSymbolicLink() || installed.nlink !== 1
                || installed.size !== content.length
                || (opened.dev !== 0 && installed.dev !== 0 && opened.dev !== installed.dev)
                || (opened.ino !== 0 && installed.ino !== 0 && opened.ino !== installed.ino)) {
                throw new Error("macos-artifact-install-invalid");
            }
            return path;
        } catch (error) {
            if (descriptor !== null) closeSync(descriptor);
            if (created && !renamed) {
                try { unlinkSync(temporaryPath); } catch { /* remove only the temporary file created by this attempt */ }
            }
            if (error?.code === "EEXIST") continue;
            if (error?.message?.startsWith("macos-")) throw error;
            throw new Error("macos-artifact-create-failed", { cause: error });
        }
    }
    throw new Error("macos-artifact-create-failed");
}

function macosHelperMetadata(device) { return observationMacosHelper(device,macosObservationHelperPaths(device)); }





function providerByName(name) {
    return PROVIDERS.find((provider) => provider.name === name);
}

function macosProviderPlan(device,discovery=macosDiscovery()) { return deviceObservation.plan(device,discovery); }

function deviceWithPlan(device,discovery) { return deviceObservation.project(device,discovery); }

function helperRequiredResult(device, toolName) {
    return textResult(false, `macOS VM ${toolName} requires SSH bridge metadata. Configure sshUser plus sshHost, or start a Tart VM with waitForBoot so the host can be inferred from tart ip. Optional fields: sshPort, sshKeyPath, sshPassword. Workspace: ${macosWorkspaceDir(device)}`);
}

function unsupportedProviderResult(deviceOrProvider, toolName) {
    const provider = typeof deviceOrProvider === "string" ? deviceOrProvider : deviceOrProvider.provider || "auto";
    return textResult(false, `macOS VM ${toolName} is not supported for provider ${provider}; Tart is currently required for image and snapshot operations.`);
}

function tartProviderPlan(device, toolName) {
    const plan = macosProviderPlan(device);
    if (!plan.available) return { error: textResult(false, `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`) };
    if (plan.selectedProvider !== "tart") return { error: unsupportedProviderResult({ ...device, provider: plan.selectedProvider || device.provider }, toolName) };
    return { plan };
}

function usesDefaultTartMacosCredentials({ provider, image }) {
    const selectedProvider = !provider || provider === "auto" ? "tart" : provider;
    if (selectedProvider !== "tart") return false;
    const value = String(image || "");
    return value === "ccc-macos-base" ||
        /^ghcr\.io\/cirruslabs\/macos-[^:]+(?:[:@].*)?$/.test(value) ||
        /^macos-[^-]+-base$/.test(value);
}

function macosSshConfig({ sshHost, sshPort = 22, sshUser, sshKeyPath, sshPassword, provider, image }) {
    const useDefaultPassword = usesDefaultTartMacosCredentials({ provider, image }) && !sshHost && !sshUser && !sshKeyPath && !sshPassword;
    return sshHost || sshUser || sshKeyPath || sshPassword || useDefaultPassword ? {
        host: sshHost || null,
        port: sshPort,
        user: sshUser || (useDefaultPassword ? "admin" : null),
        keyPath: sshKeyPath || null,
        password: sshPassword || (useDefaultPassword ? "admin" : null),
    } : null;
}

function validateMacosSshKeyPath(sshKeyPath) {
    return validateLocalReferencePath(sshKeyPath, { label: "ssh-key-path" });
}

function macosDeviceDefinition({ id, name, provider, image, memoryMb, cpus, ssh, extra = {} }) {
    return {
        id,
        name,
        backend: "macos-vm",
        kind: "desktop",
        platform: "macos",
        ownerId: ownerId(),
        provider,
        image,
        memoryMb,
        cpus,
        providerInstance: `ccc-${ownerId()}-${id}`,
        ssh,
        helper: macosHelperMetadata({ id, ssh }),
        status: "stopped",
        creatable: true,
        snapshots: [],
        recording: null,
        ...extra,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

function findSnapshot(device, snapshotName, snapshotId) {
    const snapshots = Array.isArray(device.snapshots) ? device.snapshots : [];
    const wantedId = snapshotId || (snapshotName ? macosSnapshotId(snapshotName) : null);
    return snapshots.find((snapshot) => snapshot.id === wantedId || snapshot.name === snapshotName);
}

function macosLifecycleConflict(deviceId, operation, transition, rollback = null) {
    return macosVmLifecycle.conflict(deviceId, operation, transition, rollback);
}

function macosLifecycleReplacement(device, lifecycle, updates = {}) {
    return macosVmLifecycle.replacement(device, lifecycle, updates);
}

function claimMacosLifecycle(deviceId, device, operation, updates = {}) {
    return macosVmLifecycle.claimLifecycle(deviceId, device, operation, updates);
}

function macosLifecycleClaimTtlMs() {
    const parsed = Number(process.env.CCC_MACOS_VM_LIFECYCLE_CLAIM_TTL_MS || MACOS_LIFECYCLE_CLAIM_TTL_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : MACOS_LIFECYCLE_CLAIM_TTL_MS;
}


function recoverStaleMacosLifecycle(deviceId) {
    return macosVmLifecycle.recoverStale(deviceId);
}

function currentMacosLifecycleDevice(deviceId, lifecycle) {
    return macosVmLifecycle.currentLifecycleDevice(deviceId, lifecycle);
}

function abortMacosLifecycle(deviceId, lifecycle, original, updates = {}) {
    return macosVmLifecycle.abortLifecycle(deviceId, lifecycle, original, updates);
}

function transitionCurrentMacosLifecycle(deviceId, lifecycle, updater) {
    return macosVmLifecycle.transitionCurrent(deviceId, lifecycle, updater);
}

function rollbackStartedMacosVm(deviceId, lifecycle, plan) {
    return macosVmLifecycle.rollbackStarted(deviceId, lifecycle, plan);
}


function rollbackCreatedMacosResource(deviceId, plan, instance) {
    return macosVmLifecycle.rollbackCreated(deviceId, plan, instance);
}




function tartDeleteInstance(plan, instance) {
    return runProviderCommand(plan.providerCommand, ["delete", instance], "delete");
}

function runTartClone(plan, source, target) {
    return macosVmLifecycle.clone(plan, source, target);
}

function tartCloneFailure(result, cleanup, target) {
    return macosVmLifecycle.cloneFailure(result, cleanup, target);
}

function sshDiscovery() {
    const ssh = commandPath("ssh");
    const scp = commandPath("scp");
    const missing = [];
    if (!ssh) missing.push("ssh");
    if (!scp) missing.push("scp");
    return { ssh, scp, available: missing.length === 0, missing };
}

function sshTarget(device) {
    if (!device.ssh?.host || !device.ssh?.user) return null;
    return `${device.ssh.user}@${device.ssh.host}`;
}

function sshBaseArgs(device) {
    const args = [];
    if (device.ssh?.keyPath) args.push("-i", device.ssh.keyPath);
    if (device.ssh?.port) args.push("-p", String(device.ssh.port));
    if (device.ssh?.password) args.push("-o", "BatchMode=no", "-o", "PubkeyAuthentication=no");
    else args.push("-o", "BatchMode=yes");
    args.push("-o", "StrictHostKeyChecking=no");
    return args;
}

export function materializeMacosSshAskpass(device, options = {}) {
    const askpassPath = join(macosWorkspaceDir(device), "ssh-askpass.sh");
    return writeMacosExecutableArtifact(
        askpassPath,
        "#!/bin/sh\nprintf '%s\\n' \"$CCC_MACOS_SSH_PASSWORD\"\n",
        options,
    );
}

function sshCommandOptions(device) {
    const password = device.ssh?.password;
    if (!password) return {};
    const askpassPath = materializeMacosSshAskpass(device);
    return {
        env: {
            SSH_ASKPASS_REQUIRE: "force",
            SSH_ASKPASS: askpassPath,
            CCC_MACOS_SSH_PASSWORD: String(password),
            DISPLAY: process.env.DISPLAY || "ccc",
        },
    };
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function macosHelperCommand(device, subcommand, args = [], timeoutMs) {
    const bridge = sshBridge(device, subcommand);
    if (bridge.error) return { error: bridge.error };
    const remoteScriptPath = device.helper?.remoteScriptPath || `/tmp/ccc-${device.id}-guest-helper.sh`;
    const command = [shellQuote(remoteScriptPath), subcommand, ...args.map(shellQuote)].join(" ");
    const result = runHelperCommand(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, command], timeoutMs, sshCommandOptions(device));
    return { result, remoteScriptPath };
}

function macosHelperJson(stdout) {
    try {
        return JSON.parse(stdout || "");
    } catch {
        return null;
    }
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

async function waitForProviderStart(child, label) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => done(null), 200);
        child.once("error", (error) => done(textResult(false, `${label} failed to start: ${error.message}`)));
        child.once("exit", (code, signal) => {
            done(textResult(false, `${label} exited before it was ready: ${signal || `exit ${code}`}`));
        });
    });
}

async function waitForMacosBoot(plan, timeoutMs = 300000, deadlineAt) {
    if (plan.selectedProvider !== "tart" || !plan.providerCommand || !plan.providerInstance) {
        return { ready: false, skipped: true, reason: "boot readiness is only implemented for Tart" };
    }
    const parsedTimeout = Number(timeoutMs);
    const deadline = deadlineAt ?? Date.now() + (Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 300000);
    let last = null;
    const attempts = [];
    const ipAttempts = () => [
        { resolver: "dhcp-leases", args: ["ip", plan.providerInstance] },
        { resolver: "arp", args: ["ip", "--resolver=arp", plan.providerInstance] },
    ];
    while (Date.now() < deadline) {
        for (const attempt of ipAttempts()) {
            if (Date.now() >= deadline) break;
            const ip = runWithTimeout(plan.providerCommand, attempt.args, Math.max(1, Math.min(macosProviderTimeoutMs("ip"), deadline - Date.now())));
            last = ip;
            attempts.push({
                resolver: attempt.resolver,
                status: ip.status,
                stdout: ip.stdout || "",
                stderr: ip.stderr || "",
            });
            const address = String(ip.stdout || "").trim();
            if (ip.status === 0 && address) {
                return {
                    ready: true,
                    skipped: false,
                    provider: "tart",
                    resolver: attempt.resolver,
                    ip: address,
                    status: ip.status,
                    stdout: ip.stdout,
                    stderr: ip.stderr,
                    attempts: attempts.slice(-4),
                };
            }
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs > 0) await sleep(Math.min(5000, remainingMs));
    }
    return {
        ready: false,
        skipped: false,
        provider: "tart",
        status: last?.status ?? null,
        stdout: last?.stdout || "",
        stderr: last?.stderr || "",
        attempts: attempts.slice(-8),
        error: `Timed out waiting for Tart IP for ${plan.providerInstance}`,
    };
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

/** @param {import("../ports/lifecycle/macos-vm-lifecycle.mjs").MacosVmRuntime} recording
 * @param {number} timeoutMs */
async function waitForOwnedRecordingExit(recording, timeoutMs) {
    if (!recording.runtimeId || !recording.processIdentity
        || typeof recording.pid !== "number" || !Number.isInteger(recording.pid) || recording.pid <= 0) return false;
    const identity = recording.processIdentity;
    if (identity.pid !== recording.pid || typeof identity.startToken !== "string" || !identity.startToken
        || typeof identity.commandHash !== "string" || !/^[a-f0-9]{64}$/i.test(identity.commandHash)) return false;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
        const observation = inspectProcessIdentity(identity, recording.pid);
        if (observation.status === "exited") return true;
        if (observation.status !== "match" || Date.now() >= deadline) return false;
        await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return false;
}

async function terminateStartedRecorder(child) {
    const pid = child.pid;
    try { child.kill("SIGINT"); } catch { /* recorder already exited */ }
    if (await waitForProcessExit(pid, 1000)) return true;
    try { child.kill("SIGKILL"); } catch { /* recorder already exited */ }
    return waitForProcessExit(pid, 1000);
}

function reconcileMacosRecording(device) {
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
    return updateMacosDevice(device.id, (item) => recordingGenerationMatches(expected, item.recording)
        ? { ...item, recording: pending, updatedAt: new Date().toISOString() }
        : item) || device;
}

function monitorMacosRecordingExit(deviceId, recording) {
    return () => {
        transitionRecordingGeneration(updateMacosDevice, deviceId, recording, {
            ...recording,
            active: false,
            endedAt: new Date().toISOString(),
        });
    };
}

function scpBaseArgs(device) {
    const args = [];
    if (device.ssh?.keyPath) args.push("-i", device.ssh.keyPath);
    if (device.ssh?.port) args.push("-P", String(device.ssh.port));
    if (device.ssh?.password) args.push("-o", "BatchMode=no", "-o", "PubkeyAuthentication=no");
    else args.push("-o", "BatchMode=yes");
    args.push("-o", "StrictHostKeyChecking=no");
    return args;
}

// Normalize captures to the same main-display coordinate space used by CGEvent.
export function macosScreenshotCommand(remotePath) {
    const script = String.raw`set -eu
geometry() {
  osascript -l JavaScript <<'JXA'
ObjC.import('ApplicationServices');
var id = $.CGMainDisplayID();
var b = $.CGDisplayBounds(id);
var w = Number(b.size.width), h = Number(b.size.height);
if (Number(b.origin.x) !== 0 || Number(b.origin.y) !== 0 || ![w,h].every(function(v) { return isFinite(v) && Math.floor(v) === v && v > 0 && v <= 16384; }) || w*h > 33554432) throw Error('display-geometry-invalid');
String(id) + ' ' + w + ' ' + h;
JXA
}
before=$(geometry)
set -- $before
[ "$#" -eq 3 ] || { echo display-geometry-invalid >&2; exit 1; }
width=$2; height=$3
case "$width:$height" in *[!0-9:]*|:*) echo display-geometry-invalid >&2; exit 1;; esac
screencapture -x -m -t png "$capture_path"
sips --resampleHeightWidth "$height" "$width" "$capture_path" >/dev/null
sizes=$(sips -g pixelWidth -g pixelHeight "$capture_path")
actual_width=$(printf '%s\n' "$sizes" | awk '$1 == "pixelWidth:" { print $2 }')
actual_height=$(printf '%s\n' "$sizes" | awk '$1 == "pixelHeight:" { print $2 }')
[ "$actual_width" = "$width" ] && [ "$actual_height" = "$height" ] || { echo screenshot-coordinate-size-mismatch >&2; exit 1; }
[ "$(geometry)" = "$before" ] || { echo display-geometry-changed >&2; exit 1; }
`;
    return `capture_path=${shellQuote(remotePath)}; export capture_path; sh -c ${shellQuote(script)}`;
}

export function macosGuestHelperScript(device) {
    return [
        "#!/bin/sh",
        "set -eu",
        `# ccc macOS guest helper for ${device.id}`,
        "case \"${1:-status}\" in",
        "  status) echo '{\"ok\":true,\"helper\":\"ccc-macos-guest-helper\"}' ;;",
        "  click)",
        "    osascript -l JavaScript - \"$2\" \"$3\" \"${4:-left}\" <<'JXA'",
        "function run(argv) {",
        "  ObjC.import('ApplicationServices');",
        "  var x = Number(argv[0]); var y = Number(argv[1]); var buttonName = String(argv[2] || 'left');",
        "  var button = buttonName === 'right' ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;",
        "  var down = buttonName === 'right' ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;",
        "  var up = buttonName === 'right' ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;",
        "  var point = $.CGPointMake(x, y);",
        "  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, down, point, button));",
        "  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, up, point, button));",
        "  return JSON.stringify({ok:true, clicked:{x:x, y:y, button:buttonName}, provider:'macos-helper'});",
        "}",
        "JXA",
        "    ;;",
        "  double_click)",
        "    osascript -l JavaScript - \"$2\" \"$3\" \"${4:-left}\" <<'JXA'",
        "function run(argv) {",
        "  ObjC.import('ApplicationServices');",
        "  var x = Number(argv[0]); var y = Number(argv[1]); var buttonName = String(argv[2] || 'left');",
        "  var button = buttonName === 'right' ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;",
        "  var down = buttonName === 'right' ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;",
        "  var up = buttonName === 'right' ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;",
        "  var point = $.CGPointMake(x, y);",
        "  for (var i = 0; i < 2; i++) {",
        "    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, down, point, button));",
        "    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, up, point, button));",
        "    delay(0.08);",
        "  }",
        "  return JSON.stringify({ok:true, doubleClicked:{x:x, y:y, button:buttonName}, provider:'macos-helper'});",
        "}",
        "JXA",
        "    ;;",
        "  key)",
        "    KEY_CODE=\"$2\"",
        "    MODIFIERS=\"${3:-}\"",
        "    USING=\"\"",
        "    [ -n \"$MODIFIERS\" ] && USING=\" using {$(printf '%s' \"$MODIFIERS\" | sed 's/,/ down, /g') down}\"",
        "    osascript -e \"tell application \\\"System Events\\\" to key code $KEY_CODE$USING\"",
        "    printf '{\"ok\":true,\"key\":{\"keyCode\":%s,\"modifiers\":\"%s\"},\"provider\":\"macos-helper\"}\\n' \"$KEY_CODE\" \"$MODIFIERS\"",
        "    ;;",
        "  type)",
        "    osascript -l JavaScript - \"$2\" <<'JXA'",
        "function run(argv) {",
        "  var text = String(argv[0] || '');",
        "  Application('System Events').keystroke(text);",
        "  return JSON.stringify({ok:true, typed:{text:text}, provider:'macos-helper'});",
        "}",
        "JXA",
        "    ;;",
        "  scroll)",
        "    osascript -l JavaScript - \"${2:-down}\" \"${3:-1}\" <<'JXA'",
        "function run(argv) {",
        "  ObjC.import('ApplicationServices');",
        "  var direction = String(argv[0] || 'down'); var amount = Number(argv[1] || 1);",
        "  var delta = (direction === 'down' || direction === 'right') ? -amount : amount;",
        "  var axisCount = (direction === 'left' || direction === 'right') ? 2 : 1;",
        "  var event = axisCount === 2 ? $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, 0, delta) : $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 1, delta);",
        "  $.CGEventPost($.kCGHIDEventTap, event);",
        "  return JSON.stringify({ok:true, scrolled:{direction:direction, amount:amount}, provider:'macos-helper'});",
        "}",
        "JXA",
        "    ;;",
        "  drag|move)",
        "    osascript -l JavaScript - \"$@\" <<'JXA'",
        "function run(argv) {",
        "  ObjC.import('ApplicationServices');",
        "  var mode = String(argv[0]);",
        "  var x1 = Number(argv[1]), y1 = Number(argv[2]);",
        "  var x2 = mode === 'drag' ? Number(argv[3]) : x1;",
        "  var y2 = mode === 'drag' ? Number(argv[4]) : y1;",
        "  var ms = mode === 'drag' ? Number(argv[5]) : 1;",
        "  if (![x1,y1,x2,y2,ms].every(function(v) { return isFinite(v) && Math.floor(v) === v && v >= 0 && v <= 2147483647; }) || ms < 1 || ms > 10000) throw Error('invalid-pointer-arguments');",
        "  var bounds = $.CGDisplayBounds($.CGMainDisplayID());",
        "  if (x1 >= bounds.size.width || x2 >= bounds.size.width || y1 >= bounds.size.height || y2 >= bounds.size.height) throw Error('pointer-outside-display');",
        "  var point = $.CGPointMake(x1,y1);",
        "  function post(kind, at) { var event = $.CGEventCreateMouseEvent(null, kind, at, $.kCGMouseButtonLeft); if (!event) throw Error('mouse-event-unavailable'); $.CGEventPost($.kCGHIDEventTap, event); }",
        "  post($.kCGEventMouseMoved, point);",
        "  if (mode === 'drag') {",
        "    try {",
        "      post($.kCGEventLeftMouseDown, point);",
        "      for (var i = 1; i <= 20; i++) {",
        "        delay(ms / 20000);",
        "        point = $.CGPointMake(x1 + (x2-x1)*i/20, y1 + (y2-y1)*i/20);",
        "        post($.kCGEventLeftMouseDragged, point);",
        "      }",
        "    } finally { post($.kCGEventLeftMouseUp, point); }",
        "  }",
        "  return JSON.stringify({ok:true});",
        "}",
        "JXA",
        "    ;;",
        "  cursor_position)",
        "    osascript -l JavaScript <<'JXA'",
        "function run() {",
        "  ObjC.import('ApplicationServices');",
        "  var event = $.CGEventCreate(null); var point = $.CGEventGetLocation(event);",
        "  return JSON.stringify({ok:true, cursor:{x:point.x, y:point.y}, provider:'macos-helper'});",
        "}",
        "JXA",
        "    ;;",
        "  window_list|focus_window)",
        "    osascript -l JavaScript - \"$@\" <<'JXA'",
        MACOS_WINDOW_JXA,
        "JXA",
        "    ;;",
        "  accessibility_snapshot)",
        "    osascript -l JavaScript - \"${2:-3}\" \"${3:-200}\" <<'JXA'",
        "function safe(fn, fallback) { try { return fn(); } catch (error) { return fallback; } }",
        "function run(argv) {",
        "  var maxDepth = Math.max(0, Math.min(Number(argv[0] || 3), 8));",
        "  var maxNodes = Math.max(1, Math.min(Number(argv[1] || 200), 1000));",
        "  var count = 1;",
        "  function node(element, depth) {",
        "    if (!element || depth > maxDepth || count >= maxNodes) return null;",
        "    count += 1;",
        "    var children = [];",
        "    if (depth < maxDepth && count < maxNodes) {",
        "      var uiElements = safe(function () { return element.uiElements(); }, []);",
        "      for (var i = 0; i < uiElements.length && count < maxNodes; i++) {",
        "        var child = node(uiElements[i], depth + 1);",
        "        if (child) children.push(child);",
        "      }",
        "    }",
        "    return {name:safe(function () { return element.name(); }, ''), role:safe(function () { return element.role(); }, ''), subrole:safe(function () { return element.subrole(); }, ''), description:safe(function () { return element.description(); }, ''), value:safe(function () { return element.value(); }, null), enabled:safe(function () { return element.enabled(); }, null), position:safe(function () { return element.position(); }, null), size:safe(function () { return element.size(); }, null), children:children};",
        "  }",
        "  var systemEvents = Application('System Events');",
        "  var processes = safe(function () { return systemEvents.processes.whose({visible:true})(); }, []);",
        "  var root = {name:'macOS Desktop', role:'AXApplicationGroup', children:[]};",
        "  for (var p = 0; maxDepth > 0 && p < processes.length && count < maxNodes; p++) {",
        "    var process = processes[p];",
        "    var processNode = {name:safe(function () { return process.name(); }, ''), role:'AXApplication', processId:safe(function () { return process.unixId(); }, null), children:[]};",
        "    count += 1;",
        "    var windows = safe(function () { return process.windows(); }, []);",
        "    for (var w = 0; maxDepth > 1 && w < windows.length && count < maxNodes; w++) {",
        "      var windowNode = node(windows[w], 2);",
        "      if (windowNode) processNode.children.push(windowNode);",
        "    }",
        "    root.children.push(processNode);",
        "  }",
        "  return JSON.stringify({ok:true, accessibility:{provider:'macos-system-events', maxDepth:maxDepth, maxNodes:maxNodes, nodeCount:count, root:root}, provider:'macos-system-events'});",
        "}",
        "JXA",
        "    ;;",
        "  *) echo \"unsupported helper command: $1\" >&2; exit 64 ;;",
        "esac",
        "",
    ].join("\n");
}

export function writeMacosGuestHelper(device, options = {}) {
    ensureMacosWorkspace(device);
    const path = join(macosToolsDir(device), "ccc-guest-helper.sh");
    return writeMacosExecutableArtifact(path, macosGuestHelperScript(device), options);
}

function provisionMacosGuestHelper(device, { deadlineAt } = {}) {
    const exhausted = () => Number.isFinite(deadlineAt) && Date.now() >= deadlineAt;
    const budget = () => Number.isFinite(deadlineAt) ? Math.max(1, Math.min(macosHelperTimeoutMs(), deadlineAt - Date.now())) : undefined;
    const timeout = () => ({ ok: false, error: "macos-helper-readiness-timeout", provisioning: { status: "failed", provider: "ssh", updatedAt: new Date().toISOString() } });
    if (exhausted()) return timeout();
    const target = sshTarget(device);
    if (!target) {
        return {
            ok: true,
            skipped: true,
            provisioning: {
                status: "skipped-missing-ssh",
                updatedAt: new Date().toISOString(),
            },
        };
    }
    const keyPolicy = validateMacosSshKeyPath(device.ssh?.keyPath);
    if (!keyPolicy.ok) {
        return {
            ok: false,
            error: keyPolicy.message,
            provisioning: {
                status: "failed",
                provider: "ssh-key-policy",
                detail: keyPolicy.message,
                updatedAt: new Date().toISOString(),
            },
        };
    }
    if (device.ssh?.keyPath && keyPolicy.path !== device.ssh.keyPath) {
        device.ssh = { ...device.ssh, keyPath: keyPolicy.path };
    }
    const discovery = sshDiscovery();
    if (!discovery.available) {
        return {
            ok: false,
            error: `macOS VM SSH bridge missing prerequisites: ${discovery.missing.join(", ")}`,
            provisioning: {
                status: "failed",
                missing: discovery.missing,
                updatedAt: new Date().toISOString(),
            },
        };
    }
    let localScriptPath;
    try {
        localScriptPath = writeMacosGuestHelper(device);
    } catch (error) {
        return {
            ok: false,
            error: "macos-helper-write-failed",
            detail: error instanceof Error ? error.message : String(error),
            provisioning: {
                status: "failed",
                provider: "local",
                detail: error instanceof Error ? error.message : String(error),
                updatedAt: new Date().toISOString(),
            },
        };
    }
    const remoteScriptPath = device.helper?.remoteScriptPath || `/tmp/ccc-${device.id}-guest-helper.sh`;
    if (exhausted()) return timeout();
    const copy = runHelperCommand(discovery.scp, [...scpBaseArgs(device), localScriptPath, `${target}:${remoteScriptPath}`], budget(), sshCommandOptions(device));
    if (copy.status !== 0) {
        return {
            ok: false,
            error: "macos-helper-scp-failed",
            command: copy,
            provisioning: {
                status: "failed",
                localScriptPath,
                remoteScriptPath,
                provider: "scp",
                updatedAt: new Date().toISOString(),
            },
        };
    }
    if (exhausted()) return timeout();
    const chmod = runHelperCommand(discovery.ssh, [...sshBaseArgs(device), target, `chmod 700 ${shellQuote(remoteScriptPath)} && ${shellQuote(remoteScriptPath)} status`], budget(), sshCommandOptions(device));
    if (chmod.status !== 0) {
        return {
            ok: false,
            error: "macos-helper-chmod-failed",
            command: chmod,
            provisioning: {
                status: "failed",
                localScriptPath,
                remoteScriptPath,
                provider: "ssh",
                updatedAt: new Date().toISOString(),
            },
        };
    }
    return {
        ok: true,
        skipped: false,
        provisioning: {
            status: "provisioned",
            localScriptPath,
            remoteScriptPath,
            provider: "ssh-scp",
            stdout: chmod.stdout,
            stderr: chmod.stderr,
            updatedAt: new Date().toISOString(),
        },
    };
}

export async function waitForMacosGuestHelper(device, deadlineAt, {
    provision = provisionMacosGuestHelper, now = Date.now, delay = sleep,
} = {}) {
    let last;
    while (now() < deadlineAt) {
        last = provision(device, { deadlineAt });
        if (last.ok && now() < deadlineAt) return last;
        const command = last.command;
        const transient = ["macos-helper-scp-failed", "macos-helper-chmod-failed"].includes(last.error)
            && (command?.error?.code === "ETIMEDOUT"
                || /connection (?:refused|reset|closed)|connection timed out|operation timed out|no route to host|network is unreachable/i.test(`${command?.stderr || ""}\n${command?.stdout || ""}`));
        if (!transient && !last.ok) return last;
        if (now() >= deadlineAt) break;
        await delay(Math.min(500, deadlineAt - now()));
    }
    return { ok: false, error: "macos-helper-readiness-timeout", provisioning: { ...last?.provisioning, status: "failed", updatedAt: new Date().toISOString() } };
}

/** @returns {{target:string, discovery:ReturnType<typeof sshDiscovery>, error?:undefined}|{error:ReturnType<typeof textResult>, target?:undefined, discovery?:undefined}} */
function sshBridge(device, toolName) {
    const target = sshTarget(device);
    if (!target) return { error: helperRequiredResult(device, toolName) };
    const keyPolicy = validateMacosSshKeyPath(device.ssh?.keyPath);
    if (!keyPolicy.ok) return { error: textResult(false, keyPolicy.message) };
    if (device.ssh?.keyPath && keyPolicy.path !== device.ssh.keyPath) {
        device.ssh = { ...device.ssh, keyPath: keyPolicy.path };
    }
    const discovery = sshDiscovery();
    if (!discovery.available) {
        return { error: textResult(false, `macOS VM SSH bridge missing prerequisites: ${discovery.missing.join(", ")}`) };
    }
    return { target, discovery };
}

/** @typedef {{path:string, stagedPath:string, cleanup:()=>void}} MacosTransferStage */
/** @type {import('../ports/desktop-control-transfer.mjs').MacosPorts<ReturnType<typeof findMacosDevice>, {target:string, discovery:ReturnType<typeof sshDiscovery>}, MacosTransferStage, MacosTransferStage>} */
const macosDesktopPorts = {
    variant: "macos",
    target: deviceId => findMacosDevice(deviceId),
    helper: (device, subcommand, argv, timeoutMs) => macosHelperCommand(device, subcommand, argv, timeoutMs),
    parseHelper: stdout => macosHelperJson(stdout),
    bridge: (device, operation) => {
        const bridge = sshBridge(device, operation);
        return bridge.error !== undefined ? { ok: false, result: bridge.error } : { ok: true, bridge };
    },
    guestPath: (path, label) => {
        const policy = validateGuestPath(path, { label: `${label}-remote-path`, platform: "posix", transport: "scp" });
        return policy.ok ? { ok: true, path: policy.path } : { ok: false, message: policy.message };
    },
    stageInput: path => {
        const stage = stageLocalInputFile(path, { label: "upload-local-path" });
        return stage.ok ? { ok: true, path: stage.path, stagedPath: stage.stagedPath, handle: stage } : { ok: false, message: stage.message };
    },
    stageOutput: path => {
        const stage = createLocalOutputStage(path, { label: "download-local-path" });
        return stage.ok ? { ok: true, path: stage.path, stagedPath: stage.stagedPath, handle: stage } : { ok: false, message: stage.message };
    },
    upload: (device, bridge, stagedPath, remotePath, timeoutMs) => runHelperCommand(bridge.discovery.scp,
        [...scpBaseArgs(device), stagedPath, `${bridge.target}:${remotePath}`], timeoutMs, sshCommandOptions(device)),
    download: (device, bridge, remotePath, stagedPath, timeoutMs) => runHelperCommand(bridge.discovery.scp,
        [...scpBaseArgs(device), `${bridge.target}:${remotePath}`, stagedPath], timeoutMs, sshCommandOptions(device)),
    commitOutput: stage => {
        const committed = commitLocalOutputStage(stage, { label: "download-local-path" });
        return committed.ok ? { ok: true, path: committed.path } : { ok: false, message: committed.message };
    },
    disposeInput: stage => { stage.cleanup(); return undefined; },
    disposeOutput: stage => { stage.cleanup(); return undefined; },
};
const macosDesktop = createDesktopControlTransfer(macosDesktopPorts);

/** @param {import('../domain/desktop-control-transfer.mjs').DesktopOutcome} outcome */
function macosDesktopResult(outcome) {
    if (outcome === undefined) return undefined;
    if (outcome.kind === "json") return jsonResult(outcome.value);
    if (outcome.kind === "text") return textResult(outcome.ok, outcome.text);
    if (outcome.kind === "command-failure") return fail(outcome.receipt);
    return outcome.value;
}

export function listMacosDevices({identityOnly=false}={}) { return deviceObservation.owned({identityOnly}); }

async function handleMacosToolUnlocked(name, args) {
    if (requiresOwnerDeviceOperation("macos", name)) {
        for (const candidate of [args?.deviceId, args?.sourceDeviceId]) {
            if (typeof candidate !== "string") continue;
            const recovery = recoverStaleMacosLifecycle(candidate);
            if (recovery.error) return recovery.error;
        }
    }
    switch (name) {
        case "device_inventory": { const value=deviceObservation.inventory(args); return value === undefined ? undefined : jsonResult(value); }


        case "device_base_image_create": return macosVmLifecycle.createImage(args);

        case "device_base_image_clone": {
            const { backend = "macos-vm", name: deviceName, deviceId, sourceDeviceId, sourceImage, provider = "auto", memoryMb = 4096, cpus = 4, sshHost, sshPort = 22, sshUser, sshKeyPath, sshPassword, force = false } = args;
            if (backend !== "macos-vm") return undefined;
            if (!sourceDeviceId && !sourceImage) return textResult(false, `${name} requires sourceDeviceId or sourceImage`);

            const sourceDevice = sourceDeviceId ? findMacosDevice(sourceDeviceId) : null;
            if (sourceDeviceId && !sourceDevice) return textResult(false, `Unknown source macOS device: ${sourceDeviceId}`);
            if (sourceDevice?.lifecycle) {
                return textResult(false, `Refusing to clone ${sourceDeviceId} while lifecycle operation ${sourceDevice.lifecycle.operation || "unknown"} is active`);
            }
            if (sourceDevice && sourceDevice.status !== "stopped" && !force) {
                return textResult(false, `Refusing to clone ${sourceDeviceId} while status is ${sourceDevice.status}; stop it first or pass force=true.`);
            }
            const sourceProvider = sourceDevice?.provider || provider;
            const sourceRef = sourceDevice?.providerInstance || sourceImage;
            const id = deviceId || macosDeviceId(deviceName);
            const devices = readMacosDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }
            const sshKeyPolicy = validateMacosSshKeyPath(sshKeyPath);
            if (!sshKeyPolicy.ok) return textResult(false, sshKeyPolicy.message);

            const ssh = macosSshConfig({ sshHost, sshPort, sshUser, sshKeyPath: sshKeyPolicy.path, sshPassword, provider: sourceProvider, image: sourceImage || sourceDevice?.image || sourceRef });
            const device = macosDeviceDefinition({
                id,
                name: deviceName,
                provider: sourceProvider,
                image: sourceImage || sourceDevice?.image || sourceRef,
                memoryMb: sourceDevice?.memoryMb || memoryMb,
                cpus: sourceDevice?.cpus || cpus,
                ssh,
                extra: {
                    clonedFrom: sourceDeviceId ? { deviceId: sourceDeviceId, providerInstance: sourceRef } : { image: sourceImage },
                    provisioning: "image-cloned",
                },
            });
            const tart = tartProviderPlan(device, name);
            if (tart.error) return tart.error;
            let sourceClaim = null;
            let sourceCompletionUpdates = {};
            if (sourceDevice) {
                sourceClaim = claimMacosLifecycle(sourceDevice.id, sourceDevice, sourceDevice.status !== "stopped" ? "clone-source-stop" : "clone-source");
                if (!sourceClaim.transition.matched) return macosLifecycleConflict(sourceDevice.id, "clone-source-claim", sourceClaim.transition);
            }
            if (sourceDevice && sourceDevice.status !== "stopped" && force) {
                const sourcePlan = tartProviderPlan(sourceDevice, name);
                if (sourcePlan.error) {
                    abortMacosLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice);
                    return sourcePlan.error;
                }
                if (!sourcePlan.plan.stopCommand) {
                    abortMacosLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice);
                    return textResult(false, `macOS VM stop is unavailable for clone source ${sourceDevice.id}`);
                }
                if (sourcePlan.plan.stopCommand) {
                    const stop = runProviderCommand(sourcePlan.plan.stopCommand.command, sourcePlan.plan.stopCommand.args, "stop");
                    if (stop.status !== 0) {
                        abortMacosLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice);
                        return fail(stop);
                    }
                    const recorderSignal = signalOwnedRuntimeProcess(sourceDevice.recording, "SIGINT");
                    if (recorderSignal.signaled) await waitForProcessExit(sourceDevice.recording.pid, 1000);
                    sourceCompletionUpdates = {
                        status: "stopped",
                        runtime: null,
                        bootReady: false,
                        lastBootCheck: null,
                        recording: null,
                    };
                }
            }
            const target = tart.plan.providerInstance;
            const clone = runTartClone(tart.plan, sourceRef, target);
            const r = clone.result;
            if (r.status !== 0) {
                if (sourceClaim) abortMacosLifecycle(sourceDevice.id, sourceClaim.lifecycle, sourceDevice, sourceCompletionUpdates);
                return tartCloneFailure(r, clone.cleanup, target);
            }

            if (sourceClaim) {
                const currentSource = currentMacosLifecycleDevice(sourceDevice.id, sourceClaim.lifecycle);
                if (!currentSource) {
                    const rollback = tartDeleteInstance(tart.plan, target);
                    return macosLifecycleConflict(sourceDevice.id, "clone-source-complete", { found: Boolean(findMacosDevice(sourceDevice.id)), matched: false }, {
                        ok: rollback.status === 0,
                        target,
                        status: rollback.status,
                        stdout: rollback.stdout,
                        stderr: rollback.stderr,
                    });
                }
                const completedSource = macosLifecycleReplacement(currentSource, null, sourceCompletionUpdates);
                const sourceTransition = transitionMacosDevice(sourceDevice.id, currentSource, completedSource);
                if (!sourceTransition.matched) {
                    const rollback = tartDeleteInstance(tart.plan, target);
                    return macosLifecycleConflict(sourceDevice.id, "clone-source-complete", sourceTransition, {
                        ok: rollback.status === 0,
                        target,
                        status: rollback.status,
                        stdout: rollback.stdout,
                        stderr: rollback.stderr,
                    });
                }
            }

            const cloned = {
                ...device,
                provider: tart.plan.selectedProvider,
                providerInstance: target,
                providerResourceManaged: true,
                clonedAt: new Date().toISOString(),
            };
            let claim;
            try {
                claim = claimMacosDevice(cloned);
            } catch (error) {
                const rollback = runProviderCommand(tart.plan.providerCommand, ["delete", target], "delete");
                if (rollback.status !== 0) {
                    return textResult(false, `Owner device state update failed; macOS VM rollback failed: ${rollback.stderr || rollback.stdout}`);
                }
                throw error;
            }
            if (!claim.ok) {
                if (claim.existing?.provider !== cloned.provider || claim.existing?.providerInstance !== target) {
                    const rollback = runProviderCommand(tart.plan.providerCommand, ["delete", target], "delete");
                    if (rollback.status !== 0) {
                        return textResult(false, `Device identity conflict for this owner (${claim.field}: ${claim.value}); macOS VM rollback failed: ${rollback.stderr || rollback.stdout}`);
                    }
                }
                return textResult(false, `Device identity already exists for this owner (${claim.field}: ${typeof claim.value === "object" ? JSON.stringify(claim.value) : claim.value})`);
            }
            return jsonResult({
                operation: "base-image-clone",
                device: deviceWithPlan(cloned),
                stdout: r.stdout,
                stderr: r.stderr,
                status: r.status,
            });
        }

        case "device_create": return macosVmLifecycle.create(args);

        case "device_delete": return macosVmLifecycle.delete(args);

        case "device_status": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const discovery = macosDiscovery();
            return jsonResult({ device: deviceWithPlan(device, discovery), backend: macosBackend(discovery) });
        }

        case "device_snapshot_create": {
            const { deviceId, snapshotName, force = false } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return textResult(false, `Unknown macOS device: ${deviceId}`);
            if (!snapshotName) return textResult(false, "device_snapshot_create requires snapshotName");
            if (device.status !== "stopped" && !force) {
                return textResult(false, `Refusing to snapshot ${deviceId} while status is ${device.status}; stop it first or pass force=true.`);
            }
            const snapshotId = macosSnapshotId(snapshotName);
            if ((device.snapshots || []).some((snapshot) => snapshot.id === snapshotId || snapshot.name === snapshotName)) {
                return textResult(false, `Snapshot already exists for ${deviceId}: ${snapshotName}`);
            }
            const tart = tartProviderPlan(device, name);
            if (tart.error) return tart.error;
            if (force && device.status !== "stopped" && !tart.plan.stopCommand) {
                return textResult(false, `macOS VM stop is unavailable for snapshot source ${deviceId}`);
            }
            const claim = claimMacosLifecycle(deviceId, device, "snapshot-create");
            if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "snapshot-create-claim", claim.transition);
            let completionUpdates = {};
            if (force && device.status !== "stopped" && tart.plan.stopCommand) {
                const stop = runProviderCommand(tart.plan.stopCommand.command, tart.plan.stopCommand.args, "stop");
                if (stop.status !== 0) {
                    abortMacosLifecycle(deviceId, claim.lifecycle, device);
                    return fail(stop);
                }
                const recorderSignal = signalOwnedRuntimeProcess(device.recording, "SIGINT");
                if (recorderSignal.signaled) await waitForProcessExit(device.recording.pid, 1000);
                completionUpdates = {
                    status: "stopped",
                    runtime: null,
                    bootReady: false,
                    lastBootCheck: null,
                    recording: null,
                };
            }
            const snapshotInstance = `${tart.plan.providerInstance}-${snapshotId}`;
            const clone = runTartClone(tart.plan, tart.plan.providerInstance, snapshotInstance);
            const r = clone.result;
            if (r.status !== 0) {
                abortMacosLifecycle(deviceId, claim.lifecycle, device, completionUpdates);
                return tartCloneFailure(r, clone.cleanup, snapshotInstance);
            }
            const snapshot = {
                id: snapshotId,
                name: snapshotName,
                provider: tart.plan.selectedProvider,
                providerInstance: snapshotInstance,
                sourceProviderInstance: tart.plan.providerInstance,
                createdAt: new Date().toISOString(),
            };
            const current = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) {
                const rollback = rollbackCreatedMacosResource(deviceId, tart.plan, snapshotInstance);
                return macosLifecycleConflict(deviceId, "snapshot-create", { found: Boolean(findMacosDevice(deviceId)), matched: false }, rollback);
            }
            const completed = macosLifecycleReplacement(current, null, {
                ...completionUpdates,
                provider: tart.plan.selectedProvider,
                providerInstance: tart.plan.providerInstance,
                status: "stopped",
                snapshots: [...(current.snapshots || []), snapshot],
            });
            const transition = transitionMacosDevice(deviceId, current, completed);
            if (!transition.matched) {
                const rollback = rollbackCreatedMacosResource(deviceId, tart.plan, snapshotInstance);
                return macosLifecycleConflict(deviceId, "snapshot-create", transition, rollback);
            }
            return jsonResult({ device: deviceWithPlan(transition.device), snapshot, stdout: r.stdout, stderr: r.stderr, status: r.status });
        }

        case "device_snapshot_restore": {
            const { deviceId, snapshotName, snapshotId, force = false } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return textResult(false, `Unknown macOS device: ${deviceId}`);
            const snapshot = findSnapshot(device, snapshotName, snapshotId);
            if (!snapshot) return textResult(false, `Unknown snapshot for ${deviceId}: ${snapshotName || snapshotId || "<missing>"}`);
            if (device.status !== "stopped" && !force) {
                return textResult(false, `Refusing to restore ${deviceId} while status is ${device.status}; stop it first or pass force=true.`);
            }
            const tart = tartProviderPlan(device, name);
            if (tart.error) return tart.error;
            if (force && device.status !== "stopped" && !tart.plan.stopCommand) {
                return textResult(false, `macOS VM stop is unavailable for snapshot restore ${deviceId}`);
            }
            const claim = claimMacosLifecycle(deviceId, device, "snapshot-restore");
            if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "snapshot-restore-claim", claim.transition);
            let completionUpdates = {};
            if (force && device.status !== "stopped" && tart.plan.stopCommand) {
                const stop = runProviderCommand(tart.plan.stopCommand.command, tart.plan.stopCommand.args, "stop");
                if (stop.status !== 0) {
                    abortMacosLifecycle(deviceId, claim.lifecycle, device);
                    return fail(stop);
                }
                const recorderSignal = signalOwnedRuntimeProcess(device.recording, "SIGINT");
                if (recorderSignal.signaled) await waitForProcessExit(device.recording.pid, 1000);
                completionUpdates = {
                    status: "stopped",
                    runtime: null,
                    bootReady: false,
                    lastBootCheck: null,
                    recording: null,
                };
            }
            const pendingRecovery = device.restoreRecovery;
            const resumesPendingCandidate = pendingRecovery?.candidateProviderInstance
                && pendingRecovery.snapshotId === snapshot.id
                && pendingRecovery.snapshotName === snapshot.name;
            const restoreCandidate = resumesPendingCandidate
                ? pendingRecovery.candidateProviderInstance
                : `${tart.plan.providerInstance}-restore-${snapshot.id}-${randomUUID()}`;
            let restore = { status: 0, stdout: "", stderr: "" };
            if (!resumesPendingCandidate) {
                const clone = runTartClone(tart.plan, snapshot.providerInstance, restoreCandidate);
                restore = clone.result;
                if (restore.status !== 0) {
                    abortMacosLifecycle(deviceId, claim.lifecycle, device, completionUpdates);
                    return tartCloneFailure(restore, clone.cleanup, restoreCandidate);
                }
                const recovery = {
                    snapshotId: snapshot.id,
                    snapshotName: snapshot.name,
                    candidateProviderInstance: restoreCandidate,
                    supersededCandidateProviderInstances: pendingRecovery?.candidateProviderInstance
                        ? [pendingRecovery.candidateProviderInstance, ...(pendingRecovery.supersededCandidateProviderInstances || [])]
                        : [],
                    phase: "prepared",
                    preparedAt: new Date().toISOString(),
                };
                const registered = transitionCurrentMacosLifecycle(deviceId, claim.lifecycle, (current) => macosLifecycleReplacement(current, claim.lifecycle, {
                    ...completionUpdates,
                    restoreRecovery: recovery,
                }));
                if (!registered.matched) {
                    const rollback = rollbackCreatedMacosResource(deviceId, tart.plan, restoreCandidate);
                    return macosLifecycleConflict(deviceId, "snapshot-restore-candidate", registered, rollback);
                }
            }
            let activate = { status: 0, stdout: "", stderr: "" };
            if (pendingRecovery?.phase !== "activated" || !resumesPendingCandidate) {
                const remove = runProviderCommand(tart.plan.providerCommand, ["delete", tart.plan.providerInstance], "delete");
                if (!currentMacosLifecycleDevice(deviceId, claim.lifecycle)) {
                    return macosLifecycleConflict(deviceId, "snapshot-restore-primary", { found: Boolean(findMacosDevice(deviceId)), matched: false }, {
                        ok: false,
                        attempted: false,
                        reason: "restore-candidate-preserved",
                        candidateProviderInstance: restoreCandidate,
                    });
                }
                const activationClone = runTartClone(tart.plan, restoreCandidate, tart.plan.providerInstance);
                activate = activationClone.result;
                if (activate.status !== 0) {
                    const recovery = {
                        ...(currentMacosLifecycleDevice(deviceId, claim.lifecycle)?.restoreRecovery || {}),
                        snapshotId: snapshot.id,
                        snapshotName: snapshot.name,
                        candidateProviderInstance: restoreCandidate,
                        failedAt: new Date().toISOString(),
                        error: remove.status !== 0
                            ? `primary delete: ${remove.stderr || remove.stdout || `exit ${remove.status}`}; activation: ${activate.stderr || activate.stdout || `exit ${activate.status}`}`
                            : activate.stderr || activate.stdout || `exit ${activate.status}`,
                    };
                    const current = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
                    if (!current) {
                        return macosLifecycleConflict(deviceId, "snapshot-restore-recovery", { found: Boolean(findMacosDevice(deviceId)), matched: false }, {
                            ok: false,
                            attempted: false,
                            reason: "restore-candidate-preserved",
                            candidateProviderInstance: restoreCandidate,
                        });
                    }
                    const failed = macosLifecycleReplacement(current, null, {
                        ...completionUpdates,
                        status: "stopped",
                        restoreRecovery: recovery,
                    });
                    const transition = transitionMacosDevice(deviceId, current, failed);
                    if (!transition.matched) {
                        return macosLifecycleConflict(deviceId, "snapshot-restore-recovery", transition, {
                            ok: false,
                            attempted: false,
                            reason: "restore-candidate-preserved",
                            candidateProviderInstance: restoreCandidate,
                        });
                    }
                    if (activationClone.cleanup) {
                        return textResult(false, `${(tartCloneFailure(activate, activationClone.cleanup, tart.plan.providerInstance).content || [])[0]?.text || `Error: ${recovery.error}`}. Restore candidate preserved: ${restoreCandidate}`);
                    }
                    return textResult(false, `Error: ${recovery.error}. Restore candidate preserved: ${restoreCandidate}`);
                }
                const activated = transitionCurrentMacosLifecycle(deviceId, claim.lifecycle, (current) => macosLifecycleReplacement(current, claim.lifecycle, {
                    ...completionUpdates,
                    status: "stopped",
                    restoreRecovery: {
                        ...current.restoreRecovery,
                        phase: "activated",
                        activatedAt: new Date().toISOString(),
                    },
                }));
                if (!activated.matched) {
                    return macosLifecycleConflict(deviceId, "snapshot-restore-activate", activated, {
                        ok: false,
                        attempted: false,
                        reason: "restore-candidate-preserved",
                        candidateProviderInstance: restoreCandidate,
                    });
                }
            }
            const trackedRecovery = currentMacosLifecycleDevice(deviceId, claim.lifecycle)?.restoreRecovery;
            const cleanupResults = [restoreCandidate, ...(trackedRecovery?.supersededCandidateProviderInstances || [])]
                .map((instance) => ({ instance, result: tartDeleteInstance(tart.plan, instance) }));
            const failedCleanups = cleanupResults.filter(({ result }) => result.status !== 0);
            const cleanup = failedCleanups[0]?.result || cleanupResults[0].result;
            const current = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) return macosLifecycleConflict(deviceId, "snapshot-restore", { found: Boolean(findMacosDevice(deviceId)), matched: false }, failedCleanups.length === 0 ? null : {
                ok: false,
                attempted: true,
                reason: "restore-candidate-cleanup-failed",
                candidateProviderInstance: failedCleanups[0].instance,
                status: cleanup.status,
            });
            const completed = macosLifecycleReplacement(current, null, {
                ...completionUpdates,
                provider: tart.plan.selectedProvider,
                providerInstance: tart.plan.providerInstance,
                status: "stopped",
                restoreRecovery: failedCleanups.length === 0 ? null : {
                    snapshotId: snapshot.id,
                    snapshotName: snapshot.name,
                    candidateProviderInstance: failedCleanups[0].instance,
                    supersededCandidateProviderInstances: failedCleanups.slice(1).map(({ instance }) => instance),
                    failedAt: new Date().toISOString(),
                    error: cleanup.stderr || cleanup.stdout || `cleanup exit ${cleanup.status}`,
                },
                restoredFrom: { id: snapshot.id, name: snapshot.name, providerInstance: snapshot.providerInstance, restoredAt: new Date().toISOString() },
            });
            const transition = transitionMacosDevice(deviceId, current, completed);
            if (!transition.matched) return macosLifecycleConflict(deviceId, "snapshot-restore", transition, failedCleanups.length === 0 ? null : {
                ok: false,
                attempted: true,
                reason: "restore-candidate-cleanup-failed",
                candidateProviderInstance: failedCleanups[0].instance,
                status: cleanup.status,
            });
            return jsonResult({ device: deviceWithPlan(transition.device), snapshot, stdout: activate.stdout, stderr: activate.stderr, status: activate.status });
        }

        case "device_snapshot_delete": {
            const { deviceId, snapshotName, snapshotId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return textResult(false, `Unknown macOS device: ${deviceId}`);
            const snapshot = findSnapshot(device, snapshotName, snapshotId);
            if (!snapshot) return textResult(false, `Unknown snapshot for ${deviceId}: ${snapshotName || snapshotId || "<missing>"}`);
            const tart = tartProviderPlan(device, name);
            if (tart.error) return tart.error;
            const claim = claimMacosLifecycle(deviceId, device, "snapshot-delete");
            if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "snapshot-delete-claim", claim.transition);
            const r = runProviderCommand(tart.plan.providerCommand, ["delete", snapshot.providerInstance], "delete");
            if (r.status !== 0) {
                abortMacosLifecycle(deviceId, claim.lifecycle, device);
                return fail(r);
            }
            const current = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) return macosLifecycleConflict(deviceId, "snapshot-delete", { found: Boolean(findMacosDevice(deviceId)), matched: false });
            const completed = macosLifecycleReplacement(current, null, {
                snapshots: (current.snapshots || []).filter((candidate) => candidate.id !== snapshot.id),
            });
            const transition = transitionMacosDevice(deviceId, current, completed);
            if (!transition.matched) return macosLifecycleConflict(deviceId, "snapshot-delete", transition);
            return jsonResult({ device: deviceWithPlan(transition.device), deleted: snapshot.id, stdout: r.stdout, stderr: r.stderr, status: r.status });
        }

        case "device_start": return macosVmLifecycle.start(args);

        case "device_stop": return macosVmLifecycle.stop(args);

        case "device_exec": {
            const { deviceId, command, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const r = runHelperCommand(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, command], helperTimeoutMs, sshCommandOptions(device));
            return jsonResult({ stdout: r.stdout, stderr: r.stderr, status: r.status, provider: "ssh" });
        }

        case "device_upload":
        case "device_download":
            return macosDesktopResult(await macosDesktop.handle(name, args));

        case "device_screenshot": {
            const { deviceId, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const tempRoot = mkdtempSync(join(tmpdir(), "ccc-macos-screenshot-"));
            const localPath = join(tempRoot, "screenshot.png");
            const remotePath = `/tmp/ccc-${device.id}-${randomUUID()}-screenshot.png`;
            const commandOptions = sshCommandOptions(device);
            try {
                const capture = runHelperCommand(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, macosScreenshotCommand(remotePath)], helperTimeoutMs, commandOptions);
                if (capture.status !== 0) return fail(capture);
                const copy = runHelperCommand(bridge.discovery.scp, [...scpBaseArgs(device), `${bridge.target}:${remotePath}`, localPath], helperTimeoutMs, commandOptions);
                if (copy.status !== 0) return fail(copy);
                return screenshotFileResult(localPath, "macos-vm-screenshot");
            } finally {
                runHelperCommand(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, `rm -f -- ${shellQuote(remotePath)}`], Math.min(macosHelperTimeoutMs(helperTimeoutMs), 5000), commandOptions);
                rmSync(tempRoot, { recursive: true, force: true });
            }
        }

        case "device_click":
        case "device_double_click":
        case "device_key":
        case "device_type":
        case "device_scroll":
        case "device_focus_window":
        case "device_drag":
        case "device_cursor_position":
        case "device_window_list":
            return macosDesktopResult(await macosDesktop.handle(name, args));

        case "device_accessibility_snapshot": {
            const { deviceId, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const maxDepth = Math.max(0, Math.min(Number.isFinite(Number(args.maxDepth)) ? Number(args.maxDepth) : 3, 8));
            const maxNodes = Math.max(1, Math.min(Number.isFinite(Number(args.maxNodes)) ? Number(args.maxNodes) : 200, 1000));
            const helper = macosHelperCommand(device, "accessibility_snapshot", [String(maxDepth), String(maxNodes)], helperTimeoutMs);
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            const payload = macosHelperJson(helper.result.stdout);
            return jsonResult({
                provider: payload?.accessibility?.provider || payload?.provider || "macos-system-events",
                remoteScriptPath: helper.remoteScriptPath,
                accessibility: payload?.accessibility || null,
                response: payload,
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

        case "device_record_video_status": {
            const { deviceId } = args;
            const device = reconcileMacosRecording(findMacosDevice(deviceId));
            if (!device) return undefined;
            return jsonResult({ deviceId, recording: device.recording || null, provider: "ssh-screencapture-video" });
        }

        case "device_record_video_start": {
            const { deviceId, remotePath, localPath, timeLimitSec } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (device.recording) {
                const state = device.recording.active ? "already active" : "pending finalization";
                return textResult(false, `macOS VM recording ${state} for ${deviceId}`);
            }
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            ensureMacosWorkspace(device);
            const resolvedRemotePath = remotePath || `/tmp/ccc-${device.id}-recording.mov`;
            const resolvedLocalPath = localPath || macosRecordingLocalPath(device);
            const localPolicy = validateLocalOutputPath(resolvedLocalPath, { label: "recording-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const safeLocalPath = localPolicy.path;
            mkdirSync(dirname(safeLocalPath), { recursive: true });
            const limitPrefix = timeLimitSec ? `sleep ${Number(timeLimitSec)}; pkill -INT -f ${shellQuote(`screencapture.*${resolvedRemotePath}`)}` : "wait";
            const command = [
                `rm -f ${shellQuote(resolvedRemotePath)}`,
                `(screencapture -v ${shellQuote(resolvedRemotePath)} &)`,
                limitPrefix,
            ].join("; ");
            const child = spawn(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, command], {
                detached: true,
                stdio: "ignore",
                env: { ...process.env, ...(sshCommandOptions(device).env || {}) },
                windowsHide: true,
            });
            let recording = null;
            const runtimeId = randomUUID();
            let exited = false;
            child.once("exit", () => {
                exited = true;
                if (recording) monitorMacosRecordingExit(deviceId, recording)();
            });
            const startError = await waitForRecorderProcess(child, "macOS VM screencapture");
            if (startError) return startError;
            const processIdentity = readProcessIdentity(child.pid);
            if (!processIdentity) {
                try { child.kill("SIGINT"); } catch { /* recorder already exited */ }
                return textResult(false, `macOS VM recorder process identity could not be established for ${deviceId}.`);
            }
            recording = {
                active: true,
                provider: "ssh-screencapture-video",
                runtimeId,
                pid: child.pid,
                processIdentity,
                remotePath: resolvedRemotePath,
                localPath: safeLocalPath,
                timeLimitSec: timeLimitSec || null,
                startedAt: new Date().toISOString(),
            };
            child.unref();
            let committed;
            try {
                committed = transitionRecordingGeneration(updateMacosDevice, deviceId, device.recording ?? null, recording);
            } catch (error) {
                recording = null;
                const terminated = await terminateStartedRecorder(child);
                const detail = error instanceof Error ? error.message : String(error);
                return textResult(false, `macOS VM recording metadata persistence failed for ${deviceId}; the new recorder was ${terminated ? "stopped" : "sent termination signals"}: ${detail}`);
            }
            if (!committed.committed) {
                recording = null;
                const terminated = await terminateStartedRecorder(child);
                return textResult(false, `macOS VM recording state changed while starting for ${deviceId}; the new recorder was ${terminated ? "stopped" : "sent termination signals"}.`);
            }
            if (exited || !processIsAlive(child.pid)) {
                transitionRecordingGeneration(updateMacosDevice, deviceId, recording, null);
                return textResult(false, `macOS VM recorder exited before its state was committed for ${deviceId}.`);
            }
            return jsonResult({ deviceId, recording: committed.device.recording });
        }

        case "device_record_video_stop": {
            const { deviceId, localPath, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (!device.recording) return textResult(false, `No macOS VM recording active for ${deviceId}`);
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const previous = device.recording;
            const resolvedLocalPath = localPath || previous.localPath || macosRecordingLocalPath(device);
            const localPolicy = validateLocalOutputPath(resolvedLocalPath, { label: "recording-local-path" });
            if (!localPolicy.ok) return textResult(false, localPolicy.message);
            const safeLocalPath = localPolicy.path;
            if (previous.active) {
                const recorderSignal = signalOwnedRuntimeProcess(previous, "SIGINT");
                runHelperCommand(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, `pkill -INT -f ${shellQuote(`screencapture.*${previous.remotePath}`)} || true`], helperTimeoutMs, sshCommandOptions(device));
                if (recorderSignal.signaled) {
                    const exited = await waitForProcessExit(previous.pid, 3000);
                    if (!exited) return textResult(false, `macOS VM recording did not exit within 3000ms for ${deviceId}; state remains active.`);
                }
            }
            const claimed = claimRecordingFinalization(updateMacosDevice, deviceId, previous, { localPath: safeLocalPath });
            if (!claimed.committed || !claimed.device?.recording) {
                return textResult(false, `macOS VM recording state changed while stopping for ${deviceId}; successor state was preserved.`);
            }
            const pending = claimed.device.recording;
            mkdirSync(dirname(safeLocalPath), { recursive: true });
            const localStage = createLocalOutputStage(safeLocalPath, { label: "recording-local-path" });
            if (!localStage.ok) return textResult(false, localStage.message);
            try {
                const copy = runHelperCommand(bridge.discovery.scp, [...scpBaseArgs(device), `${bridge.target}:${pending.remotePath}`, localStage.stagedPath], helperTimeoutMs, sshCommandOptions(device));
                if (copy.status !== 0) {
                    return textResult(false, `Error: ${copy.stderr || copy.stdout || `exit ${copy.status}`}. macOS VM recording remains pending finalization for ${deviceId}.`);
                }
                const committed = commitLocalOutputStage(localStage, { label: "recording-local-path", minBytes: 1 });
                if (!committed.ok) {
                    return textResult(false, `${committed.message}. macOS VM recording remains pending finalization for ${deviceId}.`);
                }
                const cleared = transitionRecordingGeneration(updateMacosDevice, deviceId, pending, null);
                const updated = cleared.device;
                if (!cleared.committed) {
                    return textResult(false, `macOS VM recording state changed while stopping for ${deviceId}; successor state and remote artifact were preserved.`);
                }
                runHelperCommand(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, `rm -f ${shellQuote(pending.remotePath)}`], helperTimeoutMs, sshCommandOptions(device));
                return jsonResult({
                    deviceId,
                    stopped: true,
                    provider: "ssh-screencapture-video",
                    recording: { ...pending, active: false, localPath: safeLocalPath, stoppedAt: new Date().toISOString() },
                    device: updated,
                    stdout: copy.stdout,
                    stderr: copy.stderr,
                });
            } finally {
                localStage.cleanup();
            }
        }

        default:
            return undefined;
    }
}

export async function handleMacosTool(name, args) {
    if (!requiresOwnerDeviceOperation("macos", name)) return handleMacosToolUnlocked(name, args);
    const createsDevice = ["device_create", "device_base_image_create", "device_base_image_clone"].includes(name);
    const deviceId = typeof args?.deviceId === "string"
        ? args.deviceId
        : createsDevice && typeof args?.name === "string"
            ? macosDeviceId(args.name)
            : null;
    if (!deviceId) return handleMacosToolUnlocked(name, args);
    if (!createsDevice && !findMacosDevice(deviceId)) return handleMacosToolUnlocked(name, args);
    try {
        if (name === "device_base_image_clone" && typeof args?.sourceDeviceId === "string") {
            return await withOwnerDeviceOperations("macos", [deviceId, args.sourceDeviceId], () => handleMacosToolUnlocked(name, args));
        }
        return await withOwnerDeviceOperation("macos", deviceId, () => handleMacosToolUnlocked(name, args));
    } catch (error) {
        if (error?.code !== "shared-mutation-lock-timeout") throw error;
        return textResult(false, `macOS VM device operation lock failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function macosObservationHelperPaths(device) { ensureMacosWorkspace(device); return { workspaceDir: macosWorkspaceDir(device), toolsDir: macosToolsDir(device), hostHelperScript: join(macosToolsDir(device), "ccc-guest-helper.sh") }; }
const deviceObservation = createDeviceObservation({ kind: "macos-vm", ownerId: () => ownerId(), now: () => Date.now(), readPhysicalLeases: backend => observationPhysicalLeases(backend), capabilities: [
        "device_list_files",
        "device_inventory",
        "device_create",
        "device_delete",
        "device_start",
        "device_stop",
        "device_status",
        "device_exec",
        "device_screenshot",
        "device_click",
        "device_double_click",
        "device_key",
        "device_type",
        "device_scroll",
        "device_cursor_position",
        "device_window_list",
        "device_focus_window",
        "device_drag",
        "device_accessibility_snapshot",
        "device_base_image_create",
        "device_base_image_clone",
        "device_snapshot_create",
        "device_snapshot_restore",
        "device_snapshot_delete",
        "device_record_video_start",
        "device_record_video_stop",
        "device_record_video_status",
        "device_upload",
        "device_download",
    ], platform: () => process.platform, providerNames: PROVIDERS.map(provider => provider.name), executable: name => commandPath(name), records: () => readMacosDevices(), helperPaths: device => macosObservationHelperPaths(device) });
