// src/docker.ts - Container lifecycle management (runtime-agnostic).
//
// Despite the filename this module drives either Docker or Podman via the
// runtime abstraction in `container-runtime.ts`. The file name is kept to
// avoid a noisy rename; all CLI invocations go through `runtimeCli()` /
// `bindMountArgs()` / `runtimeExtraRunArgs()`.

import { spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
    closeSync,
    constants as fsConstants,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, normalize, posix, resolve } from "path";
import { fileURLToPath } from "url";
import {
    getProjectId,
    projectPathsEquivalent,
    getClaudeDir,
    getClaudeJsonFile,
    IMAGE_NAME,
    CONTAINER_PID_LIMIT,
    MISE_VOLUME_NAME,
    CLI_VERSION,
    DOCKER_REGISTRY_IMAGE,
    CLIPBOARD_FILES_DIR,
    CLIPBOARD_FILES_CONTAINER_DIR,
    LAB_RUNNER_PROFILE_NAME,
    LAB_RUNNER_STATE_CONTAINER_DIR,
} from "./utils.js";
import {
    runtimeCli,
    bindMountArgs,
    runtimeExtraRunArgs,
    isContainerHostRemote,
    getRuntimeInfo,
} from "./container-runtime.js";
import { cleanupOwnerDevices } from "./device-lab-admin.js";
import { deviceLabContainerName, deviceLabOwnerId } from "./device-lab-owner.js";
import { getAllCredentialMounts } from "./tool-registry.js";
import type { CredentialMount } from "./tool-registry.js";
import { getSessionLockClaimsForContainer, withContainerLifecycleLock } from "./session.js";

const MANAGED_MCP_BUNDLES = ["x11-mcp", "device-lab-mcp"] as const;
const MANAGED_MCP_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
const DIST_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const DEVICE_BROKER_AUTH_CONTAINER_FILE = "/run/ccc-device-broker-auth/owner.json";
const DEVICE_LAB_MOUNT_IDENTITY_LABEL = "ccc.device-lab.mount-identity";
const PROJECT_MOUNT_IDENTITY_LABEL = "ccc.project.mount-identity";
const DEVICE_LAB_MOUNT_CONTRACT_VERSION = "2";

type MountSourceIdentity = {
    path: string;
    kind: "directory" | "file";
    dev: string;
    ino: string;
};

