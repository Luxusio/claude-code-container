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
//   - `--userns=keep-id` on rootless Podman
//   - `host.docker.internal` vs `host.containers.internal` alias
//   - docker.sock host path substitution (Podman ships Docker-compatible socket)
//   - `isContainerHostRemote()` unifies docker-desktop + podman-machine

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export type RuntimeName = "docker" | "podman";

export type RuntimeFlavor =
    | "linux-rootful"        // docker or podman, running natively on Linux as root-equivalent
    | "linux-rootless"       // podman rootless on Linux
    | "docker-desktop"       // docker on macOS/Windows/WSL2 (VM-backed)
    | "podman-machine"       // podman on macOS/Windows (VM-backed)
    | "unknown";

export interface RuntimeInfo {
    runtime: RuntimeName;
    flavor: RuntimeFlavor;
    version: string | null;    // "x.y.z" or null if detection failed
    socketPath: string | null; // host-side path to the container-manager socket
    rootless: boolean;         // true iff rootless podman
    remote: boolean;           // true iff Docker Desktop or podman machine (VM-backed)
}

// === Module state (cache for process lifetime) ===

let _runtimeOverride: RuntimeName | null = null;
let _cachedInfo: RuntimeInfo | null = null;

/**
 * Reset the runtime cache. Tests only.
 */
export function _resetRuntimeCacheForTest(): void {
    _runtimeOverride = null;
    _cachedInfo = null;
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
        flavor: info.runtime === "docker" ? "linux-rootful" : "linux-rootful",
        version: "0.0.0",
        socketPath: info.runtime === "docker" ? "/var/run/docker.sock" : "/run/podman/podman.sock",
        rootless: false,
        remote: false,
    };
    _cachedInfo = { ...defaults, ...info };
    _runtimeOverride = info.runtime;
}

/**
 * Set an explicit runtime override. Called from the `--runtime` CLI flag.
 * Must be called before the first `getRuntime*()` access, otherwise detection
 * has already been cached. Throws on invalid input.
 */
export function setRuntimeOverride(name: string | undefined | null): void {
    if (name == null || name === "") {
        return;
    }
    if (name !== "docker" && name !== "podman") {
        throw new Error(
            `Invalid --runtime value: '${name}'. Allowed: 'docker' or 'podman'.`,
        );
    }
    _runtimeOverride = name;
    _cachedInfo = null;
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
    });
    return result.status === 0;
}

/**
 * Resolve which runtime to use. Pure function over inputs + environment.
 * Throws if neither runtime is available and no override is set.
 */
function resolveRuntime(): RuntimeName {
    if (_runtimeOverride) return _runtimeOverride;

    const envOverride = process.env.CCC_RUNTIME;
    if (envOverride) {
        if (envOverride !== "docker" && envOverride !== "podman") {
            throw new Error(
                `Invalid CCC_RUNTIME value: '${envOverride}'. Allowed: 'docker' or 'podman'.`,
            );
        }
        return envOverride;
    }

    // Prefer Podman, fall back to Docker.
    if (isRuntimeOnPath("podman")) return "podman";
    if (isRuntimeOnPath("docker")) return "docker";

    throw new Error(
        "No container runtime found. Install podman or docker and ensure the CLI is on PATH.",
    );
}

// === Version parsing ===

function parseVersion(output: string): string | null {
    // Matches "Docker version 27.1.1, build ..." and "podman version 5.2.3"
    const match = output.match(/\b(\d+\.\d+(?:\.\d+)?)/);
    return match ? match[1] : null;
}

