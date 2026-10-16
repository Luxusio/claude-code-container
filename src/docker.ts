// src/docker.ts - Container lifecycle management (runtime-agnostic).
//
// Despite the filename this module drives either Docker or Podman via the
// runtime abstraction in `container-runtime.ts`. The file name is kept to
// avoid a noisy rename; all CLI invocations go through `runtimeCli()` /
// `bindMountArgs()` / `runtimeExtraRunArgs()`.

import { spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
    accessSync,
    closeSync,
    constants as fsConstants,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    statSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, posix, resolve } from "path";
import { fileURLToPath } from "url";
import { createContainerSessionHandoff } from "./application/container-session-handoff.js";
import { createContainerLaunchArguments } from "./application/container-launch-arguments.js";
import { createContainerRuntimeReadiness } from "./application/container-runtime-readiness.js";
import type { ContainerRuntimeRepairCategory } from "./ports/container-runtime-readiness.js";
import { createContainerExecReadiness } from "./application/container-exec-readiness.js";
import { ContainerEngineUnavailableError } from "./domain/container-runtime.js";
import { createContainerSocketAccess } from "./application/container-socket-access.js";
import { createOrderedCodexConfigPreparation } from "./application/credentials/codex-config-preparation.js";
import type { CodexConfigPreparationObservation, CodexConfigPreparationResult } from "./ports/codex-config-preparation.js";
import { createCodexHostAccessRestoration } from "./application/credentials/codex-host-access.js";
import { createNativeContainerExistingLifecycle } from "./composition/container-existing-lifecycle.js";
import { createNativeContainerCreateLifecycle } from "./composition/container-create-lifecycle.js";
import { createNativeContainerDestructiveLifecycle } from "./composition/container-destructive-lifecycle.js";
import { createNativeContainerImagePreparation } from "./composition/container-image-preparation.js";
import type { ContainerDestructiveLifecycleOptions } from "./ports/container-destructive-lifecycle.js";
import { cccHome, clipboardFilesDir } from "./home-layout.js";
import { ContainerRestartRequiredError } from "./container-restart-guidance.js";
import {
    getProjectId,
    projectPathsEquivalent,
    getClaudeDir,
    getClaudeJsonFile,
    getCodexDir,
    getCodexConfigFile,
    IMAGE_NAME,
    CONTAINER_PID_LIMIT,
    CODEX_PACKAGES_VOLUME_NAME,
    CODEX_PACKAGES_CONTAINER_DIR,
    CLI_VERSION,
    DOCKER_REGISTRY_IMAGE,
    CLIPBOARD_FILES_CONTAINER_DIR,
    LAB_RUNNER_PROFILE_NAME,
    LAB_RUNNER_STATE_CONTAINER_DIR,
} from "./utils.js";
import {
    runtimeCli,
    containerManagerSocketPath,
    containerManagerSocketMountArgs,
    bindMountArgs,
    runtimeExtraRunArgs,
    isContainerHostRemote,
    getRuntimeInfo,
} from "./container-runtime.js";
import { ensureIdentityImage, getIdentityLabels, getIdentityMiseVolumeName, getIdentityCodexPackagesVolumeName, normalizeImageId, resolveContainerIdentity, type ContainerIdentity as ContainerUserIdentity } from "./container-identity.js";
import { withSharedMutationLock, withSharedMutationLockAsync } from "@ccc/device-lab/device-lab-shared-state.js";
import { codexConfigFileAclScript, codexConfigDirectoryAclScript } from "./codex-config-acl.js";
import { prepareLabStateOwnership } from "./lab-state-ownership.js";
import { prepareCodexStateOwnership } from "./codex-state-ownership.js";
import { createHostCredentialRefresh } from "./application/credentials/host-refresh.js";
import { createHostCredentialPaths } from "./application/credentials/host-paths.js";
import { createNativeHostCredentialRefreshPorts } from "./adapters/credentials/host-refresh.js";
export { gitSigningKeyRewriteShell, sshCredentialCopyShell } from "./adapters/credentials/ssh-material.js";
import { cleanupOwnerDevices } from "./device-lab-admin.js";
import { deviceLabContainerName, deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { getAllCredentialMounts } from "./tool-registry.js";
import type { CredentialMount } from "./tool-registry.js";
import {
    getSessionLockClaimsForContainer,
    withContainerLifecycleLock,
    withProjectFamilyLifecycleLock,
} from "./session.js";
import { createContainerMountVerification } from "./application/container-mount-verification.js";
import type { StoppedMountPreflight } from "./ports/container-mount-verification.js";
import {
    assertBindMountSourceIdentity,
    bindMountSourceIdentityDigest,
    bindSourceIsTrustedFilesystemAlias,
    canonicalHostPath,
    captureBindMountSourceIdentity,
    createNativeContainerMountObservations,
    inspectContainerJsonOnce,
    normalizedHostPath,
    projectPathIdentityMatches,
    sameFileIdentity,
    type BindMountSourceIdentity,
    type InspectedContainerMount,
    type RequiredContainerMount,
} from "./adapters/container-mount-observations.js";
export {
    captureBindMountSourceIdentity,
    bindMountSourceIdentityDigest,
    bindSourcePathsEquivalent,
    readDirectoryMountMarker,
    projectPathIdentityMatches,
} from "./adapters/container-mount-observations.js";
export type { BindMountSourceIdentity } from "./adapters/container-mount-observations.js";
import type { MountPresencePolicy, MountVerification } from "./bind-mount-verification.js";

const MANAGED_MCP_BUNDLES = ["device-lab-mcp"] as const;
const MANAGED_MCP_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
const DIST_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const DEVICE_BROKER_AUTH_CONTAINER_FILE = "/run/ccc-device-broker-auth/owner.json";
const DEVICE_LAB_MOUNT_IDENTITY_LABEL = "ccc.device-lab.mount-identity";
const PROJECT_MOUNT_IDENTITY_LABEL = "ccc.project.mount-identity";
const DEVICE_LAB_MOUNT_CONTRACT_VERSION = "2";
const VERIFICATION_RETRY_DELAYS_MS = [100, 200, 400, 800] as const;
export const CODEX_CONFIG_PREPARE_TIMEOUT_MS = 15_000;
const CODEX_CONFIG_MUTATION_INNER_TIMEOUT_SECONDS = 10;

function codexConfigMutation(command: string): string {
    return `timeout -k 2s ${CODEX_CONFIG_MUTATION_INNER_TIMEOUT_SECONDS}s sh -c '${command.replace(/'/g, `'"'"'`)}'`;
}

function withBoundedVerificationRetry<T>(
    operation: (finalAttempt: boolean) => T,
    isRetryable: (result: T) => boolean,
): T {
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let result = operation(false);
    for (let index = 0; index < VERIFICATION_RETRY_DELAYS_MS.length; index += 1) {
        if (!isRetryable(result)) return result;
        Atomics.wait(sleeper, 0, 0, VERIFICATION_RETRY_DELAYS_MS[index]);
        result = operation(index === VERIFICATION_RETRY_DELAYS_MS.length - 1);
    }
    return result;
}

type MountSourceIdentity = {
    path: string;
    kind: "directory" | "file";
    dev: string;
    ino: string;
};

type PreparedDeviceLabMountSources = {
    stateRoot: MountSourceIdentity;
    ownerRoot: MountSourceIdentity;
    ownerAuthPath: string;
    ownerAuthFile?: MountSourceIdentity;
    contractIdentity: string;
};

function sourceIdentity(
    path: string,
    kind: MountSourceIdentity["kind"],
    stat: { dev?: number | bigint; ino?: number | bigint },
): MountSourceIdentity {
    if (stat.dev === undefined || stat.ino === undefined) {
        throw new Error(`filesystem identity is unavailable for mount source: ${path}`);
    }
    return {
        path,
        kind,
        dev: String(stat.dev),
        ino: String(stat.ino),
    };
}

function sameMountSourceIdentity(left: MountSourceIdentity, right: MountSourceIdentity): boolean {
    return left.path === right.path
        && left.kind === right.kind
        && left.dev === right.dev
        && left.ino === right.ino;
}

function assertStableDirectory(path: string, label: string): MountSourceIdentity {
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
        throw new Error(`${label} must be a real directory: ${path}`);
    }
    const canonical = canonicalHostPath(path);
    if (canonical !== normalizedHostPath(path)) {
        throw new Error(`${label} must not traverse symbolic links: ${path}`);
    }
    const after = lstatSync(path, { bigint: true });
    if (after.isSymbolicLink() || !after.isDirectory() || !sameFileIdentity(before, after)) {
        throw new Error(`${label} changed while it was being validated: ${path}`);
    }
    return sourceIdentity(canonical, "directory", after);
}