export type BindMountSourceIdentity = {
    realpath: string;
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

type RequiredContainerMount = {
    hostPath: string;
    containerPath: string;
    readonly?: boolean;
    type?: "bind" | "tmpfs" | "volume";
    verifySource?: boolean;
    verifySourceCanonical?: boolean;
    equivalentSources?: string[];
    expectedIdentity?: BindMountSourceIdentity;
};

function normalizedHostPath(path: string): string {
    const normalized = normalize(resolve(path));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalHostPath(path: string): string {
    return normalizedHostPath(realpathSync(path));
}

export function captureBindMountSourceIdentity(path: string): BindMountSourceIdentity {
    const canonical = realpathSync(path);
    const before = lstatSync(canonical, { bigint: true });
    if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) {
        throw new Error(`bind mount source must resolve to a real file or directory: ${path}`);
    }
    const after = lstatSync(canonical, { bigint: true });
    if (after.isSymbolicLink()
        || (!after.isDirectory() && !after.isFile())
        || !sameFileIdentity(before, after)) {
        throw new Error(`bind mount source changed while it was being validated: ${path}`);
    }
    return {
        realpath: canonical,
        dev: String(after.dev),
        ino: String(after.ino),
    };
}

function bindMountSourceIdentityMatches(
    expected: BindMountSourceIdentity,
    actual: BindMountSourceIdentity,
): boolean {
    return bindSourcePathsEquivalent(expected.realpath, actual.realpath)
        && expected.dev === actual.dev
        && expected.ino === actual.ino;
}

function assertBindMountSourceIdentity(
    path: string,
    expected: BindMountSourceIdentity,
): void {
    if (!bindMountSourceIdentityMatches(
        expected,
        captureBindMountSourceIdentity(path),
    )) {
        throw new Error(`bind mount source identity changed: ${path}`);
    }
}

function containerSeesCurrentBindSource(
    containerId: string,
    hostPath: string,
    containerPath: string,
    expected: BindMountSourceIdentity,
): boolean {
    let verified = false;
    let markerPath: string | null = null;
    try {
        assertBindMountSourceIdentity(hostPath, expected);
        const observed = lstatSync(expected.realpath);
        if (observed.isSymbolicLink()) return false;
        if (typeof observed.isDirectory === "function" && observed.isDirectory()) {
            const markerName = `.ccc-mount-identity-${randomBytes(16).toString("hex")}`;
            markerPath = join(expected.realpath, markerName);
            const markerContent = randomBytes(32).toString("hex");
            writeFileSync(markerPath, markerContent, { flag: "wx", mode: 0o600 });
            assertBindMountSourceIdentity(hostPath, expected);
            let result = spawnSync(
                runtimeCli(),
                ["exec", containerId, "cat", posix.join(containerPath, markerName)],
                { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            );
            if ((result.error || result.status !== 0)
                && canExecContainerAfterBriefRetry(containerId)) {
                assertBindMountSourceIdentity(hostPath, expected);
                result = spawnSync(
                    runtimeCli(),
                    ["exec", containerId, "cat", posix.join(containerPath, markerName)],
                    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
                );
            }
            verified = !result.error
                && result.status === 0
                && (result.stdout ?? "") === markerContent;
        } else if (typeof observed.isFile === "function" && observed.isFile()) {
            if (observed.size > 1024 * 1024) return false;
            const expectedContent = readFileSync(expected.realpath);
            assertBindMountSourceIdentity(hostPath, expected);
            let result = spawnSync(
                runtimeCli(),
                ["exec", containerId, "cat", containerPath],
                {
                    encoding: null,
                    stdio: ["pipe", "pipe", "pipe"],
                    maxBuffer: 1024 * 1024 + 1,
                },
            );
            if ((result.error || result.status !== 0)
                && canExecContainerAfterBriefRetry(containerId)) {
                assertBindMountSourceIdentity(hostPath, expected);
                result = spawnSync(
                    runtimeCli(),
                    ["exec", containerId, "cat", containerPath],
                    {
                        encoding: null,
                        stdio: ["pipe", "pipe", "pipe"],
                        maxBuffer: 1024 * 1024 + 1,
                    },
                );
            }
            verified = !result.error
                && result.status === 0
                && Buffer.isBuffer(result.stdout)
                && result.stdout.equals(expectedContent);
        }
    } catch {
        verified = false;
    } finally {
        if (markerPath) rmSync(markerPath, { force: true });
        try {
            assertBindMountSourceIdentity(hostPath, expected);
        } catch {
            verified = false;
        }
    }
    return verified;
}

export function bindMountSourceIdentityDigest(
    identity: BindMountSourceIdentity,
): string {
    return createHash("sha256")
        .update(`${identity.realpath}\0${identity.dev}\0${identity.ino}`)
        .digest("hex");
}

export function projectPathIdentityMatches(left: string, right: string): boolean {
    if (normalizedHostPath(left) === normalizedHostPath(right)) return true;
    try {
        return projectPathsEquivalent(left, right);
    } catch {
        return false;
    }
}

function windowsBindSourceIdentity(path: string): string | null {
    const slashed = path.replace(/\\/g, "/").replace(/^\/\/\?\//, "");
    const desktop = /^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\/(.+)$/i.exec(slashed);
    if (desktop) return `${desktop[1].toLowerCase()}:/${desktop[2]}`.toLowerCase();
    const drive = /^([a-z]):\/(.+)$/i.exec(slashed);
    return drive ? `${drive[1].toLowerCase()}:/${drive[2]}`.toLowerCase() : null;
}

export function bindSourcePathsEquivalent(actual: string, expected: string): boolean {
    const actualWindows = windowsBindSourceIdentity(actual);
    const expectedWindows = windowsBindSourceIdentity(expected);
    if (actualWindows || expectedWindows) return actualWindows === expectedWindows;
    return normalizedHostPath(actual) === normalizedHostPath(expected);
}

function requiredBindSourceMatches(
    actualSource: string,
    required: RequiredContainerMount,
    containerId?: string,
): boolean {
    const expectedSource = required.verifySourceCanonical === false
        ? required.hostPath
        : canonicalHostPath(required.hostPath);
    if ([expectedSource, ...(required.equivalentSources ?? [])]
        .some((candidate) => bindSourcePathsEquivalent(actualSource, candidate))) {
        return true;
    }
    return required.containerPath === "/var/run/docker.sock"
        && typeof containerId === "string"
        && containerManagerSocketTargetsCurrentDockerDaemon(containerId);
}

function dockerDaemonIdentity(result: ReturnType<typeof spawnSync>): string | null {
    if (result.error || result.status !== 0) return null;
    const identity = (result.stdout ?? "").toString().trim();
    return /^[^\s]{1,512}$/.test(identity) ? identity : null;
}

function containerManagerSocketTargetsCurrentDockerDaemon(containerId: string): boolean {
    if (getRuntimeInfo().runtime !== "docker") return false;
    const options = {
        encoding: "utf-8" as const,
        stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
        timeout: 10_000,
        windowsHide: true,
    };
    const hostIdentity = dockerDaemonIdentity(spawnSync(
        runtimeCli(),
        ["info", "--format", "{{.ID}}"],
        options,
    ));
    if (!hostIdentity) return false;
    const mountedIdentity = dockerDaemonIdentity(spawnSync(
        runtimeCli(),
        [
            "exec",
            containerId,
            "/usr/bin/docker",
            "--host",
            "unix:///var/run/docker.sock",
            "info",
            "--format",
            "{{.ID}}",
        ],
        options,
    ));
    return mountedIdentity === hostIdentity;
}

function sameFileIdentity(
    left: { dev?: number | bigint; ino?: number | bigint },
    right: { dev?: number | bigint; ino?: number | bigint },
): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

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
    credentialMounts: Array<{ hostPath: string; containerPath: string }>;
    gitIdentityMounts?: Array<{ hostPath: string; containerPath: string }>;
    claudeJsonFile: string;
    miseVolumeName: string;
    pidsLimit: string;
    imageName: string;
    hostSshDir: string | null;
    sshAgentSocket: string | null;
    extraMounts?: Array<{
        hostPath: string;
        containerPath: string;
        identity?: BindMountSourceIdentity;
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

// Docker Compose-compatible labels for Docker Desktop grouping.
// com.docker.compose.* labels are undocumented internals but stable since Compose V2.
// Podman accepts arbitrary labels as opaque strings.
function getComposeLabels(
    containerName: string,
    fullPath: string,
    projectMountIdentity?: string,
): string[] {
    const labels = [
        "--label", "com.docker.compose.project=ccc",
        "--label", `com.docker.compose.service=${containerName}`,
        "--label", "com.docker.compose.oneoff=False",
        "--label", "com.docker.compose.version=2",
        "--label", "com.docker.compose.container-number=1",
        "--label", "ccc.managed=true",
        "--label", `ccc.project.path=${fullPath}`,
        "--label", `ccc.cli.version=${CLI_VERSION}`,
    ];
    if (projectMountIdentity) {
        labels.push("--label", `${PROJECT_MOUNT_IDENTITY_LABEL}=${projectMountIdentity}`);
    }
    return labels;
}

export function buildDockerRunArgs(opts: DockerRunArgsOptions): string[] {
    // Stable hostname: derived from container name, truncated to 63 chars (RFC 1123).
    // Ensures Claude Code's --resume can find conversations after container recreation,
    // since conversations are keyed by hostname internally.
    const hostname = opts.containerName.slice(0, 63);

    const args: string[] = [
        "run",
        "-d",
        "--name",
        opts.containerName,
        "--hostname",
        hostname,
        "--network",
        "host",
        "--security-opt",
        "seccomp=unconfined",
        "--cap-add",
        "NET_ADMIN",
    ];

    // Bind mounts (runtime-aware: adds :Z on SELinux podman)
    args.push(...bindMountArgs(opts.fullPath, opts.projectMountPath));
    for (const mount of opts.credentialMounts) {
        args.push(...bindMountArgs(mount.hostPath, mount.containerPath));
    }
    for (const mount of opts.gitIdentityMounts ?? []) {
        args.push(...bindMountArgs(mount.hostPath, mount.containerPath, { readonly: true }));
    }
    args.push(...bindMountArgs(opts.claudeJsonFile, "/home/ccc/.claude.json"));
    if (opts.deviceLabStateHostDir) {
        args.push(...bindMountArgs(opts.deviceLabStateHostDir, "/home/ccc/.ccc/devices", { readonly: true }));
        args.push("--tmpfs", "/home/ccc/.ccc/devices/owners:rw,noexec,nosuid,nodev,mode=0711");
        if (opts.deviceLabOwnerId) {
            args.push(...bindMountArgs(
                join(opts.deviceLabStateHostDir, "owners", opts.deviceLabOwnerId),
                `/home/ccc/.ccc/devices/owners/${opts.deviceLabOwnerId}`,
            ));
        }
        args.push("--tmpfs", "/home/ccc/.ccc/devices/broker/auth:rw,noexec,nosuid,nodev,mode=0711");
        if (opts.deviceLabOwnerAuthFile) {
            args.push(...bindMountArgs(opts.deviceLabOwnerAuthFile, DEVICE_BROKER_AUTH_CONTAINER_FILE, { readonly: true }));
            args.push("-e", `CCC_DEVICE_BROKER_AUTH_FILE=${DEVICE_BROKER_AUTH_CONTAINER_FILE}`);
        }
    }
    // Named volume — never gets :Z (mount helper auto-detects host-path vs name)
    args.push(...bindMountArgs(opts.miseVolumeName, "/home/ccc/.local/share/mise"));
    if (opts.labRunner) {
        args.push(...bindMountArgs(opts.labRunner.stateVolumeName, opts.labRunner.stateContainerDir));
    }
    // Container-manager socket: Docker uses /var/run/docker.sock,
    // Podman substitutes its own socket on the host side but keeps the same
    // in-container path so docker CLI shims inside the container keep working.
    args.push(...bindMountArgs(resolveHostSocketPath(), "/var/run/docker.sock"));

    args.push("-w", opts.projectMountPath, "--pids-limit", opts.pidsLimit);

    // Runtime-specific: --userns=keep-id:uid=1000,gid=1000 on rootless podman
    args.push(...runtimeExtraRunArgs());

    // Mount host SSH keys (read-only) for git SSH access
    if (opts.hostSshDir) {
        args.push(...bindMountArgs(opts.hostSshDir, "/home/ccc/.ssh", { readonly: true }));
        args.push(
            "-e",
            "GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/.ssh-copy/known_hosts -o IdentityFile=/tmp/.ssh-copy/id_rsa -o IdentityFile=/tmp/.ssh-copy/id_ed25519",
        );
    }

    // Forward SSH agent socket
    if (opts.sshAgentSocket) {
        args.push(...bindMountArgs(opts.sshAgentSocket, "/tmp/ssh-agent.sock"));
        args.push("-e", "SSH_AUTH_SOCK=/tmp/ssh-agent.sock");
    }

    // Trust the project's mise config without requiring a separate `mise trust`
    // call. Baked in at container creation so every `docker exec` inherits it;
    // mise checks this env var in-memory on each invocation and skips the
    // trust-file write path entirely.
    args.push("-e", `MISE_TRUSTED_CONFIG_PATHS=${opts.projectMountPath}`);
    if (opts.proxyEnabled) {
        args.push("-e", "CCC_PROXY_ENABLED=1");
    }

    if (opts.labRunner) {
        args.push("-e", "CCC_LAB_RUNNER=1");
        args.push("-e", `CCC_LAB_RUNNER_STATUS=${opts.labRunner.status}`);
        args.push("-e", `CCC_LAB_STATE_DIR=${opts.labRunner.stateContainerDir}`);
        args.push("-e", `CCC_LAB_NET_MODE=${opts.labRunner.networkMode}`);
        if (opts.labRunner.unsupportedReason) {
            args.push("-e", `CCC_LAB_RUNNER_UNSUPPORTED_REASON=${opts.labRunner.unsupportedReason}`);
        }
        if (opts.labRunner.status === "ready" && opts.labRunner.kvmDevicePath) {
            args.push("--device", `${opts.labRunner.kvmDevicePath}:${opts.labRunner.kvmDevicePath}`);
            if (opts.labRunner.kvmGroupId !== undefined) {
                args.push("--group-add", String(opts.labRunner.kvmGroupId));
            }
        }
    }

    // Extra volume mounts (e.g., source .git for worktree workspaces)
    if (opts.extraMounts) {
        for (const mount of opts.extraMounts) {
            args.push(...bindMountArgs(mount.hostPath, mount.containerPath));
        }
    }

    // Mount clipboard port file so shims can read the latest token even after server restarts
    if (opts.clipboardPortFile && existsSync(opts.clipboardPortFile)) {
        args.push(...bindMountArgs(opts.clipboardPortFile, "/run/ccc/clipboard.port", { readonly: true }));
    }
    if (opts.clipboardFilesHostDir) {
        args.push(...bindMountArgs(opts.clipboardFilesHostDir, CLIPBOARD_FILES_CONTAINER_DIR));
    }

    args.push(...getComposeLabels(
        opts.containerName,
        opts.fullPath,
        opts.projectMountIdentity,
    ));
    if (opts.deviceLabMountIdentity) {
        args.push("--label", `${DEVICE_LAB_MOUNT_IDENTITY_LABEL}=${opts.deviceLabMountIdentity}`);
    }
    args.push(opts.imageName);
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
 * Docker → /var/run/docker.sock. Podman → Podman socket path (rootless or rootful).
 * If the Podman socket doesn't exist on disk, fall back to /var/run/docker.sock
 * (callers that need the socket must themselves enable it via
 * `systemctl --user start podman.socket`).
 */
function resolveHostSocketPath(): string {
    const info = getRuntimeInfo();
    if (info.runtime === "docker") return "/var/run/docker.sock";
    const socket = info.socketPath ?? "/run/podman/podman.sock";
    if (existsSync(socket)) return socket;
    // Fall back to /var/run/docker.sock if Podman socket isn't running.
    // This keeps the bind-mount spec valid; the socket will 404 but nothing
    // inside the container will crash at create time.
    return "/var/run/docker.sock";
}

// === Container Name ===

export function getContainerName(projectPath: string, profile?: string): string {
    return deviceLabContainerName(projectPath, profile);
}

// === Runtime Status Checks ===

/**
 * Back-compat alias preserved for call sites / tests. Prefer
 * `isContainerHostRemote()` from container-runtime.ts in new code.
 */
export function isDockerDesktop(): boolean {
    return isContainerHostRemote();
}

export function resolveCredentialHostPath(mount: CredentialMount, profile?: string): string {
    if (!profile && process.env.container === "docker" && !process.env.VITEST) {
        return mount.containerDir;
    }
    if (profile && mount.containerDir === "/home/ccc/.claude") {
        return getClaudeDir(profile);
    }
    return join(homedir(), mount.hostDir);
}

export function restoreCodexConfigHostOwnership(containerName: string): void {
    void containerName;
}

export function prepareCodexConfigForContainer(containerName: string): void {
    const accessCheck = spawnSync(runtimeCli(), [
        "exec", containerName,
        "sh", "-c",
        "test ! -e /home/ccc/.codex/config.toml || test -r /home/ccc/.codex/config.toml -a -w /home/ccc/.codex/config.toml",
    ], { stdio: "ignore" });
    if (accessCheck.status === 0) return;

    spawnSync(runtimeCli(), [
        "exec", "--user", "root", containerName,
        "sh", "-c",
        "if [ -e /home/ccc/.codex/config.toml ]; then chown ccc:docker /home/ccc/.codex/config.toml 2>/dev/null || chown ccc:ccc /home/ccc/.codex/config.toml 2>/dev/null || true; chmod 600 /home/ccc/.codex/config.toml 2>/dev/null || true; fi",
    ], { stdio: "ignore" });
}

export function isDockerRunning(): boolean {
    const result = spawnSync(runtimeCli(), ["info"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0 && process.env.DEBUG) {
        const stderr = (result.stderr ?? "").toString().trim();
        if (stderr) console.error(`[ccc:debug] ${runtimeCli()} info failed: ${stderr}`);
    }
    return result.status === 0;
}

export function ensureDockerRunning(): void {
    if (!isDockerRunning()) {
        const info = getRuntimeInfo();
        console.error(`Error: ${info.runtime} is not running.`);
        if (info.runtime === "docker") {
            if (info.flavor === "docker-desktop") {
                console.error("Please start Docker Desktop and try again.");
            } else {
                console.error("Please start the docker service (e.g. `sudo systemctl start docker`) and try again.");
            }
        } else {
            if (info.flavor === "podman-machine") {
                console.error("Please start the Podman machine (`podman machine start`) and try again.");
            } else if (info.flavor === "podman-rootless") {
                console.error("Please start the rootless Podman service (`systemctl --user start podman.socket`) and try again.");
            } else {
                console.error("Please start the Podman service (`sudo systemctl start podman.socket`) and try again.");
            }
        }
        process.exit(1);
    }
}

export function isContainerRunning(containerName: string): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["ps", "-q", "-f", `name=^${containerName}$`],
        { encoding: "utf-8" },
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
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
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
    const result = spawnSync(
        runtimeCli(),
        ["inspect", "-f", "{{json .}}", containerName],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0) return null;
    try {
        const inspected = JSON.parse((result.stdout ?? "").trim()) as {
            Id?: unknown;
            State?: { Running?: unknown };
            Config?: { Labels?: Record<string, string> };
            Mounts?: Array<{ Source?: unknown; Destination?: unknown; Type?: unknown }>;
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
            const projectMount = inspected.Mounts?.find((mount) => (
                mount.Destination === projectMountPath
            ));
            const currentIdentity = captureBindMountSourceIdentity(projectPath);
            if (projectMount?.Type !== "bind"
                || typeof projectMount.Source !== "string"
                || !bindSourcePathsEquivalent(projectMount.Source, currentIdentity.realpath)
                || !containerSeesCurrentBindSource(
                    inspected.Id,
                    projectPath,
                    projectMountPath,
                    currentIdentity,
                )) {
                return null;
            }
        }
        return { containerId: inspected.Id, running: inspected.State.Running };
    } catch {
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

export function canExecContainer(containerName: string, timeoutMs = 5000): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["exec", containerName, "true"],
        { stdio: ["ignore", "ignore", "ignore"], timeout: Math.max(1, timeoutMs) },
    );
    return result.status === 0;
}

function canExecContainerAfterBriefRetry(containerName: string): boolean {
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 750;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        if (canExecContainer(containerName, Math.min(200, remainingMs))) return true;
        const sleepMs = Math.min(75, deadline - Date.now());
        if (attempt < 2 && sleepMs > 0) Atomics.wait(sleeper, 0, 0, sleepMs);
    }
    return false;
}

export function isContainerExists(containerName: string): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["ps", "-aq", "--no-trunc", "-f", `name=^${containerName}$`],
        { encoding: "utf-8" },
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
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0) return { known: false, containerId: null };
    const ids = (result.stdout ?? "").trim().split(/\s+/).filter(Boolean);
    if (ids.length === 0) return { known: true, containerId: null };
    if (ids.length !== 1 || !/^[a-f0-9]{1,64}$/i.test(ids[0])) return { known: false, containerId: null };
    return { known: true, containerId: ids[0] };
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
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
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
    const localExists = isImageExists();

    if (localExists) {
        const label = getImageLabel(IMAGE_NAME, "cli.version");
        if (label === null) return;
        if (label === CLI_VERSION) return;
        console.log(`Image version mismatch (have v${label}, need v${CLI_VERSION}). Pulling update...`);
    } else {
        console.log(`Pulling ccc image v${CLI_VERSION} from registry...`);
    }

    const remoteRef = qualifyImageRefForRuntime(`${DOCKER_REGISTRY_IMAGE}:${CLI_VERSION}`);
    if (pullImage(remoteRef)) {
        tagImage(remoteRef, IMAGE_NAME);
        return;
    }

    if (localExists) {
        console.warn(`Warning: Failed to pull ${remoteRef}. Using existing image.`);
        return;
    }

    console.error(`Error: Failed to pull ${remoteRef}.`);
    console.error(`You can build locally instead: ${runtimeCli()} build -t ccc .`);
    process.exit(1);
}

// === Clipboard Shim Sync ===

const CLIPBOARD_SHIMS = ["xclip", "xsel", "wl-paste", "wl-copy", "pbpaste"];

export function syncClipboardShims(containerName: string, distDir: string): void {
    const shimsDir = join(distDir, "..", "scripts", "clipboard-shims");
    if (!existsSync(shimsDir)) return;
    const copied: string[] = [];
    const cli = runtimeCli();
    for (const shim of CLIPBOARD_SHIMS) {
        const src = join(shimsDir, shim);
        if (existsSync(src)) {
            spawnSync(cli, ["cp", src, `${containerName}:/usr/local/bin/${shim}`]);
            copied.push(`/usr/local/bin/${shim}`);
        }
    }
    if (copied.length > 0) {
        spawnSync(cli, ["exec", containerName, "chmod", "+x", ...copied]);
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

function unexpectedContainerMount(
    mounts: Array<{ Source?: unknown; Destination?: unknown; RW?: unknown; Type?: unknown }>,
    requiredMounts: RequiredContainerMount[],
): string | null {
    const allowedDestinations = new Set(requiredMounts.map((mount) => mount.containerPath));
    const destinations = new Set<string>();
    for (const mount of mounts) {
        if (!mount || typeof mount !== "object"
            || typeof mount.Destination !== "string" || mount.Destination.length === 0) {
            return "<malformed-destination>";
        }
        if (typeof mount.Source !== "string"
            || typeof mount.Type !== "string" || mount.Type.length === 0
            || typeof mount.RW !== "boolean") {
            return `<malformed:${mount.Destination}>`;
        }
        if (destinations.has(mount.Destination)) return `<duplicate:${mount.Destination}>`;
        destinations.add(mount.Destination);
        if (!allowedDestinations.has(mount.Destination)) return mount.Destination;
    }
    return null;
}

type InspectedContainerMount = {
    Source: string;
    Destination: string;
    RW?: boolean;
    Type?: string;
    Name?: unknown;
};

function namedVolumeMatches(
    mount: InspectedContainerMount,
    expectedName: string,
): boolean {
    if (Object.hasOwn(mount, "Name")) {
        return typeof mount.Name === "string" && mount.Name === expectedName;
    }
    return mount.Source === expectedName;
}

function createdContainerBindMountsMatch(
    containerId: string,
    required: Array<{
        hostPath: string;
        containerPath: string;
        identity: BindMountSourceIdentity;
    }>,
    projectMountIdentity: string,
): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["inspect", "-f", "{{json .}}", containerId],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0) return false;
    try {
        const inspected = JSON.parse((result.stdout ?? "").trim()) as {
            Id?: unknown;
            Mounts?: Array<{ Source?: unknown; Destination?: unknown; Type?: unknown }>;
            Config?: { Labels?: Record<string, string> };
        };
        if (inspected.Id !== containerId
            || inspected.Config?.Labels?.[PROJECT_MOUNT_IDENTITY_LABEL] !== projectMountIdentity) {
            return false;
        }
        const mounts = inspected.Mounts ?? [];
        return required.every((expected) => {
            assertBindMountSourceIdentity(expected.hostPath, expected.identity);
            const actual = mounts.find((mount) => (
                mount.Destination === expected.containerPath
            ));
            return actual?.Type === "bind"
                && typeof actual.Source === "string"
                && bindSourcePathsEquivalent(actual.Source, expected.identity.realpath)
                && containerSeesCurrentBindSource(
                    containerId,
                    expected.hostPath,
                    expected.containerPath,
                    expected.identity,
                );
        });
    } catch {
        return false;
    }
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
    for (const key of ["Devices", "DeviceRequests", "GroupAdd"] as const) {
        if (!Object.hasOwn(config, key) || (config[key] !== null && !Array.isArray(config[key]))) {
            return null;
        }
    }
    return config as InspectedHostConfig;
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
    reportMismatch: (reason: string) => void = () => undefined,
): boolean | null {
    const result = spawnSync(
        runtimeCli(),
        ["inspect", "-f", "{{json .}}", containerName],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0) return null;

    try {
        const failContract = (reason: string) => {
            reportMismatch(reason);
            if (process.env.DEBUG) console.error(`[ccc:debug] containerMatchesRunContract: ${reason}`);
            return false;
        };
        const inspected = JSON.parse((result.stdout ?? "").trim()) as {
            Id?: unknown;
            Mounts?: InspectedContainerMount[];
            Config?: { Env?: string[]; Labels?: Record<string, string> };
            HostConfig?: { Devices?: unknown; DeviceRequests?: unknown; GroupAdd?: unknown; Privileged?: boolean };
        };
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
        for (const req of requiredMounts) {
            if (req.expectedIdentity) {
                try {
                    assertBindMountSourceIdentity(req.hostPath, req.expectedIdentity);
                } catch {
                    return failContract(`bind source identity changed for ${req.containerPath}`);
                }
            }
            const mount = mounts.find((item) => item.Destination === req.containerPath);
            if (!mount) {
                if (process.env.DEBUG) {
                    console.error(`[ccc:debug] containerMatchesRunContract: missing ${req.containerPath}`);
                    console.error(`[ccc:debug] containerMatchesRunContract: container destinations: ${mounts.map((item) => item.Destination).join(", ")}`);
                }
                return failContract(`missing mount ${req.containerPath}`);
            }
            if (req.readonly !== undefined && mount.RW !== !req.readonly) return failContract(`mount access changed for ${req.containerPath}`);
            if (req.type !== undefined && mount.Type !== req.type) return failContract(`mount type changed for ${req.containerPath}`);
            if (req.type === "volume" && !namedVolumeMatches(mount, req.hostPath)) {
                return failContract(`volume source changed for ${req.containerPath}`);
            }
            if (req.verifySource) {
                if (mount.Type !== "bind" || !mount.Source) return failContract(`bind source missing for ${req.containerPath}`);
                try {
                    // The runtime daemon may be reached through a host socket, so
                    // its Source path is not necessarily readable in this process.
                    // The expected source was already resolved and identity-checked
                    // before it entered the contract.
                    if (!requiredBindSourceMatches(
                        mount.Source,
                        req,
                        typeof inspected.Id === "string" ? inspected.Id : undefined,
                    )) {
                        return failContract(`bind source changed for ${req.containerPath}`);
                    }
                } catch {
                    return failContract(`bind source unreadable for ${req.containerPath}`);
                }
            }
        }
        const identityMounts = requiredMounts.filter((mount) => (
            mount.type === "bind" && mount.expectedIdentity
        ));
        if (typeof inspected.Id !== "string"
            || identityMounts.length === 0
            || !identityMounts.every((mount) => (
                mount.expectedIdentity
                && containerSeesCurrentBindSource(
                    inspected.Id as string,
                    mount.hostPath,
                    mount.containerPath,
                    mount.expectedIdentity,
                )
            ))) {
            return failContract("bind mount identities could not be verified");
        }
        const unexpectedMount = unexpectedContainerMount(mounts, requiredMounts);
        if (unexpectedMount) return failContract(`unexpected mount ${unexpectedMount}`);
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
    } catch {
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
    reportUnsafe: (reason: string) => void = () => undefined,
): boolean {
    const unsafe = (reason: string) => {
        reportUnsafe(reason);
        return false;
    };
    const result = spawnSync(
        runtimeCli(),
        ["inspect", "-f", "{{json .}}", containerName],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0) return unsafe("container contract inspection failed");
    try {
        const inspected = JSON.parse((result.stdout ?? "").trim()) as {
            Id?: unknown;
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
        const projectMount = requiredMounts.find((mount) => mount.containerPath.startsWith("/project/"));
        if (!projectMount) return unsafe("project mount contract is unavailable");
        if (!projectMount.expectedIdentity) return unsafe("project mount identity is unavailable");
        try {
            assertBindMountSourceIdentity(
                projectMount.hostPath,
                projectMount.expectedIdentity,
            );
        } catch {
            return unsafe(`bind source identity changed for ${projectMount.containerPath}`);
        }
        const unexpectedMount = unexpectedContainerMount(mounts, requiredMounts);
        if (unexpectedMount) return unsafe(`unexpected mount ${unexpectedMount}`);
        const mountedProject = mounts.find((mount) => mount.Destination === projectMount.containerPath);
        if (!mountedProject) return unsafe(`missing mount ${projectMount.containerPath}`);
        if (mountedProject.Type !== "bind" || !mountedProject.Source) {
            return unsafe(`bind source missing for ${projectMount.containerPath}`);
        }
        let expectedProjectSource: string;
        try {
            expectedProjectSource = canonicalHostPath(projectMount.hostPath);
        } catch {
            return unsafe(`bind source unreadable for ${projectMount.containerPath}`);
        }
        if (!bindSourcePathsEquivalent(mountedProject.Source, expectedProjectSource)) {
            return unsafe(`bind source changed for ${projectMount.containerPath}`);
        }
        const mountedDestinations = new Set(mounts.map((mount) => mount.Destination));
        const identityMounts = requiredMounts.filter((mount) => (
            mount.type === "bind"
            && mount.expectedIdentity
            && mountedDestinations.has(mount.containerPath)
        ));
        if (typeof inspected.Id !== "string"
            || identityMounts.length === 0
            || !identityMounts.every((mount) => (
                mount.expectedIdentity
                && containerSeesCurrentBindSource(
                    inspected.Id as string,
                    mount.hostPath,
                    mount.containerPath,
                    mount.expectedIdentity,
                )
            ))) {
            return unsafe("bind mount identities could not be verified");
        }
        if (projectMount.readonly !== undefined && mountedProject.RW !== !projectMount.readonly) {
            return unsafe(`mount access changed for ${projectMount.containerPath}`);
        }
        for (const required of requiredMounts) {
            if (required === projectMount) continue;
            const mounted = mounts.find((mount) => mount.Destination === required.containerPath);
            if (!mounted) {
                if (required.containerPath === "/var/run/docker.sock") {
                    return unsafe(`missing mount ${required.containerPath}`);
                }
                continue;
            }
            if (required.expectedIdentity) {
                try {
                    assertBindMountSourceIdentity(
                        required.hostPath,
                        required.expectedIdentity,
                    );
                } catch {
                    return unsafe(`bind source identity changed for ${required.containerPath}`);
                }
            }
            if (required.type !== undefined && mounted.Type !== required.type) {
                return unsafe(`mount type changed for ${required.containerPath}`);
            }
            if (required.readonly !== undefined && mounted.RW !== !required.readonly) {
                return unsafe(`mount access changed for ${required.containerPath}`);
            }
            if (required.type === "volume" && !namedVolumeMatches(mounted, required.hostPath)) {
                return unsafe(`volume source changed for ${required.containerPath}`);
            }
            if (required.verifySource) {
                if (mounted.Type !== "bind" || !mounted.Source) {
                    return unsafe(`bind source missing for ${required.containerPath}`);
                }
                try {
                    if (!requiredBindSourceMatches(
                        mounted.Source,
                        required,
                        typeof inspected.Id === "string" ? inspected.Id : undefined,
                    )) {
                        return unsafe(`bind source changed for ${required.containerPath}`);
                    }
                } catch {
                    return unsafe(`bind source unreadable for ${required.containerPath}`);
                }
            }
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
    } catch {
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
    const hostGitConfig = join(homedir(), ".gitconfig");
    if (!existsSync(hostGitConfig)) return;

    const cli = runtimeCli();
    const stagedPath = "/tmp/ccc-host-gitconfig";
    const copied = spawnSync(cli, ["cp", hostGitConfig, `${containerName}:${stagedPath}`], { stdio: "ignore" });
    if (copied.status !== 0) {
        console.error("[ccc] WARNING: failed to copy host .gitconfig into container");
        return;
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
            `cp ${stagedPath} /home/ccc/.gitconfig && git config --file /home/ccc/.gitconfig --add safe.directory '*' && chown ccc:ccc /home/ccc/.gitconfig && rm -f ${stagedPath}`,
        ],
        { stdio: "ignore" },
    );
    if (installed.status !== 0) {
        console.error("[ccc] WARNING: failed to install host .gitconfig inside container");
    }
}

function fixSshPermissions(containerName: string): void {
    const hostSshDir = join(homedir(), ".ssh");
    const cli = runtimeCli();

    spawnSync(
        cli,
        ["exec", containerName, "sh", "-c", "chmod 666 /tmp/ssh-agent.sock 2>/dev/null; true"],
        { stdio: "ignore" },
    );

    if (existsSync(hostSshDir)) {
        spawnSync(
            cli,
            [
                "exec",
                containerName,
                "sh",
                "-c",
                "cp -r /home/ccc/.ssh /tmp/.ssh-copy && " +
                    "chmod 700 /tmp/.ssh-copy && " +
                    "chmod 600 /tmp/.ssh-copy/* 2>/dev/null; " +
                    "chmod 644 /tmp/.ssh-copy/*.pub 2>/dev/null; " +
                    "chmod 644 /tmp/.ssh-copy/known_hosts 2>/dev/null; " +
                    "true",
            ],
            { stdio: "ignore" },
        );
    }
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

function recreateContainer(containerId: string, reason: string, onRecreate?: () => void): void {
    console.log(`Recreating container (${reason})...`);
    const cli = runtimeCli();
    // Do not stop here. The caller confirmed the container was stopped under
    // the lifecycle lock; plain `rm` fails if an external actor starts it in
    // the meantime, closing the destructive TOCTOU window.
    const removed = spawnSync(cli, ["rm", containerId], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (removed.error || removed.status !== 0) {
        throw new Error("Container replacement aborted because the stopped container could not be removed.");
    }
    onRecreate?.();
}

function recreateContainerWithSessionGuard(
    containerName: string,
    reason: string,
    onRecreate: (() => void) | undefined,
    guard: ((recreate: () => void) => boolean) | undefined,
    expectedContainerId?: string,
): boolean {
    if (!guard) {
        throw new Error("Container replacement requires a lifecycle/session guard.");
    }
    const initialIdentity = getContainerIdentity(containerName);
    if (!initialIdentity || initialIdentity.running) return false;
    const pinnedContainerId = expectedContainerId ?? initialIdentity.containerId;
    if (initialIdentity.containerId !== pinnedContainerId) return false;
    let replacementConfirmed = false;
    const guarded = guard(() => {
        recreateContainer(pinnedContainerId, reason, onRecreate);
        replacementConfirmed = true;
    });
    return guarded && replacementConfirmed;
}

// === Container Lifecycle ===

function cleanupDevicesBestEffort(projectPath: string, profile?: string): void {
    try {
        cleanupOwnerDevices(projectPath, 5000, profile);
    } catch (err) {
        console.error(`[ccc] device cleanup failed before container stop: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export function startProjectContainer(
    projectPath: string,
    ensureDirs: () => void,
    extraMounts?: Array<{
        hostPath: string;
        containerPath: string;
        identity?: BindMountSourceIdentity;
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
     * Re-evaluated immediately before replacing a stopped container. Running
     * containers are always preserved; callers additionally protect stopped
     * containers whose lifecycle is still owned by another live CCC session.
     */
    recreateRunningContainer?: (recreate: () => void) => boolean,
    /** Receives the exact running container ID before the lifecycle lock is released. */
    onContainerReady?: (containerId: string) => void,
): string {
    ensureDirs();
    mkdirSync(CLIPBOARD_FILES_DIR, { recursive: true });
    ensureImage();

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
    const hostSshPath = join(homedir(), ".ssh");
    const hostSshDir = existsSync(hostSshPath) ? hostSshPath : null;
    let sshAgentSocket: string | null = null;
    if (process.platform === "darwin") {
        sshAgentSocket = "/run/host-services/ssh-auth.sock";
    } else {
        const hostSock = process.env.SSH_AUTH_SOCK;
        if (hostSock && existsSync(hostSock)) sshAgentSocket = hostSock;
    }

    const debug = !!process.env.DEBUG;

    // Recreate the container if it's missing any required mount destination.
    // Required = credential mounts for every registered tool (claude, gemini,
    // codex, opencode) + any worktree git mounts the caller passed in.
    // Otherwise an old container created before a tool was added to the
    // registry would silently miss that tool's auth dir on subsequent runs.
    const listedContainer = getListedContainerId(containerName);
    let lifecycleContainerId = listedContainer.containerId;
    const markRecreated = () => {
        lifecycleContainerId = null;
        onRecreate?.();
    };
    const finish = (containerId: string): string => {
        assertPreparedProjectMountSources();
        if (onContainerReady) {
            const finalIdentity = getContainerIdentity(containerId);
            if (!finalIdentity?.running || finalIdentity.containerId !== containerId) {
                throw new Error("Container identity changed before session handoff; refusing to join.");
            }
            onContainerReady(containerId);
        }
        return containerName;
    };
    if (!listedContainer.known) {
        throw new Error("Container identity inspection failed; the existing container was preserved.");
    }
    if (listedContainer.containerId) {
        const gitIdentityMounts = getHostGitIdentityMounts();
        const labRunner = buildContainerVmRunConfig(containerName);
        const runtimeInfo = getRuntimeInfo();
        const requiredMounts: RequiredContainerMount[] = [
            {
                hostPath: fullPath,
                containerPath: projectMountPath,
                readonly: false,
                type: "bind",
                verifySource: true,
                expectedIdentity: projectMountSourceIdentity,
            },
            { hostPath: getClaudeJsonFile(profile), containerPath: "/home/ccc/.claude.json", readonly: false, type: "bind", verifySource: true },
            ...getAllCredentialMounts().map((m) => ({
                hostPath: resolveCredentialHostPath(m, profile),
                containerPath: m.containerDir,
                readonly: false,
                type: "bind" as const,
                verifySource: true,
            })),
            ...gitIdentityMounts.map((mount) => ({ ...mount, readonly: true, type: "bind" as const, verifySource: true })),
            ...preparedExtraMounts.map((mount) => ({
                ...mount,
                readonly: false,
                type: "bind" as const,
                verifySource: true,
                expectedIdentity: mount.identity,
            })),
            { hostPath: deviceLabStateHostDir, containerPath: "/home/ccc/.ccc/devices", readonly: true, type: "bind", verifySource: true },
            { hostPath: "tmpfs", containerPath: "/home/ccc/.ccc/devices/owners", readonly: false, type: "tmpfs" },
            { hostPath: currentDeviceLabOwnerRoot, containerPath: `/home/ccc/.ccc/devices/owners/${currentDeviceLabOwnerId}`, readonly: false, type: "bind", verifySource: true },
            { hostPath: "tmpfs", containerPath: "/home/ccc/.ccc/devices/broker/auth", readonly: false, type: "tmpfs" },
            { hostPath: CLIPBOARD_FILES_DIR, containerPath: CLIPBOARD_FILES_CONTAINER_DIR, readonly: false, type: "bind", verifySource: true },
            { hostPath: MISE_VOLUME_NAME, containerPath: "/home/ccc/.local/share/mise", readonly: false, type: "volume" },
            {
                hostPath: resolveHostSocketPath(),
                containerPath: "/var/run/docker.sock",
                readonly: false,
                type: "bind",
                verifySource: true,
                verifySourceCanonical: false,
                equivalentSources: runtimeInfo.runtime === "docker"
                    && runtimeInfo.dockerDesktop
                    ? ["/var/run/docker.sock.raw"]
                    : [],
            },
            ...(hostSshDir
                ? [{ hostPath: hostSshDir, containerPath: "/home/ccc/.ssh", readonly: true, type: "bind" as const, verifySource: true }]
                : []),
            ...(sshAgentSocket
                ? [{ hostPath: sshAgentSocket, containerPath: "/tmp/ssh-agent.sock", readonly: false, type: "bind" as const, verifySource: true }]
                : []),
            ...(clipboardPortFile && existsSync(clipboardPortFile)
                ? [{
                    hostPath: clipboardPortFile,
                    containerPath: "/run/ccc/clipboard.port",
                    readonly: true,
                    type: "bind" as const,
                    verifySource: true,
                }]
                : []),
        ];
        if (currentDeviceLabOwnerAuthFile) {
            requiredMounts.push({
                hostPath: currentDeviceLabOwnerAuthFile,
                containerPath: DEVICE_BROKER_AUTH_CONTAINER_FILE,
                readonly: true,
                type: "bind",
                verifySource: true,
            });
        }
        requiredMounts.push({
            hostPath: labRunner.stateVolumeName,
            containerPath: labRunner.stateContainerDir,
            readonly: false,
            type: "volume",
        });
        assertPreparedProjectMountSources();
        assertPreparedDeviceLabMountSources(preparedDeviceLabSources);
        let contractMismatchReason = "container contract changed";
        const contractMatches = containerMatchesRunContract(
            listedContainer.containerId,
            requiredMounts,
            labRunner,
            preparedDeviceLabSources.contractIdentity,
            fullPath,
            projectMountIdentity,
            (reason) => { contractMismatchReason = reason; },
        );
        assertPreparedProjectMountSources();
        assertPreparedDeviceLabMountSources(preparedDeviceLabSources);
        if (contractMatches === null) {
            throw new Error("Container contract inspection failed; the existing container was preserved.");
        }
        if (!contractMatches) {
            if (debug) {
                console.error(`[ccc:debug] Container ${containerName} missing required mounts or VM run contract:`);
                for (const m of requiredMounts) {
                    console.error(`[ccc:debug]   required destination: ${m.containerPath}`);
                }
            }
            if (recreateRunningContainer) {
                const recreated = recreateContainerWithSessionGuard(
                    containerName,
                    contractMismatchReason,
                    markRecreated,
                    recreateRunningContainer,
                    listedContainer.containerId,
                );
                if (!recreated) {
                    let unsafeDeferReason = "unknown safety mismatch";
                    if (!containerRunContractIsSafeToDefer(
                        listedContainer.containerId,
                        requiredMounts,
                        labRunner,
                        fullPath,
                        projectMountIdentity,
                        (reason) => { unsafeDeferReason = reason; },
                    )) {
                        throw new Error(
                            `Running container contract failed safety validation (${unsafeDeferReason}); `
                            + "preserving the existing running container without joining it.",
                        );
                    }
                    if (!isContainerRunning(containerName)) {
                        throw new Error("Container contract update is required, but automatic replacement was not authorized.");
                    }
                    if (!canExecContainerAfterBriefRetry(listedContainer.containerId)) {
                        throw new Error("Running container is unavailable; automatic destructive recovery was refused.");
                    }
                    console.warn(`[ccc] Container update deferred (${contractMismatchReason}) because the existing container is running. It will be applied after the container stops.`);
                    return finish(listedContainer.containerId);
                }
            } else {
                recreateContainerWithSessionGuard(containerName, contractMismatchReason, onRecreate, undefined);
            }
        } else if (debug) {
            console.error(`[ccc:debug] Container ${containerName} has all required mounts`);
        }
    }

    const namedContainerIsRunning = isContainerRunning(containerName);
    if (lifecycleContainerId && namedContainerIsRunning) {
        const execReady = recreateRunningContainer
            ? canExecContainerAfterBriefRetry(lifecycleContainerId)
            : canExecContainer(lifecycleContainerId);
        if (execReady) {
            if (!preparedDeviceLabMountSourcesMatch(preparedDeviceLabSources)) {
                if (recreateRunningContainer) {
                    const recreated = recreateContainerWithSessionGuard(
                        containerName,
                        "device-lab mount source identity changed",
                        markRecreated,
                        recreateRunningContainer,
                        lifecycleContainerId,
                    );
                    if (!recreated) {
                        throw new Error("Device-lab mount source changed during validation; preserving the existing running container without joining it.");
                    }
                } else {
                    recreateContainerWithSessionGuard(containerName, "device-lab mount source identity changed", onRecreate, undefined);
                }
            } else {
                syncManagedMcpBundles(lifecycleContainerId);
                syncHostGitConfig(lifecycleContainerId);
                if (preparedDeviceLabMountSourcesMatch(preparedDeviceLabSources)) return finish(lifecycleContainerId);
                if (recreateRunningContainer) {
                    const recreated = recreateContainerWithSessionGuard(
                        containerName,
                        "device-lab mount source identity changed",
                        markRecreated,
                        recreateRunningContainer,
                        lifecycleContainerId,
                    );
                    if (!recreated) {
                        throw new Error("Device-lab mount source changed during synchronization; preserving the existing running container without joining it.");
                    }
                } else {
                    recreateContainerWithSessionGuard(containerName, "device-lab mount source identity changed", onRecreate, undefined);
                }
            }
        } else {
            if (recreateRunningContainer) {
                const recreated = recreateContainerWithSessionGuard(
                    containerName,
                    "container exec failed",
                    markRecreated,
                    recreateRunningContainer,
                    lifecycleContainerId,
                );
                if (!recreated) {
                    throw new Error("Running container is unavailable; automatic destructive recovery was refused.");
                }
            } else {
                recreateContainerWithSessionGuard(containerName, "container exec failed", onRecreate, undefined);
            }
        }
    }

    if (lifecycleContainerId) {
        if (debug) console.error(`[ccc:debug] Container ${containerName} exists, restarting`);
        assertPreparedProjectMountSources();
        if (!preparedDeviceLabMountSourcesMatch(preparedDeviceLabSources)) {
            const recreated = recreateContainerWithSessionGuard(
                containerName,
                "device-lab mount source identity changed",
                markRecreated,
                recreateRunningContainer,
                lifecycleContainerId,
            );
            if (!recreated) {
                throw new Error("Device-lab mount source changed; automatic replacement was not authorized.");
            }
        } else {
            const started = spawnSync(cli, ["start", lifecycleContainerId], { stdio: "inherit" });
            if (started.error || started.status !== 0) {
                throw new Error("Stopped container could not be restarted; automatic replacement was refused.");
            }
            const execReady = recreateRunningContainer
                ? canExecContainerAfterBriefRetry(lifecycleContainerId)
                : canExecContainer(lifecycleContainerId);
            if (!execReady) {
                const recreated = recreateContainerWithSessionGuard(
                    containerName,
                    "container exec failed after restart",
                    markRecreated,
                    recreateRunningContainer,
                    lifecycleContainerId,
                );
                if (!recreated) {
                    throw new Error("Restarted container is unavailable; automatic replacement was refused.");
                }
            } else {
                syncManagedMcpBundles(lifecycleContainerId);
                syncHostGitConfig(lifecycleContainerId);
                fixSshPermissions(lifecycleContainerId);
                if (preparedDeviceLabMountSourcesMatch(preparedDeviceLabSources)) return finish(lifecycleContainerId);
                const recreated = recreateContainerWithSessionGuard(
                    containerName,
                    "device-lab mount source identity changed",
                    markRecreated,
                    recreateRunningContainer,
                    lifecycleContainerId,
                );
                if (!recreated) {
                    throw new Error("Device-lab mount source changed during restart; automatic replacement was refused.");
                }
            }
        }
    }

    if (lifecycleContainerId || isContainerExists(containerName)) {
        console.error(`Failed to remove unhealthy container ${containerName}`);
        process.exit(1);
    }

    if (debug) {
        console.error(`[ccc:debug] Container ${containerName} not found, creating`);
    }
    console.log("Creating container...");

    const credentialMounts = getAllCredentialMounts().map(m => {
        const hostPath = resolveCredentialHostPath(m, profile);
        mkdirSync(hostPath, { recursive: true });
        return { hostPath, containerPath: m.containerDir };
    });
    const gitIdentityMounts = getHostGitIdentityMounts();

    const labRunner = buildContainerVmRunConfig(containerName);
    if (isLabRunnerProfile(profile) && labRunner.status === "unsupported") {
        console.warn(`[ccc] lab-runner profile requested but nested VM support is unavailable: ${labRunner.unsupportedReason}`);
        console.warn("[ccc] lab state volume will still be mounted; device-lab should report linux-vm as unsupported/SKIP.");
    }

    const args = buildDockerRunArgs({
        containerName,
        fullPath,
        projectMountPath,
        credentialMounts,
        gitIdentityMounts,
        claudeJsonFile: getClaudeJsonFile(profile),
        miseVolumeName: MISE_VOLUME_NAME,
        pidsLimit: CONTAINER_PID_LIMIT,
        imageName: IMAGE_NAME,
        hostSshDir,
        sshAgentSocket,
        extraMounts: preparedExtraMounts,
        projectMountIdentity,
        clipboardPortFile,
        clipboardFilesHostDir: CLIPBOARD_FILES_DIR,
        labRunner,
        deviceLabStateHostDir,
        deviceLabOwnerId: currentDeviceLabOwnerId,
        deviceLabOwnerAuthFile: currentDeviceLabOwnerAuthFile,
        deviceLabMountIdentity: preparedDeviceLabSources.contractIdentity,
        // CCC_DISABLE_PROXY is the escape hatch when the runtime-detect
        // heuristics get it wrong (exotic VPN/networking setups, mirrored
        // mode we failed to recognize, etc).
        proxyEnabled: (process.platform !== "linux" || isContainerHostRemote()) && process.env.CCC_DISABLE_PROXY !== "1",
    });

    assertPreparedProjectMountSources();
    assertPreparedDeviceLabMountSources(preparedDeviceLabSources);
    const result = spawnSync(cli, args, {
        encoding: "utf-8",
        stdio: ["inherit", "pipe", "inherit"],
    });
    if (result.status !== 0) {
        console.error("Failed to create container");
        process.exit(1);
    }
    const createdContainerId = (result.stdout ?? "").trim().split(/\s+/).find((line) => /^[a-f0-9]{12,64}$/i.test(line)) ?? null;

    try {
        assertPreparedProjectMountSources();
        assertPreparedDeviceLabMountSources(preparedDeviceLabSources);
        if (!createdContainerId || !createdContainerBindMountsMatch(
            createdContainerId,
            [
                {
                    hostPath: fullPath,
                    containerPath: projectMountPath,
                    identity: projectMountSourceIdentity,
                },
                ...preparedExtraMounts,
            ],
            projectMountIdentity,
        )) {
            throw new Error("created container bind mount identity verification failed");
        }
    } catch (error) {
        if (createdContainerId) {
            spawnSync(
                cli,
                ["rm", "-f", createdContainerId],
                { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            );
            const remaining = spawnSync(
                cli,
                ["inspect", "-f", "{{.Id}}", createdContainerId],
                { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            );
            if (!containerInspectExplicitlyNotFound(remaining)) {
                throw new Error(
                    `${(error as Error).message}; failed to remove rejected container ${createdContainerId}`,
                    { cause: error },
                );
            }
        }
        throw error;
    }

    if (!createdContainerId) {
        throw new Error("Container runtime did not return the created container ID; refusing an unpinned session.");
    }
    syncManagedMcpBundles(createdContainerId);
    syncHostGitConfig(createdContainerId);
    fixSshPermissions(createdContainerId);

    return finish(createdContainerId);
}

type DestructiveContainerOptions = { force?: boolean };

function stopProjectContainerUnlocked(projectPath: string, profile?: string): void {
    ensureDockerRunning();
    const fullPath = resolve(projectPath);
    const containerName = getContainerName(fullPath, profile);

    const identity = getManagedProjectContainerIdentity(containerName, fullPath);
    if (!identity) {
        console.log("Container not found");
        return;
    }

    cleanupDevicesBestEffort(fullPath, profile);
    if (identity.running) {
        console.log("Stopping container...");
        const stopped = spawnSync(runtimeCli(), ["stop", identity.containerId], { stdio: "inherit" });
        if (stopped.error || stopped.status !== 0) throw new Error("Failed to stop container.");
    }
    console.log("Container stopped");
}

function withDestructiveContainerGuard<T>(
    projectPath: string,
    profile: string | undefined,
    options: DestructiveContainerOptions,
    operation: () => T,
): T {
    const projectId = getProjectId(resolve(projectPath));
    const containerPrefix = profile ? `${projectId}--p--${profile}` : projectId;
    return withContainerLifecycleLock(containerPrefix, () => {
        const sessionClaims = getSessionLockClaimsForContainer(containerPrefix);
        if (sessionClaims.length > 0 && options.force !== true) {
            throw new Error(`Container has ${sessionClaims.length} session ownership claim(s); use --force to continue.`);
        }
        return operation();
    });
}

export function stopProjectContainer(projectPath: string, profile?: string, options: DestructiveContainerOptions = {}): void {
    withDestructiveContainerGuard(projectPath, profile, options, () => stopProjectContainerUnlocked(projectPath, profile));
}

export function removeProjectContainer(projectPath: string, profile?: string, options: DestructiveContainerOptions = {}): void {
    withDestructiveContainerGuard(projectPath, profile, options, () => {
        ensureDockerRunning();
        const containerName = getContainerName(resolve(projectPath), profile);

        const identity = getManagedProjectContainerIdentity(containerName, resolve(projectPath));
        if (!identity) {
            console.log("Container not found");
            return;
        }

        cleanupDevicesBestEffort(resolve(projectPath), profile);
        if (identity.running) {
            console.log("Stopping container...");
            const stopped = spawnSync(runtimeCli(), ["stop", identity.containerId], { stdio: "inherit" });
            if (stopped.error || stopped.status !== 0) throw new Error("Failed to stop container.");
            console.log("Container stopped");
        }
        console.log("Removing container...");
        const removed = spawnSync(runtimeCli(), ["rm", identity.containerId], { stdio: "inherit" });
        if (removed.error || removed.status !== 0) throw new Error("Failed to remove container.");
        console.log("Container removed");
    });
}