function detectVersion(runtime: RuntimeName): string | null {
    const result = spawnSync(runtime, ["--version"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0) return null;
    return parseVersion((result.stdout ?? "").toString());
}

// === Flavor detection ===

/**
 * Detect whether the resolved runtime is VM-backed (Docker Desktop / podman
 * machine). Called once and cached.
 */
function detectRemote(runtime: RuntimeName): boolean {
    // Non-Linux always runs via a VM (Docker Desktop or podman machine).
    if (process.platform !== "linux") return true;

    if (runtime === "docker") {
        const result = spawnSync(
            "docker",
            ["info", "--format", "{{.OperatingSystem}}"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if ((result.stdout ?? "").toLowerCase().includes("docker desktop")) {
            return true;
        }
        // WSL2 hosting Docker Desktop for Windows
        if (process.env.WSL_DISTRO_NAME) return true;
        return false;
    }

    // runtime === "podman"
    // `podman info --format '{{.Host.Remote}}'` returns true for VM-backed podman.
    const result = spawnSync(
        "podman",
        ["info", "--format", "{{.Host.Remote}}"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.status === 0 && (result.stdout ?? "").trim().toLowerCase() === "true") {
        return true;
    }
    return false;
}

/**
 * Rootless detection (podman only). Docker is rootful by convention.
 */
function detectRootless(runtime: RuntimeName): boolean {
    if (runtime !== "podman") return false;
    if (process.platform !== "linux") return false; // machine VM: not "rootless" in the host sense

    const result = spawnSync(
        "podman",
        ["info", "--format", "{{.Host.Security.Rootless}}"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.status === 0) {
        const out = (result.stdout ?? "").trim().toLowerCase();
        if (out === "true") return true;
        if (out === "false") return false;
    }
    // Fallback: if effective UID is nonzero, assume rootless.
    try {
        if (typeof process.getuid === "function" && process.getuid() !== 0) return true;
    } catch { /* ignore */ }
    return false;
}

/**
 * Derive the RuntimeFlavor from the collected facts.
 */
function deriveFlavor(runtime: RuntimeName, remote: boolean, rootless: boolean): RuntimeFlavor {
    if (runtime === "docker") {
        if (remote) return "docker-desktop";
        return "linux-rootful";
    }
    // runtime === "podman"
    if (remote) return "podman-machine";
    if (rootless) return "linux-rootless";
    return "linux-rootful";
}

/**
 * Default socket path on the host for the detected runtime.
 * Returns null if detection isn't confident (fall back to Docker default).
 *
 * Users can override the detected path via `CCC_RUNTIME_SOCKET`. This is the
 * escape hatch for non-standard installs (custom XDG_RUNTIME_DIR, rootful
 * podman on a non-default path, lima/colima, etc).
 */
function detectSocketPath(runtime: RuntimeName, rootless: boolean): string | null {
    const override = process.env.CCC_RUNTIME_SOCKET;
    if (override) return override;

    if (runtime === "docker") {
        return "/var/run/docker.sock";
    }
    // Podman
    if (rootless) {
        const xdg = process.env.XDG_RUNTIME_DIR;
        if (xdg) return join(xdg, "podman", "podman.sock");
        const uid = typeof process.getuid === "function" ? process.getuid() : 0;
        return `/run/user/${uid}/podman/podman.sock`;
    }
    return "/run/podman/podman.sock";
}

// === Public info ===

/**
 * Return cached runtime info, running detection on first call.
 */
export function getRuntimeInfo(): RuntimeInfo {
    if (_cachedInfo) return _cachedInfo;

    // In vitest, default to a docker stub unless a test explicitly calls
    // `_setRuntimeInfoForTest`. This keeps existing spawnSync-mocking tests
    // deterministic (no stray detection spawns consuming mock return values)
    // and hermetic against the host's CCC_RUNTIME env. Tests that exercise
    // detection or podman paths set the info directly; the real resolve path
    // still runs in production.
    if (process.env.VITEST && !_runtimeOverride) {
        _cachedInfo = {
            runtime: "docker",
            flavor: "linux-rootful",
            version: "0.0.0",
            socketPath: "/var/run/docker.sock",
            rootless: false,
            remote: false,
        };
        return _cachedInfo;
    }

    const runtime = resolveRuntime();
    const version = detectVersion(runtime);
    const remote = detectRemote(runtime);
    const rootless = detectRootless(runtime);
    const flavor = deriveFlavor(runtime, remote, rootless);
    const socketPath = detectSocketPath(runtime, rootless);

    _cachedInfo = { runtime, flavor, version, socketPath, rootless, remote };
    return _cachedInfo;
}

/**
 * Short accessor for the CLI name. This is what you pass as the first arg to
 * `spawnSync`/`spawn`/`execSync`. Never hardcode "docker" elsewhere.
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
export function _resetSelinuxCacheForTest(): void {
    _selinuxCached = null;
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

/**
 * Build a single `-v` bind mount spec, applying :Z / :ro suffixes as needed.
 * Returns ["-v", "<host>:<container>[:ro][:Z]"] argv pair.
 *
 * NOTE: Named volumes (no leading `/`) never get `:Z`. SELinux relabel only
 * applies to host-path bind mounts.
 */
export function bindMountArgs(
    hostPath: string,
    containerPath: string,
    opts: { readonly?: boolean } = {},
): string[] {
    const suffixes: string[] = [];
    if (opts.readonly) suffixes.push("ro");
    const isHostPath = hostPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(hostPath);
    if (isHostPath && needsSelinuxRelabel()) {
        suffixes.push("Z");
    }
    const suffix = suffixes.length > 0 ? `:${suffixes.join(",")}` : "";
    return ["-v", `${hostPath}:${containerPath}${suffix}`];
}

/**
 * Extra `run` args that are runtime-specific. At the moment this is
 * `--userns=keep-id` on rootless podman. Returned as a flat argv array.
 */
export function runtimeExtraRunArgs(): string[] {
    const info = getRuntimeInfo();
    const extras: string[] = [];
    if (info.runtime === "podman" && info.rootless) {
        extras.push("--userns=keep-id");
    }
    return extras;
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