function ensureStableDirectory(path: string, label: string): MountSourceIdentity {
    try {
        return assertStableDirectory(path, label);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    mkdirSync(path, { mode: 0o700 });
    return assertStableDirectory(path, label);
}

function stableRegularFile(path: string, label: string): MountSourceIdentity | undefined {
    let before;
    try {
        before = lstatSync(path, { bigint: true });
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
    if (before.isSymbolicLink() || !before.isFile()) {
        throw new Error(`${label} must be a real regular file: ${path}`);
    }
    const canonical = canonicalHostPath(path);
    if (canonical !== normalizedHostPath(path)) {
        throw new Error(`${label} must not traverse symbolic links: ${path}`);
    }

    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    let identity: MountSourceIdentity;
    try {
        const opened = fstatSync(fd, { bigint: true });
        const after = lstatSync(path, { bigint: true });
        if (!opened.isFile() || after.isSymbolicLink() || !after.isFile()
            || !sameFileIdentity(before, opened) || !sameFileIdentity(opened, after)) {
            throw new Error(`${label} changed while it was being validated: ${path}`);
        }
        identity = sourceIdentity(canonical, "file", opened);
    } finally {
        closeSync(fd);
    }
    return identity;
}

function deviceLabMountContractIdentity(
    stateRoot: MountSourceIdentity,
    ownerRoot: MountSourceIdentity,
    ownerAuthFile?: MountSourceIdentity,
): string {
    const sourceIdentity = [stateRoot, ownerRoot, ownerAuthFile ?? null]
        .map((identity) => identity
            ? `${identity.kind}:${identity.dev}:${identity.ino}`
            : "absent")
        .join("|");
    const payload = `${DEVICE_LAB_MOUNT_CONTRACT_VERSION}|${sourceIdentity}`;
    return createHash("sha256").update(payload).digest("hex");
}

function prepareDeviceLabMountSources(stateRoot: string, ownerId: string): PreparedDeviceLabMountSources {
    const cccRoot = ensureStableDirectory(dirname(stateRoot), "CCC state root");
    const stableStateRoot = ensureStableDirectory(join(cccRoot.path, "devices"), "device-lab state root");
    const ownersRoot = ensureStableDirectory(join(stableStateRoot.path, "owners"), "device-lab owners root");
    const ownerRoot = ensureStableDirectory(join(ownersRoot.path, ownerId), "device-lab owner root");
    const brokerRoot = ensureStableDirectory(join(stableStateRoot.path, "broker"), "device broker root");
    const authRoot = ensureStableDirectory(join(brokerRoot.path, "auth"), "device broker auth root");
    const ownerAuthPath = join(authRoot.path, `${ownerId}.json`);
    const ownerAuthFile = stableRegularFile(ownerAuthPath, "device broker owner auth file");
    return {
        stateRoot: stableStateRoot,
        ownerRoot,
        ownerAuthPath,
        ownerAuthFile,
        contractIdentity: deviceLabMountContractIdentity(stableStateRoot, ownerRoot, ownerAuthFile),
    };
}

function assertPreparedDeviceLabMountSources(prepared: PreparedDeviceLabMountSources): void {
    const stateRoot = assertStableDirectory(prepared.stateRoot.path, "device-lab state root");
    const ownerRoot = assertStableDirectory(prepared.ownerRoot.path, "device-lab owner root");
    const ownerAuthFile = stableRegularFile(prepared.ownerAuthPath, "device broker owner auth file");
    if (!sameMountSourceIdentity(stateRoot, prepared.stateRoot)
        || !sameMountSourceIdentity(ownerRoot, prepared.ownerRoot)
        || Boolean(ownerAuthFile) !== Boolean(prepared.ownerAuthFile)
        || (ownerAuthFile && prepared.ownerAuthFile
            && !sameMountSourceIdentity(ownerAuthFile, prepared.ownerAuthFile))) {
        throw new Error("device-lab mount source changed after preflight validation");
    }
}

function preparedDeviceLabMountSourcesMatch(prepared: PreparedDeviceLabMountSources): boolean {
    try {
        assertPreparedDeviceLabMountSources(prepared);
        return true;
    } catch {
        return false;
    }
}

// === Docker Args Builder ===

export interface DockerRunArgsOptions {
    containerName: string;
    fullPath: string;
    projectMountPath: string;
    profile?: string;
    credentialMounts: Array<{ hostPath: string; containerPath: string }>;
    gitIdentityMounts?: Array<{ hostPath: string; containerPath: string }>;
    claudeJsonFile: string;
    miseVolumeName: string;
    codexPackagesVolumeName?: string;
    identity?: ContainerUserIdentity;
    pidsLimit: string;
    imageName: string;
    hostSshDir: string | null;
    sshAgentSocket: string | null;
    extraMounts?: Array<{
        hostPath: string;
        containerPath: string;
        identity?: BindMountSourceIdentity;
        presence?: RequiredContainerMount["presence"];
    }>;
    projectMountIdentity?: string;
    clipboardPortFile?: string;
    clipboardFilesHostDir?: string;
    /**
     * Optional in-container QEMU/KVM contract. Despite the historical
     * `labRunner` name, this is now used for ordinary containers too so
     * the device-lab Linux VM backend can run from the default CCC container.
     */
    labRunner?: LabRunnerRunConfig | null;
    deviceLabStateHostDir?: string;
    deviceLabOwnerId?: string;
    deviceLabOwnerAuthFile?: string;
    deviceLabMountIdentity?: string;
    /**
     * Tells the in-container entrypoint to install the iptables NAT REDIRECT
     * and start ccc-proxy. Set on Docker Desktop / WSL2 / podman-machine
     * flavors where --network host doesn't actually share the host loopback;
     * left unset on docker-native and rootful podman where it does.
     */
    proxyEnabled?: boolean;
    /** The runtime keeps containers in a VM (Docker Desktop, podman machine), independent of the proxy opt-out. */
    containerHostRemote?: boolean;
}

export interface LabRunnerRunConfig {
    status: "ready" | "unsupported";
    stateVolumeName: string;
    stateContainerDir: string;
    kvmDevicePath?: string;
    kvmGroupId?: number;
    networkMode: "user";
    unsupportedReason?: string;
}

function nativeContainerLaunchArguments() {
    return createContainerLaunchArguments<ContainerUserIdentity>({
        observeHostFacts: (opts) => ({
            ownerDirectory: opts.deviceLabStateHostDir && opts.deviceLabOwnerId
                ? join(opts.deviceLabStateHostDir, "owners", opts.deviceLabOwnerId)
                : undefined,
            clipboardPortFilePresent: !!opts.clipboardPortFile && existsSync(opts.clipboardPortFile),
        }),
        identityLabels: (identity) => Object.entries(getIdentityLabels(identity)),
        readCliVersion: () => CLI_VERSION,
        readProjectMountIdentityLabel: () => PROJECT_MOUNT_IDENTITY_LABEL,
        readDeviceLabMountIdentityLabel: () => DEVICE_LAB_MOUNT_IDENTITY_LABEL,
        readCodexPackagesVolumeName: () => CODEX_PACKAGES_VOLUME_NAME,
        readCodexPackagesContainerDir: () => CODEX_PACKAGES_CONTAINER_DIR,
        readBrokerAuthContainerFile: () => DEVICE_BROKER_AUTH_CONTAINER_FILE,
        readClipboardFilesContainerDir: () => CLIPBOARD_FILES_CONTAINER_DIR,
    });
}

export const CONTAINER_INIT_UNAVAILABLE_HINT = "[ccc] If the error above mentions docker-init, tini or catatonit, "
    + "the container runtime has no init binary for --init: install docker-init/tini (Docker) or catatonit (Podman).";

export function buildDockerRunArgs(opts: DockerRunArgsOptions): string[] {
    const plan = nativeContainerLaunchArguments().buildPlan(opts);
    const args: string[] = ["run", "-d", "--name", plan.containerName,
        "--hostname", plan.hostname, "--network", plan.network,
        "--security-opt", `seccomp=${plan.seccomp}`];
    for (const capability of plan.capabilities) args.push("--cap-add", capability);
    if (plan.init) args.push("--init");
    for (const operation of plan.operations) {
        switch (operation.kind) {
            case "bind":
                args.push(...bindMountArgs(operation.source, operation.destination, { readonly: operation.readonly }));
                break;
            case "socket":
                args.push(...containerManagerSocketMountArgs());
                break;
            case "tmpfs": {
                const options = ["rw"];
                if (operation.noexec) options.push("noexec");
                if (operation.nosuid) options.push("nosuid");
                if (operation.nodev) options.push("nodev");
                options.push(`mode=${operation.mode.toString(8).padStart(4, "0")}`);
                args.push("--tmpfs", `${operation.destination}:${options.join(",")}`);
                break;
            }
            case "execution":
                args.push("-w", operation.workdir, "--pids-limit", operation.pidsLimit);
                break;
            case "runtime-extras":
                args.push(...runtimeExtraRunArgs());
                break;
            case "ssh-command":
                args.push("-e", "GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/.ssh-copy/known_hosts -o IdentityFile=/tmp/.ssh-copy/id_rsa -o IdentityFile=/tmp/.ssh-copy/id_ed25519");
                break;
            case "env":
                args.push("-e", `${operation.key}=${operation.value}`);
                break;
            case "device":
                args.push("--device", `${operation.source}:${operation.destination}`);
                break;
            case "group":
                args.push("--group-add", String(operation.id));
                break;
            case "management-labels":
                // Docker Desktop groups these Compose-compatible implementation labels.
                args.push("--label", "com.docker.compose.project=ccc",
                    "--label", `com.docker.compose.service=${plan.containerName}`,
                    "--label", "com.docker.compose.oneoff=False",
                    "--label", "com.docker.compose.version=2",
                    "--label", "com.docker.compose.container-number=1",
                    "--label", "ccc.managed=true",
                    "--label", `ccc.project.path=${operation.projectPath}`,
                    "--label", `ccc.profile=${operation.profile}`,
                    "--label", `ccc.cli.version=${operation.cliVersion}`);
                break;
            case "label":
                args.push("--label", `${operation.key}=${operation.value}`);
                break;
        }
    }
    args.push(plan.imageName);
    return args;
}

export function isLabRunnerProfile(profile?: string): boolean {
    return profile === LAB_RUNNER_PROFILE_NAME;
}

export function getLabRunnerStateVolumeName(containerName: string): string {
    return `${containerName}-lab-state`;
}

export function buildContainerVmRunConfig(containerName: string): LabRunnerRunConfig {
    const stateVolumeName = getLabRunnerStateVolumeName(containerName);
    const unsupportedReason = getLabRunnerUnsupportedReason();
    if (unsupportedReason) {
        return {
            status: "unsupported",
            stateVolumeName,
            stateContainerDir: LAB_RUNNER_STATE_CONTAINER_DIR,
            networkMode: "user",
            unsupportedReason,
        };
    }

    const kvmDevicePath = "/dev/kvm";
    let kvmGroupId: number | undefined;
    try {
        kvmGroupId = statSync(kvmDevicePath).gid;
    } catch {
        kvmGroupId = undefined;
    }

    return {
        status: "ready",
        stateVolumeName,
        stateContainerDir: LAB_RUNNER_STATE_CONTAINER_DIR,
        kvmDevicePath,
        kvmGroupId,
        networkMode: "user",
    };
}

export function buildLabRunnerRunConfig(profile: string | undefined, containerName: string): LabRunnerRunConfig | null {
    if (!isLabRunnerProfile(profile)) return null;
    return buildContainerVmRunConfig(containerName);
}

export function getLabRunnerUnsupportedReason(): string | null {
    const info = getRuntimeInfo();
    if (process.platform !== "linux") {
        return "nested virtualization from the CCC container requires a Linux container host";
    }
    if (info.remote) {
        return `${info.flavor} is VM-backed; nested KVM is not exposed to CCC containers by default`;
    }
    if (info.rootless) {
        return `${info.flavor} cannot safely expose /dev/kvm to the CCC container`;
    }
    if (!existsSync("/dev/kvm")) {
        return "/dev/kvm is not available on the container host";
    }
    return null;
}

/**
 * Host-side socket path used for the container-manager bind mount.
 * Docker → configured daemon socket or /var/run/docker.sock.
 * Podman → Podman socket path (rootless or rootful).
 * If the Podman socket doesn't exist on disk, fall back to /var/run/docker.sock
 * (callers that need the socket must themselves enable it via
 * `systemctl --user start podman.socket`).
 */
function resolveHostSocketPath(): string {
    return containerManagerSocketPath();
}

// === Container Name ===

export function getContainerName(projectPath: string, profile?: string): string {
    return deviceLabContainerName(projectPath, profile);
}

const MANAGED_CONTAINER_NAME_PATTERN =
    /^ccc-[a-z0-9-]*-[a-f0-9]{12}(?:--p--([a-z0-9][a-z0-9_.-]{0,63}))?$/;

export interface ManagedProjectNamespaceCollision {
    containerId: string;
    containerName: string;
    projectPath: string;
    profile?: string;
}

function managedContainerProfile(
    containerName: string,
    labels: Record<string, string>,
): string | undefined | null {
    const nameMatch = MANAGED_CONTAINER_NAME_PATTERN.exec(containerName);
    if (!nameMatch) return null;
    const nameProfile = nameMatch[1] || undefined;
    if (!Object.hasOwn(labels, "ccc.profile")) return nameProfile;
    const labelProfile = labels["ccc.profile"] || undefined;
    if (labelProfile !== undefined
        && !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(labelProfile)) {
        return null;
    }
    return labelProfile === nameProfile ? labelProfile : null;
}

/**
 * A short-lived release derived container names from canonical Windows paths.
 * Preserve an existing same-profile namespace instead of creating a duplicate.
 */
export function findManagedProjectNamespaceCollision(
    projectPath: string,
    projectMountIdentity: string,
    projectMountSourceIdentity: BindMountSourceIdentity,
    profile?: string,
): ManagedProjectNamespaceCollision | null {
    if (process.platform !== "win32") return null;
    const listed = spawnSync(
        runtimeCli(),
        ["ps", "-aq", "--no-trunc", "--filter", "label=ccc.managed=true"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" },
    );
    if (listed.error || listed.status !== 0) {
        throw new Error(
            "Unable to inspect existing CCC container namespaces; refusing duplicate container creation.",
        );
    }
    const ids = (listed.stdout ?? "").trim().split(/\s+/).filter(Boolean);
    if (ids.some((id) => !/^[a-f0-9]{64}$/i.test(id)) || new Set(ids).size !== ids.length) {
        throw new Error(
            "Existing CCC container namespace inventory was malformed; refusing duplicate container creation.",
        );
    }
    for (const containerId of ids) {
        const inspected = inspectContainerJsonWithRetry(containerId) as {
            Id?: unknown;
            Name?: unknown;
            Config?: { Labels?: Record<string, string> };
            Mounts?: InspectedContainerMount[];
        } | null;
        if (!inspected
            || inspected.Id !== containerId
            || typeof inspected.Name !== "string"
            || !inspected.Name.startsWith("/")) {
            throw new Error(
                "Existing CCC container namespace could not be verified; refusing duplicate container creation.",
            );
        }
        const containerName = inspected.Name.slice(1);
        const labels = inspected.Config?.Labels;
        if (!labels || labels["ccc.managed"] !== "true") {
            throw new Error(
                "Existing CCC container ownership labels could not be verified; refusing duplicate container creation.",
            );
        }
        const labeledPath = labels["ccc.project.path"];
        if (typeof labeledPath !== "string" || labeledPath.length === 0) {
            throw new Error(
                "Existing CCC container project identity could not be verified; refusing duplicate container creation.",
            );
        }
        const labeledMountIdentity = labels[PROJECT_MOUNT_IDENTITY_LABEL];
        let samePhysicalProject = labeledMountIdentity === projectMountIdentity;
        if (!labeledMountIdentity) {
            samePhysicalProject = projectPathIdentityMatches(labeledPath, projectPath);
            if (!samePhysicalProject) {
                const projectMounts = (inspected.Mounts ?? []).filter((mount) => (
                    mount.Type === "bind"
                    && typeof mount.Source === "string"
                    && typeof mount.Destination === "string"
                    && mount.Destination.startsWith("/project/")
                ));
                if (projectMounts.length === 1) {
                    const sourceMatch = bindSourceIsTrustedFilesystemAlias(
                        projectMounts[0].Source!,
                        projectPath,
                        projectMountSourceIdentity,
                        getCurrentImageId,
                    );
                    if (sourceMatch === "retryable") {
                        throw new Error(
                            "Existing CCC container project source could not be verified; refusing duplicate container creation.",
                        );
                    }
                    samePhysicalProject = sourceMatch === "match";
                }
            }
        }
        if (!samePhysicalProject) continue;

        const candidateProfile = managedContainerProfile(containerName, labels);
        if (candidateProfile === null) {
            throw new Error(
                "Existing CCC container profile identity could not be verified; refusing duplicate container creation.",
            );
        }
        if (candidateProfile !== profile) continue;
        return {
            containerId,
            containerName,
            projectPath: labeledPath,
            ...(candidateProfile ? { profile: candidateProfile } : {}),
        };
    }
    return null;
}

// === Runtime Status Checks ===

/**
 * Back-compat alias preserved for call sites / tests. Prefer
 * `isContainerHostRemote()` from container-runtime.ts in new code.
 */
export function isDockerDesktop(): boolean {
    return isContainerHostRemote();
}

const hostCredentialPaths = createHostCredentialPaths({
    readContainerEnvironment: () => process.env.container,
    readVitestEnvironment: () => process.env.VITEST,
    claudeProfilePath: (profile) => getClaudeDir(profile),
    codexProfilePath: (profile) => getCodexDir(profile),
    homeDirectory: () => homedir(),
    joinHostPath: (base, relative) => join(base, relative),
    createDirectory: (path, options) => {
        mkdirSync(path, options);
        return undefined;
    },
    packageParentPath: (path) => posix.dirname(path),
    packageBasename: (path) => posix.basename(path),
}, CODEX_PACKAGES_CONTAINER_DIR);

export function resolveCredentialHostPath(mount: CredentialMount, profile?: string): string {
    return hostCredentialPaths.resolveCredentialHostPath(mount, profile);
}

/**
 * Create a credential mount's host directory. For the codex mount, also create
 * the mount point of the nested packages volume, so Docker does not create it
 * on the host as root.
 */
export function ensureCredentialHostDir(mount: CredentialMount, profile?: string): string {
    return hostCredentialPaths.ensureCredentialHostDir(mount, profile);
}

function getCodexContainerUid(containerName: string): string {
    const result = spawnSync(runtimeCli(), ["exec", containerName, "sh", "-c", "id -u"], { encoding: "utf-8", timeout: CODEX_CONFIG_PREPARE_TIMEOUT_MS });
    if (result.error || result.status !== 0) {
        throw new Error(`Unable to prepare Codex credentials: container user lookup failed (${result.error?.message ?? (result.stderr?.trim() || `exit ${result.status ?? "unknown"}`)})`);
    }
    const uid = result.stdout.trim();
    if (!/^\d+$/.test(uid) || Number(uid) >= 0xffffffff) {
        throw new Error("Unable to prepare Codex credentials: invalid container user identity");
    }
    return uid;
}

// Retain the historical API name; access is now shared without changing owners.
export function restoreCodexConfigHostOwnership(containerName: string, profile?: string): void {
    let accessMode: number;
    const hostAccess = createCodexHostAccessRestoration({
        resolveConfig: (selectedProfile) => {
            const configFile = getCodexConfigFile(selectedProfile);
            accessMode = fsConstants.R_OK | fsConstants.W_OK;
            return configFile;
        },
        accessConfig: (configFile) => {
            accessSync(configFile, accessMode);
            return undefined;
        },
        hasHostIdentity: () => typeof process.getuid === "function",
        inspectParent: (configFile) => lstatSync(dirname(configFile)),
        inspectConfig: (configFile) => lstatSync(configFile),
        currentHostUid: () => process.getuid!(),
        repairConfig: (target) => {
            const repaired = spawnSync(runtimeCli(), [
                "exec", "--user", "root", target, "sh", "-c",
                codexConfigMutation(codexConfigFileAclScript(getCodexContainerUid(target))),
            ], { encoding: "utf-8", timeout: CODEX_CONFIG_PREPARE_TIMEOUT_MS });
            if (repaired.error || repaired.status !== 0) {
                throw new Error(`container ACL repair failed (${repaired.error?.message ?? (repaired.stderr?.trim() || `exit ${repaired.status ?? "unknown"}`)})`);
            }
            return undefined;
        },
        warn: (configFile, reason) => {
            console.warn(`[ccc] Unable to restore host access to ${configFile}: ${reason instanceof Error ? reason.message : String(reason)}`);
            return undefined;
        },
    });
    hostAccess.restore(containerName, profile);
}

const SOCKET_ACCESS_TIMEOUT_MS = 10_000;
const SOCKET_ACCESS_NEEDS_GROUP_EXIT = 10;
const CONTAINER_MANAGER_SOCKET = "/var/run/docker.sock";

/** Probe as the container's default exec user: exit 0 when usable or absent, else report user and gid. */
export const CONTAINER_MANAGER_SOCKET_PROBE =
    `s=${CONTAINER_MANAGER_SOCKET}; [ -S "$s" ] || exit 0; [ -r "$s" ] && [ -w "$s" ] && exit 0; `
    + `id -un; stat -c %g "$s"; exit ${SOCKET_ACCESS_NEEDS_GROUP_EXIT}`;

/**
 * Root fix: add the user to the group owning the socket, creating or re-numbering
 * ccc-host-socket when no group has that gid. The socket's mode and owner are left alone.
 */
export const CONTAINER_MANAGER_SOCKET_GRANT =
    'u="$1"; g="$2"; n=$(getent group "$g" | cut -d: -f1); '
    + 'if [ -z "$n" ]; then '
    + 'if getent group ccc-host-socket >/dev/null; then groupmod -g "$g" ccc-host-socket; else groupadd -g "$g" ccc-host-socket; fi; '
    + 'n=ccc-host-socket; fi; usermod -aG "$n" "$u"';

const containerSocketAccess = createContainerSocketAccess({
    probe: target => {
        const probe = spawnSync(runtimeCli(), ["exec", target, "sh", "-c", CONTAINER_MANAGER_SOCKET_PROBE], {
            encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: SOCKET_ACCESS_TIMEOUT_MS,
        });
        if (probe.status === 0) return { kind: "usable" };
        const [user, gid] = String(probe.stdout ?? "").trim().split(/\s+/);
        if (probe.status !== SOCKET_ACCESS_NEEDS_GROUP_EXIT
            || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user ?? "")
            || !/^\d{1,10}$/.test(gid ?? "")) {
            return { kind: "unavailable" };
        }
        return { kind: "requires-group", user, gid };
    },
    grant: (target, user, gid) => {
        const grant = spawnSync(runtimeCli(), [
            "exec", "--user", "root", target,
            "timeout", "-k", "2s", "8s", "sh", "-c", CONTAINER_MANAGER_SOCKET_GRANT, "ccc-socket-grant", user, gid,
        ], { stdio: "ignore", timeout: SOCKET_ACCESS_TIMEOUT_MS });
        return { ok: grant.status === 0 };
    },
    warn: () => {
        console.warn("[ccc] Could not grant the container user access to the container-manager socket; "
            + "docker commands inside the container may need sudo.");
        return undefined;
    },
});

/**
 * Let the container's default exec user use the mounted container-manager socket. New execs pick
 * up the group; processes already running keep theirs. Returned failures warn; thrown failures propagate.
 */
export function ensureContainerManagerSocketAccess(containerName: string): void {
    containerSocketAccess.run(containerName);
}

/** Test hook: forget that the one-time warning was printed. */
export function resetContainerManagerSocketAccessWarningForTest(): void {
    containerSocketAccess.resetWarning();
}

export function prepareCodexConfigForContainer(containerName: string, profile?: string): void {
    const directoryGuard = 'dir=/home/ccc/.codex; [ ! -L "$dir" ] && [ -d "$dir" ]';
    const directoryProbe = `${directoryGuard} && [ -r "$dir" ] && [ -w "$dir" ] && [ -x "$dir" ]`;
    const configGuard = `${directoryGuard} && file="$dir/config.toml" && [ ! -L "$file" ]`;
    const configProbe = `${configGuard} && { [ ! -e "$file" ] || { [ -f "$file" ] && [ -r "$file" ] && [ -w "$file" ]; }; }`;
    function run(target: string, configFile: string, operation: string, script: string, root?: boolean, probe?: false): CodexConfigPreparationResult;
    function run(target: string, configFile: string, operation: string, script: string, root: boolean, probe: true): CodexConfigPreparationObservation;
    function run(target: string, configFile: string, operation: string, script: string, root = false, probe = false): CodexConfigPreparationObservation {
        const result = spawnSync(runtimeCli(), [
            "exec", ...(root ? ["--user", "root"] : []), target, "sh", "-c", codexConfigMutation(script),
        ], { encoding: "utf-8", timeout: CODEX_CONFIG_PREPARE_TIMEOUT_MS });
        if (result.error || (result.status !== 0 && !(probe && result.status === 1))) {
            const failure = new Error(`Unable to prepare Codex credentials at ${dirname(configFile)}: ${operation} failed (${result.error?.message ?? (result.stderr?.trim() || `exit ${result.status ?? "unknown"}`)})`);
            return { kind: "failed", failure };
        }
        return { kind: probe && result.status === 1 ? "repair-required" : "ready" };
    }
    createOrderedCodexConfigPreparation({
        resolveConfig: getCodexConfigFile,
        hasHostIdentity: () => typeof process.getuid === "function",
        inspectParent: configFile => lstatSync(dirname(configFile)),
        inspectConfig: (configFile, inspection) => {
            try {
                return { kind: "present", metadata: lstatSync(configFile) };
            } catch (error) {
                if (inspection === "allow-missing" && (error as { code?: unknown } | null | undefined)?.code === "ENOENT") {
                    return { kind: "missing", failure: error };
                }
                throw error;
            }
        },
        currentHostUid: () => process.getuid!(),
        mappedContainerUid: getCodexContainerUid,
        probeDirectory: (target, configFile) => run(target, configFile, "directory access check", directoryProbe, false, true),
        repairDirectory: (target, configFile, mappedUid) => run(target, configFile, "directory ACL grant", codexConfigDirectoryAclScript(mappedUid), true),
        verifyDirectory: (target, configFile) => run(target, configFile, "directory access verification", directoryProbe),
        probeConfig: (target, configFile) => run(target, configFile, "config access check", configProbe, false, true),
        repairConfig: (target, configFile, mappedUid) => run(target, configFile, "config ACL grant", codexConfigFileAclScript(mappedUid), true),
        verifyConfig: (target, configFile) => run(target, configFile, "config access verification", configProbe),
    }).prepare(containerName, profile);
}

export function isDockerRunning(): boolean {
    const result = spawnSync(runtimeCli(), ["info"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
        killSignal: "SIGKILL",
    });
    if (result.status !== 0 && process.env.DEBUG) {
        const stderr = (result.stderr ?? "").toString().trim();
        if (stderr) console.error(`[ccc:debug] ${runtimeCli()} info failed: ${stderr}`);
    }
    return result.status === 0;
}

const CONTAINER_RUNTIME_REPAIR_HINTS: Record<ContainerRuntimeRepairCategory, string> = {
    "docker-desktop": "Please start Docker Desktop and try again.",
    "docker-service": "Please start the docker service (e.g. `sudo systemctl start docker`) and try again.",
    "podman-machine": "Please start the Podman machine (`podman machine start`) and try again.",
    "podman-rootless": "Please start the rootless Podman service (`systemctl --user start podman.socket`) and try again.",
    "podman-service": "Please start the Podman service (`sudo systemctl start podman.socket`) and try again.",
};

export function ensureDockerRunning(): void {
    const result = createContainerRuntimeReadiness({
        isRunning: () => isDockerRunning(),
        runtimeInfo: () => getRuntimeInfo(),
    }).run();
    if (result.kind === "ready") return;

    console.error(`Error: ${result.runtime} is not running.`);
    console.error(CONTAINER_RUNTIME_REPAIR_HINTS[result.repairCategory]);
    throw new Error(`${result.runtime} is not running.`);
}

export function isContainerRunning(
    containerIdentifier: string,
    identifierKind: "name" | "id" = "name",
): boolean {
    if (identifierKind === "id" && !/^[a-f0-9]{64}$/i.test(containerIdentifier)) return false;
    const containerFilter = identifierKind === "id"
        ? `id=${containerIdentifier}`
        : `name=^${containerIdentifier}$`;
    const result = spawnSync(
        runtimeCli(),
        ["ps", "-q", "-f", containerFilter],
        { encoding: "utf-8", timeout: 5000, killSignal: "SIGKILL" },
    );
    return (result.stdout ?? "").trim().length > 0;
}

export interface ContainerIdentity {
    containerId: string;
    running: boolean;
}

/** Destructive lifecycle operations require a successful, explicit identity result. */
export function getContainerIdentity(containerName: string): ContainerIdentity | null {
    const result = spawnSync(
        runtimeCli(),
        ["inspect", containerName, "--format", "{{.Id}}|{{.State.Running}}"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" },
    );
    if (result.error || result.status !== 0) return null;
    const [containerId, running, ...extra] = (result.stdout ?? "").trim().split("|");
    if (!containerId || (running !== "true" && running !== "false") || extra.length > 0) return null;
    return { containerId, running: running === "true" };
}

export function getManagedProjectContainerIdentity(
    containerName: string,
    projectPath: string,
): ContainerIdentity | null {
    const inspectedResult = inspectContainerJsonWithRetry(containerName);
    if (!inspectedResult) return null;
    try {
        const inspected = inspectedResult as {
            Id?: unknown;
            State?: { Running?: unknown };
            Config?: { Labels?: Record<string, string> };
            Mounts?: InspectedContainerMount[];
        };
        if (typeof inspected.Id !== "string" || inspected.Id.length === 0) return null;
        if (typeof inspected.State?.Running !== "boolean") return null;
        const labels = inspected.Config?.Labels;
        if (labels?.["ccc.managed"] !== "true") return null;
        const labeledPath = labels["ccc.project.path"];
        if (!labeledPath || !projectPathsEquivalent(labeledPath, projectPath)) return null;
        const expectedMountIdentity = bindMountSourceIdentityDigest(
            captureBindMountSourceIdentity(projectPath),
        );
        const labeledIdentity = labels[PROJECT_MOUNT_IDENTITY_LABEL];
        if (labeledIdentity !== expectedMountIdentity) {
            if (labeledIdentity) return null;
            const projectMountPath = `/project/${getProjectId(projectPath)}`;
            const currentIdentity = captureBindMountSourceIdentity(projectPath);
            const verification = verifyRequiredContainerMounts(
                inspected.Id,
                inspected.Mounts ?? [],
                [{
                    hostPath: projectPath,
                    containerPath: projectMountPath,
                    type: "bind",
                    presence: "core",
                    sourceProof: {
                        kind: "filesystem",
                        identity: currentIdentity,
                    },
                }],
                "strict",
                true,
            );
            if (verification.kind !== "verified") {
                return null;
            }
        }
        return { containerId: inspected.Id, running: inspected.State.Running };
    } catch (error) {
        if (error instanceof ContainerEngineUnavailableError) throw error;
        return null;
    }
}

/** Destructive lifecycle operations require a successful, explicit stopped result. */
export function getConfirmedStoppedContainerId(containerName: string): string | null {
    const identity = getContainerIdentity(containerName);
    return identity && !identity.running ? identity.containerId : null;
}

export function isContainerConfirmedStopped(containerName: string): boolean {
    return getConfirmedStoppedContainerId(containerName) !== null;
}

/** Return the exact running container ID, or null for stopped/unknown/error states. */
export function getConfirmedRunningContainerId(containerName: string): string | null {
    const identity = getContainerIdentity(containerName);
    return identity?.running ? identity.containerId : null;
}

const CONTAINER_EXEC_TIMEOUT_MS = 5000;

export function canExecContainer(containerName: string, timeoutMs = CONTAINER_EXEC_TIMEOUT_MS): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["exec", containerName, "true"],
        { stdio: ["ignore", "ignore", "ignore"], timeout: Math.max(1, timeoutMs), killSignal: "SIGKILL" },
    );
    return result.status === 0;
}

function canExecContainerAfterBriefRetry(containerName: string): boolean {
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    return createContainerExecReadiness({
        now: () => Date.now(),
        canExec: (target, timeoutMs) => canExecContainer(target, timeoutMs),
        sleep: ms => {
            Atomics.wait(sleeper, 0, 0, ms);
            return undefined;
        },
    }).run(containerName);
}

export function isContainerExists(containerName: string): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["ps", "-aq", "--no-trunc", "-f", `name=^${containerName}$`],
        { encoding: "utf-8", timeout: 5000, killSignal: "SIGKILL" },
    );
    // Unknown must not bypass contract validation or authorize creation of a
    // same-name container. Callers treat it as potentially existing and use
    // inspect/confirmed-stopped probes to establish the exact state.
    if (result.error || result.status !== 0) return true;
    return (result.stdout ?? "").trim().length > 0;
}

