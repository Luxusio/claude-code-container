// src/container-runtime.ts - Container runtime abstraction (Docker | Podman)
//
// Centralises runtime selection, detection, and runtime-specific argv quirks so
// every other module that spawns a container CLI calls `runtimeCli()` instead
// of the literal string "docker". Runtime is resolved once and cached per
// process.
//
// Resolution order (first hit wins):
//   1. Explicit override set via `setRuntimeOverride()` (backs `--runtime` flag)
//   2. `CCC_RUNTIME` environment variable (`docker` | `podman`)
//   3. `podman` on PATH → podman
//   4. `docker` on PATH → docker
//   5. Neither found → error
//
// Runtime-specific behaviours centralised here:
//   - bind-mount `:Z` suffix on Linux Podman with SELinux enforcing
//   - rootless runtime detection for Docker/Podman
//   - `--userns=keep-id:uid=1000,gid=1000` on rootless Podman
//     (maps host user to container ccc UID, not the host UID)
//   - `host.docker.internal` vs `host.containers.internal` alias
//   - docker.sock host path substitution (Podman ships Docker-compatible socket)
//   - `isContainerHostRemote()` unifies docker-desktop + podman-machine

import { spawnSync, type SpawnSyncOptions } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseRuntimeOverride, type RuntimeName } from "./domain/container-runtime.js";
import { createContainerRuntimeSelector } from "./application/container-runtime-selection.js";
import type { BindMountArgumentOptions } from "./domain/container-launch-arguments.js";
import { createRuntimeCapabilitiesCollector } from "./application/runtime-capabilities.js";
import { createNativeRuntimeCapabilitiesObservations } from "./adapters/runtime-capabilities.js";
import type { RuntimeInfo } from "./domain/runtime-capabilities.js";
import type { NativeRuntimeInvocation } from "./ports/container-runtime-invocation.js";
import {
    bindNativeRuntimeInvocation, captureNativeRuntimeInvocation,
    currentNativeRuntimeInvocation, validateNativeRuntimeInvocation,
    type BoundNativeRuntimeRunner, type BoundNativeSpawnSync,
} from "./adapters/container-runtime-invocation.js";

export {
    bindNativeRuntimeInvocation, captureNativeRuntimeInvocation, compileNativeRuntimeInvocation,
    currentNativeRuntimeInvocation, runWithNativeRuntimeInvocation, validateNativeRuntimeInvocation,
} from "./adapters/container-runtime-invocation.js";
export type { NativeRuntimeInvocation } from "./ports/container-runtime-invocation.js";
export type { BoundNativeRuntimeRunner, BoundNativeSpawnSync } from "./adapters/container-runtime-invocation.js";

export type { RuntimeName } from "./domain/container-runtime.js";

/** Transport diagnostics describe an unavailable engine, not a stopped container. */
export function containerEngineFailureHint(stderr: unknown): string | undefined {
    if (typeof stderr !== "string" || !/(?:request returned 5\d\d .*for API route and version|cannot connect to the docker daemon|error during connect:|connection refused.*(?:docker|podman)|(?:docker|podman).*connection refused)/i.test(stderr)) return undefined;
    return "Container engine is unavailable. Docker Desktop returned a transport/server error; CCC stopped without restarting or replacing the container. Check Docker Desktop engine diagnostics, then retry when the engine is healthy. The API-version text alone does not establish a version mismatch.";
}

export type { RuntimeFlavor, RuntimeInfo } from "./domain/runtime-capabilities.js";

// === Module state (cache for process lifetime) ===

let _runtimeOverride: RuntimeName | null = null;
let _cachedInfo: RuntimeInfo | null = null;
let _cachedInvocation: NativeRuntimeInvocation | null = null;
const _scopedInfo = new WeakMap<NativeRuntimeInvocation, RuntimeInfo>();

/**
 * Reset the runtime cache. Tests only.
 */
export function _resetRuntimeCacheForTest(): void {
    _runtimeOverride = null;
    _cachedInfo = null;
    _cachedInvocation = null;
    _selinuxCached = null;
}

/**
 * Preload the runtime cache. Tests only. Lets test suites pin a specific
 * runtime without triggering `spawnSync` detection calls that would interfere
 * with mocked spawn assertions.
 */
