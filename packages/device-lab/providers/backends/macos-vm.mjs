import { createDirectRecording } from "../adapters/direct-recording.mjs";
import { macosImageProviderRefusal } from "../domain/macos-image-snapshots.mjs";
import { createMacosImageSnapshots } from "../application/macos-image-snapshots.mjs";
import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { observationMacosHelper, observationMacosStartArgs } from "../domain/device-observation.mjs";
import { createMacosVmLifecycleApplication } from "../application/lifecycle/macos-vm-lifecycle.mjs";
import { macosProviderInstanceReferenced, managedProviderResource, snapshotProviderInstances, restoreRecoveryProviderInstances } from "../domain/lifecycle/macos-vm-lifecycle.mjs";
import { MACOS_WINDOW_JXA } from "./macos-window-focus.mjs";
import { createDesktopControlTransfer } from "../application/desktop-control-transfer.mjs";
import { createDesktopDeviceAccess } from "../application/desktop-device-access.mjs";
import { createDesktopAccessResult } from "../adapters/desktop-access-result.mjs";
import { commandPath, run, runWithTimeout } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { validateGuestPath, validateLocalOutputPath, validateLocalReferencePath } from "../policy/files.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { readScreenshotFile } from "../screenshot-file.mjs";
import { claimMacosDevice, findMacosDevice, readMacosDevices, transitionMacosDevice, updateMacosDevice } from "../state/macos-state.mjs";
import { withOwnerDeviceOperation, withOwnerDeviceOperations } from "../state/device-store.mjs";
import { requiresOwnerDeviceOperation } from "../state/device-operation-policy.mjs";
import { inspectProcessIdentity, signalOwnedRuntimeProcess } from "../state/process-identity.mjs";
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
const macosVmNativeLifecycle = createMacosVmLifecycleApplication({
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
    providerPlan: device => macosNativePlan(macosProviderPlan(device)),
    tartPlan: (device, name) => {
        const result = tartProviderPlan(device,name);
        return result.error ? {error:{kind:'native',evidence:result.error}} : {plan:macosNativePlan(result.plan)};
    },
    cloneInstance: (plan,source,target) => macosNativeObservation(runProviderCommand(plan.evidence.providerCommand,['clone',source,target],'clone')),
    deleteInstance: (plan,instance) => macosNativeObservation(runProviderCommand(plan.evidence.providerCommand,['delete',instance],'delete')),
    stopInstance: plan => macosNativeObservation(runProviderCommand(plan.evidence.stopCommand.command,plan.evidence.stopCommand.args,'stop')),
    launchProvider: (plan,device) => {
        const native = plan.evidence;
        const startCommand = native.selectedProvider === 'tart' && native.providerCommand
            ? {command:native.providerCommand,args:providerByName('tart').startArgs(native.providerInstance,{...device,softnet:device.softnet !== false && tartSupportsFeature(native.providerCommand,'--with-softnet')})}
            : native.startCommand;
        const child = spawn(startCommand.command,startCommand.args,{detached:true,stdio:'ignore',env:process.env,windowsHide:true});
        return {child,startCommand};
    },
    waitProviderStart: async child => {
        const error = await waitForProviderStart(child,'macOS VM provider start');
        return error ? {kind:'native',evidence:error} : null;
    },
    waitBoot: (plan,timeoutMs,deadlineAt) => waitForMacosBoot(plan.evidence,timeoutMs,deadlineAt),
    interruptGuestRecording: (device,recording) => {
        const bridge = sshBridge(device,'device_record_video_stop');
        if (!bridge.error) runHelperCommand(bridge.discovery.ssh,[...sshBaseArgs(device),bridge.target,`pkill -INT -f ${shellQuote(`screencapture.*${recording.remotePath}`)} || true`],undefined,sshCommandOptions(device));
    },
    get waitGuestHelper() { return waitForMacosGuestHelper; },
    get provisionHelper() { return provisionMacosGuestHelper; },
    get signalRecording() { return signalOwnedRuntimeProcess; },
    get waitRecordingExit() { return waitForOwnedRecordingExit; },
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

});

/** @param {import('../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmProviderPlan} evidence
 * @returns {import('../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmNativePlan} */
