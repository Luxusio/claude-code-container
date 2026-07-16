// src/docker.ts - Container lifecycle management (runtime-agnostic).
//
// Despite the filename this module drives either Docker or Podman via the
// runtime abstraction in `container-runtime.ts`. The file name is kept to
// avoid a noisy rename; all CLI invocations go through `runtimeCli()` /
// `bindMountArgs()` / `runtimeExtraRunArgs()`.

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import {
    getProjectId,
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
import { deviceLabContainerName } from "./device-lab-owner.js";
import { getAllCredentialMounts } from "./tool-registry.js";
import type { CredentialMount } from "./tool-registry.js";

const MANAGED_MCP_BUNDLES = ["x11-mcp", "device-lab-mcp", "lab-mcp"] as const;
const MANAGED_MCP_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
const DIST_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));

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
    extraMounts?: Array<{ hostPath: string; containerPath: string }>;
    clipboardPortFile?: string;
    clipboardFilesHostDir?: string;
    /**
     * Optional in-container QEMU/KVM contract. Despite the historical
     * `labRunner` name, this is now used for ordinary containers too so
     * lab-mcp can run from the default CCC container when the host supports it.
     */
    labRunner?: LabRunnerRunConfig | null;
    deviceLabStateHostDir?: string;
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
function getComposeLabels(containerName: string, fullPath: string): string[] {
    return [
        "--label", "com.docker.compose.project=ccc",
        "--label", `com.docker.compose.service=${containerName}`,
        "--label", "com.docker.compose.oneoff=False",
        "--label", "com.docker.compose.version=2",
        "--label", "com.docker.compose.container-number=1",
        "--label", "ccc.managed=true",
        "--label", `ccc.project.path=${fullPath}`,
        "--label", `ccc.cli.version=${CLI_VERSION}`,
    ];
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
        args.push(...bindMountArgs(opts.deviceLabStateHostDir, "/home/ccc/.ccc/devices"));
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

    args.push(...getComposeLabels(opts.containerName, opts.fullPath));
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

export function canExecContainer(containerName: string): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["exec", containerName, "true"],
        { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 },
    );
    return result.status === 0;
}

export function isContainerExists(containerName: string): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["ps", "-aq", "-f", `name=^${containerName}$`],
        { encoding: "utf-8" },
    );
    return (result.stdout ?? "").trim().length > 0;
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
    imageId: string | null;
}