export function _setRuntimeInfoForTest(info: Partial<RuntimeInfo> & { runtime: RuntimeName }): void {
    const defaults: RuntimeInfo = {
        runtime: info.runtime,
        flavor: info.runtime === "docker" ? "docker-native" : "podman-rootful",
        version: "0.0.0",
        socketPath: info.runtime === "docker" ? "/var/run/docker.sock" : "/run/podman/podman.sock",
        rootless: false,
        remote: false,
        dockerDesktop: false,
    };
    _cachedInfo = { ...defaults, ...info };
    _runtimeOverride = info.runtime;
    _cachedInvocation = null;
}

/** An explicit native invocation fixture, independent of capability preloads. */
export function _setRuntimeInvocationForTest(value: NativeRuntimeInvocation): void {
    const invocation = validateNativeRuntimeInvocation(value);
    if (_cachedInfo?.runtime !== invocation.runtime) _cachedInfo = null;
    _cachedInvocation = invocation;
    _runtimeOverride = invocation.runtime;
}

/**
 * Set an explicit runtime override. Called from the `--runtime` CLI flag.
 * Must be called before the first `getRuntime*()` access, otherwise detection
 * has already been cached. Throws on invalid input.
 */
export function setRuntimeOverride(name: string | undefined | null): void {
    const runtime = parseRuntimeOverride(name, "cli");
    if (runtime === null) {
        return;
    }
    _runtimeOverride = runtime;
    _cachedInfo = null;
    _cachedInvocation = null;
}

// === Runtime detection ===

/**
 * Check if a CLI is on PATH by running `<name> --version`.
 * `which`/`where` is avoided to stay OS-agnostic.
 */
function isRuntimeOnPath(name: RuntimeName): boolean {
    const result = spawnSync(name, ["--version"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
        killSignal: "SIGKILL",
    });
    return result.status === 0;
}

/**
 * Compose selection policy with the current override, environment and native probe.
 * Throws if neither runtime is available and no override is set.
 */
function resolveRuntime(): RuntimeName {
    return createContainerRuntimeSelector({
        getExplicitOverride: () => _runtimeOverride,
        getEnvironmentOverride: () => process.env.CCC_RUNTIME,
        isRuntimeAvailable: isRuntimeOnPath,
    })();
}

function collectRuntimeCapabilities(invocation: NativeRuntimeInvocation): RuntimeInfo {
    const runner = bindNativeRuntimeInvocation(invocation);
    return createRuntimeCapabilitiesCollector({
        ...createNativeRuntimeCapabilitiesObservations(
            () => invocation.transport.kind === "docker" ? invocation.transport.host : null,
            runner,
        ),
        selectRuntime: () => invocation.runtime,
    })();
}

function publishNativeRuntime(): void {
    // Capture and all native observations must succeed before either cache becomes visible.
    const invocation = _cachedInvocation ?? captureNativeRuntimeInvocation(resolveRuntime());
    const info = collectRuntimeCapabilities(invocation);
    _cachedInvocation = invocation;
    _cachedInfo = info;
}

/** Ordinary native composition captures before inspection or session reservation. */
export function getRuntimeInvocation(): NativeRuntimeInvocation {
    const scoped = currentNativeRuntimeInvocation();
    if (scoped) return scoped;
    if (!_cachedInvocation) publishNativeRuntime();
    return _cachedInvocation!;
}

/** Read already captured authority without native discovery or capability probes. */
export function peekRuntimeInvocation(): NativeRuntimeInvocation | undefined {
    return currentNativeRuntimeInvocation() ?? _cachedInvocation ?? undefined;
}

/** Native dispatch always uses the current operation's capture, including nested helper calls. */
export const runtimeSpawnSync: BoundNativeSpawnSync = ((args: readonly string[], options: SpawnSyncOptions = {}) =>
    bindNativeRuntimeInvocation(getRuntimeInvocation()).spawnSync(args, options)) as BoundNativeSpawnSync;

export const runtimeSpawn: BoundNativeRuntimeRunner["spawn"] = (args, options) =>
    bindNativeRuntimeInvocation(getRuntimeInvocation()).spawn(args, options);

// === Public info ===

/**
 * Return cached runtime info, running detection on first call.
 */
