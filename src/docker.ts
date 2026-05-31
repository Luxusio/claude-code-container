// src/docker.ts - Container lifecycle management (runtime-agnostic).
//
// Despite the filename this module drives either Docker or Podman via the
// runtime abstraction in `container-runtime.ts`. The file name is kept to
// avoid a noisy rename; all CLI invocations go through `runtimeCli()` /
// `bindMountArgs()` / `runtimeExtraRunArgs()`.

import { spawnSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import {
    getProjectId,
    getClaudeDir,
    getClaudeJsonFile,
    IMAGE_NAME,
    CONTAINER_PID_LIMIT,
    MISE_VOLUME_NAME,
    CLI_VERSION,
    DOCKER_REGISTRY_IMAGE,
} from "./utils.js";
import {
    runtimeCli,
    bindMountArgs,
    runtimeExtraRunArgs,
    isContainerHostRemote,
    getRuntimeInfo,
} from "./container-runtime.js";
import { getAllCredentialMounts } from "./tool-registry.js";
import type { CredentialMount } from "./tool-registry.js";

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
    /**
     * Tells the in-container entrypoint to install the iptables NAT REDIRECT
     * and start ccc-proxy. Set on Docker Desktop / WSL2 / podman-machine
     * flavors where --network host doesn't actually share the host loopback;
     * left unset on docker-native and rootful podman where it does.
     */
    proxyEnabled?: boolean;
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
    // Named volume — never gets :Z (mount helper auto-detects host-path vs name)
    args.push(...bindMountArgs(opts.miseVolumeName, "/home/ccc/.local/share/mise"));
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

    args.push(...getComposeLabels(opts.containerName, opts.fullPath));
    args.push(opts.imageName);
    return args;
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
    const base = `ccc-${getProjectId(projectPath)}`;
    if (!profile) return base;
    return `${base}--p--${profile}`;
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

/**
 * Check if a container has all the required volume mounts.
 */
function containerHasMounts(
    containerName: string,
    requiredMounts: Array<{ hostPath: string; containerPath: string }>,
): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["inspect", "-f", "{{json .Mounts}}", containerName],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.status !== 0) return false;

    try {
        const mounts = JSON.parse((result.stdout ?? "").trim()) as Array<{
            Source: string;
            Destination: string;
        }>;
        const destinations = new Set(mounts.map((m) => m.Destination));
        for (const req of requiredMounts) {
            if (!destinations.has(req.containerPath)) {
                if (process.env.DEBUG) {
                    console.error(`[ccc:debug] containerHasMounts: missing ${req.containerPath}`);
                    console.error(`[ccc:debug] containerHasMounts: container destinations: ${[...destinations].join(", ")}`);
                }
                return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

// Why host ~/.gitconfig is staged, not mounted at /home/ccc/.gitconfig directly:
// single-file bind mounts anchor the inode, so rename(2) — the call git uses to
// atomically replace .gitconfig after writing .gitconfig.lock — returns EBUSY or
// stalls. Inside the container, scripts/ccc-entrypoint.sh copies
// /host-stage/gitconfig to /home/ccc/.gitconfig at startup, producing a regular
// file on the same filesystem as /home/ccc that supports atomic replace.
// Directory mounts (~/.config/git/) don't have this problem and stay as-is.
export function getHostGitIdentityMounts(): Array<{ hostPath: string; containerPath: string }> {
    const home = homedir();
    const candidates = [
        { hostPath: join(home, ".gitconfig"), containerPath: "/host-stage/gitconfig" },
        { hostPath: join(home, ".config", "git"), containerPath: "/home/ccc/.config/git" },
    ];
    return candidates.filter((mount) => existsSync(mount.hostPath));
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

function recreateContainer(containerName: string, reason: string, onRecreate?: () => void): void {
    console.log(`Recreating container (${reason})...`);
    const cli = runtimeCli();
    spawnSync(cli, ["stop", containerName], { stdio: "ignore" });
    spawnSync(cli, ["rm", containerName], { stdio: "ignore" });
    onRecreate?.();
}

// === Container Lifecycle ===

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
    ensureImage();

    const fullPath = resolve(projectPath);
    const containerName = getContainerName(fullPath, profile);
    const cli = runtimeCli();

    const debug = !!process.env.DEBUG;

    // Recreate the container if it's missing any required mount destination.
    // Required = credential mounts for every registered tool (claude, gemini,
    // codex, opencode) + any worktree git mounts the caller passed in.
    // Otherwise an old container created before a tool was added to the
    // registry would silently miss that tool's auth dir on subsequent runs.
    if (isContainerExists(containerName)) {
        const gitIdentityMounts = getHostGitIdentityMounts();
        const requiredMounts: Array<{ hostPath: string; containerPath: string }> = [
            ...getAllCredentialMounts().map((m) => ({
                // hostPath isn't checked — only containerPath matters
                hostPath: m.hostDir,
                containerPath: m.containerDir,
            })),
            ...gitIdentityMounts,
            ...(extraMounts ?? []),
        ];
        if (!containerHasMounts(containerName, requiredMounts)) {
            if (debug) {
                console.error(`[ccc:debug] Container ${containerName} missing required mounts:`);
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
        // CCC_DISABLE_PROXY is the escape hatch when the runtime-detect
        // heuristics get it wrong (exotic VPN/networking setups, mirrored
        // mode we failed to recognize, etc).
        proxyEnabled: isContainerHostRemote() && process.env.CCC_DISABLE_PROXY !== "1",
    });

    const result = spawnSync(cli, args, { stdio: "inherit" });
    if (result.status !== 0) {
        console.error("Failed to create container");
        process.exit(1);
    }

    fixSshPermissions(containerName);

    return containerName;
}

export function stopProjectContainer(projectPath: string, profile?: string): void {
    ensureDockerRunning();
    const containerName = getContainerName(resolve(projectPath), profile);

    if (!isContainerExists(containerName)) {
        console.log("Container not found");
        return;
    }

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
