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
import { withTargetStatus } from "../status.mjs";
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
        startArgs: (instance, options = {}) => ["run", ...(options.softnet ? ["--with-softnet"] : []), ...(options.headless ? ["--no-graphics"] : []), instance],
        stopArgs: (instance) => ["stop", instance],
        deleteArgs: (instance) => ["delete", instance],
    },
    {
        name: "vz",
        command: "vz",
        startArgs: (instance) => ["start", instance],
        stopArgs: (instance) => ["stop", instance],
        deleteArgs: (instance) => ["delete", instance],
    },
    {
        name: "utmctl",
        command: "utmctl",
        startArgs: (instance) => ["start", instance],
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

function providerCandidates() {
    return PROVIDERS
        .map((provider) => ({ ...provider, command: commandPath(provider.command) }))
        .filter((provider) => provider.command);
}

function macosDiscovery() {
    const hostSupported = process.platform === "darwin";
    const providers = hostSupported ? providerCandidates() : [];
    const missing = [];
    if (!hostSupported) missing.push("macos-host");
    if (hostSupported && providers.length === 0) missing.push("macos-vm-provider");
    return {
        hostSupported,
        providers,
        available: hostSupported && providers.length > 0,
        missing,
    };
}

export function macosBackend() {
    const discovery = macosDiscovery();
    return {
        name: "macos-vm",
        host: "macos-host",
        creatable: true,
        available: discovery.available,
        lazy: true,
        status: discovery.available ? "available" : "missing-prerequisites",
        missing: discovery.missing,
        providers: discovery.providers,
        capabilities: [
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
        ],
    };
}

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

function macosHelperMetadata(device) {
    ensureMacosWorkspace(device);
    const remoteScriptPath = device.helper?.remoteScriptPath || `/tmp/ccc-${device.id}-guest-helper.sh`;
    const provisioning = device.helper?.provisioning || null;
    const bridgeConfigured = Boolean(device.ssh?.host && device.ssh?.user);
    return {
        workspaceDir: macosWorkspaceDir(device),
        toolsDir: macosToolsDir(device),
        hostHelperScript: join(macosToolsDir(device), "ccc-guest-helper.sh"),
        remoteScriptPath,
        bridge: bridgeConfigured ? "ssh" : "missing",
        ssh: publicSshConfig(device.ssh),
        status: provisioning?.status || (bridgeConfigured ? "ssh-configured" : "planned"),
        provisioning,
        requiredFor: ["device_exec", "device_screenshot", "device_click", "device_double_click", "device_key", "device_type", "device_scroll", "device_cursor_position", "device_window_list", "device_accessibility_snapshot", "device_record_video_start", "device_record_video_stop", "device_upload", "device_download"],
    };
}

function publicSshConfig(ssh) {
    if (!ssh) return null;
    const { password, ...publicSsh } = ssh;
    return password ? { ...publicSsh, passwordConfigured: true } : publicSsh;
}

function publicMacosDevice(device) {
    return {
        ...device,
        ssh: publicSshConfig(device.ssh),
    };
}

function providerByName(name) {
    return PROVIDERS.find((provider) => provider.name === name);
}

function macosProviderPlan(device, discovery = macosDiscovery()) {
    const requestedProvider = device.provider || "auto";
    const selected = requestedProvider === "auto"
        ? discovery.providers[0]
        : discovery.providers.find((provider) => provider.name === requestedProvider);
    const catalog = selected ? providerByName(selected.name) : null;
    const instance = device.providerInstance || `ccc-${ownerId()}-${device.id}`;
    const missing = [...discovery.missing];
    if (discovery.hostSupported && !selected) {
        const providerMissing = requestedProvider === "auto" ? "macos-vm-provider" : `macos-vm-provider:${requestedProvider}`;
        if (!missing.includes(providerMissing)) missing.push(providerMissing);
    }
    const command = selected?.command || null;
    return {
        requestedProvider,
        selectedProvider: selected?.name || null,
        providerCommand: command,
        providerInstance: instance,
        workspaceDir: macosWorkspaceDir(device),
        image: device.image || null,
        memoryMb: device.memoryMb,
        cpus: device.cpus,
        helper: macosHelperMetadata(device),
        available: missing.length === 0 && Boolean(catalog && command),
        missing,
        startCommand: catalog && command ? { command, args: catalog.startArgs(instance, device) } : null,
        stopCommand: catalog && command ? { command, args: catalog.stopArgs(instance) } : null,
        deleteCommand: catalog && command ? { command, args: catalog.deleteArgs(instance) } : null,
        implemented: catalog?.name === "tart" ? [
            "base-image-create",
            "base-image-clone",
            "snapshot-clone",
            "snapshot-restore",
            "snapshot-delete",
            "provider-delete",
        ] : [],
        deferred: [
            ...(device.ssh ? [] : ["guest-helper-auto-provisioning-requires-ssh"]),
        ],
    };
}

function deviceWithPlan(device) {
    const publicDevice = publicMacosDevice(device);
    return withTargetStatus({
        ...publicDevice,
        providerPlan: macosProviderPlan(publicDevice),
    });
}

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
    return textResult(false, JSON.stringify({
        ok: false,
        error: "owner-device-state-conflict",
        backend: "macos-vm",
        deviceId,
        operation,
        found: transition.found,
        ...(rollback ? { rollback } : {}),
    }));
}

