// src/docker.ts - Docker container lifecycle management
//
// Extracted from index.ts for separation of concerns.
// Contains: Docker args builder, container CRUD, image checks.

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

// === Docker Args Builder ===

export interface DockerRunArgsOptions {
    containerName: string;
    fullPath: string;
    projectMountPath: string;
    claudeDir: string;
    claudeJsonFile: string;
    hostClaudeIdeDir: string;
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
    const args = [
        "run",
        "-d",
        "--name",
        opts.containerName,
        "--network",
        "host",
        "--security-opt",
        "seccomp=unconfined",
        "--cap-add",
        "NET_ADMIN",
        "-v",
        `${opts.fullPath}:${opts.projectMountPath}`,
        "-v",
        `${opts.claudeDir}:/home/ccc/.claude`,
        "-v",
        `${opts.claudeJsonFile}:/home/ccc/.claude.json`,
        "-v",
        `${opts.hostClaudeIdeDir}:/home/ccc/.claude/ide`,
        "-v",
        `${opts.miseVolumeName}:/home/ccc/.local/share/mise`,
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-w",
        opts.projectMountPath,
        "--pids-limit",
        opts.pidsLimit,
    ];

    // Mount host SSH keys (read-only) for git SSH access
    if (opts.hostSshDir) {
        args.push("-v", `${opts.hostSshDir}:/home/ccc/.ssh:ro`);
        args.push(
            "-e",
            "GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/.ssh-copy/known_hosts -o IdentityFile=/tmp/.ssh-copy/id_rsa -o IdentityFile=/tmp/.ssh-copy/id_ed25519",
        );
    }

    // Forward SSH agent socket
    if (opts.sshAgentSocket) {
        args.push(
            "-v",
            `${opts.sshAgentSocket}:/tmp/ssh-agent.sock`,
            "-e",
            "SSH_AUTH_SOCK=/tmp/ssh-agent.sock",
        );
    }

    // Extra volume mounts (e.g., source .git for worktree workspaces)
    if (opts.extraMounts) {
        for (const mount of opts.extraMounts) {
            args.push("-v", `${mount.hostPath}:${mount.containerPath}`);
        }
    }

    // Mount clipboard port file so shims can read the latest token even after server restarts
    if (opts.clipboardPortFile && existsSync(opts.clipboardPortFile)) {
        args.push("-v", `${opts.clipboardPortFile}:/run/ccc/clipboard.port:ro`);
    }

    args.push(...getComposeLabels(opts.containerName, opts.fullPath));
    args.push(opts.imageName);
    return args;
}

// === Container Name ===

export function getContainerName(projectPath: string, profile?: string): string {
    const base = `ccc-${getProjectId(projectPath)}`;
    if (!profile) return base;
    return `${base}--p--${profile}`;
}

// === Docker Status Checks ===

let _isDockerDesktopCached: boolean | null = null;

/**
 * Detect if Docker is running as Docker Desktop (macOS, Windows, or WSL2).
 * On Docker Desktop, --network host uses a VM and doesn't truly share the host network.
 * Cached for the lifetime of the process (Docker engine type doesn't change mid-session).
 */