export function getContainerStatus(containerName: string): ContainerStatus {
    const result = spawnSync(
        runtimeCli(),
        ["inspect", containerName, "--format", "{{.State.Running}}|{{.Image}}"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.status !== 0) {
        return { exists: false, running: false, imageId: null };
    }
    const output = (result.stdout ?? "").trim();
    const sep = output.indexOf("|");
    return {
        exists: true,
        running: output.substring(0, sep) === "true",
        imageId: sep >= 0 ? output.substring(sep + 1) : null,
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
    requiredMounts: Array<{ hostPath: string; containerPath: string }>,
    labRunner: LabRunnerRunConfig,
): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["inspect", "-f", "{{json .}}", containerName],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.status !== 0) return false;

    try {
        const inspected = JSON.parse((result.stdout ?? "").trim()) as {
            Mounts?: Array<{ Source: string; Destination: string }>;
            Config?: { Env?: string[] };
            HostConfig?: { Devices?: unknown; GroupAdd?: unknown; Privileged?: boolean };
        };
        const mounts = inspected.Mounts || [];
        const env = envMap(inspected.Config?.Env);
        const devices = inspected.HostConfig?.Devices;
        const groupAdd = inspected.HostConfig?.GroupAdd;
        const destinations = new Set(mounts.map((m: {
            Source: string;
            Destination: string;
        }) => m.Destination));
        for (const req of requiredMounts) {
            if (!destinations.has(req.containerPath)) {
                if (process.env.DEBUG) {
                    console.error(`[ccc:debug] containerMatchesRunContract: missing ${req.containerPath}`);
                    console.error(`[ccc:debug] containerMatchesRunContract: container destinations: ${[...destinations].join(", ")}`);
                }
                return false;
            }
        }
        const failContract = (reason: string) => {
            if (process.env.DEBUG) console.error(`[ccc:debug] containerMatchesRunContract: ${reason}`);
            return false;
        };
        if (inspected.HostConfig?.Privileged === true) return failContract("stale privileged container");
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
        return false;
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

function recreateContainer(containerName: string, reason: string, onRecreate?: () => void): void {
    console.log(`Recreating container (${reason})...`);
    const cli = runtimeCli();
    spawnSync(cli, ["stop", containerName], { stdio: "ignore" });
    spawnSync(cli, ["rm", containerName], { stdio: "ignore" });
    onRecreate?.();
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
    extraMounts?: Array<{ hostPath: string; containerPath: string }>,
    clipboardPortFile?: string,
    profile?: string,
    /**
     * Fires when the container is recreated (stop+rm+create) due to missing
     * mounts. Callers should treat this as equivalent to a brand-new container:
     * the writable layer is fresh, so per-container setup (ensureTools, mise
     * install, env config) must re-run even if the old container was running.
     */
    onRecreate?: () => void,
): string {
    ensureDirs();
    mkdirSync(CLIPBOARD_FILES_DIR, { recursive: true });
    ensureImage();

    const fullPath = resolve(projectPath);
    const containerName = getContainerName(fullPath, profile);
    const cli = runtimeCli();
    const deviceLabStateHostDir = join(homedir(), ".ccc", "devices");

    const debug = !!process.env.DEBUG;

    // Recreate the container if it's missing any required mount destination.
    // Required = credential mounts for every registered tool (claude, gemini,
    // codex, opencode) + any worktree git mounts the caller passed in.
    // Otherwise an old container created before a tool was added to the
    // registry would silently miss that tool's auth dir on subsequent runs.
    if (isContainerExists(containerName)) {
        const gitIdentityMounts = getHostGitIdentityMounts();
        const labRunner = buildContainerVmRunConfig(containerName);
        const requiredMounts: Array<{ hostPath: string; containerPath: string }> = [
            ...getAllCredentialMounts().map((m) => ({
                // hostPath isn't checked — only containerPath matters
                hostPath: m.hostDir,
                containerPath: m.containerDir,
            })),
            ...gitIdentityMounts,
            ...(extraMounts ?? []),
            { hostPath: deviceLabStateHostDir, containerPath: "/home/ccc/.ccc/devices" },
            { hostPath: CLIPBOARD_FILES_DIR, containerPath: CLIPBOARD_FILES_CONTAINER_DIR },
        ];
        requiredMounts.push({
            hostPath: labRunner.stateVolumeName,
            containerPath: labRunner.stateContainerDir,
        });
        if (!containerMatchesRunContract(containerName, requiredMounts, labRunner)) {
            if (debug) {
                console.error(`[ccc:debug] Container ${containerName} missing required mounts or VM run contract:`);
                for (const m of requiredMounts) {
                    console.error(`[ccc:debug]   required destination: ${m.containerPath}`);
                }
            }
            recreateContainer(containerName, "missing tool credential / git mounts", onRecreate);
        } else if (debug) {
            console.error(`[ccc:debug] Container ${containerName} has all required mounts`);
        }
    }

    if (isContainerRunning(containerName)) {
        if (canExecContainer(containerName)) {
            syncManagedMcpBundles(containerName);
            syncHostGitConfig(containerName);
            return containerName;
        }
        recreateContainer(containerName, "container exec failed", onRecreate);
    }

    if (isContainerExists(containerName)) {
        if (debug) console.error(`[ccc:debug] Container ${containerName} exists, restarting`);
        spawnSync(cli, ["start", containerName], { stdio: "inherit" });
        if (!canExecContainer(containerName)) {
            recreateContainer(containerName, "container exec failed after restart", onRecreate);
        } else {
            syncManagedMcpBundles(containerName);
            syncHostGitConfig(containerName);
            fixSshPermissions(containerName);
            return containerName;
        }
    }

    if (isContainerExists(containerName)) {
        console.error(`Failed to remove unhealthy container ${containerName}`);
        process.exit(1);
    }

    if (debug) {
        console.error(`[ccc:debug] Container ${containerName} not found, creating`);
    }
    console.log("Creating container...");

    const projectId = getProjectId(fullPath);
    const projectMountPath = `/project/${projectId}`;
    mkdirSync(deviceLabStateHostDir, { recursive: true });

    const credentialMounts = getAllCredentialMounts().map(m => {
        const hostPath = resolveCredentialHostPath(m, profile);
        mkdirSync(hostPath, { recursive: true });
        return { hostPath, containerPath: m.containerDir };
    });
    const gitIdentityMounts = getHostGitIdentityMounts();

    const hostSshDir = join(homedir(), ".ssh");

    let sshAgentSocket: string | null = null;
    if (process.platform === "darwin") {
        sshAgentSocket = "/run/host-services/ssh-auth.sock";
    } else {
        const hostSock = process.env.SSH_AUTH_SOCK;
        if (hostSock && existsSync(hostSock)) {
            sshAgentSocket = hostSock;
        }
    }

    const labRunner = buildContainerVmRunConfig(containerName);
    if (isLabRunnerProfile(profile) && labRunner.status === "unsupported") {
        console.warn(`[ccc] lab-runner profile requested but nested VM support is unavailable: ${labRunner.unsupportedReason}`);
        console.warn("[ccc] lab state volume will still be mounted; lab-mcp should report this provider as unsupported/SKIP.");
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
        hostSshDir: existsSync(hostSshDir) ? hostSshDir : null,
        sshAgentSocket,
        extraMounts,
        clipboardPortFile,
        clipboardFilesHostDir: CLIPBOARD_FILES_DIR,
        labRunner,
        deviceLabStateHostDir,
        // CCC_DISABLE_PROXY is the escape hatch when the runtime-detect
        // heuristics get it wrong (exotic VPN/networking setups, mirrored
        // mode we failed to recognize, etc).
        proxyEnabled: (process.platform !== "linux" || isContainerHostRemote()) && process.env.CCC_DISABLE_PROXY !== "1",
    });

    const result = spawnSync(cli, args, { stdio: "inherit" });
    if (result.status !== 0) {
        console.error("Failed to create container");
        process.exit(1);
    }

    syncManagedMcpBundles(containerName);
    syncHostGitConfig(containerName);
    fixSshPermissions(containerName);

    return containerName;
}

export function stopProjectContainer(projectPath: string, profile?: string): void {
    ensureDockerRunning();
    const fullPath = resolve(projectPath);
    const containerName = getContainerName(fullPath, profile);

    if (!isContainerExists(containerName)) {
        console.log("Container not found");
        return;
    }

    cleanupDevicesBestEffort(fullPath, profile);
    console.log("Stopping container...");
    spawnSync(runtimeCli(), ["stop", containerName], { stdio: "inherit" });
    console.log("Container stopped");
}

export function removeProjectContainer(projectPath: string, profile?: string): void {
    ensureDockerRunning();
    const containerName = getContainerName(resolve(projectPath), profile);

    if (!isContainerExists(containerName)) {
        console.log("Container not found");
        return;
    }

    stopProjectContainer(projectPath, profile);
    console.log("Removing container...");
    spawnSync(runtimeCli(), ["rm", containerName], { stdio: "inherit" });
    console.log("Container removed");
}