function macosNativePlan(evidence) {
    return {available:evidence.available,missing:evidence.missing,selectedProvider:evidence.selectedProvider,providerInstance:evidence.providerInstance,stopAvailable:Boolean(evidence.stopCommand),evidence};
}
/** @param {import('../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmCommandResult} evidence
 * @returns {import('../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmNativeObservation} */
function macosNativeObservation(evidence) {
    return {ok:evidence.status === 0,timedOut:providerCommandTimedOut(evidence),detail:evidence.stderr||evidence.stdout||evidence.error?.message||`exit ${evidence.status}`,evidence};
}
/** @param {import('../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmLifecycleOutcome|undefined} outcome */
function presentMacosLifecycle(outcome) {
    if (!outcome) return undefined;
    if (outcome.kind === 'identity-conflict') return textResult(false,`Device identity already exists for this owner (${outcome.field}: ${typeof outcome.value === 'object' ? JSON.stringify(outcome.value) : outcome.value})`);
    if (outcome.kind === 'refused') return textResult(false,outcome.message);
    if (outcome.kind === 'native') return outcome.evidence;
    if (outcome.kind === 'failed') return fail(outcome.evidence);
    if (outcome.kind === 'clone-failed') return presentMacosCloneFailure({target:outcome.evidence.target,command:outcome.evidence.command.evidence,cleanup:outcome.evidence.cleanup?.evidence||null});
    const value = /** @type {{device?:import('../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmDevice,native?:import('../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmCommandResult,rollback?:import('../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmRollback} & Record<string,unknown>} */ (outcome.value);
    const {native,...payload} = value;
    if (payload.device) payload.device = deviceWithPlan(payload.device);
    if (payload.rollback?.evidence) {
        const {evidence,...rollback} = payload.rollback;
        payload.rollback = {...rollback,.../** @type {import('../ports/lifecycle/macos-vm-lifecycle.mjs').MacosVmCommandResult} */ (evidence)};
    }
    if (native) Object.assign(payload,{stdout:native.stdout,stderr:native.stderr,status:native.status});
    return outcome.kind === 'problem' ? textResult(false,JSON.stringify(payload)) : jsonResult(payload);
}
// Existing image/snapshot policy consumes the original raw helper contract.
// Adapt only at this native composition; the direct lifecycle stays finite.
/** @type {import('../application/lifecycle/macos-vm-lifecycle.mjs').MacosVmLifecycle<ReturnType<typeof textResult>>} */
const macosVmLifecycle = {
    ...macosVmNativeLifecycle,
    create: (args, admittedDeviceId) => presentMacosLifecycle(macosVmNativeLifecycle.create(args, admittedDeviceId)),
    createImage: (args, admittedDeviceId) => presentMacosLifecycle(macosVmNativeLifecycle.createImage(args, admittedDeviceId)),
    start: async args => presentMacosLifecycle(await macosVmNativeLifecycle.start(args)),
    stop: async args => presentMacosLifecycle(await macosVmNativeLifecycle.stop(args)),
    delete: async args => presentMacosLifecycle(await macosVmNativeLifecycle.delete(args)),
    conflict: (...args) => presentMacosLifecycle(macosVmNativeLifecycle.conflict(...args)),
    recoverStale: id => {
        const result = macosVmNativeLifecycle.recoverStale(id);
        return result.error ? {error:presentMacosLifecycle(result.error)} : result;
    },
    rollbackStarted: (id,claim,plan) => macosVmNativeLifecycle.rollbackStarted(id,claim,macosNativePlan(plan)),
    rollbackCreated: (id,plan,instance) => macosVmNativeLifecycle.rollbackCreated(id,macosNativePlan(plan),instance),
    clone: (plan,source,target) => {
        const result = macosVmNativeLifecycle.clone(macosNativePlan(plan),source,target);
        return {result:result.result.evidence,cleanup:result.cleanup?.evidence||null};
    },
    cloneFailure: (result,cleanup,target) => presentMacosLifecycle(macosVmNativeLifecycle.cloneFailure(macosNativeObservation(result),cleanup ? macosNativeObservation(cleanup) : null,target)),
    cloneFailureEvidence: (command,cleanup,target) => ({command,cleanup,target}),
};


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