function getListedContainerId(containerName: string): { known: boolean; containerId: string | null } {
    const result = spawnSync(
        runtimeCli(),
        ["ps", "-aq", "--no-trunc", "-f", `name=^${containerName}$`],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" },
    );
    if (result.error || result.status !== 0) return { known: false, containerId: null };
    const ids = (result.stdout ?? "").trim().split(/\s+/).filter(Boolean);
    if (ids.length === 0) return { known: true, containerId: null };
    if (ids.length !== 1 || !/^[a-f0-9]{64}$/i.test(ids[0])) return { known: false, containerId: null };
    return { known: true, containerId: ids[0] };
}

export function inspectSessionContainerOwnership(projectPath: string, profile?: string): { known: boolean; containerId: string | null } {
    const listed = getListedContainerId(getContainerName(projectPath, profile));
    if (!listed.known || listed.containerId === null) return listed;
    const managed = getManagedProjectContainerIdentity(listed.containerId, projectPath);
    return managed?.containerId === listed.containerId
        ? listed
        : { known: false, containerId: null };
}

export function isImageExists(): boolean {
    const result = spawnSync(runtimeCli(), ["images", "-q", IMAGE_NAME], {
        encoding: "utf-8",
    });
    return (result.stdout ?? "").trim().length > 0;
}

