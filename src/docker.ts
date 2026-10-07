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
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, normalize, posix, resolve } from "path";
import { fileURLToPath } from "url";
import { createContainerSessionHandoff } from "./application/container-session-handoff.js";
import { createContainerRuntimeReadiness } from "./application/container-runtime-readiness.js";
import { createContainerExecReadiness } from "./application/container-exec-readiness.js";
import { createContainerSocketAccess } from "./application/container-socket-access.js";
import { createCodexConfigPreparation } from "./application/codex-config-preparation.js";
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
    bindMountArgs,
    runtimeExtraRunArgs,
    isContainerHostRemote,
    getRuntimeInfo,
} from "./container-runtime.js";
import { ensureIdentityImage, getIdentityLabels, getIdentityMiseVolumeName, getIdentityCodexPackagesVolumeName, normalizeImageId, resolveContainerIdentity, type ContainerIdentity as ContainerUserIdentity } from "./container-identity.js";
import { withSharedMutationLock } from "@ccc/device-lab/device-lab-shared-state.js";
import { codexConfigFileAclScript, codexConfigDirectoryAclScript } from "./codex-config-acl.js";
import { proveWslBindSourceIdentity } from "./wsl-bind-source-proof.js";
import { prepareLabStateOwnership } from "./lab-state-ownership.js";
import { prepareCodexStateOwnership } from "./codex-state-ownership.js";
import { SSH_KNOWN_HOSTS_PROVENANCE_SCRIPT } from "./ssh-known-hosts.js";
import { cleanupOwnerDevices } from "./device-lab-admin.js";
import { deviceLabContainerName, deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { getAllCredentialMounts } from "./tool-registry.js";
import type { CredentialMount } from "./tool-registry.js";
import {
    getSessionLockClaimsForContainer,
    withContainerLifecycleLock,
    withProjectFamilyLifecycleLock,
} from "./session.js";
import {
    validateObservedMountSet,
    verifyMountSet,
    type LiveSourceProof,
    type MountEvidence,
    type MountPresencePolicy,
    type MountVerification,
    type RequiredMountContract,
} from "./bind-mount-verification.js";

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

type DirectoryMountChallenge = {
    markerName: string;
    markerPath: string;
    markerContent: string;
};

type MountVerificationSession = {
    directoryChallenges: Map<string, DirectoryMountChallenge>;
    containerExecReady?: boolean;
};

function createMountVerificationSession(): MountVerificationSession {
    return { directoryChallenges: new Map() };
}

function cleanupMountVerificationSession(session: MountVerificationSession): void {
    let cleanupError: unknown;
    for (const challenge of session.directoryChallenges.values()) {
        try {
            rmSync(challenge.markerPath, { force: true });
        } catch (error) {
            cleanupError ??= error;
        }
    }
    session.directoryChallenges.clear();
    if (cleanupError) throw cleanupError;
}

function getDirectoryMountChallenge(
    session: MountVerificationSession,
    expected: BindMountSourceIdentity,
    containerPath: string,
): DirectoryMountChallenge {
    const existing = session.directoryChallenges.get(containerPath);
    if (existing) return existing;
    const markerName = `.ccc-mount-identity-${randomBytes(16).toString("hex")}`;
    const challenge = {
        markerName,
        markerPath: join(expected.realpath, markerName),
        markerContent: randomBytes(32).toString("hex"),
    };
    writeFileSync(challenge.markerPath, challenge.markerContent, { flag: "wx", mode: 0o600 });
    session.directoryChallenges.set(containerPath, challenge);
    return challenge;
}

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
    presence: "core" | "additive" | "optional";
    sourceProof?:
        | {
            kind: "filesystem";
            identity: BindMountSourceIdentity;
        }
        | {
            kind: "path";
            canonical: boolean;
            equivalentSources?: string[];
        }
        | {
            kind: "daemon";
            equivalentSources?: string[];
        };
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

function observeBindMountSourceIdentity(
    path: string,
    expected: BindMountSourceIdentity,
): LiveSourceProof {
    let actual: BindMountSourceIdentity;
    try {
        actual = captureBindMountSourceIdentity(path);
    } catch {
        return { kind: "retryable", reason: `bind source identity is temporarily unavailable: ${path}` };
    }
    return bindMountSourceIdentityMatches(expected, actual)
        ? { kind: "verified", via: "identity" }
        : { kind: "mismatch", reason: `bind source identity changed: ${path}` };
}

function combineLiveSourceProof(
    current: LiveSourceProof,
    candidate: LiveSourceProof,
): LiveSourceProof {
    const priority: Record<LiveSourceProof["kind"], number> = {
        verified: 0,
        retryable: 1,
        mismatch: 2,
    };
    return priority[candidate.kind] > priority[current.kind] ? candidate : current;
}

export function readDirectoryMountMarker(containerId: string, markerPath: string) {
    const options = { encoding: "utf-8" as const, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
    const result = spawnSync(runtimeCli(), ["exec", containerId, "cat", markerPath], options);
    // Only this generated, non-secret challenge may need traversal through a
    // host-owned 0700 SSH directory. Never read keys as part of mount proof.
    if ((result.error || result.status !== 0)
        && /^\/home\/ccc\/\.ssh\/\.ccc-mount-identity-[a-f0-9]{32}$/.test(markerPath)) {
        return spawnSync(runtimeCli(), ["exec", "--user", "root", containerId, "cat", markerPath], options);
    }
    return result;
}

function proveContainerSeesCurrentBindSource(
    containerId: string,
    hostPath: string,
    containerPath: string,
    expected: BindMountSourceIdentity,
    session: MountVerificationSession,
    finalProofAttempt = false,
): LiveSourceProof {
    let verification: LiveSourceProof = {
        kind: "retryable",
        reason: `bind source proof unavailable for ${containerPath}`,
    };
    try {
        const initialIdentity = observeBindMountSourceIdentity(hostPath, expected);
        if (initialIdentity.kind !== "verified") return initialIdentity;
        const observed = lstatSync(expected.realpath);
        if (observed.isSymbolicLink()) {
            return { kind: "mismatch", reason: `bind source identity changed for ${containerPath}` };
        }
        if (typeof observed.isDirectory === "function" && observed.isDirectory()) {
            const challenge = getDirectoryMountChallenge(session, expected, containerPath);
            const markerIdentity = observeBindMountSourceIdentity(hostPath, expected);
            if (markerIdentity.kind !== "verified") return markerIdentity;
            const result = readDirectoryMountMarker(containerId, posix.join(containerPath, challenge.markerName));
            let containerExecReady = false;
            if (result.error || result.status !== 0) {
                session.containerExecReady ??= canExecContainer(containerId, 200);
                containerExecReady = session.containerExecReady;
            }
            if (result.error) {
                verification = { kind: "retryable", reason: `container exec unavailable for ${containerPath}` };
            } else if (result.status !== 0) {
                verification = containerExecReady && finalProofAttempt
                    ? { kind: "mismatch", reason: `bind marker is not visible for ${containerPath}` }
                    : { kind: "retryable", reason: `container exec unavailable for ${containerPath}` };
            } else if ((result.stdout ?? "") !== challenge.markerContent) {
                verification = { kind: "mismatch", reason: `bind marker content changed for ${containerPath}` };
            } else {
                verification = { kind: "verified", via: "identity" };
            }
        } else if (typeof observed.isFile === "function" && observed.isFile()) {
            if (observed.size > 1024 * 1024) {
                return { kind: "mismatch", reason: `bind source file is too large to verify for ${containerPath}` };
            }
            const expectedContent = readFileSync(expected.realpath);
            const fileIdentity = observeBindMountSourceIdentity(hostPath, expected);
            if (fileIdentity.kind !== "verified") return fileIdentity;
            let result = spawnSync(
                runtimeCli(),
                ["exec", containerId, "cat", containerPath],
                {
                    encoding: null,
                    stdio: ["pipe", "pipe", "pipe"],
                    maxBuffer: 1024 * 1024 + 1,
                },
            );
            let containerExecReady = false;
            if (result.error || result.status !== 0) {
                session.containerExecReady ??= canExecContainer(containerId, 200);
                containerExecReady = session.containerExecReady;
            }
            if (result.error) {
                verification = { kind: "retryable", reason: `container exec unavailable for ${containerPath}` };
            } else if (result.status !== 0) {
                verification = containerExecReady && finalProofAttempt
                    ? { kind: "mismatch", reason: `bind file is not readable for ${containerPath}` }
                    : { kind: "retryable", reason: `container exec unavailable for ${containerPath}` };
            } else {
                const currentContent = readFileSync(expected.realpath);
                if (!currentContent.equals(expectedContent)) {
                    verification = { kind: "retryable", reason: `bind source file changed during proof for ${containerPath}` };
                } else if (!Buffer.isBuffer(result.stdout) || !result.stdout.equals(expectedContent)) {
                    verification = { kind: "mismatch", reason: `bind file content changed for ${containerPath}` };
                } else {
                    verification = { kind: "verified", via: "identity" };
                }
            }
        } else {
            verification = { kind: "mismatch", reason: `bind source type changed for ${containerPath}` };
        }
    } catch {
        verification = {
            kind: "retryable",
            reason: `bind source proof failed for ${containerPath}`,
        };
    } finally {
        const finalIdentity = observeBindMountSourceIdentity(hostPath, expected);
        verification = combineLiveSourceProof(verification, finalIdentity.kind === "verified"
            ? finalIdentity
            : {
                ...finalIdentity,
                reason: finalIdentity.kind === "mismatch"
                    ? `bind source identity changed for ${containerPath}`
                    : `bind source identity is temporarily unavailable for ${containerPath}`,
            });
    }
    return verification;
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

type NativeMacDockerDesktopBindSource =
    | { kind: "not-alias" }
    | { kind: "candidate"; hostPath: string }
    | { kind: "mismatch" };

function pathHasTraversalSegments(path: string): boolean {
    return path.replace(/\\/g, "/").split("/")
        .some((segment) => segment === "." || segment === "..");
}

function nativeMacDockerDesktopBindSource(path: string): NativeMacDockerDesktopBindSource {
    if (process.platform !== "darwin") return { kind: "not-alias" };
    const prefixes = ["/host_mnt", "/run/desktop/mnt/host"];
    const prefix = prefixes.find((candidate) => path.startsWith(`${candidate}/`));
    if (!prefix) return { kind: "not-alias" };
    const runtime = getRuntimeInfo();
    if (runtime.runtime !== "docker"
        || !runtime.dockerDesktop) {
        return { kind: "mismatch" };
    }
    const hostPath = path.slice(prefix.length);
    if (!hostPath.startsWith("/")
        || hostPath.startsWith("//")
        || pathHasTraversalSegments(hostPath)) {
        return { kind: "mismatch" };
    }
    return { kind: "candidate", hostPath };
}

type FilesystemAliasVerification = "match" | "mismatch" | "retryable";

function bindSourceIsTrustedFilesystemAlias(
    observedSource: string,
    hostPath: string,
    expected: BindMountSourceIdentity,
): FilesystemAliasVerification {
    if (pathHasTraversalSegments(observedSource)) return "mismatch";
    const nativeMacSource = nativeMacDockerDesktopBindSource(observedSource);
    if (nativeMacSource.kind === "mismatch") return "mismatch";
    const candidates = nativeMacSource.kind === "candidate"
        ? [nativeMacSource.hostPath]
        : [observedSource];
    if (candidates.some((candidate) => (
        bindSourcePathsEquivalent(candidate, hostPath)
        || bindSourcePathsEquivalent(candidate, expected.realpath)
    ))) {
        return "match";
    }
    let canonicalizationUnavailable = false;
    for (const candidate of candidates) {
        try {
            if (bindSourcePathsEquivalent(canonicalHostPath(candidate), expected.realpath)) {
                return "match";
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            canonicalizationUnavailable ||= code !== "ENOENT" && code !== "ENOTDIR";
        }
    }
    // Docker Desktop may retain an opaque WSL daemon path for an older bind.
    // Resolve it by object identity, never by guessing a host path translation.
    if (/^\/run\/desktop\/mnt\/host\/wsl\/docker-desktop-bind-mounts\//.test(observedSource)) {
        const before = observeBindMountSourceIdentity(hostPath, expected);
        if (before.kind !== "verified") return before.kind === "retryable" ? "retryable" : "mismatch";
        const image = getCurrentImageId();
        const proof = image ? proveWslBindSourceIdentity(observedSource, expected, image) : null;
        const after = observeBindMountSourceIdentity(hostPath, expected);
        if (after.kind !== "verified") return after.kind === "retryable" ? "retryable" : "mismatch";
        return proof === true ? "match" : proof === false ? "mismatch" : "retryable";
    }
    return canonicalizationUnavailable ? "retryable" : "mismatch";
}

function dockerDaemonIdentity(result: ReturnType<typeof spawnSync>): string | null {
    if (result.error || result.status !== 0) return null;
    const identity = (result.stdout ?? "").toString().trim();
    return /^[^\s]{1,512}$/.test(identity) ? identity : null;
}

function containerManagerSocketTargetsCurrentDockerDaemon(containerId: string): LiveSourceProof {
    if (getRuntimeInfo().runtime !== "docker") {
        return { kind: "mismatch", reason: "container manager socket runtime changed" };
    }
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
    if (!hostIdentity) {
        return { kind: "retryable", reason: "host container-manager daemon identity is unavailable" };
    }
    const mountedIdentity = dockerDaemonIdentity(spawnSync(
        runtimeCli(),
        [
            "exec",
            "--user",
            "root",
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
    if (!mountedIdentity) {
        return { kind: "retryable", reason: "mounted container-manager daemon identity is unavailable" };
    }
    return mountedIdentity === hostIdentity
        ? { kind: "verified", via: "daemon" }
        : { kind: "mismatch", reason: "container manager socket targets a different daemon" };
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

// Docker Compose-compatible labels for Docker Desktop grouping.
// com.docker.compose.* labels are undocumented internals but stable since Compose V2.
// Podman accepts arbitrary labels as opaque strings.
function getComposeLabels(
    containerName: string,
    fullPath: string,
    projectMountIdentity?: string,
    profile?: string,
): string[] {
    const labels = [
        "--label", "com.docker.compose.project=ccc",
        "--label", `com.docker.compose.service=${containerName}`,
        "--label", "com.docker.compose.oneoff=False",
        "--label", "com.docker.compose.version=2",
        "--label", "com.docker.compose.container-number=1",
        "--label", "ccc.managed=true",
        "--label", `ccc.project.path=${fullPath}`,
        "--label", `ccc.profile=${profile ?? ""}`,
        "--label", `ccc.cli.version=${CLI_VERSION}`,
    ];
    if (projectMountIdentity) {
        labels.push("--label", `${PROJECT_MOUNT_IDENTITY_LABEL}=${projectMountIdentity}`);
    }
    return labels;
}

export const CONTAINER_INIT_UNAVAILABLE_HINT = "[ccc] If the error above mentions docker-init, tini or catatonit, "
    + "the container runtime has no init binary for --init: install docker-init/tini (Docker) or catatonit (Podman).";

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
        // Run the runtime's init (docker-init/tini, catatonit) as PID 1 so orphaned
        // children are reaped instead of piling up as zombies under `tail`.
        "--init",
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
    args.push(...bindMountArgs(opts.codexPackagesVolumeName ?? CODEX_PACKAGES_VOLUME_NAME, CODEX_PACKAGES_CONTAINER_DIR));
    if (opts.labRunner) {
        // Lab state only matters where container-QEMU labs can run (REQ__lab-state-volume.md).
        if (opts.labRunner.status === "ready") {
            args.push(...bindMountArgs(opts.labRunner.stateVolumeName, opts.labRunner.stateContainerDir));
        }
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
    // Fixed at creation, unlike per-session env: the device-lab MCP uses it to know the container's
    // loopback is shared through a VM even when CCC_DISABLE_PROXY turned the proxy off
    // (doc/device-lab/REQ__container-broker-discovery.md).
    if (opts.containerHostRemote) {
        args.push("-e", "CCC_CONTAINER_HOST_REMOTE=1");
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
        opts.profile,
    ));
    if (opts.identity) {
        for (const [key, value] of Object.entries(getIdentityLabels(opts.identity))) {
            args.push("--label", `${key}=${value}`);
        }
    }
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
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
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

export function resolveCredentialHostPath(mount: CredentialMount, profile?: string): string {
    if (!profile && process.env.container === "docker" && !process.env.VITEST) {
        return mount.containerDir;
    }
    if (mount.containerDir === "/home/ccc/.claude") return getClaudeDir(profile);
    if (mount.containerDir === "/home/ccc/.codex") return getCodexDir(profile);
    return join(homedir(), mount.hostDir);
}

/**
 * Create a credential mount's host directory. For the codex mount, also create
 * the mount point of the nested packages volume, so Docker does not create it
 * on the host as root.
 */
export function ensureCredentialHostDir(mount: CredentialMount, profile?: string): string {
    const hostPath = resolveCredentialHostPath(mount, profile);
    // ccc's own profile credential folders are private; other tools' folders keep their defaults.
    const cccOwned = mount.containerDir === "/home/ccc/.claude" || mount.containerDir === "/home/ccc/.codex";
    mkdirSync(hostPath, cccOwned ? { recursive: true, mode: 0o700 } : { recursive: true });
    if (posix.dirname(CODEX_PACKAGES_CONTAINER_DIR) === mount.containerDir) {
        mkdirSync(join(hostPath, posix.basename(CODEX_PACKAGES_CONTAINER_DIR)), { recursive: true, mode: 0o700 });
    }
    return hostPath;
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
    const configFile = getCodexConfigFile(profile);
    const accessMode = fsConstants.R_OK | fsConstants.W_OK;
    const warn = (reason: unknown): void => {
        console.warn(`[ccc] Unable to restore host access to ${configFile}: ${reason instanceof Error ? reason.message : String(reason)}`);
    };
    try {
        accessSync(configFile, accessMode);
        return;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if (code !== "EACCES" && code !== "EPERM") {
            warn(error);
            return;
        }
    }

    // Repair only an inaccessible file, never the credential tree. The parent
    // must represent the invoking host user before it can identify the ACL user.
    // Raw host IDs cannot be used inside rootless Podman's user namespace.
    try {
        if (typeof process.getuid !== "function") {
            throw new Error("host user identity is unavailable; automatic access repair skipped");
        }
        const parent = lstatSync(dirname(configFile));
        const config = lstatSync(configFile);
        if (!parent.isDirectory() || parent.uid !== process.getuid() || !config.isFile()) {
            throw new Error("automatic repair requires a regular config file in a non-symlink directory owned by the host user");
        }
        const repaired = spawnSync(runtimeCli(), [
            "exec", "--user", "root", containerName, "sh", "-c",
            codexConfigMutation(codexConfigFileAclScript(getCodexContainerUid(containerName))),
        ], { encoding: "utf-8", timeout: CODEX_CONFIG_PREPARE_TIMEOUT_MS });
        if (repaired.error || repaired.status !== 0) {
            throw new Error(`container ACL repair failed (${repaired.error?.message ?? (repaired.stderr?.trim() || `exit ${repaired.status ?? "unknown"}`)})`);
        }
        accessSync(configFile, accessMode);
    } catch (error) {
        // MCP generation still reports an actionable error if access is denied.
        // A post-exit repair failure must not prevent session/env-file cleanup.
        warn(error);
    }
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
    probe: target => spawnSync(runtimeCli(), ["exec", target, "sh", "-c", CONTAINER_MANAGER_SOCKET_PROBE], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: SOCKET_ACCESS_TIMEOUT_MS,
    }),
    grant: (target, user, gid) => spawnSync(runtimeCli(), [
        "exec", "--user", "root", target,
        "timeout", "-k", "2s", "8s", "sh", "-c", CONTAINER_MANAGER_SOCKET_GRANT, "ccc-socket-grant", user, gid,
    ], { stdio: "ignore", timeout: SOCKET_ACCESS_TIMEOUT_MS }),
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
    const configFile = getCodexConfigFile(profile);
    const directoryGuard = 'dir=/home/ccc/.codex; [ ! -L "$dir" ] && [ -d "$dir" ]';
    const directoryProbe = `${directoryGuard} && [ -r "$dir" ] && [ -w "$dir" ] && [ -x "$dir" ]`;
    const configGuard = `${directoryGuard} && file="$dir/config.toml" && [ ! -L "$file" ]`;
    const configProbe = `${configGuard} && { [ ! -e "$file" ] || { [ -f "$file" ] && [ -r "$file" ] && [ -w "$file" ]; }; }`;
    const run = (operation: string, script: string, root = false, probe = false, timeout = CODEX_CONFIG_PREPARE_TIMEOUT_MS) => {
        const result = spawnSync(runtimeCli(), [
            "exec", ...(root ? ["--user", "root"] : []), containerName, "sh", "-c", codexConfigMutation(script),
        ], { encoding: "utf-8", timeout });
        if (result.error || (result.status !== 0 && !(probe && result.status === 1))) {
            throw new Error(`Unable to prepare Codex credentials at ${dirname(configFile)}: ${operation} failed (${result.error?.message ?? (result.stderr?.trim() || `exit ${result.status ?? "unknown"}`)})`);
        }
        return result;
    };
    const validateHostDirectory = (): void => {
        if (typeof process.getuid !== "function") {
            throw new Error("Unable to prepare Codex credentials: host user identity is unavailable");
        }
        const parent = lstatSync(dirname(configFile));
        if (!parent.isDirectory() || parent.uid !== process.getuid()) {
            throw new Error("Unable to prepare Codex credentials: automatic repair requires a non-symlink directory owned by the host user");
        }
    };
    const validateHostConfig = (allowAbsent = false): void => {
        try {
            const metadata = lstatSync(configFile);
            if (!metadata.isFile() || metadata.nlink !== 1) {
                throw new Error("Unable to prepare Codex credentials: automatic repair requires a regular non-symlink, single-link config file");
            }
        } catch (error) {
            if (allowAbsent && (error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
    };
    let containerUid: string | undefined;
    const getContainerUid = (): string => {
        if (containerUid === undefined) {
            containerUid = getCodexContainerUid(containerName);
        }
        return containerUid;
    };

    // Parent access must be established before a file-only probe can report absence.
    // Both resources use the existing semantic probe/repair/finalize policy.
    const prepareAccess = (probeScript: string, repairScript: () => string, allowAbsent: boolean,
        probeOperation: string, repairOperation: string, verifyOperation: string): void => {
        createCodexConfigPreparation({
            probe: () => run(probeOperation, probeScript, false, true),
            repair: () => {
                validateHostDirectory();
                validateHostConfig(allowAbsent);
                return run(repairOperation, repairScript(), true);
            },
            finalize: () => run(verifyOperation, probeScript),
        }).run(containerName);
    };
    prepareAccess(directoryProbe, () => codexConfigDirectoryAclScript(getContainerUid()), true,
        "directory access check", "directory ACL grant", "directory access verification");
    prepareAccess(configProbe, () => codexConfigFileAclScript(getContainerUid()), false,
        "config access check", "config ACL grant", "config access verification");
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
    createContainerRuntimeReadiness({
        isRunning: () => isDockerRunning(),
        runtimeInfo: () => getRuntimeInfo(),
        reportError: message => {
            console.error(message());
            return undefined;
        },
        exitFailure: () => {
            process.exit(1);
            return undefined;
        },
    }).run();
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

const CONTAINER_EXEC_TIMEOUT_MS = 5000;

export function canExecContainer(containerName: string, timeoutMs = CONTAINER_EXEC_TIMEOUT_MS): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["exec", containerName, "true"],
        { stdio: ["ignore", "ignore", "ignore"], timeout: Math.max(1, timeoutMs) },
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
    const bridgeSource = join(distDir, "..", "scripts", "ccc-x11-bridge");
    const bridgeStage = `/usr/local/bin/ccc-x11-bridge.${randomBytes(8).toString("hex")}.new`;
    let bridgeCopied = false;
    if (existsSync(bridgeSource)) {
        // Rename after normalization so a running bash never reads a partially
        // replaced script. The next normal bridge invocation checks generation
        // and safely replaces its previous daemon with the current session URL.
        const result = spawnSync(cli, ["cp", bridgeSource, `${containerName}:${bridgeStage}`]);
        bridgeCopied = !result.error && result.status === 0;
        if (bridgeCopied) copied.push(bridgeStage);
    }
    if (copied.length > 0) {
        try {
            const normalized = spawnSync(cli, ["exec", "-u", "root", containerName, "sed", "-i", "s/\r$//", ...copied]);
            if (normalized.error || normalized.status !== 0) return;
            const executable = spawnSync(cli, ["exec", "-u", "root", containerName, "chmod", "+x", ...copied]);
            if (executable.error || executable.status !== 0) return;
            if (bridgeCopied) {
                // Installation needs root for /usr/local/bin and /run, but the
                // bridge itself remains the normal unprivileged ccc process.
                const stateDirectory = spawnSync(cli, [
                    "exec", "-u", "root", containerName,
                    "install", "-d", "-m", "700", "-o", "ccc", "-g", "ccc", "/run/ccc-x11-bridge",
                ]);
                if (stateDirectory.error || stateDirectory.status !== 0) return;
                spawnSync(cli, ["exec", "-u", "root", containerName, "mv", "-f", bridgeStage, "/usr/local/bin/ccc-x11-bridge"]);
            }
        } finally {
            if (bridgeCopied) spawnSync(cli, ["exec", "-u", "root", containerName, "rm", "-f", bridgeStage]);
        }
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

type InspectedContainerMount = {
    Source: string;
    Destination: string;
    RW?: boolean;
    Type?: string;
    Name?: unknown;
};

/** Docker and Podman keep --tmpfs mounts in HostConfig.Tmpfs instead of Mounts. */
function normalizeInspectedTmpfsMounts(inspected: Record<string, unknown>): boolean {
    const hostConfig = inspected.HostConfig;
    if (!hostConfig || typeof hostConfig !== "object" || Array.isArray(hostConfig)) return true;
    const tmpfs = (hostConfig as Record<string, unknown>).Tmpfs;
    if (tmpfs === undefined || tmpfs === null) return true;
    if (typeof tmpfs !== "object" || Array.isArray(tmpfs)) return false;
    if (!Array.isArray(inspected.Mounts)) return false;
    const mounts = [...inspected.Mounts];
    for (const [destination, options] of Object.entries(tmpfs)) {
        if (!destination.startsWith("/") || posix.normalize(destination) !== destination
            || typeof options !== "string") return false;
        const tokens = options === "" ? [] : options.split(",");
        // Podman 4.9.3 adds private propagation and tmpfs copy-up defaults.
        // Accept only those exact spellings, preserving the other refusal gates.
        if (tokens.some((token) => !/^(?:rw|ro|exec|noexec|suid|nosuid|dev|nodev|sync|async|dirsync|atime|noatime|diratime|nodiratime|relatime|strictatime|lazytime|nolazytime|rprivate|tmpcopyup|(?:size|nr_inodes|nr_blocks)=[0-9]+[kKmMgG%]?|mode=[0-7]{3,4}|(?:uid|gid)=[0-9]+)$/.test(token))) return false;
        const access = tokens.filter((token) => token === "rw" || token === "ro");
        if (access.length > 1) return false;
        // Docker/kernel tmpfs defaults to writable when neither ro nor rw is given.
        const writable = access[0] !== "ro";
        const existing = mounts.filter((mount) => mount && typeof mount === "object"
            && mount.Destination === destination);
        if (existing.length > 0) {
            // A second representation cannot hide a conflicting mount or access mode.
            if (existing.length !== 1 || existing[0].Type !== "tmpfs"
                || existing[0].RW !== writable) return false;
        } else {
            mounts.push({ Source: "", Destination: destination, Type: "tmpfs", RW: writable });
        }
    }
    inspected.Mounts = mounts;
    return true;
}

function inspectContainerJsonOnce(containerId: string): Record<string, unknown> | null {
    const result = spawnSync(
        runtimeCli(),
        ["inspect", "-f", "{{json .}}", containerId],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.error || result.status !== 0) return null;
    try {
        const inspected = JSON.parse((result.stdout ?? "").trim()) as unknown;
        if (!inspected || typeof inspected !== "object" || Array.isArray(inspected)) return null;
        const record = inspected as Record<string, unknown>;
        return normalizeInspectedTmpfsMounts(record) ? record : null;
    } catch {
        return null;
    }
}

function inspectContainerJsonWithRetry(containerId: string): Record<string, unknown> | null {
    return withBoundedVerificationRetry(
        () => inspectContainerJsonOnce(containerId),
        (result) => result === null,
    );
}

function namedVolumeMatches(
    mount: InspectedContainerMount,
    expectedName: string,
): boolean {
    if (Object.hasOwn(mount, "Name")) {
        return typeof mount.Name === "string" && mount.Name === expectedName;
    }
    return mount.Source === expectedName;
}

function mountContract(required: RequiredContainerMount): RequiredMountContract {
    return {
        containerPath: required.containerPath,
        readonly: required.readonly,
        type: required.type,
        presence: required.presence,
        sourceKind: required.type === "volume"
            ? "volume"
            : required.sourceProof?.kind ?? "none",
    };
}

function collectMountEvidence(
    containerId: string,
    required: RequiredContainerMount,
    observed: InspectedContainerMount | undefined,
    policy: MountPresencePolicy,
    finalProofAttempt: boolean,
    session: MountVerificationSession,
): MountEvidence {
    if (!observed) return {};
    if (required.type === "volume") {
        return { volumeSourceMatches: namedVolumeMatches(observed, required.hostPath) };
    }
    const proof = required.sourceProof;
    if (!proof || typeof observed.Source !== "string") return {};
    if (proof.kind === "filesystem") {
        const hostIdentity = observeBindMountSourceIdentity(required.hostPath, proof.identity);
        if (hostIdentity.kind === "mismatch") {
            return { authoritativeMismatch: `bind source identity changed for ${required.containerPath}` };
        }
        const sourceAlias = bindSourceIsTrustedFilesystemAlias(
            observed.Source,
            required.hostPath,
            proof.identity,
        );
        if (sourceAlias === "retryable") return { sourcePathUnavailable: true };
        const sourcePathMatches = sourceAlias === "match";
        const liveProof = hostIdentity.kind === "retryable"
            ? hostIdentity
            : sourcePathMatches
                ? proveContainerSeesCurrentBindSource(
                    containerId,
                    required.hostPath,
                    required.containerPath,
                    proof.identity,
                    session,
                    finalProofAttempt,
                )
                : { kind: "mismatch", reason: `bind source changed for ${required.containerPath}` } as const;
        return { sourcePathMatches, liveProof };
    }
    let primarySource: string;
    try {
        primarySource = proof.kind === "path" && proof.canonical
            ? canonicalHostPath(required.hostPath)
            : required.hostPath;
    } catch {
        return { sourcePathUnavailable: true };
    }
    const candidates = [primarySource, ...(proof.equivalentSources ?? [])];
    const sourcePathMatches = candidates.some((candidate) => (
        bindSourcePathsEquivalent(observed.Source, candidate)
    ));
    if (proof.kind === "daemon" && !sourcePathMatches) {
        if (policy === "strict") {
            return {
                sourcePathMatches,
                liveProof: {
                    kind: "mismatch",
                    reason: `bind source changed for ${required.containerPath}`,
                },
            };
        }
        return {
            sourcePathMatches,
            liveProof: containerManagerSocketTargetsCurrentDockerDaemon(containerId),
        };
    }
    return { sourcePathMatches };
}

function verifyRequiredContainerMountsOnce(
    containerId: string,
    observedMounts: InspectedContainerMount[],
    requiredMounts: RequiredContainerMount[],
    policy: MountPresencePolicy,
    session: MountVerificationSession,
    allowUnexpected = false,
    finalProofAttempt = false,
): MountVerification {
    session.containerExecReady = undefined;
    const contracts = requiredMounts.map(mountContract);
    const shape = validateObservedMountSet(contracts, observedMounts, allowUnexpected);
    if (shape.kind === "mismatch") return shape;
    const observedByPath = new Map(observedMounts.map((mount) => [mount.Destination, mount]));
    const evidence = new Map<string, MountEvidence>();
    for (const required of requiredMounts) {
        evidence.set(
            required.containerPath,
            collectMountEvidence(
                containerId,
                required,
                observedByPath.get(required.containerPath),
                policy,
                finalProofAttempt,
                session,
            ),
        );
    }
    return verifyMountSet(contracts, observedMounts, evidence, { policy, allowUnexpected });
}

type StoppedMountPreflight =
    | { kind: "preflight-verified" }
    | { kind: "mismatch" | "retryable", reason: string };

/** Static evidence permits starting a stopped container, never executing or joining it. */
function preflightStoppedContainerMounts(
    observedMounts: InspectedContainerMount[],
    requiredMounts: RequiredContainerMount[],
): StoppedMountPreflight {
    const shape = validateObservedMountSet(requiredMounts.map(mountContract), observedMounts);
    if (shape.kind === "mismatch") return shape;
    const observedByPath = new Map(observedMounts.map(mount => [mount.Destination, mount]));
    for (const required of requiredMounts) {
        const observed = observedByPath.get(required.containerPath);
        const mismatch = (reason: string): StoppedMountPreflight => ({ kind: "mismatch", reason: `${reason} for ${required.containerPath}` });
        if (!observed) {
            if (required.presence === "optional") continue;
            return { kind: "mismatch", reason: `missing mount ${required.containerPath}` };
        }
        if (required.type !== undefined && observed.Type !== required.type) return mismatch("mount type changed");
        if (required.readonly !== undefined && observed.RW !== !required.readonly) return mismatch("mount access changed");
        if (required.type === "volume") {
            if (!namedVolumeMatches(observed, required.hostPath)) return mismatch("volume source changed");
            continue;
        }
        const proof = required.sourceProof;
        if (!proof) continue;
        if (observed.Type !== "bind" || !observed.Source) return mismatch("bind source missing");
        if (proof.kind === "filesystem") {
            const host = observeBindMountSourceIdentity(required.hostPath, proof.identity);
            if (host.kind !== "verified") return { kind: host.kind, reason: `bind source identity ${host.kind === "mismatch" ? "changed" : "unavailable"} for ${required.containerPath}` };
            const alias = bindSourceIsTrustedFilesystemAlias(observed.Source, required.hostPath, proof.identity);
            if (alias === "retryable") return { kind: "retryable", reason: `bind source unreadable for ${required.containerPath}` };
            if (alias !== "match") return mismatch("bind source changed");
        } else {
            let primary: string;
            try {
                primary = proof.kind === "path" && proof.canonical ? canonicalHostPath(required.hostPath) : required.hostPath;
            } catch {
                return { kind: "retryable", reason: `bind source unreadable for ${required.containerPath}` };
            }
            if (![primary, ...(proof.equivalentSources ?? [])].some(candidate => bindSourcePathsEquivalent(observed.Source, candidate))) return mismatch("bind source changed");
        }
    }
    return { kind: "preflight-verified" };
}

function verifyRequiredContainerMounts(
    containerId: string,
    observedMounts: InspectedContainerMount[],
    requiredMounts: RequiredContainerMount[],
    policy: MountPresencePolicy,
    allowUnexpected = false,
): MountVerification {
    const session = createMountVerificationSession();
    try {
        return withBoundedVerificationRetry(
            (finalAttempt) => verifyRequiredContainerMountsOnce(
                containerId,
                observedMounts,
                requiredMounts,
                policy,
                session,
                allowUnexpected,
                finalAttempt,
            ),
            (verification) => verification.kind === "retryable",
        );
    } finally {
        cleanupMountVerificationSession(session);
    }
}

function inspectCreatedContainerBindMounts(
    containerId: string,
    requiredMounts: RequiredContainerMount[],
    projectMountIdentity: string,
    finalProofAttempt: boolean,
    session: MountVerificationSession,
): MountVerification {
    const inspected = inspectContainerJsonOnce(containerId) as {
        Id?: unknown;
        Mounts?: InspectedContainerMount[];
        Config?: { Labels?: Record<string, string> };
    } | null;
    if (!inspected) {
        return { kind: "retryable", reason: "created container inspection is temporarily unavailable" };
    }
    if (inspected.Id !== containerId) {
        return { kind: "mismatch", reason: "created container identity changed during inspection" };
    }
    if (inspected.Config?.Labels?.[PROJECT_MOUNT_IDENTITY_LABEL] !== projectMountIdentity) {
        return { kind: "mismatch", reason: "created container project mount identity label changed" };
    }
    return verifyRequiredContainerMountsOnce(
        containerId,
        inspected.Mounts ?? [],
        requiredMounts,
        "strict",
        session,
        true,
        finalProofAttempt,
    );
}

function verifyCreatedContainerBindMounts(
    containerId: string,
    requiredMounts: RequiredContainerMount[],
    projectMountIdentity: string,
): MountVerification {
    const session = createMountVerificationSession();
    try {
        return withBoundedVerificationRetry(
            (finalAttempt) => inspectCreatedContainerBindMounts(
                containerId,
                requiredMounts,
                projectMountIdentity,
                finalAttempt,
                session,
            ),
            (verification) => verification.kind === "retryable",
        );
    } finally {
        cleanupMountVerificationSession(session);
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
            ? preflightStoppedContainerMounts(mounts, requiredMounts)
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
    const hostSshRoot = join(homedir(), ".ssh").replace(/\\/g, "/").replace(/\/+$/, "");
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
            `set -e; cp ${stagedPath} /home/ccc/.gitconfig; `
            + "git config --file /home/ccc/.gitconfig --add safe.directory '*'; "
            + gitSigningKeyRewriteShell()
            + "; "
            + `chown ccc:ccc /home/ccc/.gitconfig; rm -f ${stagedPath}`,
            "ccc-signing-key-rewrite",
            "/home/ccc/.gitconfig",
            hostSshRoot,
            "/tmp/.ssh-copy",
        ],
        { stdio: "ignore" },
    );
    if (installed.status !== 0) {
        console.error("[ccc] WARNING: failed to install host .gitconfig inside container");
    }
}

export function gitSigningKeyRewriteShell(): string {
    return [
        "config_path=$1",
        "host_ssh_root=$2",
        "copied_ssh_root=$3",
        "signing_keys=$(git config --file \"$config_path\" --get-all user.signingkey 2>/dev/null || true)",
        "signing_key_count=$(printf '%s\\n' \"$signing_keys\" | sed '/^$/d' | wc -l | tr -d ' ')",
        "if [ \"$signing_key_count\" = 1 ]; then",
        "  normalized_signing_key=$(printf '%s' \"$signing_keys\" | tr '\\\\' '/')",
        "  key_name=${normalized_signing_key##*/}",
        "  case \"$key_name\" in",
        "    id_rsa|id_ed25519|id_ecdsa|id_dsa|id_ed25519_sk|id_ecdsa_sk)",
        "      expected_signing_key=$host_ssh_root/$key_name",
        "      copied_signing_key=$copied_ssh_root/$key_name",
        "      if [ -f \"$copied_ssh_root/.ccc-copy-complete\" ] && [ ! -L \"$copied_ssh_root/.ccc-copy-complete\" ] && [ \"$normalized_signing_key\" = \"$expected_signing_key\" ] && [ -f \"$copied_signing_key\" ] && [ ! -L \"$copied_signing_key\" ]; then",
        "        git config --file \"$config_path\" --replace-all user.signingkey \"$copied_signing_key\"",
        "      fi",
        "      ;;",
        "  esac",
        "fi",
    ].join("\n");
}

export function sshCredentialCopyShell(privilegedRead = false): string {
    return [
        "source_ssh_root=$1",
        "copied_ssh_root=$2",
        "copy_parent=${copied_ssh_root%/*}",
        "copy_name=${copied_ssh_root##*/}",
        "copy_stage=$copy_parent/.${copy_name}.next.$$",
        "copy_previous=$copy_parent/.${copy_name}.previous.$$",
        "rm -rf -- \"$copy_stage\" \"$copy_previous\"",
        "if [ ! -d \"$source_ssh_root\" ] || [ -L \"$source_ssh_root\" ]; then",
        "  rm -rf -- \"$copied_ssh_root\"",
        "  exit 0",
        "fi",
        "umask 077",
        "if ! mkdir \"$copy_stage\"; then rm -rf -- \"$copied_ssh_root\"; exit 1; fi",
        ...(privilegedRead ? [
            "copy_archive=$(mktemp \"$copy_parent/.ccc-ssh-archive.XXXXXX\") || { rm -rf -- \"$copy_stage\" \"$copied_ssh_root\"; exit 1; }",
            "trap 'rm -f -- \"$copy_archive\"' EXIT",
            // Elevate only source reads. The caller owns the archive and extracts as ccc.
            "if ! sudo -n tar -C \"$source_ssh_root\" -cf - . > \"$copy_archive\" || ! tar --no-same-owner --no-same-permissions -xf \"$copy_archive\" -C \"$copy_stage\"; then",
        ] : ["if ! cp -R \"$source_ssh_root\"/. \"$copy_stage\"/; then"]),
        "  rm -rf -- \"$copy_stage\" \"$copied_ssh_root\"",
        "  exit 1",
        "fi",
        "if ! /usr/bin/python3 -I - \"$copied_ssh_root\" \"$copy_stage\" <<'CCC_KNOWN_HOSTS'",
        SSH_KNOWN_HOSTS_PROVENANCE_SCRIPT,
        "CCC_KNOWN_HOSTS",
        "then rm -rf -- \"$copy_stage\" \"$copied_ssh_root\"; exit 1; fi",
        "if ! find \"$copy_stage\" -type d -exec chmod 700 {} + || ! find \"$copy_stage\" -type f -exec chmod 600 {} + || ! find \"$copy_stage\" -type f -name '*.pub' -exec chmod 644 {} +; then",
        "  rm -rf -- \"$copy_stage\" \"$copied_ssh_root\"",
        "  exit 1",
        "fi",
        "if [ -f \"$copy_stage/known_hosts\" ] && [ ! -L \"$copy_stage/known_hosts\" ] && ! chmod 644 \"$copy_stage/known_hosts\"; then",
        "  rm -rf -- \"$copy_stage\" \"$copied_ssh_root\"",
        "  exit 1",
        "fi",
        "if ! rm -f -- \"$copy_stage/.ccc-copy-complete\" || ! printf '%s\\n' complete > \"$copy_stage/.ccc-copy-complete\" || ! chmod 600 \"$copy_stage/.ccc-copy-complete\"; then",
        "  rm -rf -- \"$copy_stage\" \"$copied_ssh_root\"",
        "  exit 1",
        "fi",
        "if [ -e \"$copied_ssh_root\" ] || [ -L \"$copied_ssh_root\" ]; then",
        "  if ! mv \"$copied_ssh_root\" \"$copy_previous\"; then",
        "    rm -rf -- \"$copy_stage\" \"$copied_ssh_root\"",
        "    exit 1",
        "  fi",
        "fi",
        "if mv \"$copy_stage\" \"$copied_ssh_root\"; then",
        "  rm -rf -- \"$copy_previous\"",
        "  exit 0",
        "fi",
        "rm -rf -- \"$copy_stage\" \"$copied_ssh_root\" \"$copy_previous\"",
        "exit 1",
    ].join("\n");
}

function fixSshPermissions(containerName: string): void {
    const hostSshDir = join(homedir(), ".ssh");
    const cli = runtimeCli();

    const copied = spawnSync(
        cli,
        [
            "exec",
            containerName,
            "sh",
            "-c",
            sshCredentialCopyShell(true),
            "ccc-ssh-copy",
            "/home/ccc/.ssh",
            "/tmp/.ssh-copy",
        ],
        { stdio: "ignore" },
    );
    if (copied.status !== 0 && existsSync(hostSshDir)) {
        console.error("[ccc] WARNING: failed to refresh copied SSH credentials inside container");
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

/** Validate the effective exec user, never infer it from mutable labels alone. */
function containerExecIdentityMatches(containerId: string, identity: ContainerUserIdentity): boolean {
    const result = spawnSync(runtimeCli(), ["exec", containerId, "sh", "-c",
        'printf "%s:%s:%s:%s" "$(id -u)" "$(id -g)" "$(id -un)" "$HOME"'],
        { encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    return !result.error && result.status === 0
        && result.stdout.trim() === `${identity.uid}:${identity.gid}:ccc:/home/ccc`;
}

/** One host-wide fence covers retained state migration through container start. */
export function startProjectContainer(...args: Parameters<typeof startProjectContainerLocked>): string {
    return withSharedMutationLock(join(cccHome(), "codex-state.lock"),
        () => startProjectContainerLocked(...args), { waitMs: 600_000, reclaimStale: false });
}

// === Container Lifecycle ===

function startProjectContainerLocked(
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
): string {
    ensureDirs();
    mkdirSync(clipboardFilesDir(), { recursive: true, mode: 0o700 });
    ensureImage();
    const identity = resolveContainerIdentity();
    const baseImageId = getCurrentImageId();
    if (!baseImageId) throw new Error("Cannot resolve the current CCC base image.");
    const imageId = ensureIdentityImage(baseImageId, identity);
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
    const credentialMounts = getAllCredentialMounts().map((mount) => {
        const hostPath = ensureCredentialHostDir(mount, profile);
        return { hostPath, containerPath: mount.containerDir };
    });
    const gitIdentityMounts = getHostGitIdentityMounts();
    const labRunner = buildContainerVmRunConfig(containerName);
    const runtimeInfo = getRuntimeInfo();
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
                (source) => bindSourceIsTrustedFilesystemAlias(source, codexRoot, codexSource) === "match");
        }
        prepareLabStateOwnership(labRunner.stateVolumeName, imageId, identity,
            typeof previousContainer?.Image === "string" ? previousContainer.Image : undefined);
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
        syncMcp: (id) => { syncManagedMcpBundles(id); },
        fixSsh: (id) => { fixSshPermissions(id); },
        syncGit: (id) => { syncHostGitConfig(id); },
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
        assertProjectSources: () => { assertPreparedProjectMountSources(); },
        assertDeviceSources: () => { assertPreparedDeviceLabMountSources(preparedDeviceLabSources); },
        assertFilesystemSources: () => { assertRequiredFilesystemMountSources(); },
        verifyCreated: (id) => {
            const verification = verifyCreatedContainerBindMounts(
                id,
                requiredMounts.filter((mount) => mount.sourceProof?.kind === "filesystem"),
                projectMountIdentity,
            );
            if (verification.kind === "verified") publishStarted(id);
            return verification;
        },
        syncMcp: (id) => { syncManagedMcpBundles(id); },
        fixSsh: (id) => { fixSshPermissions(id); },
        syncGit: (id) => { syncHostGitConfig(id); },
        finish: (id) => finish(id, true),
    }, {
        createCli: cli,
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