export function getRuntimeInfo(): RuntimeInfo {
    const scoped = currentNativeRuntimeInvocation();
    if (scoped) {
        let info = _scopedInfo.get(scoped);
        if (!info) {
            info = collectRuntimeCapabilities(scoped);
            _scopedInfo.set(scoped, info);
        }
        return info;
    }
    if (_cachedInfo) return _cachedInfo;
    publishNativeRuntime();
    return _cachedInfo!;
}

/**
 * Runtime-name compatibility accessor. Native execution uses runtimeSpawnSync/runtimeSpawn.
 */
export function runtimeCli(): RuntimeName {
    return getRuntimeInfo().runtime;
}

/**
 * True iff container host is a VM (Docker Desktop or podman machine).
 * Used to decide whether --network host truly shares the host network and
 * whether host.docker.internal rewriting is needed.
 */
export function isContainerHostRemote(): boolean {
    return getRuntimeInfo().remote;
}

/**
 * Alias by which container processes can reach the host.
 * Podman accepts both host.docker.internal and host.containers.internal;
 * Docker only accepts host.docker.internal. Using the Docker alias keeps
 * existing configs portable.
 */
export function getHostInternalAlias(): string {
    return "host.docker.internal";
}

// === Mount helpers ===

/**
 * Whether SELinux is enforcing. Cached statically.
 * Read via /sys/fs/selinux/enforce (== "1") with a getenforce fallback.
 */
let _selinuxCached: boolean | null = null;
let _currentContainerMounts = new WeakMap<NativeRuntimeInvocation, Array<{ source: string; destination: string }>>();
export function _resetSelinuxCacheForTest(): void {
    _selinuxCached = null;
    _currentContainerMounts = new WeakMap();
}