/**
 * Check if a container's image is outdated compared to the current IMAGE_NAME image.
 */
export function isContainerImageOutdated(containerName: string): boolean {
    try {
        const cli = runtimeCli();
        const containerResult = spawnSync(
            cli,
            ["inspect", containerName, "--format", "{{.Image}}"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (containerResult.status !== 0) return false;

        const imageResult = spawnSync(
            cli,
            ["inspect", IMAGE_NAME, "--format", "{{.Id}}"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (imageResult.status !== 0) return false;

        const containerImageSha = (containerResult.stdout ?? "").trim();
        const currentImageSha = (imageResult.stdout ?? "").trim();

        if (!containerImageSha || !currentImageSha) return false;

        return containerImageSha !== currentImageSha;
    } catch {
        return false;
    }
}

// === Combined Status (single inspect) ===

export interface ContainerStatus {
    exists: boolean;
    running: boolean;
    containerId: string | null;
    imageId: string | null;
}

export function getContainerStatus(containerName: string): ContainerStatus {
    const result = spawnSync(
        runtimeCli(),
        ["inspect", containerName, "--format", "{{.Id}}|{{.State.Running}}|{{.Image}}"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0) {
        return { exists: false, running: false, containerId: null, imageId: null };
    }
    const [containerId, running, imageId, ...extra] = (result.stdout ?? "").trim().split("|");
    if (!containerId || (running !== "true" && running !== "false") || !imageId || extra.length > 0) {
        return { exists: false, running: false, containerId: null, imageId: null };
    }
    return {
        exists: true,
        running: running === "true",
        containerId,
        imageId,
    };
}

export function getCurrentImageId(): string | null {
    const result = spawnSync(
        runtimeCli(),
        ["inspect", IMAGE_NAME, "--format", "{{.Id}}"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" },
    );
    if (result.status !== 0) return null;
    return (result.stdout ?? "").trim() || null;
}

export function getImageLabel(imageName: string, label: string): string | null {
    try {
        const result = spawnSync(
            runtimeCli(),
            ["inspect", imageName, "--format", `{{index .Config.Labels "${label}"}}`],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (result.status !== 0) return null;
        const value = (result.stdout ?? "").trim();
        if (!value || value === "<no value>") return null;
        return value;
    } catch {
        return null;
    }
}

export function pullImage(imageRef: string): boolean {
    const result = spawnSync(runtimeCli(), ["pull", imageRef], { stdio: "inherit" });
    return result.status === 0;
}

export function tagImage(source: string, target: string): void {
    spawnSync(runtimeCli(), ["tag", source, target], { stdio: "ignore" });
}

function hasExplicitRegistry(imageRef: string): boolean {
    const firstSegment = imageRef.split("/")[0] ?? "";
    return firstSegment === "localhost" || firstSegment.includes(".") || firstSegment.includes(":");
}

export function qualifyImageRefForRuntime(imageRef: string): string {
    if (runtimeCli() !== "podman") return imageRef;
    if (hasExplicitRegistry(imageRef)) return imageRef;
    return `docker.io/${imageRef}`;
}

export function ensureImage(): void {
    createNativeContainerImagePreparation({
        get registryImage() { return DOCKER_REGISTRY_IMAGE; },
        isImageExists, getImageLabel, qualifyImageRefForRuntime, pullImage, tagImage,
    }).run();
}

// === Clipboard Shim Sync ===

const CLIPBOARD_SHIMS = ["xclip", "xsel", "wl-paste", "wl-copy", "pbpaste"];

export function syncClipboardShims(containerName: string, distDir: string): void {
    const shimsDir = join(distDir, "..", "scripts", "clipboard-shims");
    const copied: string[] = [];
    const cli = runtimeCli();
    for (const shim of CLIPBOARD_SHIMS) {
        const src = join(shimsDir, shim);
        if (existsSync(src)) {
            const result = spawnSync(cli, ["cp", src, `${containerName}:/usr/local/bin/${shim}`]);
            if (!result.error && result.status === 0) copied.push(`/usr/local/bin/${shim}`);
        }
    }
    // Already-copied shims must remain runnable even if asset staging fails.
    if (copied.length > 0) {
        const normalized = spawnSync(cli, ["exec", "-u", "root", containerName, "sed", "-i", "s/\r$//", ...copied]);
        if (normalized.error || normalized.status !== 0) return;
        const executable = spawnSync(cli, ["exec", "-u", "root", containerName, "chmod", "+x", ...copied]);
        if (executable.error || executable.status !== 0) return;
    }
    const bridgeSource = join(distDir, "..", "scripts", "ccc-x11-bridge");
    const policySource = join(distDir, "..", "scripts", "lib", "clipboard-x11-sync.sh");
    const suffix = randomBytes(8).toString("hex");
    const bridgeStage = `/usr/local/bin/ccc-x11-bridge.${suffix}.new`;
    const policyStage = `/usr/local/lib/ccc/clipboard-x11-sync.sh.${suffix}.new`;
    let bridgeCopied = false;
    let policyCopied = false;
    try {
        // A bridge replacement requires its complete policy asset. Publish the
        // normalized policy first; failures leave the old bridge runnable.
        if (existsSync(bridgeSource) && existsSync(policySource)) {
            const policyDirectory = spawnSync(cli, [
                "exec", "-u", "root", containerName,
                "install", "-d", "-m", "755", "-o", "root", "-g", "root", "/usr/local/lib/ccc",
            ]);
            if (policyDirectory.error || policyDirectory.status !== 0) return;
            const policy = spawnSync(cli, ["cp", policySource, `${containerName}:${policyStage}`]);
            policyCopied = !policy.error && policy.status === 0;
            if (!policyCopied) return;
            const bridge = spawnSync(cli, ["cp", bridgeSource, `${containerName}:${bridgeStage}`]);
            bridgeCopied = !bridge.error && bridge.status === 0;
            if (!bridgeCopied) return;
        }
        if (!bridgeCopied || !policyCopied) return;
        const stages = [bridgeStage, policyStage];
        const normalized = spawnSync(cli, ["exec", "-u", "root", containerName, "sed", "-i", "s/\r$//", ...stages]);
        if (normalized.error || normalized.status !== 0) return;
        const executable = spawnSync(cli, ["exec", "-u", "root", containerName, "chmod", "+x", ...stages]);
        if (executable.error || executable.status !== 0) return;
        if (bridgeCopied && policyCopied) {
            const policyOwner = spawnSync(cli, ["exec", "-u", "root", containerName, "chown", "root:root", policyStage]);
            if (policyOwner.error || policyOwner.status !== 0) return;
            const policyMode = spawnSync(cli, ["exec", "-u", "root", containerName, "chmod", "644", policyStage]);
            if (policyMode.error || policyMode.status !== 0) return;
            // Root installs files; the daemon remains the ordinary ccc process.
            const stateDirectory = spawnSync(cli, [
                "exec", "-u", "root", containerName,
                "install", "-d", "-m", "700", "-o", "ccc", "-g", "ccc", "/run/ccc-x11-bridge",
            ]);
            if (stateDirectory.error || stateDirectory.status !== 0) return;
            const publishedPolicy = spawnSync(cli, ["exec", "-u", "root", containerName, "mv", "-f", policyStage, "/usr/local/lib/ccc/clipboard-x11-sync.sh"]);
            if (publishedPolicy.error || publishedPolicy.status !== 0) return;
            spawnSync(cli, ["exec", "-u", "root", containerName, "mv", "-f", bridgeStage, "/usr/local/bin/ccc-x11-bridge"]);
        }
    } finally {
        // cp may fail after creating a partial stage; both names are ours.
        spawnSync(cli, ["exec", "-u", "root", containerName, "rm", "-f", bridgeStage, policyStage]);
    }
}

function envMap(values: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (!Array.isArray(values)) return map;
    for (const value of values) {
        const text = String(value);
        const idx = text.indexOf("=");
        if (idx > 0) map.set(text.slice(0, idx), text.slice(idx + 1));
    }
    return map;
}

function inspectContainerJsonWithRetry(containerId: string): Record<string, unknown> | null {
    return withBoundedVerificationRetry(
        () => inspectContainerJsonOnce(containerId),
        (result) => result === null,
    );
}

function mountVerification(containerId: string, requiredMounts: RequiredContainerMount[]) {
    const native = createNativeContainerMountObservations({
        containerId,
        requiredMounts,
        canExecContainer,
        currentImageId: getCurrentImageId,
        withRetry: withBoundedVerificationRetry,
    });
    return {
        native,
        application: createContainerMountVerification(native.requiredMounts, native.ports),
    };
}

/** Static evidence permits starting a stopped container, never executing or joining it. */
function preflightStoppedContainerMounts(
    containerId: string,
    observedMounts: InspectedContainerMount[],
    requiredMounts: RequiredContainerMount[],
): StoppedMountPreflight {
    const { native, application } = mountVerification(containerId, requiredMounts);
    return application.preflightStopped(native.decodeObservedMounts(observedMounts));
}

function verifyRequiredContainerMounts(
    containerId: string,
    observedMounts: InspectedContainerMount[],
    requiredMounts: RequiredContainerMount[],
    policy: MountPresencePolicy,
    allowUnexpected = false,
): MountVerification {
    const { native, application } = mountVerification(containerId, requiredMounts);
    return application.verifyExisting(native.decodeObservedMounts(observedMounts), policy, allowUnexpected);
}

function verifyCreatedContainerMounts(
    containerId: string,
    requiredMounts: RequiredContainerMount[],
    projectMountIdentity: string,
): MountVerification {
    return mountVerification(containerId, requiredMounts)
        .application.verifyCreated(containerId, projectMountIdentity);
}

function containerInspectExplicitlyNotFound(
    result: ReturnType<typeof spawnSync>,
): boolean {
    return !result.error
        && result.status !== null
        && result.status !== 0
        && /\bno such (?:container|object)\b/i.test(result.stderr?.toString() ?? "");
}

function hasKvmDevice(devices: unknown): boolean {
    return JSON.stringify(devices ?? []).includes("/dev/kvm");
}

function deviceEntries(devices: unknown): Array<{ hostPath: string; containerPath: string }> {
    if (!Array.isArray(devices)) return [];
    return devices.map((device) => {
        if (!device || typeof device !== "object") return null;
        const entry = device as { PathOnHost?: unknown; PathInContainer?: unknown };
        return {
            hostPath: String(entry.PathOnHost || ""),
            containerPath: String(entry.PathInContainer || ""),
        };
    }).filter((entry): entry is { hostPath: string; containerPath: string } => Boolean(entry));
}

function hasDeviceRequests(deviceRequests: unknown): boolean {
    return Array.isArray(deviceRequests) && deviceRequests.length > 0;
}

type InspectedHostConfig = {
    Devices: unknown[] | null;
    DeviceRequests: unknown[] | null;
    GroupAdd: unknown[] | null;
    Privileged: boolean;
};

function inspectedHostConfig(value: unknown): InspectedHostConfig | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const config = value as Record<string, unknown>;
    if (typeof config.Privileged !== "boolean") return null;
    // Podman 4.9.3's inspect schema omits Docker's DeviceRequests field.
    // Runtime selection is trusted; inspected payloads cannot select this exception.
    const normalized = !Object.hasOwn(config, "DeviceRequests") && getRuntimeInfo().runtime === "podman"
        ? { ...config, DeviceRequests: [] }
        : config;
    for (const key of ["Devices", "DeviceRequests", "GroupAdd"] as const) {
        if (!Object.hasOwn(normalized, key) || (normalized[key] !== null && !Array.isArray(normalized[key]))) {
            return null;
        }
    }
    return normalized as InspectedHostConfig;
}

function devicesMatchExpectedKvmOnly(devices: unknown, kvmDevicePath: string | undefined): boolean {
    if (!kvmDevicePath) return false;
    const actual = deviceEntries(devices);
    return actual.length === 1
        && actual[0].hostPath === kvmDevicePath
        && actual[0].containerPath === kvmDevicePath;
}

function groupAddIncludes(groupAdd: unknown, groupId: number): boolean {
    if (!Array.isArray(groupAdd)) return false;
    return groupAdd.map(String).includes(String(groupId));
}

function groupAddMatchesExpected(groupAdd: unknown, groupId: number | undefined): boolean {
    const actual = Array.isArray(groupAdd) ? groupAdd.map(String) : [];
    const expected = groupId === undefined ? [] : [String(groupId)];
    return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

/**
 * Check if an existing container has the required mounts and immutable VM
 * contract. Env, device, and group wiring cannot be changed by `docker start`,
 * so stale containers are recreated.
 */
function containerMatchesRunContract(
    containerName: string,
    requiredMounts: RequiredContainerMount[],
    labRunner: LabRunnerRunConfig,
    deviceLabMountIdentity: string,
    projectPath: string,
    projectMountIdentity: string,
    desiredImageId: string,
    identity: ContainerUserIdentity,
    reportMismatch: (reason: string) => void = () => undefined,
    phase: "preflight" | "live" = "live",
): boolean | null {
    const inspectedResult = inspectContainerJsonWithRetry(containerName);
    if (!inspectedResult) {
        reportMismatch("container contract inspection failed");
        return null;
    }

    try {
        const failContract = (reason: string) => {
            reportMismatch(reason);
            if (process.env.DEBUG) console.error(`[ccc:debug] containerMatchesRunContract: ${reason}`);
            return false;
        };
        const inspected = inspectedResult as {
            Id?: unknown;
            State?: { Running?: unknown };
            Mounts?: InspectedContainerMount[];
            Config?: { Env?: string[]; Labels?: Record<string, string> };
            HostConfig?: { Devices?: unknown; DeviceRequests?: unknown; GroupAdd?: unknown; Privileged?: boolean; Init?: unknown };
        };
        if (phase === "preflight" && typeof inspected.State?.Running !== "boolean") {
            reportMismatch("container running state inspection failed");
            return null;
        }
        if (phase === "live" && inspected.State?.Running !== true) {
            reportMismatch("container is not confirmed running during live verification");
            return null;
        }
        if (normalizeImageId(String(inspectedResult.Image)) !== normalizeImageId(desiredImageId)
            || !Object.entries(getIdentityLabels(identity)).every(([key, value]) => inspected.Config?.Labels?.[key] === value)) {
            return failContract("image or user identity changed");
        }
        const mounts = inspected.Mounts || [];
        const env = envMap(inspected.Config?.Env);
        const hostConfig = inspectedHostConfig(inspected.HostConfig);
        if (!hostConfig) return failContract("container host configuration is malformed");
        if (inspected.Config?.Labels?.["ccc.managed"] !== "true") {
            return failContract("container is not CCC-managed");
        }
        const labeledProjectPath = inspected.Config?.Labels?.["ccc.project.path"];
        if (!labeledProjectPath || !projectPathIdentityMatches(labeledProjectPath, projectPath)) {
            return failContract("project path identity changed");
        }
        const labeledProjectIdentity =
            inspected.Config?.Labels?.[PROJECT_MOUNT_IDENTITY_LABEL];
        if (labeledProjectIdentity && labeledProjectIdentity !== projectMountIdentity) {
            return failContract("project mount identity changed");
        }
        if (inspected.Config?.Labels?.[DEVICE_LAB_MOUNT_IDENTITY_LABEL] !== deviceLabMountIdentity) {
            return failContract("device-lab mount identity changed");
        }
        const devices = hostConfig.Devices;
        const deviceRequests = hostConfig.DeviceRequests;
        const groupAdd = hostConfig.GroupAdd;
        if (typeof inspected.Id !== "string") {
            return failContract("bind mount identities could not be verified");
        }
        if (inspected.Id !== containerName) {
            return failContract("container identity changed during contract inspection");
        }
        const staticStoppedPreflight = phase === "preflight" && inspected.State?.Running === false;
        const mountVerification = staticStoppedPreflight
            ? preflightStoppedContainerMounts(inspected.Id, mounts, requiredMounts)
            : verifyRequiredContainerMounts(inspected.Id, mounts, requiredMounts, "strict");
        if (mountVerification.kind === "retryable") {
            reportMismatch(mountVerification.reason);
            return null;
        }
        if (mountVerification.kind !== "verified" && mountVerification.kind !== "preflight-verified") {
            return failContract(mountVerification.reason);
        }
        const authRequired = requiredMounts.some((mount) => mount.containerPath === DEVICE_BROKER_AUTH_CONTAINER_FILE);
        const authMounted = mounts.some((mount) => mount.Destination === DEVICE_BROKER_AUTH_CONTAINER_FILE);
        if (authRequired !== authMounted) return failContract("stale isolated device broker auth mount");
        if (authRequired && env.get("CCC_DEVICE_BROKER_AUTH_FILE") !== DEVICE_BROKER_AUTH_CONTAINER_FILE) {
            return failContract("missing isolated device broker auth file environment");
        }
        if (!authRequired && env.has("CCC_DEVICE_BROKER_AUTH_FILE")) {
            return failContract("stale isolated device broker auth file environment");
        }
        if (hostConfig.Privileged) return failContract("stale privileged container");
        // Docker reports null and Podman omits the key when --init was not used.
        if (inspected.HostConfig?.Init !== true) return failContract("missing init process");
        if (hasDeviceRequests(deviceRequests)) return failContract("unexpected host device requests");
        if (env.get("CCC_LAB_RUNNER") !== "1") return failContract("missing CCC_LAB_RUNNER=1");
        if (env.get("CCC_LAB_RUNNER_STATUS") !== labRunner.status) return failContract(`CCC_LAB_RUNNER_STATUS is ${env.get("CCC_LAB_RUNNER_STATUS") || "unset"}, expected ${labRunner.status}`);
        if (env.get("CCC_LAB_STATE_DIR") !== labRunner.stateContainerDir) return failContract(`CCC_LAB_STATE_DIR is ${env.get("CCC_LAB_STATE_DIR") || "unset"}, expected ${labRunner.stateContainerDir}`);
        if (env.get("CCC_LAB_NET_MODE") !== labRunner.networkMode) return failContract(`CCC_LAB_NET_MODE is ${env.get("CCC_LAB_NET_MODE") || "unset"}, expected ${labRunner.networkMode}`);
        if (labRunner.unsupportedReason && env.get("CCC_LAB_RUNNER_UNSUPPORTED_REASON") !== labRunner.unsupportedReason) return failContract("unsupported reason changed");
        if (!labRunner.unsupportedReason && env.has("CCC_LAB_RUNNER_UNSUPPORTED_REASON")) return failContract("stale unsupported reason env");
        if (labRunner.status === "ready") {
            if (!hasKvmDevice(devices)) return failContract("missing /dev/kvm device");
            if (!devicesMatchExpectedKvmOnly(devices, labRunner.kvmDevicePath)) return failContract("unexpected VM device set");
            if (labRunner.kvmGroupId !== undefined && !groupAddIncludes(groupAdd, labRunner.kvmGroupId)) return failContract(`missing kvm group ${labRunner.kvmGroupId}`);
            if (!groupAddMatchesExpected(groupAdd, labRunner.kvmGroupId)) return failContract("unexpected extra VM group-add");
        } else {
            if (deviceEntries(devices).length > 0) return failContract("stale device on unsupported config");
            if (Array.isArray(groupAdd) && groupAdd.length > 0) return failContract("stale group-add on unsupported config");
        }
        return true;
    } catch (error) {
        if (error instanceof ContainerEngineUnavailableError) throw error;
        reportMismatch("container contract inspection failed");
        return null;
    }
}

/**
 * A running managed container remains joinable while additive mount and
 * device-broker contract updates wait for the next stopped-container rebuild.
 * Core project identity, the writable project bind destination, and host
 * privilege expansion still fail closed. The host source is deferred because
 * Docker Desktop may report a different representation of the same Windows
 * path than the current CLI process.
 */
function containerRunContractIsSafeToDefer(
    containerName: string,
    requiredMounts: RequiredContainerMount[],
    labRunner: LabRunnerRunConfig,
    projectPath: string,
    projectMountIdentity: string,
    identity: ContainerUserIdentity,
    reportUnsafe: (reason: string) => void = () => undefined,
): boolean {
    const unsafe = (reason: string) => {
        reportUnsafe(reason);
        return false;
    };
    const inspectedResult = inspectContainerJsonWithRetry(containerName);
    if (!inspectedResult) return unsafe("container contract inspection failed");
    try {
        const inspected = inspectedResult as {
            Id?: unknown;
            State?: { Running?: unknown };
            Mounts?: InspectedContainerMount[];
            Config?: { Env?: string[]; Labels?: Record<string, string> };
            HostConfig?: { Devices?: unknown; DeviceRequests?: unknown; GroupAdd?: unknown; Privileged?: boolean };
        };
        const labels = inspected.Config?.Labels;
        if (labels?.["ccc.managed"] !== "true") return unsafe("container is not CCC-managed");
        if (!labels?.["ccc.project.path"]
            || !projectPathIdentityMatches(labels["ccc.project.path"], projectPath)) {
            return unsafe("project path identity changed");
        }
        const labeledProjectIdentity = labels[PROJECT_MOUNT_IDENTITY_LABEL];
        if (labeledProjectIdentity && labeledProjectIdentity !== projectMountIdentity) {
            return unsafe("project mount identity changed");
        }
        const hostConfig = inspectedHostConfig(inspected.HostConfig);
        if (!hostConfig) return unsafe("container host configuration is malformed");
        if (hostConfig.Privileged) return unsafe("stale privileged container");
        const mounts = inspected.Mounts || [];
        if (typeof inspected.Id !== "string") {
            return unsafe("bind mount identities could not be verified");
        }
        if (inspected.Id !== containerName) {
            return unsafe("container identity changed during contract inspection");
        }
        // Preserve safe-defer policy, but never run live probes on a known stopped
        // or unknown-state object after a static preflight mismatch.
        if (inspected.State?.Running !== true) return unsafe("container is not confirmed running for safe defer");
        if (!containerExecIdentityMatches(containerName, identity)) return unsafe("container UID/GID does not match the host identity");
        const mountVerification = verifyRequiredContainerMounts(
            inspected.Id,
            mounts,
            requiredMounts,
            "safe-defer",
        );
        if (mountVerification.kind === "retryable") {
            return unsafe(mountVerification.reason);
        }
        if (mountVerification.kind === "mismatch") {
            return unsafe(mountVerification.reason);
        }
        const devices = deviceEntries(hostConfig.Devices);
        if (hasDeviceRequests(hostConfig.DeviceRequests)) {
            return unsafe("unexpected host device requests");
        }
        const groupAdd = Array.isArray(hostConfig.GroupAdd)
            ? hostConfig.GroupAdd.map(String)
            : [];
        if (labRunner.status === "ready") {
            const expectedDevices = labRunner.kvmDevicePath ? [labRunner.kvmDevicePath] : [];
            if (devices.some((device) => !expectedDevices.includes(device.hostPath) || device.hostPath !== device.containerPath)) {
                return unsafe("unexpected VM device set");
            }
            const expectedGroups = labRunner.kvmGroupId === undefined ? [] : [String(labRunner.kvmGroupId)];
            if (groupAdd.some((group) => !expectedGroups.includes(group))) {
                return unsafe("unexpected extra VM group-add");
            }
        } else if (devices.length > 0 || groupAdd.length > 0) {
            return unsafe("stale VM device or group on unsupported config");
        }
        return true;
    } catch (error) {
        if (error instanceof ContainerEngineUnavailableError) throw error;
        return unsafe("container contract inspection failed");
    }
}

// Host ~/.gitconfig is copied after the container starts instead of bind-mounted.
// Single-file bind mounts are not portable when CCC itself runs in a container
// with a host Docker socket: the Docker daemon may not see the caller's path, or
// may create a directory at the file destination. Copying through `docker cp`
// produces a regular in-container file that git can atomically rewrite.
// Directory mounts (~/.config/git/) don't have this problem and stay as-is.
export function getHostGitIdentityMounts(): Array<{ hostPath: string; containerPath: string }> {
    const home = homedir();
    const candidates = [
        { hostPath: join(home, ".config", "git"), containerPath: "/home/ccc/.config/git" },
    ];
    return candidates.filter((mount) => existsSync(mount.hostPath));
}

function syncHostGitConfig(containerName: string): void {
    createHostCredentialRefresh(createNativeHostCredentialRefreshPorts(runtimeCli)).syncGit(containerName);
}

function fixSshPermissions(containerName: string): void {
    createHostCredentialRefresh(createNativeHostCredentialRefreshPorts(runtimeCli)).refreshSsh(containerName);
}

/**
 * Keep CCC-managed MCP entrypoints aligned with the host CLI package. The
 * image remains a self-contained fallback, but a same-version development or
 * hotfix build must not silently keep an older bundled MCP implementation.
 */
export function syncManagedMcpBundles(containerName: string): void {
    const cli = runtimeCli();
    for (const bundle of MANAGED_MCP_BUNDLES) {
        const source = join(DIST_DIR, bundle, "server.mjs");
        let sourceStat: ReturnType<typeof lstatSync>;
        try {
            sourceStat = lstatSync(source);
        } catch (error) {
            console.error(`[ccc] WARNING: managed MCP bundle is unavailable (${bundle}): ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size < 1 || sourceStat.size > MANAGED_MCP_BUNDLE_MAX_BYTES) {
            console.error(`[ccc] WARNING: managed MCP bundle is invalid (${bundle}): expected a regular file between 1 and ${MANAGED_MCP_BUNDLE_MAX_BYTES} bytes`);
            continue;
        }

        const staging = `/tmp/ccc-managed-${bundle}-${process.pid}.mjs`;
        const destinationDir = `/opt/ccc/dist/${bundle}`;
        const destination = `${destinationDir}/server.mjs`;
        let sourceDigest: string;
        try {
            sourceDigest = createHash("sha256").update(readFileSync(source)).digest("hex");
        } catch (error) {
            console.error(`[ccc] WARNING: failed to hash managed MCP bundle (${bundle}): ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        const currentDigest = spawnSync(cli, ["exec", containerName, "sha256sum", destination], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
            windowsHide: true,
        });
        if (currentDigest.status === 0 && currentDigest.stdout.trim().split(/\s+/, 1)[0] === sourceDigest) {
            continue;
        }

        const copied = spawnSync(cli, ["cp", source, `${containerName}:${staging}`], { stdio: "ignore" });
        if (copied.status !== 0) {
            console.error(`[ccc] WARNING: failed to stage managed MCP bundle inside container (${bundle})`);
            continue;
        }

        const installed = spawnSync(
            cli,
            [
                "exec",
                "--user",
                "root",
                containerName,
                "sh",
                "-c",
                `mkdir -p ${destinationDir} && chown ccc:ccc ${destinationDir} && install -m 0644 -o ccc -g ccc ${staging} ${destination} && rm -f ${staging}`,
            ],
            { stdio: "ignore" },
        );
        if (installed.status !== 0) {
            spawnSync(cli, ["exec", "--user", "root", containerName, "rm", "-f", staging], { stdio: "ignore" });
            console.error(`[ccc] WARNING: failed to install managed MCP bundle inside container (${bundle})`);
            continue;
        }

        const installedDigest = spawnSync(cli, ["exec", containerName, "sha256sum", destination], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
            windowsHide: true,
        });
        if (installedDigest.status !== 0 || installedDigest.stdout.trim().split(/\s+/, 1)[0] !== sourceDigest) {
            spawnSync(cli, ["exec", "--user", "root", containerName, "rm", "-f", destination], { stdio: "ignore" });
            console.error(`[ccc] WARNING: managed MCP bundle verification failed; removed invalid destination (${bundle})`);
        }
    }
}

/** Validate the effective exec user, never infer it from mutable labels alone. */
function containerExecIdentityMatches(containerId: string, identity: ContainerUserIdentity): boolean {
    const result = spawnSync(runtimeCli(), ["exec", containerId, "sh", "-c",
        'printf "%s:%s:%s:%s" "$(id -u)" "$(id -g)" "$(id -un)" "$HOME"'],
        { encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    return !result.error && result.status === 0
        && result.stdout.trim() === `${identity.uid}:${identity.gid}:ccc:/home/ccc`;
}

/** Preparation pins the image before any shared mutation guard is acquired. */
export function prepareProjectContainerStartup() {
    ensureImage();
    const identity = resolveContainerIdentity();
    const baseImageId = getCurrentImageId();
    if (!baseImageId) throw new Error("Cannot resolve the current CCC base image.");
    const imageId = ensureIdentityImage(baseImageId, identity);
    const helpers = new Map<string, Array<() => void>>();
    return {
        start: (...args: Parameters<typeof startProjectContainer>) => {
            helpers.clear();
            return startProjectContainerLocked({ identity, imageId, helpers }, ...args);
        },
        initialize: (id: string) => {
            const pending = helpers.get(id);
            if (!pending) throw new Error("Container initialization has no exact startup identity.");
            for (const helper of pending) helper();
            helpers.delete(id);
        },
    };
}

export function withProjectContainerStateLockAsync<T>(operation: () => Promise<T> | T): Promise<T> {
    return withSharedMutationLockAsync(join(cccHome(), "codex-state.lock"), operation,
        { waitMs: 600_000 });
}

/** Legacy synchronous callers retain guarded startup and helper initialization. */
export function startProjectContainer(...args: Parameters<ProjectContainerStartup>): string {
    const prepared = prepareProjectContainerStartup();
    let readyId: string | undefined;
    const onReady = args[7];
    args[7] = (id, handoff) => { readyId = id; onReady?.(id, handoff); };
    const result = withSharedMutationLock(join(cccHome(), "codex-state.lock"),
        () => prepared.start(...args), { waitMs: 600_000, reclaimStale: false });
    if (readyId) prepared.initialize(readyId);
    return result;
}

// === Container Lifecycle ===

type ProjectContainerStartup = (
    projectPath: string,
    ensureDirs: () => void,
    extraMounts?: Array<{
        hostPath: string;
        containerPath: string;
        identity?: BindMountSourceIdentity;
        presence?: RequiredContainerMount["presence"];
    }>,
    clipboardPortFile?: string,
    profile?: string,
    /**
     * Fires when the container is recreated (stop+rm+create) due to missing
     * mounts. Callers should treat this as equivalent to a brand-new container:
     * the writable layer is fresh, so per-container setup (ensureTools, mise
     * install, env config) must re-run even if the old container was running.
     */
    onRecreate?: () => void,
    /**
     * Re-evaluated immediately before replacing an existing container. The
     * caller must hold the lifecycle lock and deny replacement while another
     * live or indeterminate CCC session owns the container.
     */
    recreateRunningContainer?: (recreate: () => void) => boolean,
    /** Receives the pinned ID and this lifecycle operation's start authority, under its lock. */
    onContainerReady?: (containerId: string, handoff: { startedByInvocation: boolean }) => void,
    /** Existing container ID observed running before this lifecycle operation began. */
    initiallyRunningContainerId?: string,
    /** Publishes this invocation's exact started ID before helper setup can fail. */
    onContainerStarted?: (containerId: string) => void,
) => string;

function startProjectContainerLocked(
    prepared: { identity: ContainerUserIdentity; imageId: string; helpers: Map<string, Array<() => void>> },
    ...args: Parameters<ProjectContainerStartup>
): string {
    const [projectPath, ensureDirs, extraMounts, clipboardPortFile, profile, onRecreate, recreateRunningContainer, onContainerReady, initiallyRunningContainerId, onContainerStarted] = args;
    ensureDirs();
    mkdirSync(clipboardFilesDir(), { recursive: true, mode: 0o700 });
    const { identity, imageId } = prepared;
    const miseVolumeName = getIdentityMiseVolumeName(identity);
    const codexPackagesVolumeName = getIdentityCodexPackagesVolumeName(identity);

    const fullPath = resolve(projectPath);
    const projectMountSourceIdentity = captureBindMountSourceIdentity(fullPath);
    const projectMountIdentity = bindMountSourceIdentityDigest(projectMountSourceIdentity);
    const preparedExtraMounts = (extraMounts ?? []).map((mount) => {
        const identity = mount.identity ?? captureBindMountSourceIdentity(mount.hostPath);
        assertBindMountSourceIdentity(mount.hostPath, identity);
        return { ...mount, identity };
    });
    const assertPreparedProjectMountSources = () => {
        assertBindMountSourceIdentity(fullPath, projectMountSourceIdentity);
        for (const mount of preparedExtraMounts) {
            assertBindMountSourceIdentity(mount.hostPath, mount.identity);
        }
    };
    const containerName = getContainerName(fullPath, profile);
    const cli = runtimeCli();
    const requestedDeviceLabStateHostDir = join(homedir(), ".ccc", "devices");
    const currentDeviceLabOwnerId = deviceLabOwnerId(fullPath, profile);
    const preparedDeviceLabSources = prepareDeviceLabMountSources(requestedDeviceLabStateHostDir, currentDeviceLabOwnerId);
    const deviceLabStateHostDir = preparedDeviceLabSources.stateRoot.path;
    const currentDeviceLabOwnerRoot = preparedDeviceLabSources.ownerRoot.path;
    const currentDeviceLabOwnerAuthFile = preparedDeviceLabSources.ownerAuthFile?.path;
    const projectId = getProjectId(fullPath);
    const projectMountPath = `/project/${projectId}`;
    const runtimeInfo = getRuntimeInfo();
    const hostSshPath = join(homedir(), ".ssh");
    const hostSshDir = existsSync(hostSshPath) ? hostSshPath : null;
    let sshAgentSocket: string | null = null;
    if (process.platform === "darwin") {
        if (runtimeInfo.runtime === "docker" && runtimeInfo.dockerDesktop) {
            sshAgentSocket = "/run/host-services/ssh-auth.sock";
        }
    } else {
        const hostSock = process.env.SSH_AUTH_SOCK;
        if (hostSock && existsSync(hostSock)) sshAgentSocket = hostSock;
    }

    const debug = !!process.env.DEBUG;
    const credentialMounts = getAllCredentialMounts().map((mount) => {
        const hostPath = ensureCredentialHostDir(mount, profile);
        return { hostPath, containerPath: mount.containerDir };
    });
    const gitIdentityMounts = getHostGitIdentityMounts();
    const labRunner = buildContainerVmRunConfig(containerName);
    const filesystemBind = (
        hostPath: string,
        containerPath: string,
        readonly: boolean,
        presence: RequiredContainerMount["presence"] = "additive",
        identity = captureBindMountSourceIdentity(hostPath),
    ): RequiredContainerMount => ({
        hostPath,
        containerPath,
        readonly,
        type: "bind",
        presence,
        sourceProof: { kind: "filesystem", identity },
    });
    const requiredMounts: RequiredContainerMount[] = [
        filesystemBind(fullPath, projectMountPath, false, "core", projectMountSourceIdentity),
        filesystemBind(getClaudeJsonFile(profile), "/home/ccc/.claude.json", false),
        ...credentialMounts.map((mount) => filesystemBind(mount.hostPath, mount.containerPath, false)),
        ...gitIdentityMounts.map((mount) => filesystemBind(mount.hostPath, mount.containerPath, true)),
        ...preparedExtraMounts.map((mount) => (
            filesystemBind(
                mount.hostPath,
                mount.containerPath,
                false,
                mount.presence ?? "additive",
                mount.identity,
            )
        )),
        filesystemBind(deviceLabStateHostDir, "/home/ccc/.ccc/devices", true),
        {
            hostPath: "tmpfs",
            containerPath: "/home/ccc/.ccc/devices/owners",
            readonly: false,
            type: "tmpfs",
            presence: "additive",
        },
        filesystemBind(
            currentDeviceLabOwnerRoot,
            `/home/ccc/.ccc/devices/owners/${currentDeviceLabOwnerId}`,
            false,
        ),
        {
            hostPath: "tmpfs",
            containerPath: "/home/ccc/.ccc/devices/broker/auth",
            readonly: false,
            type: "tmpfs",
            presence: "additive",
        },
        filesystemBind(clipboardFilesDir(), CLIPBOARD_FILES_CONTAINER_DIR, false),
        {
            hostPath: miseVolumeName,
            containerPath: "/home/ccc/.local/share/mise",
            readonly: false,
            type: "volume",
            presence: "additive",
        },
        {
            hostPath: codexPackagesVolumeName,
            containerPath: CODEX_PACKAGES_CONTAINER_DIR,
            readonly: false,
            type: "volume",
            presence: "additive",
        },
        {
            hostPath: resolveHostSocketPath(),
            containerPath: "/var/run/docker.sock",
            readonly: false,
            type: "bind",
            presence: "core",
            sourceProof: {
                kind: "daemon",
                equivalentSources: runtimeInfo.runtime === "docker" && runtimeInfo.dockerDesktop
                    && (runtimeInfo.socketPath ?? "/var/run/docker.sock") === "/var/run/docker.sock"
                    ? ["/var/run/docker.sock.raw"]
                    : [],
            },
        },
        ...(hostSshDir ? [filesystemBind(hostSshDir, "/home/ccc/.ssh", true)] : []),
        ...(sshAgentSocket
            ? [{
                hostPath: sshAgentSocket,
                containerPath: "/tmp/ssh-agent.sock",
                readonly: false,
                type: "bind" as const,
                presence: "additive" as const,
                sourceProof: { kind: "path" as const, canonical: false },
            }]
            : []),
        ...(clipboardPortFile && existsSync(clipboardPortFile)
            ? [filesystemBind(clipboardPortFile, "/run/ccc/clipboard.port", true)]
            : []),
    ];
    if (currentDeviceLabOwnerAuthFile) {
        requiredMounts.push(filesystemBind(
            currentDeviceLabOwnerAuthFile,
            DEVICE_BROKER_AUTH_CONTAINER_FILE,
            true,
        ));
    }
    requiredMounts.push({
        hostPath: labRunner.stateVolumeName,
        containerPath: labRunner.stateContainerDir,
        readonly: false,
        type: "volume",
        // New containers on hosts without nested VMs no longer get this volume; older ones
        // may still carry it, which is fine as long as it is exactly this volume.
        presence: labRunner.status === "ready" ? "additive" : "optional",
    });
    const assertRequiredFilesystemMountSources = () => {
        for (const mount of requiredMounts) {
            if (mount.sourceProof?.kind === "filesystem") {
                assertBindMountSourceIdentity(mount.hostPath, mount.sourceProof.identity);
            }
        }
    };
    assertRequiredFilesystemMountSources();

    const queueHelper = (id: string, helper: (id: string) => void) => {
        const pending = prepared.helpers.get(id) ?? [];
        pending.push(() => {
            const assertInitializationSources = () => {
                assertPreparedProjectMountSources();
                assertPreparedDeviceLabMountSources(preparedDeviceLabSources);
                assertRequiredFilesystemMountSources();
                const current = getContainerIdentity(id);
                if (!current?.running || current.containerId !== id) throw new Error("Container identity changed during initialization.");
            };
            assertInitializationSources();
            helper(id);
            assertInitializationSources();
        });
        prepared.helpers.set(id, pending);
    };

    const listedContainer = getListedContainerId(containerName);
    // Retain immutable provenance before a guarded replacement removes the old container.
    const previousContainer = listedContainer.containerId
        ? inspectContainerJsonWithRetry(listedContainer.containerId) : null;
    if (previousContainer && (previousContainer.Id !== listedContainer.containerId
        || typeof previousContainer.Image !== "string" || !Array.isArray(previousContainer.Mounts))) {
        throw new Error("Previous container identity or state provenance could not be verified; the container was preserved.");
    }
    let retainedStatePrepared = false;
    const prepareRetainedState = () => {
        if (retainedStatePrepared) return;
        if (listedContainer.containerId && !previousContainer) {
            throw new Error("Previous container state provenance is unavailable; refusing unproven Codex state migration.");
        }
        if (previousContainer) {
            const codexRoot = getCodexDir(profile);
            const codexSource = captureBindMountSourceIdentity(codexRoot);
            prepareCodexStateOwnership(previousContainer, imageId, identity, profile,
                (source) => bindSourceIsTrustedFilesystemAlias(source, codexRoot, codexSource, getCurrentImageId) === "match");
        }
        if (labRunner.status === "ready") {
            prepareLabStateOwnership(labRunner.stateVolumeName, imageId, identity,
                typeof previousContainer?.Image === "string" ? previousContainer.Image : undefined);
        }
        retainedStatePrepared = true;
    };
    if ((previousContainer?.State as { Running?: boolean } | undefined)?.Running
        && !containerExecIdentityMatches(listedContainer.containerId!, identity)) {
        throw new ContainerRestartRequiredError("container UID/GID does not match the host identity", fullPath, cli, profile);
    }
    let restartedByInvocation = false;
    const publishStarted = (containerId: string): void => {
        if (!onContainerStarted) return;
        const startedIdentity = getContainerIdentity(containerId);
        if (!startedIdentity?.running || startedIdentity.containerId !== containerId) {
            throw new Error("Container identity changed before start authorization handoff; refusing cleanup authority.");
        }
        onContainerStarted(containerId);
    };
    const finish = (containerId: string, startedByInvocation: boolean): string => {
        if (!containerExecIdentityMatches(containerId, identity)) {
            throw new Error("Container UID/GID validation failed; refusing a session that could change host project ownership.");
        }
        return createContainerSessionHandoff({
            assertProjectSources: () => { assertPreparedProjectMountSources(); },
            assertFilesystemSources: () => { assertRequiredFilesystemMountSources(); },
            identity: getContainerIdentity,
        }).run(containerId, containerName, onContainerReady
            ? (id) => onContainerReady(id, { startedByInvocation })
            : undefined);
    };
    const existingLifecycle = createNativeContainerExistingLifecycle({
        listContainer: getListedContainerId,
        identity: getContainerIdentity,
        managedIdentity: getManagedProjectContainerIdentity,
        assertProjectSources: () => { assertPreparedProjectMountSources(); },
        assertDeviceSources: () => { assertPreparedDeviceLabMountSources(preparedDeviceLabSources); },
        assertFilesystemSources: () => { assertRequiredFilesystemMountSources(); },
        inspectContract: (id, reportReason) => containerMatchesRunContract(
            id,
            requiredMounts,
            labRunner,
            preparedDeviceLabSources.contractIdentity,
            fullPath,
            projectMountIdentity,
            imageId,
            identity,
            reportReason,
            "preflight",
        ),
        verifyBeforeSetup: (id) => {
            assertPreparedProjectMountSources();
            assertPreparedDeviceLabMountSources(preparedDeviceLabSources);
            assertRequiredFilesystemMountSources();
            let reason = "container contract changed";
            const verified = containerMatchesRunContract(id, requiredMounts, labRunner,
                preparedDeviceLabSources.contractIdentity, fullPath, projectMountIdentity,
                imageId, identity, value => { reason = value; }, "live");
            if (verified !== true) {
                throw new Error(`Existing container live verification failed (${reason}); preserving it without replacement or join.`);
            }
            if (!containerExecIdentityMatches(id, identity)) {
                throw new Error("Container UID/GID validation failed before setup; refusing a session that could change host project ownership.");
            }
            assertPreparedProjectMountSources();
            assertPreparedDeviceLabMountSources(preparedDeviceLabSources);
            assertRequiredFilesystemMountSources();
        },
        safeToDefer: (id, reportReason) => containerRunContractIsSafeToDefer(
            id, requiredMounts, labRunner, fullPath, projectMountIdentity, identity, reportReason,
        ),
        isRunning: isContainerRunning,
        canExec: canExecContainer,
        canExecAfterBriefRetry: canExecContainerAfterBriefRetry,
        deviceSourcesMatch: () => preparedDeviceLabMountSourcesMatch(preparedDeviceLabSources),
        syncMcp: (id) => { queueHelper(id, syncManagedMcpBundles); },
        fixSsh: (id) => { queueHelper(id, fixSshPermissions); },
        syncGit: (id) => { queueHelper(id, syncHostGitConfig); },
        finish: (id) => { finish(id, restartedByInvocation); },
    }, {
        startCli: cli,
        beforeStart: prepareRetainedState,
        afterStart: (id) => {
            restartedByInvocation = true;
            publishStarted(id);
        },
        beforeRemove: prepareRetainedState,
        requiredMountDestinations: () => requiredMounts.map(mount => mount.containerPath),
        projectPath: fullPath,
        profile,
    }).run({
        containerName,
        debug,
        managedProjectPath: fullPath,
        initiallyRunningContainerId,
        replacementGuard: recreateRunningContainer,
        onRecreate,
    });
    if (existingLifecycle.kind === "joined") return containerName;

    return createNativeContainerCreateLifecycle({
        withFamilyLock: withProjectFamilyLifecycleLock,
        namespaceExists: isContainerExists,
        findCollision: () => findManagedProjectNamespaceCollision(
            fullPath,
            projectMountIdentity,
            projectMountSourceIdentity,
            profile,
        ),
        assertProjectSources: () => { assertPreparedProjectMountSources(); },
        assertDeviceSources: () => { assertPreparedDeviceLabMountSources(preparedDeviceLabSources); },
        assertFilesystemSources: () => { assertRequiredFilesystemMountSources(); },
        verifyCreated: (id) => {
            const verification = verifyCreatedContainerMounts(
                id,
                requiredMounts,
                projectMountIdentity,
            );
            if (verification.kind === "verified") publishStarted(id);
            return verification;
        },
        syncMcp: (id) => { queueHelper(id, syncManagedMcpBundles); },
        fixSsh: (id) => { queueHelper(id, fixSshPermissions); },
        syncGit: (id) => { queueHelper(id, syncHostGitConfig); },
        finish: (id) => finish(id, true),
    }, {
        createCli: cli,
        prepareRunArgs: () => buildDockerRunArgs({
            containerName,
            fullPath,
            projectMountPath,
            profile,
            credentialMounts,
            gitIdentityMounts,
            claudeJsonFile: getClaudeJsonFile(profile),
            miseVolumeName,
            codexPackagesVolumeName,
            identity,
            pidsLimit: CONTAINER_PID_LIMIT,
            imageName: imageId,
            hostSshDir,
            sshAgentSocket,
            extraMounts: preparedExtraMounts,
            projectMountIdentity,
            clipboardPortFile,
            clipboardFilesHostDir: clipboardFilesDir(),
            labRunner,
            deviceLabStateHostDir,
            deviceLabOwnerId: currentDeviceLabOwnerId,
            deviceLabOwnerAuthFile: currentDeviceLabOwnerAuthFile,
            deviceLabMountIdentity: preparedDeviceLabSources.contractIdentity,
            // CCC_DISABLE_PROXY is the escape hatch when the runtime-detect
            // heuristics get it wrong (exotic VPN/networking setups, mirrored
            // mode we failed to recognize, etc).
            proxyEnabled: (process.platform !== "linux" || isContainerHostRemote()) && process.env.CCC_DISABLE_PROXY !== "1",
            containerHostRemote: process.platform !== "linux" || isContainerHostRemote(),
        }),
        beforeCreating: prepareRetainedState,
        createFailureHint: CONTAINER_INIT_UNAVAILABLE_HINT,
        labWarning: () => isLabRunnerProfile(profile) && labRunner.status === "unsupported"
            ? { unsupportedReason: labRunner.unsupportedReason }
            : null,
        explicitlyNotFound: containerInspectExplicitlyNotFound,
    }).run({
        containerName,
        projectMountIdentity,
        profile,
        debug,
    });
}

type DestructiveContainerOptions = ContainerDestructiveLifecycleOptions;

function projectContainerDestructiveLifecycle() {
    return createNativeContainerDestructiveLifecycle({
        resolvePath: resolve,
        projectId: getProjectId,
        containerName: getContainerName,
        withLifecycleLock: (prefix, operation) => { withContainerLifecycleLock(prefix, operation); },
        sessionClaims: getSessionLockClaimsForContainer,
        ensureRuntime: () => { ensureDockerRunning(); },
        managedIdentity: getManagedProjectContainerIdentity,
        cleanupDevices: (fullPath, timeoutMs, profile) => { cleanupOwnerDevices(fullPath, timeoutMs, profile); },
    });
}

export function stopProjectContainer(projectPath: string, profile?: string, options: DestructiveContainerOptions = {}): void {
    projectContainerDestructiveLifecycle().stop(projectPath, profile, options);
}

export function removeProjectContainer(projectPath: string, profile?: string, options: DestructiveContainerOptions = {}): void {
    projectContainerDestructiveLifecycle().remove(projectPath, profile, options);
}