function macosDeviceId() {
    return `macos-${randomUUID()}`;
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



function tartProviderPlan(device, toolName) {
    const plan = macosProviderPlan(device);
    const refusal = macosImageProviderRefusal(plan, device, toolName);
    return refusal ? { error: textResult(false, refusal) } : { plan };
}





function validateMacosSshKeyPath(sshKeyPath) {
    return validateLocalReferencePath(sshKeyPath, { label: "ssh-key-path" });
}











function macosLifecycleClaimTtlMs() {
    const parsed = Number(process.env.CCC_MACOS_VM_LIFECYCLE_CLAIM_TTL_MS || MACOS_LIFECYCLE_CLAIM_TTL_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : MACOS_LIFECYCLE_CLAIM_TTL_MS;
}


function recoverStaleMacosLifecycle(deviceId) {
    return macosVmLifecycle.recoverStale(deviceId);
}

function rollbackStartedMacosVm(deviceId, lifecycle, plan) {
    return macosVmLifecycle.rollbackStarted(deviceId, lifecycle, plan);
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

/** @param {string|undefined} key */
function macosKeySpec(key) {
    const value = String(key || "");
    /** @type {Record<string,number>} */
    const keyCodes = {
        A: 0, B: 11, C: 8, D: 2, E: 14, F: 3, G: 5, H: 4, I: 34, J: 38, K: 40, L: 37, M: 46,
        N: 45, O: 31, P: 35, Q: 12, R: 15, S: 1, T: 17, U: 32, V: 9, W: 13, X: 7, Y: 16, Z: 6,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
        Enter: 36, Return: 36, Tab: 48, Space: 49, Delete: 51, Backspace: 51, Escape: 53, Esc: 53,
        ArrowLeft: 123, Left: 123, ArrowRight: 124, Right: 124, ArrowDown: 125, Down: 125, ArrowUp: 126, Up: 126,
        Home: 115, End: 119, PageUp: 116, PageDown: 121,
        F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
    };
    const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
    const keyPart = parts.length > 0 ? parts[parts.length - 1] : value;
    const normalizedKey = keyPart.length === 1 ? keyPart.toUpperCase() : keyPart;
    const keyCode = keyCodes[normalizedKey];
    if (keyCode === undefined) return null;
    const modifiers = [];
    for (const part of parts.slice(0, -1).map((item) => item.toLowerCase())) {
        if (part === "cmd" || part === "command" || part === "meta") modifiers.push("command");
        else if (part === "ctrl" || part === "control") modifiers.push("control");
        else if (part === "alt" || part === "option") modifiers.push("option");
        else if (part === "shift") modifiers.push("shift");
        else return null;
    }
    return { key, keyCode, modifiers };
}

/** @typedef {{kind:'native',value:ReturnType<typeof textResult>}|{kind:'command',result:ReturnType<typeof runHelperCommand>}|{kind:'helper',helper:{result:ReturnType<typeof runHelperCommand>,remoteScriptPath:string},payload:ReturnType<typeof macosHelperJson>}} MacosDesktopEvidence */
/** @param {ReturnType<typeof runHelperCommand>} result @returns {import('../ports/desktop-control-transfer.mjs').NativeObservation} */
function macosDesktopCommand(result) {
    return { ok: result.status === 0, evidence: { kind: "command", result } };
}
/** @param {ReturnType<typeof findMacosDevice>} device @param {string} operation @param {string[]} argv @param {number|undefined} timeoutMs */
function macosDesktopHelper(device, operation, argv, timeoutMs) {
    const helper = macosHelperCommand(device, operation, argv, timeoutMs);
    if (helper.error !== undefined) return { ok: false, evidence: { kind: "native", value: helper.error }, verified: false };
    const payload = macosHelperJson(helper.result.stdout);
    return { ok: helper.result.status === 0, evidence: { kind: "helper", helper, payload }, verified: payload?.ok === true };
}

/** @typedef {{path:string, stagedPath:string, cleanup:()=>void}} MacosTransferStage */
/** @type {import('../ports/desktop-control-transfer.mjs').MacosPorts<ReturnType<typeof findMacosDevice>, {target:string, discovery:ReturnType<typeof sshDiscovery>}, MacosTransferStage>} */
const macosDesktopPorts = {
    variant: "macos",
    target: deviceId => findMacosDevice(deviceId),
    supportsKey: key => macosKeySpec(key) !== null,
    click: (device, x, y, button, timeoutMs) => macosDesktopHelper(device, "click", [String(x), String(y), button], timeoutMs),
    doubleClick: (device, x, y, button, timeoutMs) => macosDesktopHelper(device, "double_click", [String(x), String(y), button], timeoutMs),
    key: (device, key, timeoutMs) => {
        const spec = /** @type {NonNullable<ReturnType<typeof macosKeySpec>>} */ (macosKeySpec(key));
        return macosDesktopHelper(device, "key", [String(spec.keyCode), spec.modifiers.join(",")], timeoutMs);
    },
    type: (device, text, timeoutMs) => macosDesktopHelper(device, "type", [text], timeoutMs),
    scroll: (device, direction, amount, timeoutMs) => macosDesktopHelper(device, "scroll", [direction, String(amount)], timeoutMs),
    drag: (device, args, timeoutMs) => macosDesktopHelper(device, "drag", [args.x1, args.y1, args.x2, args.y2, args.durationMs].map(String), timeoutMs),
    focusWindow: (device, handle, timeoutMs) => macosDesktopHelper(device, "focus_window", [handle], timeoutMs),
    movePointer: (device, x, y, timeoutMs) => macosDesktopHelper(device, "move", [String(x), String(y)], timeoutMs),
    cursorPosition: (device, timeoutMs) => macosDesktopHelper(device, "cursor_position", [], timeoutMs),
    windowList: (device, timeoutMs) => macosDesktopHelper(device, "window_list", [], timeoutMs),
    bridge: (device, operation) => {
        const bridge = sshBridge(device, operation);
        return bridge.error !== undefined ? { ok: false, evidence: { kind: "native", value: bridge.error } } : { ok: true, bridge };
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
    upload: (device, bridge, stagedPath, remotePath, timeoutMs) => macosDesktopCommand(runHelperCommand(bridge.discovery.scp,
        [...scpBaseArgs(device), stagedPath, `${bridge.target}:${remotePath}`], timeoutMs, sshCommandOptions(device))),
    download: (device, bridge, remotePath, stagedPath, timeoutMs) => macosDesktopCommand(runHelperCommand(bridge.discovery.scp,
        [...scpBaseArgs(device), `${bridge.target}:${remotePath}`, stagedPath], timeoutMs, sshCommandOptions(device))),
    commitOutput: stage => {
        const committed = commitLocalOutputStage(stage, { label: "download-local-path" });
        return committed.ok ? { ok: true, path: committed.path } : { ok: false, message: committed.message };
    },
    disposeInput: stage => { stage.cleanup(); return undefined; },
    disposeOutput: stage => { stage.cleanup(); return undefined; },
};
const macosDesktop = createDesktopControlTransfer(macosDesktopPorts);

/** @param {import('../ports/desktop-control-transfer.mjs').CommandReceipt} receipt */
function macosAccessEffect(receipt) { return {ok:receipt.status === 0,receipt}; }

/** @typedef {{tempRoot:string,localPath:string,remotePath:string,commandOptions:ReturnType<typeof sshCommandOptions>}} MacosScreenshotStage */
/** @type {import('../ports/desktop-device-access.mjs').MacosDeviceAccessPorts<NonNullable<ReturnType<typeof findMacosDevice>>,ReturnType<typeof macosDiscovery>,{target:string,discovery:ReturnType<typeof sshDiscovery>},MacosScreenshotStage>} */
const macosAccessPorts = {
    variant: "macos",
    target: id => findMacosDevice(id),
    discovery: () => macosDiscovery(),
    publicDevice: (device, discovery) => deviceWithPlan(device, discovery),
    backend: discovery => macosBackend(discovery),
    bridge: (device, operation) => {
        const bridge = sshBridge(device, operation);
        return bridge.error !== undefined ? { ok: false, result: bridge.error } : { ok: true, bridge };
    },
    exec: (device, bridge, command, timeoutMs) => {
        const result = runHelperCommand(bridge.discovery.ssh,
            [...sshBaseArgs(device), bridge.target, command], timeoutMs, sshCommandOptions(device));
        return {stdout:result.stdout,stderr:result.stderr,status:result.status,provider:'ssh'};
    },
    accessibility: (device, limits, timeoutMs) => {
        const helper = macosHelperCommand(device, "accessibility_snapshot", [String(limits.maxDepth),String(limits.maxNodes)], timeoutMs);
        if (helper.error !== undefined) return {ok:false,outcome:{kind:'native',value:helper.error}};
        const result = helper.result;
        if (result.status !== 0) return {ok:false,outcome:{kind:'command-failure',receipt:result}};
        const payload = macosHelperJson(result.stdout);
        return {ok:true,value:{provider:payload?.accessibility?.provider||payload?.provider||'macos-system-events',remoteScriptPath:helper.remoteScriptPath,accessibility:payload?.accessibility||null,response:payload,stdout:result.stdout,stderr:result.stderr,status:result.status}};
    },
    stageScreenshot: device => {
        const tempRoot = mkdtempSync(join(tmpdir(), "ccc-macos-screenshot-"));
        const localPath = join(tempRoot, "screenshot.png");
        const remotePath = `/tmp/ccc-${device.id}-${randomUUID()}-screenshot.png`;
        const commandOptions = sshCommandOptions(device);
        return { tempRoot, localPath, remotePath, commandOptions };
    },
    capture: (device, bridge, stage, timeoutMs) => macosAccessEffect(runHelperCommand(bridge.discovery.ssh,
        [...sshBaseArgs(device), bridge.target, macosScreenshotCommand(stage.remotePath)], timeoutMs, stage.commandOptions)),
    copy: (device, bridge, stage, timeoutMs) => macosAccessEffect(runHelperCommand(bridge.discovery.scp,
        [...scpBaseArgs(device), `${bridge.target}:${stage.remotePath}`, stage.localPath], timeoutMs, stage.commandOptions)),
    readScreenshot: stage => readScreenshotFile(stage.localPath, "macos-vm-screenshot"),
    cleanupRemote: (device, bridge, stage, timeoutMs) => macosAccessEffect(runHelperCommand(bridge.discovery.ssh,
        [...sshBaseArgs(device), bridge.target, `rm -f -- ${shellQuote(stage.remotePath)}`], Math.min(macosHelperTimeoutMs(timeoutMs), 5000), stage.commandOptions)),
    disposeScreenshot: stage => { rmSync(stage.tempRoot, { recursive: true, force: true }); return undefined; },
};
const macosAccess = createDesktopDeviceAccess(macosAccessPorts);

const macosAccessResult = createDesktopAccessResult({jsonResult,textResult,fail});

/** @param {import('../domain/desktop-control-transfer.mjs').DesktopOutcome} outcome */
function macosDesktopResult(outcome) {
    if (outcome === undefined) return undefined;
    if (outcome.kind === "refused") return textResult(false, outcome.message);
    const evidence = /** @type {MacosDesktopEvidence} */ (outcome.evidence);
    if (evidence.kind === "native") return evidence.value;
    const result = evidence.kind === "command" ? evidence.result : evidence.helper.result;
    if (outcome.kind === "failed") return fail(result);
    const { name, args } = outcome;
    if (name === "device_upload" || name === "device_download") {
        const paths = name === "device_upload" ? { uploaded: { localPath: args.localPath, remotePath: args.remotePath } } : { downloaded: { remotePath: args.remotePath, localPath: args.localPath } };
        return jsonResult({ ...paths, stdout: result.stdout, stderr: result.stderr, provider: "scp" });
    }
    if (name === "device_drag" || name === "device_focus_window" || (name === "device_cursor_position" && (args.x !== undefined || args.y !== undefined))) return jsonResult({ ok: true });
    const helperEvidence = /** @type {Extract<MacosDesktopEvidence,{kind:'helper'}>} */ (evidence);
    const payload = helperEvidence.payload;
    const fields = { provider: "ssh-macos-helper", remoteScriptPath: helperEvidence.helper.remoteScriptPath, stdout: result.stdout, stderr: result.stderr, status: result.status };
    if (name === "device_key") return jsonResult({ ...fields, key: macosKeySpec(args.key) });
    if (name === "device_type") return jsonResult({ ...fields, typed: { text: String(args.text) } });
    if (name === "device_click" || name === "device_double_click") return jsonResult({ ...fields, [name === "device_click" ? "clicked" : "doubleClicked"]: payload?.doubleClicked || payload?.clicked || { x: Number(args.x), y: Number(args.y), button: args.button ?? "left" } });
    if (name === "device_scroll") return jsonResult({ ...fields, scrolled: payload?.scrolled || { direction: args.direction ?? "down", amount: Number(args.amount) || 1 } });
    if (name === "device_cursor_position") return jsonResult({ ...fields, cursor: payload?.cursor || null });
    return jsonResult({ ...fields, provider: payload?.provider || "macos-system-events", windows: Array.isArray(payload?.windows) ? payload.windows : [], response: payload });
}

export function listMacosDevices({identityOnly=false}={}) { return deviceObservation.owned({identityOnly}); }

/** @type {import('../ports/direct-recording.mjs').DirectRecordingNative} */
const macosRecordingNative = {
    kind: "macos-vm",
    findDevice: id => findMacosDevice(id),
    updateDevice: (id, update) => updateMacosDevice(id, update),
    localPath: device => macosRecordingLocalPath(device),
    validateLocalOutputPath: (path, options) => validateLocalOutputPath(path, options),
    recordingDirectory: device => macosRecordingDir(device),
    resolveTarget: (device, operation) => {
        const bridge = sshBridge(device, operation);
        if (bridge.error) return { kind: "native", value: bridge.error };
        return { kind: "ready", device, target: {
            kind: "ssh", executable: bridge.discovery.ssh, prefix: sshBaseArgs(device), target: bridge.target,
            scp: bridge.discovery.scp, scpPrefix: scpBaseArgs(device), env: sshCommandOptions(device).env,
        } };
    },
    runCommand: command => runHelperCommand(command.executable, command.args, command.timeoutMs, { env: command.env }),
    ensureWorkspace: device => { ensureMacosWorkspace(device); return undefined; },
};
const macosRecording = createDirectRecording(macosRecordingNative);
/** @param {import('../domain/direct-recording.mjs').RecordingOutcome|undefined} outcome */
function macosRecordingResult(outcome) {
    if (!outcome || outcome.kind === "missing") return undefined;
    if (outcome.kind === "native") return outcome.value;
    if (outcome.kind === "failure") return textResult(false, outcome.message);
    return jsonResult(outcome.value);
}

async function handleMacosToolUnlocked(name, args, admittedDeviceId) {
    if (admittedDeviceId) {
        const instance = `ccc-${ownerId()}-${admittedDeviceId}`;
        if (readMacosDevices().some(device => device.id === admittedDeviceId || macosProviderInstanceReferenced(device, instance))
            || existsSync(macosWorkspaceDir({ id: admittedDeviceId }))) {
            return textResult(false, `Device already exists for this owner: ${admittedDeviceId}`);
        }
    }
    if (requiresOwnerDeviceOperation("macos", name)) {
        for (const candidate of [args?.deviceId, args?.sourceDeviceId]) {
            if (typeof candidate !== "string") continue;
            const recovery = recoverStaleMacosLifecycle(candidate);
            if (recovery.error) return recovery.error;
        }
    }
    switch (name) {
        case "device_inventory": { const value=deviceObservation.inventory(args); return value === undefined ? undefined : jsonResult(value); }


        case "device_base_image_create": return macosVmLifecycle.createImage(args, admittedDeviceId);

        case "device_base_image_clone": return macosImages.clone(args, admittedDeviceId);

        case "device_create": return macosVmLifecycle.create(args, admittedDeviceId);

        case "device_delete": return macosVmLifecycle.delete(args);

        case "device_status": return macosAccessResult(await macosAccess.handle(name, args));

        case "device_snapshot_create": return macosImages.createSnapshot(args);
        case "device_snapshot_restore": return macosImages.restoreSnapshot(args);
        case "device_snapshot_delete": return macosImages.deleteSnapshot(args);

        case "device_start": return macosVmLifecycle.start(args);

        case "device_stop": return macosVmLifecycle.stop(args);

        case "device_exec": return macosAccessResult(await macosAccess.handle(name, args));

        case "device_upload":
        case "device_download":
            return macosDesktopResult(await macosDesktop.handle(name, args));

        case "device_screenshot": return macosAccessResult(await macosAccess.handle(name, args));

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

        case "device_accessibility_snapshot": return macosAccessResult(await macosAccess.handle(name, args));

        case "device_record_video_status":
        case "device_record_video_start":
        case "device_record_video_stop":
            return macosRecordingResult(await macosRecording.request(name, args));

        default:
            return undefined;
    }
}

export async function handleMacosTool(name, args) {
    if (!requiresOwnerDeviceOperation("macos", name) && !["device_status", "device_record_video_status"].includes(name)) return handleMacosToolUnlocked(name, args);
    const createsDevice = ["device_create", "device_base_image_create", "device_base_image_clone"].includes(name);
    if (createsDevice && Object.hasOwn(args, "deviceId")) {
        return textResult(false, "macOS VM creation does not accept deviceId");
    }
    const admittedDeviceId = createsDevice ? macosDeviceId() : undefined;
    const deviceId = admittedDeviceId ?? (typeof args?.deviceId === "string" ? args.deviceId : null);
    if (!deviceId) return handleMacosToolUnlocked(name, args);
    try {
        if (name === "device_base_image_clone" && typeof args?.sourceDeviceId === "string") {
            return await withOwnerDeviceOperations("macos", [deviceId, args.sourceDeviceId], () => handleMacosToolUnlocked(name, args, admittedDeviceId));
        }
        return await withOwnerDeviceOperation("macos", deviceId, () => handleMacosToolUnlocked(name, args, admittedDeviceId));
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

/** @param {import('../ports/lifecycle/macos-vm-lifecycle.mjs').MacosCloneFailureEvidence} evidence */
function macosCloneFailureText(evidence) {
    const { command: result, cleanup, target } = evidence;
    if (!cleanup) return null;
    return JSON.stringify({ ok: false, error: "macos-tart-clone-failed", target, timedOut: true,
        command: { status: result.status, signal: result.signal || null, detail: result.stderr || result.stdout || result.error?.message || "clone timed out" },
        cleanup: { ok: cleanup.status === 0, status: cleanup.status, signal: cleanup.signal || null, detail: cleanup.stderr || cleanup.stdout || cleanup.error?.message || null },
    });
}
/** @param {import('../ports/lifecycle/macos-vm-lifecycle.mjs').MacosCloneFailureEvidence} evidence */
function presentMacosCloneFailure(evidence) {
    const text = macosCloneFailureText(evidence);
    return text === null ? fail(evidence.command) : textResult(false, text);
}

const macosImages = createMacosImageSnapshots({
    read: () => readMacosDevices(),
    find: id => findMacosDevice(id),
    claim: device => claimMacosDevice(device),
    transition: (id, expected, replacement) => transitionMacosDevice(id, expected, replacement),
    owner: () => ownerId(),
    deviceId: () => macosDeviceId(),
    snapshotId: name => macosSnapshotId(name),
    timestamp: () => new Date().toISOString(),
    runtimeId: () => randomUUID(),
    validateSshKey: path => validateMacosSshKeyPath(path),
    helperMetadata: device => macosHelperMetadata(device),
    providerPlan: device => macosProviderPlan(device),
    providerCommand: (command, args, kind) => runProviderCommand(command, args, kind),
    publicDevice: device => deviceWithPlan(device),
    signalRecording: (recording, signal) => signalOwnedRuntimeProcess(recording, signal),
    waitRecordingExit: (recording, timeoutMs) => waitForProcessExit(recording?.pid, timeoutMs),
    textResult: (ok, message) => textResult(ok, message),
    jsonResult: value => jsonResult(value),
    fail: command => fail(command),
    presentRestoreFailure: (evidence, fallbackError, candidate) => textResult(false, `${evidence ? macosCloneFailureText(evidence) || `Error: ${fallbackError}` : `Error: ${fallbackError}`}. Restore candidate preserved: ${candidate}`),
}, macosVmLifecycle);
