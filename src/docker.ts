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

// === Docker Args Builder ===

export interface DockerRunArgsOptions {
    containerName: string;
    fullPath: string;
    projectMountPath: string;
    credentialMounts: Array<{ hostPath: string; containerPath: string }>;
    claudeJsonFile: string;
    miseVolumeName: string;
    pidsLimit: string;
    imageName: string;
    hostSshDir: string | null;
    sshAgentSocket: string | null;
    extraMounts?: Array<{ hostPath: string; containerPath: string }>;
    clipboardPortFile?: string;
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

export function isDockerRunning(): boolean {
    const result = spawnSync(runtimeCli(), ["info"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });
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
            } else if (info.flavor === "linux-rootless") {
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

    const remoteRef = `${DOCKER_REGISTRY_IMAGE}:${CLI_VERSION}`;
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

// === Container Lifecycle ===

export function startProjectContainer(
    projectPath: string,
    ensureDirs: () => void,
    extraMounts?: Array<{ hostPath: string; containerPath: string }>,
    clipboardPortFile?: string,
    profile?: string,
): string {
    ensureDirs();
    ensureImage();

    const fullPath = resolve(projectPath);
    const containerName = getContainerName(fullPath, profile);
    const cli = runtimeCli();

    const debug = !!process.env.DEBUG;

    // Check if existing container is missing worktree git mounts.
    // Instead of destroying and recreating (which changes hostname and breaks
    // Claude Code's --resume conversation listing), warn the user.
    // Critical mounts (project dir, ~/.claude volume) never change — only
    // git mounts for newly-added nested repos can be missing.
    if (isContainerExists(containerName) && extraMounts && extraMounts.length > 0) {
        if (!containerHasMounts(containerName, extraMounts)) {
            if (debug) {
                console.error(`[ccc:debug] Container ${containerName} missing git mounts:`);
                for (const m of extraMounts) {
                    console.error(`[ccc:debug]   required: ${m.hostPath} -> ${m.containerPath}`);
                }
            }
            console.log("Recreating container (missing git mounts for worktree)...");
            spawnSync(cli, ["stop", containerName], { stdio: "ignore" });
            spawnSync(cli, ["rm", containerName], { stdio: "ignore" });
        } else if (debug) {
            console.error(`[ccc:debug] Container ${containerName} has all required mounts`);
        }
    }

    if (isContainerRunning(containerName)) {
        return containerName;
    }

    if (isContainerExists(containerName)) {
        if (debug) console.error(`[ccc:debug] Container ${containerName} exists, restarting`);
        spawnSync(cli, ["start", containerName], { stdio: "inherit" });
        fixSshPermissions(containerName);
        return containerName;
    }

    if (debug) console.error(`[ccc:debug] Container ${containerName} not found, creating`);
    console.log("Creating container...");

    const projectId = getProjectId(fullPath);
    const projectMountPath = `/project/${projectId}`;

    const credentialMounts = getAllCredentialMounts().map(m => {
        // Profile override: claude credentials use profile-specific directory
        const hostPath = (profile && m.containerDir === "/home/ccc/.claude")
            ? getClaudeDir(profile)
            : join(homedir(), m.hostDir);
        mkdirSync(hostPath, { recursive: true });
        return { hostPath, containerPath: m.containerDir };
    });

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
        claudeJsonFile: getClaudeJsonFile(profile),
        miseVolumeName: MISE_VOLUME_NAME,
        pidsLimit: CONTAINER_PID_LIMIT,
        imageName: IMAGE_NAME,
        hostSshDir: existsSync(hostSshDir) ? hostSshDir : null,
        sshAgentSocket,
        extraMounts,
        clipboardPortFile,
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
