import { createHash, randomBytes } from "crypto";
import { lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join, normalize, posix, resolve } from "path";
import { containerEngineFailureHint, getRuntimeInfo, runtimeSpawnSync, getRuntimeInvocation, runWithNativeRuntimeInvocation } from "../container-runtime.js";
import { ContainerEngineUnavailableError } from "../domain/container-runtime.js";
import { projectPathsEquivalent } from "../utils.js";
import { proveWslBindSourceIdentity } from "../wsl-bind-source-proof.js";
import type { LiveSourceProof, MountVerification, ObservedMountContract, RequiredMountContract } from "../bind-mount-verification.js";
import type { ContainerMountSourceFacts, ContainerMountVerificationPorts } from "../ports/container-mount-verification.js";

const CONTAINER_MANAGER_SOCKET = "/var/run/docker.sock";
const PROJECT_MOUNT_IDENTITY_LABEL = "ccc.project.mount-identity";

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

export type RequiredContainerMount = {
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

export function normalizedHostPath(path: string): string {
    const normalized = normalize(resolve(path));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function canonicalHostPath(path: string): string {
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

export function assertBindMountSourceIdentity(
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
    const options = { encoding: "utf-8" as const, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" as const };
    const result = runtimeSpawnSync(["exec", containerId, "cat", markerPath], options);
    const engineFailure = result.status !== 0 ? containerEngineFailureHint(result.stderr) : undefined;
    if (engineFailure) throw new ContainerEngineUnavailableError(engineFailure);
    // Only this generated, non-secret challenge may need traversal through a
    // host-owned 0700 SSH directory. Never read keys as part of mount proof.
    if (!result.error && !result.signal && result.status !== null && result.status !== 0
        && /^\/home\/ccc\/\.ssh\/\.ccc-mount-identity-[a-f0-9]{32}$/.test(markerPath)) {
        const elevated = runtimeSpawnSync(["exec", "--user", "root", containerId, "cat", markerPath], options);
        const engineFailure = elevated.status !== 0 ? containerEngineFailureHint(elevated.stderr) : undefined;
        if (engineFailure) throw new ContainerEngineUnavailableError(engineFailure);
        return elevated;
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
    canExec: (id: string, timeoutMs: number) => boolean,
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
                session.containerExecReady ??= canExec(containerId, 200);
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
            let result = runtimeSpawnSync(["exec", containerId, "cat", containerPath],
                {
                    encoding: null,
                    stdio: ["pipe", "pipe", "pipe"],
                    maxBuffer: 1024 * 1024 + 1,
                    timeout: 5000,
                    killSignal: "SIGKILL",
                },
            );
            const engineFailure = result.status !== 0 ? containerEngineFailureHint(Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr) : undefined;
            if (engineFailure) throw new ContainerEngineUnavailableError(engineFailure);
            let containerExecReady = false;
            if (result.error || result.status !== 0) {
                session.containerExecReady ??= canExec(containerId, 200);
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
    } catch (error) {
        if (error instanceof ContainerEngineUnavailableError) throw error;
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

export function bindSourceIsTrustedFilesystemAlias(
    observedSource: string,
    hostPath: string,
    expected: BindMountSourceIdentity,
    currentImageId: () => string | null,
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
        const image = currentImageId();
        const proof = image ? proveWslBindSourceIdentity(observedSource, expected, image) : null;
        const after = observeBindMountSourceIdentity(hostPath, expected);
        if (after.kind !== "verified") return after.kind === "retryable" ? "retryable" : "mismatch";
        return proof === true ? "match" : proof === false ? "mismatch" : "retryable";
    }
    return canonicalizationUnavailable ? "retryable" : "mismatch";
}

function dockerDaemonIdentity(result: ReturnType<typeof runtimeSpawnSync>): string | null {
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
        killSignal: "SIGKILL" as const,
        windowsHide: true,
    };
    const hostIdentity = dockerDaemonIdentity(runtimeSpawnSync(["info", "--format", "{{.ID}}"],
        options,
    ));
    if (!hostIdentity) {
        return { kind: "retryable", reason: "host container-manager daemon identity is unavailable" };
    }
    const mountedIdentity = dockerDaemonIdentity(runtimeSpawnSync([
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

export function sameFileIdentity(
    left: { dev?: number | bigint; ino?: number | bigint },
    right: { dev?: number | bigint; ino?: number | bigint },
): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

export type InspectedContainerMount = {
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

export function inspectContainerJsonOnce(containerId: string): Record<string, unknown> | null {
    const result = runtimeSpawnSync(["inspect", "-f", "{{json .}}", containerId],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" },
    );
    const engineFailure = result.status !== 0 ? containerEngineFailureHint(result.stderr) : undefined;
    if (engineFailure) throw new ContainerEngineUnavailableError(engineFailure);
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

export interface NativeContainerMountObservationContext {
    containerId: string;
    requiredMounts: RequiredContainerMount[];
    canExecContainer(id: string, timeoutMs: number): boolean;
    currentImageId(): string | null;
    withRetry(
        operation: (finalAttempt: boolean) => MountVerification,
        isRetryable: (result: MountVerification) => boolean,
    ): MountVerification;
}

/** Native evidence is retained only in this exact target/configuration closure. */
export function createNativeContainerMountObservations(context: NativeContainerMountObservationContext) {
    const invocation = getRuntimeInvocation();
    const session = createMountVerificationSession();
    const requiredByPath = new Map(context.requiredMounts.map(mount => [mount.containerPath, mount]));
    let observedByPath = new Map<string, InspectedContainerMount>();
    const requiredMounts: RequiredMountContract[] = context.requiredMounts.map(required => ({
        containerPath: required.containerPath,
        readonly: required.readonly,
        type: required.type,
        presence: required.presence,
        sourceKind: required.type === "volume" ? "volume" as const : required.sourceProof?.kind ?? "none" as const,
    }));

    function requiredAt(path: string): RequiredContainerMount {
        const required = requiredByPath.get(path);
        if (!required) throw new Error(`mount observation has no required configuration: ${path}`);
        return required;
    }

    function observedAt(path: string): InspectedContainerMount {
        const observed = observedByPath.get(path);
        if (!observed) throw new Error(`mount observation has no captured source: ${path}`);
        return observed;
    }

    function decodeObservedMounts(mounts: InspectedContainerMount[]): ObservedMountContract[] {
        observedByPath = new Map();
        if (!Array.isArray(mounts)) return [{ sourceState: "invalid" }];
        return mounts.map((mount): ObservedMountContract => {
            if (!mount || typeof mount !== "object") return { sourceState: "invalid" };
            if (typeof mount.Destination === "string") observedByPath.set(mount.Destination, mount);
            return {
                containerPath: mount.Destination,
                type: mount.Type,
                writable: mount.RW,
                sourceState: typeof mount.Source !== "string" ? "invalid"
                    : mount.Source.length === 0 ? "empty" : "present",
            };
        });
    }

    function observeSource(path: string): ContainerMountSourceFacts {
        const required = requiredAt(path);
        const observed = observedAt(path);
        if (required.type === "volume") {
            return {
                kind: "volume",
                matches: Object.hasOwn(observed, "Name")
                    ? typeof observed.Name === "string" && observed.Name === required.hostPath
                    : observed.Source === required.hostPath,
            };
        }
        const proof = required.sourceProof;
        if (!proof || typeof observed.Source !== "string") return { kind: "none" };
        if (proof.kind === "filesystem") {
            const alias = bindSourceIsTrustedFilesystemAlias(
                observed.Source, required.hostPath, proof.identity, context.currentImageId,
            );
            return { kind: "filesystem", pathMatch: alias === "retryable" ? "unavailable" : alias };
        }
        const requireLiteralSource = proof.kind === "daemon"
            && required.hostPath !== CONTAINER_MANAGER_SOCKET && getRuntimeInfo().runtime === "docker";
        let primarySource: string;
        try {
            primarySource = proof.kind === "path" && proof.canonical
                ? canonicalHostPath(required.hostPath) : required.hostPath;
        } catch {
            return {
                kind: proof.kind,
                generalPathMatch: "unavailable",
                literalSourceMatch: observed.Source === required.hostPath,
                requireLiteralSource,
                requireDaemonProofOnMatch: false,
            };
        }
        return {
            kind: proof.kind,
            generalPathMatch: [primarySource, ...(proof.equivalentSources ?? [])]
                .some(candidate => bindSourcePathsEquivalent(observed.Source, candidate)) ? "match" : "mismatch",
            literalSourceMatch: observed.Source === required.hostPath,
            requireLiteralSource,
            requireDaemonProofOnMatch: proof.kind === "daemon"
                && bindSourcePathsEquivalent(observed.Source, "/run/host-services/docker.proxy.sock"),
        };
    }

    const ports: ContainerMountVerificationPorts = {
        observeSource,
        observeHostIdentity(path) {
            const required = requiredAt(path);
            if (required.sourceProof?.kind !== "filesystem") throw new Error(`filesystem identity not configured: ${path}`);
            return observeBindMountSourceIdentity(required.hostPath, required.sourceProof.identity);
        },
        proveFilesystem(path, finalAttempt) {
            const required = requiredAt(path);
            if (required.sourceProof?.kind !== "filesystem") throw new Error(`filesystem proof not configured: ${path}`);
            return proveContainerSeesCurrentBindSource(
                context.containerId, required.hostPath, path, required.sourceProof.identity,
                session, finalAttempt, context.canExecContainer,
            );
        },
        proveDaemon: () => containerManagerSocketTargetsCurrentDockerDaemon(context.containerId),
        resetAttempt: () => { session.containerExecReady = undefined; },
        cleanup: () => cleanupMountVerificationSession(session),
        inspectCreated() {
            const inspected = inspectContainerJsonOnce(context.containerId) as {
                Id?: unknown;
                Mounts?: InspectedContainerMount[];
                Config?: { Labels?: Record<string, string> };
            } | null;
            if (!inspected) return { kind: "unavailable" };
            return {
                kind: "observed",
                containerId: inspected.Id,
                projectMountIdentity: inspected.Config?.Labels?.[PROJECT_MOUNT_IDENTITY_LABEL],
                mounts: decodeObservedMounts(inspected.Mounts ?? []),
            };
        },
        requiresFinalDaemonProof: () => context.requiredMounts.some(mount => (
            mount.sourceProof?.kind === "daemon" && mount.hostPath === CONTAINER_MANAGER_SOCKET
        )) && getRuntimeInfo().runtime === "docker",
        withRetry: context.withRetry,
    };
    const boundPorts: ContainerMountVerificationPorts = {
        ...ports,
        observeSource: path => runWithNativeRuntimeInvocation(invocation, () => ports.observeSource(path)),
        observeHostIdentity: path => runWithNativeRuntimeInvocation(invocation, () => ports.observeHostIdentity(path)),
        proveFilesystem: (path, finalAttempt) => runWithNativeRuntimeInvocation(invocation, () => ports.proveFilesystem(path, finalAttempt)),
        proveDaemon: () => runWithNativeRuntimeInvocation(invocation, ports.proveDaemon),
        inspectCreated: () => runWithNativeRuntimeInvocation(invocation, ports.inspectCreated),
        requiresFinalDaemonProof: () => runWithNativeRuntimeInvocation(invocation, ports.requiresFinalDaemonProof),
        withRetry: (operation, retryable) => runWithNativeRuntimeInvocation(invocation, () => ports.withRetry(operation, retryable)),
    };
    return { requiredMounts, decodeObservedMounts, ports: boundPorts };
}