export function isSelinuxEnforcing(): boolean {
    if (_selinuxCached !== null) return _selinuxCached;
    if (process.platform !== "linux") {
        _selinuxCached = false;
        return false;
    }
    try {
        const p = "/sys/fs/selinux/enforce";
        if (existsSync(p)) {
            const v = readFileSync(p, "utf-8").trim();
            _selinuxCached = v === "1";
            return _selinuxCached;
        }
    } catch { /* ignore */ }
    try {
        const r = spawnSync("getenforce", [], {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        if (r.status === 0 && (r.stdout ?? "").trim().toLowerCase() === "enforcing") {
            _selinuxCached = true;
            return true;
        }
    } catch { /* ignore */ }
    _selinuxCached = false;
    return false;
}

/**
 * Whether bind-mounts need the `:Z` (private relabel) suffix.
 * Gated by CCC_SELINUX_RELABEL=auto|force|off (default auto = detect).
 */
export function needsSelinuxRelabel(): boolean {
    const mode = (process.env.CCC_SELINUX_RELABEL ?? "auto").toLowerCase();
    if (mode === "off") return false;
    if (mode === "force") return true;
    // auto: only on podman + SELinux enforcing. Docker manages labels itself.
    if (runtimeCli() !== "podman") return false;
    return isSelinuxEnforcing();
}

/** Build a single bind spec; named volumes never receive SELinux relabeling. */
export function bindMountArgs(
    hostPath: string,
    containerPath: string,
    opts: BindMountArgumentOptions = {},
): string[] {
    const suffixes: string[] = [];
    if (opts.readonly) suffixes.push("ro");
    const translatedHostPath = opts.sourceNamespace === "daemon"
        ? hostPath
        : translateCurrentContainerPath(hostPath);
    const isHostPath = translatedHostPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(translatedHostPath);
    if (isHostPath && needsSelinuxRelabel()) {
        suffixes.push("Z");
    }
    const suffix = suffixes.length > 0 ? `:${suffixes.join(",")}` : "";
    return ["-v", `${translatedHostPath}:${containerPath}${suffix}`];
}

function translateCurrentContainerPath(hostPath: string): string {
    if (!hostPath.startsWith("/")) return hostPath;
    if (process.env.container !== "docker") return hostPath;
    if (runtimeCli() !== "docker") return hostPath;

    const mounts = getCurrentContainerMounts();
    let best: { source: string; destination: string } | null = null;
    for (const mount of mounts) {
        if (hostPath === mount.destination || hostPath.startsWith(`${mount.destination}/`)) {
            if (!best || mount.destination.length > best.destination.length) {
                best = mount;
            }
        }
    }
    if (!best) return hostPath;

    const source = normalizeDockerMountSource(best.source);
    const rel = hostPath.slice(best.destination.length).replace(/^\/+/, "");
    return rel ? join(source, rel) : source;
}

/**
 * Extra `run` args that are runtime-specific. On rootless podman we remap the
 * host user to UID/GID 1000 inside the container — the UID of the image's
 * `ccc` user. Plain `--userns=keep-id` preserves the host UID, which breaks
 * when host UID ≠ 1000: the bind-mounted `~/.ccc/claude` and the mise named
 * volume are both owned by UID 1000 inside the image, and a process running
 * as the host UID can't chmod/write those paths ("Operation not permitted"
 * when `claude.ai/install.sh` tries to chmod the downloaded binary).
 *
 * The same mapping is required for podman-machine (macOS/Windows): the VM
 * runs rootless podman internally, so bind mounts coming through the machine
 * VM land with a subuid that doesn't match container UID 1000 unless we
 * explicitly remap. Without this, first-run claude install hits the same
 * "Operation not permitted" chmod failure observed on Linux rootless.
 *
 * Requires Podman 4.3+ for the `:uid=,gid=` syntax (released Nov 2022).
 */
export function runtimeExtraRunArgs(): string[] {
    const info = getRuntimeInfo();
    const extras: string[] = [];
    const podmanCgroups = (process.env.CCC_PODMAN_CGROUPS ?? "").toLowerCase();
    if (
        info.runtime === "podman"
        && !info.remote
        && (podmanCgroups === "disabled" || (podmanCgroups !== "enabled" && process.env.container === "docker"))
    ) {
        extras.push("--cgroups=disabled");
    }
    if (info.flavor === "podman-rootless" || info.flavor === "podman-machine") {
        extras.push("--userns=keep-id:uid=1000,gid=1000");
    }
    return extras;
}

function getCurrentContainerMounts(): Array<{ source: string; destination: string }> {
    const invocation = getRuntimeInvocation();
    const cached = _currentContainerMounts.get(invocation);
    if (cached) return cached;
    let mounts: Array<{ source: string; destination: string }> = [];
    _currentContainerMounts.set(invocation, mounts);

    const name = process.env.HOSTNAME;
    if (!name) return mounts;

    const result = runtimeSpawnSync(
        ["inspect", name, "--format", "{{json .Mounts}}"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" },
    );
    if (result.status !== 0) return mounts;

    try {
        const observed = JSON.parse((result.stdout ?? "").trim()) as Array<{
            Source?: string;
            Destination?: string;
        }>;
        mounts = observed
            .filter((mount) => mount.Source && mount.Destination)
            .map((mount) => ({
                source: mount.Source!,
                destination: mount.Destination!,
            }));
    } catch {
        mounts = [];
    }
    _currentContainerMounts.set(invocation, mounts);
    return mounts;
}

/**
 * Return a one-line human-readable summary of the detected runtime.
 * Used by `ccc runtime` and `ccc doctor`.
 */
export function formatRuntimeSummary(info: RuntimeInfo = getRuntimeInfo()): string {
    const parts = [
        `runtime=${info.runtime}`,
        `version=${info.version ?? "unknown"}`,
        `flavor=${info.flavor}`,
        `socket=${info.socketPath ?? "none"}`,
    ];
    return parts.join(" ");
}

function normalizeDockerMountSource(source: string): string {
    const match = source.match(/^([A-Za-z]):[\\/](.*)$/);
    if (!match) return source;
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, "/");
    return `/run/desktop/mnt/host/${drive}/${rest}`;
}

/** Socket existence and fallback are native runtime facts. */
export function containerManagerSocketPath(): string {
    const info = getRuntimeInfo();
    if (info.runtime === "docker") {
        return info.socketPath ?? "/var/run/docker.sock";
    }
    const socket = info.socketPath ?? "/run/podman/podman.sock";
    return existsSync(socket) ? socket : "/var/run/docker.sock";
}

/** Socket source and namespace are native runtime facts. */
export function containerManagerSocketMountArgs(): string[] {
    const info = getRuntimeInfo();
    const source = containerManagerSocketPath();
    return bindMountArgs(source, "/var/run/docker.sock", {
        sourceNamespace: info.runtime === "docker" && source !== "/var/run/docker.sock" ? "daemon" : "client",
    });
}