export function isDockerDesktop(): boolean {
    if (_isDockerDesktopCached !== null) return _isDockerDesktopCached;

    // macOS/Windows are always Docker Desktop
    if (process.platform !== "linux") {
        _isDockerDesktopCached = true;
        return true;
    }

    // On Linux, check docker info for Docker Desktop (covers WSL2)
    try {
        const result = spawnSync(
            "docker",
            ["info", "--format", "{{.OperatingSystem}}"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if ((result.stdout ?? "").toLowerCase().includes("docker desktop")) {
            _isDockerDesktopCached = true;
            return true;
        }
    } catch {
        // Fall through to secondary check
    }

    // Fallback: detect WSL2 environment (Docker Desktop for Windows with WSL2 backend)
    if (process.env.WSL_DISTRO_NAME) {
        _isDockerDesktopCached = true;
        return true;
    }

    _isDockerDesktopCached = false;
    return false;
}

export function isDockerRunning(): boolean {
    const result = spawnSync("docker", ["info"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });
    return result.status === 0;
}

export function ensureDockerRunning(): void {
    if (!isDockerRunning()) {
        console.error("Error: Docker is not running.");
        console.error("Please start Docker Desktop and try again.");
        process.exit(1);
    }
}

export function isContainerRunning(containerName: string): boolean {
    const result = spawnSync(
        "docker",
        ["ps", "-q", "-f", `name=^${containerName}$`],
        { encoding: "utf-8" },
    );
    return (result.stdout ?? "").trim().length > 0;
}

export function isContainerExists(containerName: string): boolean {
    const result = spawnSync(
        "docker",
        ["ps", "-aq", "-f", `name=^${containerName}$`],
        { encoding: "utf-8" },
    );
    return (result.stdout ?? "").trim().length > 0;
}

export function isImageExists(): boolean {
    const result = spawnSync("docker", ["images", "-q", IMAGE_NAME], {
        encoding: "utf-8",
    });
    return (result.stdout ?? "").trim().length > 0;
}

/**
 * Check if a container's image is outdated compared to the current IMAGE_NAME image.
 * Compares the image SHA the container was created from against the current image SHA.
 * Returns false on any error (fail-open: never block startup due to inspect failure).
 */
export function isContainerImageOutdated(containerName: string): boolean {
    try {
        const containerResult = spawnSync(
            "docker",
            ["inspect", containerName, "--format", "{{.Image}}"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        if (containerResult.status !== 0) return false;

        const imageResult = spawnSync(
            "docker",
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

// === Combined Status (single docker inspect) ===

export interface ContainerStatus {
    exists: boolean;
    running: boolean;
    imageId: string | null;
}

/**
 * Get container existence, running state, and image ID in a single docker inspect.
 * Replaces separate isContainerRunning + isContainerExists + isContainerImageOutdated calls.
 */
export function getContainerStatus(containerName: string): ContainerStatus {
    const result = spawnSync(
        "docker",
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

/**
 * Get the current image ID for IMAGE_NAME. Used with getContainerStatus()
 * to detect outdated containers without extra docker commands.
 */
export function getCurrentImageId(): string | null {
    const result = spawnSync(
        "docker",
        ["inspect", IMAGE_NAME, "--format", "{{.Id}}"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.status !== 0) return null;
    return (result.stdout ?? "").trim() || null;
}

/**
 * Get a Docker image label value.
 * Returns null if the label is missing, the image doesn't exist, or the value is '<no value>'.
 */
export function getImageLabel(imageName: string, label: string): string | null {
    try {
        const result = spawnSync(
            "docker",
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

/**
 * Pull a Docker image. Returns true on success, false on failure.
 * Uses stdio:inherit so the user sees pull progress.
 */
export function pullImage(imageRef: string): boolean {
    const result = spawnSync("docker", ["pull", imageRef], { stdio: "inherit" });
    return result.status === 0;
}

/**
 * Tag a Docker image.
 */
export function tagImage(source: string, target: string): void {
    spawnSync("docker", ["tag", source, target], { stdio: "ignore" });
}

/**
 * Ensure a usable ccc image exists, using label-based version matching:
 * 1. Local ccc with no cli.version label = dev build, use as-is
 * 2. Local ccc with matching cli.version = correct version, use as-is
 * 3. Otherwise pull DOCKER_REGISTRY_IMAGE:CLI_VERSION from registry, tag as ccc
 * 4. On pull failure with stale image: warn and continue
 * 5. On pull failure with no image: exit with error
 */
export function ensureImage(): void {
    const localExists = isImageExists();

    if (localExists) {
        const label = getImageLabel(IMAGE_NAME, "cli.version");
        // No label = dev build (docker build -t ccc .), never auto-replace
        if (label === null) return;
        // Label matches CLI_VERSION = correct version
        if (label === CLI_VERSION) return;
        // Label mismatch = stale image after npm upgrade, fall through to pull
        console.log(`Image version mismatch (have v${label}, need v${CLI_VERSION}). Pulling update...`);
    } else {
        console.log(`Pulling ccc image v${CLI_VERSION} from registry...`);
    }

    // Pull from registry
    const remoteRef = `${DOCKER_REGISTRY_IMAGE}:${CLI_VERSION}`;
    if (pullImage(remoteRef)) {
        tagImage(remoteRef, IMAGE_NAME);
        return;
    }

    // Pull failed
    if (localExists) {
        console.warn(`Warning: Failed to pull ${remoteRef}. Using existing image.`);
        return;
    }

    console.error(`Error: Failed to pull ${remoteRef}.`);
    console.error("You can build locally instead: docker build -t ccc .");
    process.exit(1);
}

// === Clipboard Shim Sync ===

const CLIPBOARD_SHIMS = ["xclip", "xsel", "wl-paste", "wl-copy", "pbpaste"];

export function syncClipboardShims(containerName: string, distDir: string): void {
    const shimsDir = join(distDir, "..", "scripts", "clipboard-shims");
    if (!existsSync(shimsDir)) return;
    const copied: string[] = [];
    for (const shim of CLIPBOARD_SHIMS) {
        const src = join(shimsDir, shim);
        if (existsSync(src)) {
            spawnSync("docker", ["cp", src, `${containerName}:/usr/local/bin/${shim}`]);
            copied.push(`/usr/local/bin/${shim}`);
        }
    }
    if (copied.length > 0) {
        spawnSync("docker", ["exec", containerName, "chmod", "+x", ...copied]);
    }
}

/**
 * Check if a container has all the required volume mounts.
 * Uses `docker inspect` to read current mount configuration.
 */
function containerHasMounts(
    containerName: string,
    requiredMounts: Array<{ hostPath: string; containerPath: string }>,
): boolean {
    const result = spawnSync(
        "docker",
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
            // Compare only Destination (container path) which we control.
            // Source (host path) can differ on macOS Docker Desktop due to
            // /host_mnt/ prefix, symlink resolution, or path canonicalization.
            if (!destinations.has(req.containerPath)) {
                if (process.env.DEBUG) {
                    console.error(`[ccc] Missing mount: ${req.containerPath}`);
                    console.error(`[ccc] Container has: ${[...destinations].join(", ")}`);
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

    spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c", "chmod 666 /tmp/ssh-agent.sock 2>/dev/null; true"],
        { stdio: "ignore" },
    );

    if (existsSync(hostSshDir)) {
        spawnSync(
            "docker",
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

    // Check if existing container needs recreation (e.g., missing worktree git mounts)
    if (isContainerExists(containerName) && extraMounts && extraMounts.length > 0) {
        if (!containerHasMounts(containerName, extraMounts)) {
            console.log("Recreating container (missing git mounts for worktree)...");
            spawnSync("docker", ["stop", containerName], { stdio: "ignore" });
            spawnSync("docker", ["rm", containerName], { stdio: "ignore" });
            // Fall through to create new container below
        }
    }

    if (isContainerRunning(containerName)) {
        return containerName; // Already running — caller can skip setup
    }

    if (isContainerExists(containerName)) {
        spawnSync("docker", ["start", containerName], { stdio: "inherit" });
        fixSshPermissions(containerName);
        return containerName;
    }

    console.log("Creating container...");

    const projectId = getProjectId(fullPath);
    const projectMountPath = `/project/${projectId}`;

    const hostClaudeIdeDir = join(homedir(), ".claude", "ide");
    mkdirSync(hostClaudeIdeDir, { recursive: true });

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
        claudeDir: getClaudeDir(profile),
        claudeJsonFile: getClaudeJsonFile(profile),
        hostClaudeIdeDir,
        miseVolumeName: MISE_VOLUME_NAME,
        pidsLimit: CONTAINER_PID_LIMIT,
        imageName: IMAGE_NAME,
        hostSshDir: existsSync(hostSshDir) ? hostSshDir : null,
        sshAgentSocket,
        extraMounts,
        clipboardPortFile,
    });

    const result = spawnSync("docker", args, { stdio: "inherit" });
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
    spawnSync("docker", ["stop", containerName], { stdio: "inherit" });
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
    spawnSync("docker", ["rm", containerName], { stdio: "inherit" });
    console.log("Container removed");
}