function macosLifecycleReplacement(device, lifecycle, updates = {}) {
    const replacement = {
        ...device,
        ...updates,
        updatedAt: new Date().toISOString(),
    };
    if (lifecycle) replacement.lifecycle = lifecycle;
    else delete replacement.lifecycle;
    return replacement;
}

function claimMacosLifecycle(deviceId, device, operation, updates = {}) {
    const lifecycle = {
        runtimeId: randomUUID(),
        operation,
        claimedAt: new Date().toISOString(),
        previousStatus: device.status,
    };
    const claimed = macosLifecycleReplacement(device, lifecycle, {
        ...updates,
        status: operation === "delete"
            ? "deleting"
            : operation === "stop" || operation === "clone-source-stop"
                ? "stopping"
                : operation === "start"
                    ? "starting"
                    : device.status,
    });
    const transition = transitionMacosDevice(deviceId, device, claimed);
    return {
        lifecycle,
        claimed: transition.matched ? findMacosDevice(deviceId) : claimed,
        transition,
    };
}

function macosLifecycleClaimTtlMs() {
    const parsed = Number(process.env.CCC_MACOS_VM_LIFECYCLE_CLAIM_TTL_MS || MACOS_LIFECYCLE_CLAIM_TTL_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : MACOS_LIFECYCLE_CLAIM_TTL_MS;
}

function staleMacosLifecycle(lifecycle) {
    if (!lifecycle) return false;
    const claimedAt = Date.parse(lifecycle.claimedAt || "");
    return !Number.isFinite(claimedAt) || Date.now() - claimedAt >= macosLifecycleClaimTtlMs();
}

function recoverStaleMacosLifecycle(deviceId) {
    const device = findMacosDevice(deviceId);
    if (!device?.lifecycle || !staleMacosLifecycle(device.lifecycle)) return { device };

    const lifecycle = device.lifecycle;
    if (lifecycle.operation === "start") {
        const plan = macosProviderPlan(device);
        if (!plan.stopCommand) {
            return { error: textResult(false, `Cannot recover stale macOS VM start lifecycle for ${deviceId}: provider stop is unavailable`) };
        }
        const stopped = runProviderCommand(plan.stopCommand.command, plan.stopCommand.args, "stop");
        if (stopped.status !== 0) {
            return { error: textResult(false, `Cannot recover stale macOS VM start lifecycle for ${deviceId}: ${stopped.stderr || stopped.stdout || stopped.error?.message || `exit ${stopped.status}`}`) };
        }
    }

    const previousStatus = typeof lifecycle.previousStatus === "string"
        ? lifecycle.previousStatus
        : lifecycle.operation === "start"
            ? "stopped"
            : device.runtime
                ? "running"
                : "stopped";
    const recovered = macosLifecycleReplacement(device, null, {
        status: previousStatus,
        ...(lifecycle.operation === "start" ? {
            runtime: null,
            bootReady: false,
            lastBootCheck: null,
        } : {}),
        lastLifecycleRecovery: {
            runtimeId: lifecycle.runtimeId || null,
            operation: lifecycle.operation || "unknown",
            claimedAt: lifecycle.claimedAt || null,
            recoveredAt: new Date().toISOString(),
        },
    });
    const transition = transitionMacosDevice(deviceId, device, recovered);
    if (!transition.matched) {
        return { error: macosLifecycleConflict(deviceId, "stale-lifecycle-recovery", transition) };
    }
    return { device: transition.device };
}

function currentMacosLifecycleDevice(deviceId, lifecycle) {
    const current = findMacosDevice(deviceId);
    return current?.lifecycle?.runtimeId === lifecycle.runtimeId ? current : null;
}

function abortMacosLifecycle(deviceId, lifecycle, original, updates = {}) {
    const current = currentMacosLifecycleDevice(deviceId, lifecycle);
    if (!current) return { matched: false, found: Boolean(findMacosDevice(deviceId)) };
    const restored = macosLifecycleReplacement(current, original.lifecycle || null, {
        ...updates,
        status: updates.status ?? original.status,
    });
    return transitionMacosDevice(deviceId, current, restored);
}

function transitionCurrentMacosLifecycle(deviceId, lifecycle, updater) {
    const current = currentMacosLifecycleDevice(deviceId, lifecycle);
    if (!current) return { matched: false, found: Boolean(findMacosDevice(deviceId)) };
    return transitionMacosDevice(deviceId, current, updater(current));
}

function rollbackStartedMacosVm(deviceId, lifecycle, plan) {
    const current = findMacosDevice(deviceId);
    if (current?.lifecycle?.runtimeId !== lifecycle.runtimeId && current?.providerInstance === plan.providerInstance) {
        return { ok: false, attempted: false, reason: "provider-instance-owned-by-successor", providerInstance: plan.providerInstance };
    }
    if (!plan.stopCommand || !plan.providerInstance) {
        return { ok: false, attempted: false, reason: "provider-stop-command-unavailable", providerInstance: plan.providerInstance || null };
    }
    const stopped = runProviderCommand(plan.stopCommand.command, plan.stopCommand.args, "stop");
    return {
        ok: stopped.status === 0,
        attempted: true,
        providerInstance: plan.providerInstance,
        status: stopped.status,
        stdout: stopped.stdout,
        stderr: stopped.stderr,
    };
}

function macosProviderInstanceReferenced(device, instance) {
    if (!device || !instance) return false;
    if (device.providerInstance === instance || device.restoreRecovery?.candidateProviderInstance === instance) return true;
    if ((device.restoreRecovery?.supersededCandidateProviderInstances || []).includes(instance)) return true;
    return (device.snapshots || []).some((snapshot) => snapshot.providerInstance === instance);
}

function rollbackCreatedMacosResource(deviceId, plan, instance) {
    const current = findMacosDevice(deviceId);
    if (macosProviderInstanceReferenced(current, instance)) {
        return { ok: false, attempted: false, reason: "provider-instance-owned-by-successor", providerInstance: instance };
    }
    const deleted = tartDeleteInstance(plan, instance);
    return {
        ok: deleted.status === 0,
        attempted: true,
        providerInstance: instance,
        status: deleted.status,
        stdout: deleted.stdout,
        stderr: deleted.stderr,
    };
}

function managedProviderResource(device) {
    return Boolean(
        device.providerResourceManaged ||
        device.provisioning === "image-created" ||
        device.provisioning === "image-cloned" ||
        device.imageSource ||
        device.clonedFrom ||
        device.imageCreatedAt ||
        device.clonedAt
    );
}

function snapshotProviderInstances(device) {
    return (Array.isArray(device.snapshots) ? device.snapshots : [])
        .filter((snapshot) => snapshot.provider === "tart" && snapshot.providerInstance)
        .map((snapshot) => ({ kind: "snapshot", id: snapshot.id, instance: snapshot.providerInstance }));
}

function restoreRecoveryProviderInstances(device) {
    const recovery = device.restoreRecovery;
    if (!recovery?.candidateProviderInstance) return [];
    return [recovery.candidateProviderInstance, ...(recovery.supersededCandidateProviderInstances || [])]
        .map((instance) => ({ kind: "restore-recovery", instance }));
}

function tartDeleteInstance(plan, instance) {
    return runProviderCommand(plan.providerCommand, ["delete", instance], "delete");
}

function runTartClone(plan, source, target) {
    const result = runProviderCommand(plan.providerCommand, ["clone", source, target], "clone");
    const cleanup = result.status !== 0 && providerCommandTimedOut(result)
        ? tartDeleteInstance(plan, target)
        : null;
    return { result, cleanup };
}

function tartCloneFailure(result, cleanup, target) {
    if (!cleanup) return fail(result);
    return textResult(false, JSON.stringify({
        ok: false,
        error: "macos-tart-clone-failed",
        target,
        timedOut: true,
        command: {
            status: result.status,
            signal: result.signal || null,
            detail: result.stderr || result.stdout || result.error?.message || "clone timed out",
        },
        cleanup: {
            ok: cleanup.status === 0,
            status: cleanup.status,
            signal: cleanup.signal || null,
            detail: cleanup.stderr || cleanup.stdout || cleanup.error?.message || null,
        },
    }));
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

function macosKeySpec(key) {
    const value = String(key || "");
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

async function waitForMacosBoot(plan, timeoutMs = 300000) {
    if (plan.selectedProvider !== "tart" || !plan.providerCommand || !plan.providerInstance) {
        return { ready: false, skipped: true, reason: "boot readiness is only implemented for Tart" };
    }
    const parsedTimeout = Number(timeoutMs);
    const deadline = Date.now() + (Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 300000);
    let last = null;
    const attempts = [];
    const ipAttempts = () => [
        { resolver: "dhcp-leases", args: ["ip", plan.providerInstance] },
        { resolver: "arp", args: ["ip", "--resolver=arp", plan.providerInstance] },
    ];
    while (Date.now() < deadline) {
        for (const attempt of ipAttempts()) {
            const ip = runProviderCommand(plan.providerCommand, attempt.args, "ip");
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

function macosGuestHelperScript(device) {
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
        "  cursor_position)",
        "    osascript -l JavaScript <<'JXA'",
        "function run() {",
        "  ObjC.import('ApplicationServices');",
        "  var event = $.CGEventCreate(null); var point = $.CGEventGetLocation(event);",
        "  return JSON.stringify({ok:true, cursor:{x:point.x, y:point.y}, provider:'macos-helper'});",
        "}",
        "JXA",
        "    ;;",
        "  window_list)",
        "    osascript -l JavaScript <<'JXA'",
        "function safe(fn, fallback) { try { return fn(); } catch (error) { return fallback; } }",
        "function run() {",
        "  var systemEvents = Application('System Events');",
        "  var processes = safe(function () { return systemEvents.processes.whose({visible:true})(); }, []);",
        "  var windows = [];",
        "  for (var p = 0; p < processes.length; p++) {",
        "    var process = processes[p];",
        "    var processName = safe(function () { return process.name(); }, '');",
        "    var pid = safe(function () { return process.unixId(); }, null);",
        "    var processWindows = safe(function () { return process.windows(); }, []);",
        "    for (var w = 0; w < processWindows.length; w++) {",
        "      var win = processWindows[w];",
        "      var position = safe(function () { return win.position(); }, null);",
        "      var size = safe(function () { return win.size(); }, null);",
        "      windows.push({processName:processName, processId:pid, title:safe(function () { return win.name(); }, ''), role:safe(function () { return win.role(); }, ''), subrole:safe(function () { return win.subrole(); }, ''), position:position, size:size});",
        "    }",
        "  }",
        "  return JSON.stringify({ok:true, provider:'macos-system-events', windows:windows});",
        "}",
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

function provisionMacosGuestHelper(device) {
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
    const copy = runHelperCommand(discovery.scp, [...scpBaseArgs(device), localScriptPath, `${target}:${remoteScriptPath}`], undefined, sshCommandOptions(device));
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
    const chmod = runHelperCommand(discovery.ssh, [...sshBaseArgs(device), target, `chmod 700 ${shellQuote(remoteScriptPath)} && ${shellQuote(remoteScriptPath)} status`], undefined, sshCommandOptions(device));
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

export function listMacosDevices() {
    return readMacosDevices().map((device) => deviceWithPlan({ ...device, ownerId: ownerId() }));
}

async function handleMacosToolUnlocked(name, args) {
    if (requiresOwnerDeviceOperation("macos", name)) {
        for (const candidate of [args?.deviceId, args?.sourceDeviceId]) {
            if (typeof candidate !== "string") continue;
            const recovery = recoverStaleMacosLifecycle(candidate);
            if (recovery.error) return recovery.error;
        }
    }
    switch (name) {
        case "device_inventory": {
            const { backend = "macos-vm" } = args;
            if (backend !== "macos-vm") return undefined;
            const discovery = macosDiscovery();
            return jsonResult({
                ownerId: ownerId(),
                backend,
                devices: readMacosDevices().map((device) => {
                    const publicDevice = publicMacosDevice({ ...device, ownerId: ownerId() });
                    return withTargetStatus({ ...publicDevice, providerPlan: macosProviderPlan(publicDevice, discovery) });
                }),
                discovery,
                hostVms: {
                    providers: discovery.providers.map((provider) => ({
                        name: provider.name,
                        command: provider.command,
                    })),
                    available: discovery.available,
                    missing: discovery.missing,
                    lazy: true,
                    note: "Provider discovery checks command availability only; VM list/start operations are not run by inventory.",
                },
            });
        }

        case "device_base_image_create": {
            const { backend = "macos-vm", name: deviceName, deviceId, sourceImage, provider = "auto", memoryMb = 4096, cpus = 4, sshHost, sshPort = 22, sshUser, sshKeyPath, sshPassword } = args;
            if (backend !== "macos-vm") return undefined;
            if (!sourceImage) return textResult(false, `${name} requires sourceImage`);

            const id = deviceId || macosDeviceId(deviceName);
            const devices = readMacosDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }
            const sshKeyPolicy = validateMacosSshKeyPath(sshKeyPath);
            if (!sshKeyPolicy.ok) return textResult(false, sshKeyPolicy.message);

            const ssh = macosSshConfig({ sshHost, sshPort, sshUser, sshKeyPath: sshKeyPolicy.path, sshPassword, provider, image: sourceImage });
            const device = macosDeviceDefinition({
                id,
                name: deviceName,
                provider,
                image: sourceImage,
                memoryMb,
                cpus,
                ssh,
                extra: {
                    imageSource: sourceImage,
                    provisioning: "image-created",
                },
            });
            const tart = tartProviderPlan(device, name);
            if (tart.error) return tart.error;
            const target = tart.plan.providerInstance;
            const clone = runTartClone(tart.plan, sourceImage, target);
            const r = clone.result;
            if (r.status !== 0) return tartCloneFailure(r, clone.cleanup, target);

            const created = {
                ...device,
                provider: tart.plan.selectedProvider,
                providerInstance: target,
                providerResourceManaged: true,
                imageCreatedAt: new Date().toISOString(),
            };
            let claim;
            try {
                claim = claimMacosDevice(created);
            } catch (error) {
                const rollback = runProviderCommand(tart.plan.providerCommand, ["delete", target], "delete");
                if (rollback.status !== 0) {
                    return textResult(false, `Owner device state update failed; macOS VM rollback failed: ${rollback.stderr || rollback.stdout}`);
                }
                throw error;
            }
            if (!claim.ok) {
                if (claim.existing?.provider !== created.provider || claim.existing?.providerInstance !== target) {
                    const rollback = runProviderCommand(tart.plan.providerCommand, ["delete", target], "delete");
                    if (rollback.status !== 0) {
                        return textResult(false, `Device identity conflict for this owner (${claim.field}: ${claim.value}); macOS VM rollback failed: ${rollback.stderr || rollback.stdout}`);
                    }
                }
                return textResult(false, `Device identity already exists for this owner (${claim.field}: ${typeof claim.value === "object" ? JSON.stringify(claim.value) : claim.value})`);
            }
            return jsonResult({
                operation: "base-image-create",
                device: deviceWithPlan(created),
                stdout: r.stdout,
                stderr: r.stderr,
                status: r.status,
            });
        }

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

        case "device_create": {
            const { backend, name: deviceName, deviceId, provider = "auto", image = null, memoryMb = 4096, cpus = 4, headless = false, sshHost, sshPort = 22, sshUser, sshKeyPath, sshPassword } = args;
            if (backend !== "macos-vm") return undefined;

            const id = deviceId || macosDeviceId(deviceName);
            const devices = readMacosDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }
            const sshKeyPolicy = validateMacosSshKeyPath(sshKeyPath);
            if (!sshKeyPolicy.ok) return textResult(false, sshKeyPolicy.message);
            const ssh = macosSshConfig({ sshHost, sshPort, sshUser, sshKeyPath: sshKeyPolicy.path, sshPassword, provider, image });

            const device = {
                id,
                name: deviceName,
                backend,
                kind: "desktop",
                platform: "macos",
                ownerId: ownerId(),
                provider,
                image,
                memoryMb,
                cpus,
                headless: Boolean(headless),
                providerInstance: `ccc-${ownerId()}-${id}`,
                ssh,
                helper: macosHelperMetadata({ id, ssh }),
                status: "stopped",
                creatable: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            const claim = claimMacosDevice(device);
            if (!claim.ok) {
                return textResult(false, `Device identity already exists for this owner (${claim.field}: ${typeof claim.value === "object" ? JSON.stringify(claim.value) : claim.value})`);
            }
            return jsonResult({ device: deviceWithPlan(device) });
        }

        case "device_delete": {
            const { deviceId, force = false } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }
            if (device.lifecycle) {
                return textResult(false, `Refusing to delete ${deviceId} while lifecycle operation ${device.lifecycle.operation || "unknown"} is active`);
            }
            const claim = claimMacosLifecycle(deviceId, device, "delete");
            if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "delete-claim", claim.transition);
            let forcedStopPlan = null;
            let forcedStopUpdates = {};
            if (force && device.status !== "stopped") {
                const plan = macosProviderPlan(device);
                if (!plan.available) {
                    abortMacosLifecycle(deviceId, claim.lifecycle, device);
                    return textResult(false, `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`);
                }
                if (plan.stopCommand) {
                    const stop = runProviderCommand(plan.stopCommand.command, plan.stopCommand.args, "stop");
                    if (stop.status !== 0) {
                        abortMacosLifecycle(deviceId, claim.lifecycle, device);
                        return fail(stop);
                    }
                    forcedStopPlan = plan;
                    const recorderSignal = signalOwnedRuntimeProcess(device.recording, "SIGINT");
                    if (recorderSignal.signaled) await waitForProcessExit(device.recording.pid, 1000);
                    forcedStopUpdates = {
                        status: "stopped",
                        runtime: null,
                        bootReady: false,
                        lastBootCheck: null,
                        recording: null,
                    };
                }
            }
            const managedInstances = [
                ...snapshotProviderInstances(device),
                ...restoreRecoveryProviderInstances(device),
                ...(managedProviderResource(device) && device.providerInstance ? [{ kind: "device", instance: device.providerInstance }] : []),
            ];
            const providerDeleted = [];
            if (managedInstances.length > 0) {
                const tart = forcedStopPlan?.selectedProvider === "tart" ? { plan: forcedStopPlan } : tartProviderPlan(device, name);
                if (tart.error) {
                    abortMacosLifecycle(deviceId, claim.lifecycle, device, forcedStopUpdates);
                    return tart.error;
                }
                for (const resource of managedInstances) {
                    if (!currentMacosLifecycleDevice(deviceId, claim.lifecycle)) {
                        return macosLifecycleConflict(deviceId, "delete-resource-ownership", { found: Boolean(findMacosDevice(deviceId)), matched: false });
                    }
                    const deleted = tartDeleteInstance(tart.plan, resource.instance);
                    if (deleted.status !== 0) {
                        abortMacosLifecycle(deviceId, claim.lifecycle, device, forcedStopUpdates);
                        return fail(deleted);
                    }
                    providerDeleted.push(resource.instance);
                    if (resource.kind === "snapshot") {
                        const progress = transitionCurrentMacosLifecycle(deviceId, claim.lifecycle, (item) => macosLifecycleReplacement(item, claim.lifecycle, {
                            snapshots: (item.snapshots || []).filter((snapshot) => snapshot.id !== resource.id),
                        }));
                        if (!progress.matched) return macosLifecycleConflict(deviceId, "delete-snapshot-progress", progress);
                    } else if (resource.kind === "restore-recovery") {
                        const progress = transitionCurrentMacosLifecycle(deviceId, claim.lifecycle, (item) => {
                            const remaining = [
                                item.restoreRecovery?.candidateProviderInstance,
                                ...(item.restoreRecovery?.supersededCandidateProviderInstances || []),
                            ].filter((instance) => instance && instance !== resource.instance);
                            return macosLifecycleReplacement(item, claim.lifecycle, {
                                restoreRecovery: remaining.length === 0 ? null : {
                                    ...item.restoreRecovery,
                                    candidateProviderInstance: remaining[0],
                                    supersededCandidateProviderInstances: remaining.slice(1),
                                },
                            });
                        });
                        if (!progress.matched) return macosLifecycleConflict(deviceId, "delete-recovery-progress", progress);
                    }
                }
            }
            const current = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) return macosLifecycleConflict(deviceId, "delete", { found: Boolean(findMacosDevice(deviceId)), matched: false });
            const transition = transitionMacosDevice(deviceId, current, null);
            if (!transition.matched) return macosLifecycleConflict(deviceId, "delete", transition);
            return jsonResult({ deleted: deviceId, providerDeleted });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device: deviceWithPlan(device), backend: macosBackend() });
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

        case "device_start": {
            const { deviceId, headless, waitForBoot = false, bootTimeoutMs = 300000 } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (device.status !== "stopped" || device.lifecycle) {
                return textResult(false, `Refusing to start ${deviceId} while status is ${device.status}${device.lifecycle ? ` and lifecycle operation ${device.lifecycle.operation || "unknown"} is active` : ""}`);
            }
            const keyPolicy = validateMacosSshKeyPath(device.ssh?.keyPath);
            if (!keyPolicy.ok) return textResult(false, keyPolicy.message);
            const safeDevice = device.ssh?.keyPath && keyPolicy.path !== device.ssh.keyPath
                ? { ...device, ssh: { ...device.ssh, keyPath: keyPolicy.path } }
                : device;
            const startDevice = headless === undefined ? safeDevice : { ...safeDevice, headless: Boolean(headless) };

            const plan = macosProviderPlan(startDevice);
            if (!plan.available) {
                return textResult(false, `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`);
            }

            const claim = claimMacosLifecycle(deviceId, device, "start", {
                provider: plan.selectedProvider,
                providerInstance: plan.providerInstance,
                ssh: startDevice.ssh,
                headless: startDevice.headless,
            });
            if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "start-claim", claim.transition);

            const startCommand = plan.selectedProvider === "tart" && plan.providerCommand
                ? {
                    command: plan.providerCommand,
                    args: providerByName("tart").startArgs(plan.providerInstance, {
                        ...startDevice,
                        softnet: startDevice.softnet !== false && tartSupportsFeature(plan.providerCommand, "--with-softnet"),
                    }),
                }
                : plan.startCommand;

            const child = spawn(startCommand.command, startCommand.args, {
                detached: true,
                stdio: "ignore",
                env: process.env,
                windowsHide: true,
            });
            const startError = await waitForProviderStart(child, "macOS VM provider start");
            if (startError) {
                abortMacosLifecycle(deviceId, claim.lifecycle, device);
                return startError;
            }
            child.unref();

            const startedDevice = {
                ...startDevice,
                provider: plan.selectedProvider,
                providerInstance: plan.providerInstance,
                status: waitForBoot ? "starting" : "running",
                runtime: {
                    runtimeId: claim.lifecycle.runtimeId,
                    providerPid: child.pid || null,
                    startedAt: new Date().toISOString(),
                    startCommand,
                    detached: true,
                },
            };
            const started = macosLifecycleReplacement(claim.claimed, claim.lifecycle, {
                provider: plan.selectedProvider,
                providerInstance: plan.providerInstance,
                ssh: startedDevice.ssh,
                headless: startedDevice.headless,
                status: "starting",
                runtime: startedDevice.runtime,
            });
            const startedTransition = transitionMacosDevice(deviceId, claim.claimed, started);
            if (!startedTransition.matched) {
                const rollback = rollbackStartedMacosVm(deviceId, claim.lifecycle, plan);
                return macosLifecycleConflict(deviceId, "start-runtime", startedTransition, rollback);
            }
            const persistedStarted = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
            if (!persistedStarted) {
                const rollback = rollbackStartedMacosVm(deviceId, claim.lifecycle, plan);
                return macosLifecycleConflict(deviceId, "start-runtime-readback", { found: Boolean(findMacosDevice(deviceId)), matched: false }, rollback);
            }
            const boot = waitForBoot ? await waitForMacosBoot(plan, bootTimeoutMs) : { ready: false, skipped: true };
            startedDevice.status = boot.ready || boot.skipped ? "running" : "starting";
            startedDevice.bootReady = boot.ready;
            startedDevice.lastBootCheck = boot;
            if (boot.ready && boot.ip && startedDevice.ssh?.user && !startedDevice.ssh.host) {
                startedDevice.ssh = { ...startedDevice.ssh, host: boot.ip };
            }
            const provision = provisionMacosGuestHelper(startedDevice);
            const completed = macosLifecycleReplacement(persistedStarted, null, {
                provider: plan.selectedProvider,
                providerInstance: plan.providerInstance,
                ssh: startedDevice.ssh,
                headless: startedDevice.headless,
                helper: macosHelperMetadata({ ...startedDevice, helper: { ...(persistedStarted.helper || {}), provisioning: provision.provisioning } }),
                status: startedDevice.status,
                runtime: startedDevice.runtime,
                bootReady: startedDevice.bootReady,
                lastBootCheck: startedDevice.lastBootCheck,
            });
            const completedTransition = transitionMacosDevice(deviceId, persistedStarted, completed);
            if (!completedTransition.matched) {
                const rollback = rollbackStartedMacosVm(deviceId, claim.lifecycle, plan);
                return macosLifecycleConflict(deviceId, "start-complete", completedTransition, rollback);
            }
            const updated = completedTransition.device;
            if (!provision.ok) {
                return textResult(false, JSON.stringify({
                    ok: false,
                    error: provision.error,
                    command: provision.command,
                    device: deviceWithPlan(updated),
                    helper: provision.provisioning,
                    providerStart: startedDevice.runtime,
                    boot,
                }));
            }
            return jsonResult({ device: deviceWithPlan(updated), helper: provision.provisioning, providerStart: startedDevice.runtime, boot });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (device.lifecycle) {
                return textResult(false, `Refusing to stop ${deviceId} while lifecycle operation ${device.lifecycle.operation || "unknown"} is active`);
            }
            const claim = claimMacosLifecycle(deviceId, device, "stop");
            if (!claim.transition.matched) return macosLifecycleConflict(deviceId, "stop-claim", claim.transition);

            const plan = macosProviderPlan(device);
            if (device.status !== "stopped" && (!plan.available || !plan.stopCommand)) {
                abortMacosLifecycle(deviceId, claim.lifecycle, device);
                return textResult(false, `macOS VM stop is unavailable for ${deviceId}: ${plan.missing?.join(", ") || "provider stop command missing"}`);
            }
            if (plan.stopCommand && device.providerInstance && device.status !== "stopped") {
                const r = runProviderCommand(plan.stopCommand.command, plan.stopCommand.args, "stop");
                if (r.status !== 0) {
                    abortMacosLifecycle(deviceId, claim.lifecycle, device);
                    return fail(r);
                }
            }

            const recorderSignal = signalOwnedRuntimeProcess(device.recording, "SIGINT");
            if (device.recording?.active) {
                const bridge = sshBridge(device, "device_record_video_stop");
                if (!bridge.error) {
                    runHelperCommand(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, `pkill -INT -f ${shellQuote(`screencapture.*${device.recording.remotePath}`)} || true`], undefined, sshCommandOptions(device));
                }
            }
            if (recorderSignal.signaled) {
                await waitForProcessExit(device.recording.pid, 1000);
            }
            const current = currentMacosLifecycleDevice(deviceId, claim.lifecycle);
            if (!current) return macosLifecycleConflict(deviceId, "stop", { found: Boolean(findMacosDevice(deviceId)), matched: false });
            const stopped = macosLifecycleReplacement(current, null, {
                status: "stopped",
                runtime: null,
                bootReady: false,
                lastBootCheck: null,
                recording: null,
            });
            const transition = transitionMacosDevice(deviceId, current, stopped);
            if (!transition.matched) return macosLifecycleConflict(deviceId, "stop", transition);
            return jsonResult({ device: deviceWithPlan(transition.device) });
        }

        case "device_exec": {
            const { deviceId, command, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const r = runHelperCommand(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, command], helperTimeoutMs, sshCommandOptions(device));
            return jsonResult({ stdout: r.stdout, stderr: r.stderr, status: r.status, provider: "ssh" });
        }

        case "device_upload": {
            const { deviceId, localPath, remotePath, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const remotePolicy = validateGuestPath(remotePath, { label: "upload-remote-path", platform: "posix", transport: "scp" });
            if (!remotePolicy.ok) return textResult(false, remotePolicy.message);
            const localStage = stageLocalInputFile(localPath, { label: "upload-local-path" });
            if (!localStage.ok) return textResult(false, localStage.message);
            try {
                const r = runHelperCommand(bridge.discovery.scp, [...scpBaseArgs(device), localStage.stagedPath, `${bridge.target}:${remotePolicy.path}`], helperTimeoutMs, sshCommandOptions(device));
                return r.status === 0 ? jsonResult({ uploaded: { localPath: localStage.path, remotePath: remotePolicy.path }, stdout: r.stdout, stderr: r.stderr, provider: "scp" }) : fail(r);
            } finally {
                localStage.cleanup();
            }
        }

        case "device_download": {
            const { deviceId, remotePath, localPath, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const remotePolicy = validateGuestPath(remotePath, { label: "download-remote-path", platform: "posix", transport: "scp" });
            if (!remotePolicy.ok) return textResult(false, remotePolicy.message);
            const localStage = createLocalOutputStage(localPath, { label: "download-local-path" });
            if (!localStage.ok) return textResult(false, localStage.message);
            try {
                const r = runHelperCommand(bridge.discovery.scp, [...scpBaseArgs(device), `${bridge.target}:${remotePolicy.path}`, localStage.stagedPath], helperTimeoutMs, sshCommandOptions(device));
                if (r.status !== 0) return fail(r);
                const committed = commitLocalOutputStage(localStage, { label: "download-local-path" });
                if (!committed.ok) return textResult(false, committed.message);
                return jsonResult({ downloaded: { remotePath: remotePolicy.path, localPath: committed.path }, stdout: r.stdout, stderr: r.stderr, provider: "scp" });
            } finally {
                localStage.cleanup();
            }
        }

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
                const capture = runHelperCommand(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, `screencapture -x ${shellQuote(remotePath)}`], helperTimeoutMs, commandOptions);
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
        case "device_double_click": {
            const { deviceId, x, y, button = "left", helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return textResult(false, `${name} requires numeric x and y`);
            const subcommand = name === "device_double_click" ? "double_click" : "click";
            const helper = macosHelperCommand(device, subcommand, [String(Number(x)), String(Number(y)), button], helperTimeoutMs);
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            const payload = macosHelperJson(helper.result.stdout);
            return jsonResult({
                provider: "ssh-macos-helper",
                remoteScriptPath: helper.remoteScriptPath,
                [name === "device_double_click" ? "doubleClicked" : "clicked"]: payload?.doubleClicked || payload?.clicked || { x: Number(x), y: Number(y), button },
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

        case "device_key": {
            const { deviceId, key, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const spec = macosKeySpec(key);
            if (!spec) return textResult(false, `Unsupported macOS key expression: ${key}`);
            const helper = macosHelperCommand(device, "key", [String(spec.keyCode), spec.modifiers.join(",")], helperTimeoutMs);
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            return jsonResult({
                provider: "ssh-macos-helper",
                remoteScriptPath: helper.remoteScriptPath,
                key: spec,
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

        case "device_type": {
            const { deviceId, text, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (text === undefined || text === null) return textResult(false, "device_type requires text");
            const literalText = String(text);
            const helper = macosHelperCommand(device, "type", [literalText], helperTimeoutMs);
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            return jsonResult({
                provider: "ssh-macos-helper",
                remoteScriptPath: helper.remoteScriptPath,
                typed: { text: literalText },
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

        case "device_scroll": {
            const { deviceId, direction = "down", amount = 1, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (!["up", "down", "left", "right"].includes(direction)) return textResult(false, "device_scroll direction must be up, down, left, or right");
            const helper = macosHelperCommand(device, "scroll", [direction, String(Number(amount) || 1)], helperTimeoutMs);
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            const payload = macosHelperJson(helper.result.stdout);
            return jsonResult({
                provider: "ssh-macos-helper",
                remoteScriptPath: helper.remoteScriptPath,
                scrolled: payload?.scrolled || { direction, amount: Number(amount) || 1 },
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

        case "device_cursor_position": {
            const { deviceId, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const helper = macosHelperCommand(device, "cursor_position", [], helperTimeoutMs);
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            const payload = macosHelperJson(helper.result.stdout);
            return jsonResult({
                provider: "ssh-macos-helper",
                remoteScriptPath: helper.remoteScriptPath,
                cursor: payload?.cursor || null,
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

        case "device_window_list": {
            const { deviceId, helperTimeoutMs } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const helper = macosHelperCommand(device, "window_list", [], helperTimeoutMs);
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            const payload = macosHelperJson(helper.result.stdout);
            return jsonResult({
                provider: payload?.provider || "macos-system-events",
                remoteScriptPath: helper.remoteScriptPath,
                windows: Array.isArray(payload?.windows) ? payload.windows : [],
                response: payload,
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

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
