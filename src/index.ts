#!/usr/bin/env node

import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import {
    existsSync,
    mkdirSync,
    writeFileSync,
    readdirSync,
    unlinkSync,
    readFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
    formatScannedFiles,
    scanVersionFiles,
    extractVersionHints,
    formatVersionHints,
} from "./scanner.js";
import {
    remoteSetup,
    remoteCheck,
    remoteExec,
    remoteTerminate,
} from "./remote.js";
import {
    hashPath,
    getProjectId,
    EXCLUDE_ENV_KEYS,
    prompt,
    DATA_DIR,
    CLAUDE_DIR,
    CLAUDE_JSON_FILE,
    IMAGE_NAME,
    CONTAINER_PID_LIMIT,
    MISE_VOLUME_NAME,
} from "./utils.js";
import { syncCredentials } from "./credentials.js";
import {
    ensureClipboardServer,
    stopClipboardServerIfLast,
} from "./clipboard-server.js";
import {
    parseWorktreeArg,
    validateBranchName,
    listWorkspaces,
    createWorkspace,
    removeWorkspace,
    getWorkspacePath,
    workspaceExists,
    readWorkspaceMetadata,
    needsSubmoduleSetup,
    initWithSubmodules,
} from "./worktree.js";

// Re-export for tests
export { hashPath, getProjectId } from "./utils.js";

// === Docker Args Builder (exported for testing) ===
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
        // Use copied SSH keys (/tmp/.ssh-copy) to avoid UID mismatch permissions
        // StrictHostKeyChecking=accept-new: auto-accept first-seen host keys
        // UserKnownHostsFile=/tmp/.ssh-copy/known_hosts: writable known_hosts
        args.push(
            "-e",
            "GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/.ssh-copy/known_hosts -o IdentityFile=/tmp/.ssh-copy/id_rsa -o IdentityFile=/tmp/.ssh-copy/id_ed25519",
        );
    }

    // Forward SSH agent socket for key-based auth without exposing key files
    // On macOS: Docker Desktop provides /run/host-services/ssh-auth.sock inside the VM
    // On Linux: mount the host's $SSH_AUTH_SOCK directly
    if (opts.sshAgentSocket) {
        args.push(
            "-v",
            `${opts.sshAgentSocket}:/tmp/ssh-agent.sock`,
            "-e",
            "SSH_AUTH_SOCK=/tmp/ssh-agent.sock",
        );
    }

    args.push(opts.imageName);
    return args;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === Configuration ===
const locksDir = join(DATA_DIR, "locks");
const hostClaudeIdeDir = join(homedir(), ".claude", "ide"); // Host IDE lock files

// === Session State ===
let currentSessionLockFile: string | null = null;
let currentProjectPath: string | null = null;

// === Helpers ===
function ensureDirs(): void {
    mkdirSync(DATA_DIR, { recursive: true });
    mkdirSync(CLAUDE_DIR, { recursive: true });
    mkdirSync(locksDir, { recursive: true });
    // Ensure claude.json exists for file mount (onboarding state)
    if (!existsSync(CLAUDE_JSON_FILE)) {
        writeFileSync(CLAUDE_JSON_FILE, "{}");
    }
    ensureBrowserMcp();
}

function ensureBrowserMcp(): void {
    // Claude Code reads user-level MCP config from ~/.claude.json (NOT ~/.claude/mcp.json)
    // CLAUDE_JSON_FILE (~/.ccc/claude.json) is mounted to /home/ccc/.claude.json in container
    let config: Record<string, unknown> = {};

    if (existsSync(CLAUDE_JSON_FILE)) {
        try {
            config = JSON.parse(readFileSync(CLAUDE_JSON_FILE, "utf-8"));
        } catch {
            config = {};
        }
    }

    if (!config.mcpServers || typeof config.mcpServers !== "object") {
        config.mcpServers = {};
    }

    const mcpServers = config.mcpServers as Record<string, unknown>;
    // Use mise exec to run with Node.js 22+ regardless of project's Node version
    // Docker container needs --executablePath for Chromium and sandbox-related flags
    mcpServers["chrome-devtools"] = {
        command: "mise",
        args: [
            "exec",
            "node@22",
            "--",
            "npx",
            "-y",
            "chrome-devtools-mcp@latest",
            "--headless",
            "--isolated",
            "--executablePath=/usr/bin/chromium",
            "--chromeArg=--no-sandbox",
            "--chromeArg=--disable-setuid-sandbox",
            "--chromeArg=--disable-dev-shm-usage",
            // Map localhost to host.docker.internal so container can access host's web servers
            "--chromeArg=--host-resolver-rules=MAP localhost host.docker.internal",
        ],
    };

    // Remove old playwright MCP if exists
    delete mcpServers["playwright"];

    writeFileSync(CLAUDE_JSON_FILE, JSON.stringify(config, null, 2));
}

// === Lock File Management ===
function createSessionLock(projectId: string): string {
    const sessionId = randomBytes(16).toString("hex");
    const lockFile = join(locksDir, `${projectId}-${sessionId}.lock`);
    writeFileSync(lockFile, String(process.pid));
    return lockFile;
}

function removeSessionLock(lockFile: string): void {
    try {
        if (existsSync(lockFile)) {
            unlinkSync(lockFile);
        }
    } catch {
        // Ignore errors during cleanup
    }
}

function getActiveSessionsForProject(projectId: string): string[] {
    if (!existsSync(locksDir)) {
        return [];
    }

    return readdirSync(locksDir).filter(
        (f) => f.startsWith(`${projectId}-`) && f.endsWith(".lock"),
    );
}

function hasOtherActiveSessions(
    projectId: string,
    currentLockFile: string,
): boolean {
    const sessions = getActiveSessionsForProject(projectId);
    const currentLockName = basename(currentLockFile);
    return sessions.some((s) => s !== currentLockName);
}

function cleanupSession(): void {
    if (!currentSessionLockFile || !currentProjectPath) {
        return;
    }

    const projectId = getProjectId(currentProjectPath);
    const hasOthers = hasOtherActiveSessions(projectId, currentSessionLockFile);

    // Stop clipboard server if this is the last CCC session (check BEFORE removing lock)
    stopClipboardServerIfLast(currentSessionLockFile);

    // Remove our lock file
    removeSessionLock(currentSessionLockFile);

    // Stop container if no other sessions are using this project
    if (!hasOthers) {
        const containerName = getContainerName(currentProjectPath);
        if (isContainerRunning(containerName)) {
            // Save claude binary to volume before stopping (handles `claude update`)
            saveClaudeBinaryToVolume(containerName);
            spawnSync("docker", ["stop", containerName], { stdio: "ignore" });
        }
    }

    currentSessionLockFile = null;
    currentProjectPath = null;
}

// Setup signal handlers for cleanup
function setupSignalHandlers(): void {
    const cleanup = () => {
        cleanupSession();
        process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGHUP", cleanup);
}

export function getContainerName(projectPath: string): string {
    return `ccc-${getProjectId(projectPath)}`;
}

function isDockerRunning(): boolean {
    const result = spawnSync("docker", ["info"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });
    return result.status === 0;
}

function ensureDockerRunning(): void {
    if (!isDockerRunning()) {
        console.error("Error: Docker is not running.");
        console.error("Please start Docker Desktop and try again.");
        process.exit(1);
    }
}

function isContainerRunning(containerName: string): boolean {
    const result = spawnSync(
        "docker",
        ["ps", "-q", "-f", `name=^${containerName}$`],
        { encoding: "utf-8" },
    );
    return (result.stdout ?? "").trim().length > 0;
}

function isContainerExists(containerName: string): boolean {
    const result = spawnSync(
        "docker",
        ["ps", "-aq", "-f", `name=^${containerName}$`],
        { encoding: "utf-8" },
    );
    return (result.stdout ?? "").trim().length > 0;
}

function isImageExists(): boolean {
    const result = spawnSync("docker", ["images", "-q", IMAGE_NAME], {
        encoding: "utf-8",
    });
    return (result.stdout ?? "").trim().length > 0;
}

function ensureImage(): void {
    if (!isImageExists()) {
        console.error(
            "ccc image not found. Go to claude-code-container directory and run 'sudo node scripts/install.js'",
        );
        process.exit(1);
    }
}

// Claude binary persist path inside the mise volume
const CLAUDE_PERSIST_DIR = "/home/ccc/.local/share/mise/.claude-bin";
const CLAUDE_BIN_PATH = "/home/ccc/.local/bin/claude";

/**
 * Check if a file in the container is a mise shim (shell script referencing mise)
 * rather than a real native binary.
 */
function isMiseShim(containerName: string, path: string): boolean {
    const result = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c", `head -c 500 ${path} 2>/dev/null | grep -q mise`],
        { encoding: "utf-8" },
    );
    return result.status === 0;
}

/**
 * Verify the binary at the given path is actually claude by checking --version output.
 * Guards against bun or other binaries accidentally cached at the claude path.
 */
function isValidClaudeBinary(containerName: string, path: string): boolean {
    const result = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c", `${path} --version 2>&1 | grep -qi claude`],
        { encoding: "utf-8", timeout: 10000 },
    );
    return result.status === 0;
}

/**
 * Ensure claude binary is available in the container.
 * 1. If real claude binary exists at known path → do nothing
 * 2. If volume has a valid cached copy → symlink it
 * 3. Otherwise → fresh install and cache to volume
 *
 * Detects and purges stale mise shims that can masquerade as the binary.
 */
function ensureClaudeInContainer(containerName: string): void {
    // Check if claude binary actually exists at the known path.
    // Do NOT use `command -v claude` — a stale mise shim can fool it.
    const check = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c", `test -x ${CLAUDE_BIN_PATH}`],
        { encoding: "utf-8" },
    );
    if (check.status === 0) {
        // Verify it's a real binary, not a mise shim script
        if (!isMiseShim(containerName, CLAUDE_BIN_PATH)) {
            // Also verify it's actually claude (not bun or another binary cached by mistake)
            if (isValidClaudeBinary(containerName, CLAUDE_BIN_PATH)) {
                return;
            }
            console.log("Binary at claude path is not valid claude, removing...");
        } else {
            console.log("Detected stale mise shim at claude path, removing...");
        }
        spawnSync(
            "docker",
            ["exec", containerName, "sh", "-c", `rm -f ${CLAUDE_BIN_PATH}`],
            { stdio: "ignore" },
        );
    }

    // Check if volume has cached claude binary
    const volumeCheck = spawnSync(
        "docker",
        ["exec", containerName, "sh", "-c", `test -x ${CLAUDE_PERSIST_DIR}/claude`],
        { encoding: "utf-8" },
    );

    if (volumeCheck.status === 0) {
        // Verify cached copy is a real binary, not a mise shim or wrong binary
        if (isMiseShim(containerName, `${CLAUDE_PERSIST_DIR}/claude`)) {
            console.log("Cached claude is a mise shim, purging cache...");
            spawnSync(
                "docker",
                ["exec", containerName, "sh", "-c", `rm -f ${CLAUDE_PERSIST_DIR}/claude`],
                { stdio: "ignore" },
            );
            // Fall through to fresh install
        } else if (!isValidClaudeBinary(containerName, `${CLAUDE_PERSIST_DIR}/claude`)) {
            console.log("Cached binary is not valid claude, purging cache...");
            spawnSync(
                "docker",
                ["exec", containerName, "sh", "-c", `rm -f ${CLAUDE_PERSIST_DIR}/claude`],
                { stdio: "ignore" },
            );
            // Fall through to fresh install
        } else {
            // Restore from volume cache via symlink
            console.log("Restoring claude from cache...");
            spawnSync(
                "docker",
                [
                    "exec",
                    containerName,
                    "sh",
                    "-c",
                    `mkdir -p $(dirname ${CLAUDE_BIN_PATH}) && ln -sf ${CLAUDE_PERSIST_DIR}/claude ${CLAUDE_BIN_PATH}`,
                ],
                { stdio: "inherit" },
            );
            return;
        }
    }

    // Fresh install and save to volume
    console.log("Installing claude (first run)...");
    const installResult = spawnSync(
        "docker",
        [
            "exec",
            containerName,
            "sh",
            "-c",
            `curl -fsSL https://claude.ai/install.sh | bash && mkdir -p ${CLAUDE_PERSIST_DIR} && cp ${CLAUDE_BIN_PATH} ${CLAUDE_PERSIST_DIR}/claude`,
        ],
        { stdio: "inherit" },
    );
    if (installResult.status !== 0) {
        throw new Error("Failed to install claude in container");
    }
}

/**
 * Ensure global npm tools (gemini-cli, codex) are installed.
 *
 * Uses `mise exec node@22 --` for both install and wrapper scripts so that
 * project-local node versions (e.g. node 14) don't hide or break these tools.
 * Wrapper scripts in ~/.local/bin/ (before shims on PATH) guarantee the tools
 * are always available regardless of the active node version.
 */
export function ensureGlobalNpmTools(containerName: string): void {
    const tools = [
        { cmd: "gemini", pkg: "@google/gemini-cli" },
        { cmd: "codex", pkg: "@openai/codex" },
    ];

    // Check wrapper scripts in ~/.local/bin/ (not shims)
    const missing = tools.filter((t) => {
        const check = spawnSync(
            "docker",
            ["exec", containerName, "sh", "-c", `test -x /home/ccc/.local/bin/${t.cmd}`],
            { encoding: "utf-8" },
        );
        return check.status !== 0;
    });

    if (missing.length === 0) {
        return;
    }

    // Install under node@22 (persists in mise volume)
    const pkgs = missing.map((t) => t.pkg).join(" ");
    console.log(`Installing ${missing.map((t) => t.cmd).join(", ")}...`);

    // Clean stale npm temp directories that cause ENOTEMPTY on reinstall.
    // npm renames existing packages to `.<name>-<random>` before replacing them;
    // if a previous install was interrupted, these leftover dirs block the next attempt.
    // Only target the specific packages being installed to avoid side effects.
    const cleanupPatterns = missing.map((t) => {
        const name = t.pkg.split("/").pop(); // e.g. "gemini-cli", "codex"
        const scope = t.pkg.includes("/") ? t.pkg.split("/")[0] + "/" : "";
        return `"$gdir/${scope}.${name}-"*`;
    }).join(" ");
    // Use -w /home/ccc to avoid project-level mise.toml interfering
    // (project may have untrusted/malformed config or different node version)
    spawnSync(
        "docker",
        [
            "exec", "-w", "/home/ccc", containerName, "sh", "-c",
            `gdir=$(~/.local/bin/mise exec node@22 -- npm root -g 2>/dev/null) && rm -rf ${cleanupPatterns} 2>/dev/null; true`,
        ],
        { stdio: "ignore" },
    );

    const installResult = spawnSync(
        "docker",
        [
            "exec", "-w", "/home/ccc", containerName, "sh", "-c",
            `~/.local/bin/mise exec node@22 -- npm install -g ${pkgs}`,
        ],
        { stdio: "inherit" },
    );
    if (installResult.status !== 0) {
        console.warn("Warning: Failed to install some global npm tools (non-fatal)");
        return;
    }

    // Create wrapper scripts that always run with node@22
    // Use -w /home/ccc to avoid project mise.toml interference
    for (const t of missing) {
        spawnSync(
            "docker",
            [
                "exec", "-w", "/home/ccc", containerName, "sh", "-c",
                `cat > /home/ccc/.local/bin/${t.cmd} << 'WRAPPER'\n#!/bin/sh\nexec ~/.local/bin/mise exec node@22 -- ${t.cmd} "$@"\nWRAPPER\nchmod +x /home/ccc/.local/bin/${t.cmd}`,
            ],
            { stdio: "pipe" },
        );
    }
}

/**
 * Save claude binary back to volume (in case `claude update` replaced the symlink).
 * Uses cp -L to follow symlinks and copy the actual file content.
 * Skips saving if the binary is a mise shim (to avoid poisoning the cache).
 */
function saveClaudeBinaryToVolume(containerName: string): void {
    // Don't cache mise shims — only save real native binaries
    if (isMiseShim(containerName, CLAUDE_BIN_PATH)) {
        return;
    }
    // Don't cache non-claude binaries (e.g., bun accidentally at the claude path)
    if (!isValidClaudeBinary(containerName, CLAUDE_BIN_PATH)) {
        return;
    }
    spawnSync(
        "docker",
        [
            "exec",
            containerName,
            "sh",
            "-c",
            `mkdir -p ${CLAUDE_PERSIST_DIR} && [ -x ${CLAUDE_BIN_PATH} ] && cp -L ${CLAUDE_BIN_PATH} ${CLAUDE_PERSIST_DIR}/claude || true`,
        ],
        { stdio: "ignore" },
    );
}

function startProjectContainer(projectPath: string): string {
    ensureDirs();
    ensureImage();

    const fullPath = resolve(projectPath);
    const containerName = getContainerName(fullPath);

    if (isContainerRunning(containerName)) {
        return containerName;
    }

    if (isContainerExists(containerName)) {
        spawnSync("docker", ["start", containerName], { stdio: "inherit" });
        return containerName;
    }

    console.log("Creating container...");

    const projectId = getProjectId(fullPath);
    const projectMountPath = `/project/${projectId}`;

    // Ensure host IDE directory exists for mount
    mkdirSync(hostClaudeIdeDir, { recursive: true });

    const hostSshDir = join(homedir(), ".ssh");

    // Detect SSH agent socket per platform
    // macOS Docker Desktop: provides a built-in socket at /run/host-services/ssh-auth.sock
    // Linux: use $SSH_AUTH_SOCK if it exists on the host filesystem
    let sshAgentSocket: string | null = null;
    if (process.platform === "darwin") {
        // Docker Desktop for Mac always exposes this path inside the VM
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
        claudeDir: CLAUDE_DIR,
        claudeJsonFile: CLAUDE_JSON_FILE,
        hostClaudeIdeDir,
        miseVolumeName: MISE_VOLUME_NAME,
        pidsLimit: CONTAINER_PID_LIMIT,
        imageName: IMAGE_NAME,
        hostSshDir: existsSync(hostSshDir) ? hostSshDir : null,
        sshAgentSocket,
    });

    const result = spawnSync("docker", args, { stdio: "inherit" });
    if (result.status !== 0) {
        console.error("Failed to create container");
        process.exit(1);
    }

    // Fix SSH key permissions: copy from ro mount to writable location
    // This solves UID mismatch (host user UID != container ccc UID 1000)
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

    return containerName;
}

function stopProjectContainer(projectPath: string): void {
    ensureDockerRunning();
    const containerName = getContainerName(resolve(projectPath));

    if (!isContainerExists(containerName)) {
        console.log("Container not found");
        return;
    }

    console.log("Stopping container...");
    spawnSync("docker", ["stop", containerName], { stdio: "inherit" });
    console.log("Container stopped");
}

function removeProjectContainer(projectPath: string): void {
    ensureDockerRunning();
    const containerName = getContainerName(resolve(projectPath));

    if (!isContainerExists(containerName)) {
        console.log("Container not found");
        return;
    }

    stopProjectContainer(projectPath);
    console.log("Removing container...");
    spawnSync("docker", ["rm", containerName], { stdio: "inherit" });
    console.log("Container removed");
}

// Detect project tools using Claude CLI and write mise.toml
function detectProjectToolsAndWriteMiseConfig(projectPath: string): void {
    const miseConfigPath = join(projectPath, "mise.toml");

    console.log("Scanning project files...");
    const scannedFiles = scanVersionFiles(projectPath);
    const hints = extractVersionHints(scannedFiles);
    const hintsText = formatVersionHints(hints);
    const filesContext = formatScannedFiles(scannedFiles);

    console.log(
        `Found ${scannedFiles.size} version file(s), ${hints.length} version hint(s). Analyzing with Claude...`,
    );

    const defaultContent = `[tools]
# No tools detected - add your tools here
# node = "22"
`;

    const promptText = `${hintsText}${filesContext}

Task: Write "${miseConfigPath}" using Write tool.

Rules:
- Use pre-extracted versions above when available
- DO NOT output text, explanation, or markdown
- DO NOT add comments to the file
- DO NOT invent tools not found above
- Allowed tools: node, java, python, go, rust, ruby, php, deno, bun, terraform, kotlin, elixir, zig, dotnet
- Java format: "temurin-17" or "temurin-21"
- Defaults (only if unclear): node="22", python="3.12", java="temurin-21", go="1.23", rust="1.83"

Format:
[tools]
<tool> = "<version>"

If no tools:
${defaultContent}`;

    spawnSync("claude", ["-p", promptText, "--allowedTools", "Read,Write"], {
        encoding: "utf-8",
        cwd: projectPath,
        timeout: 60000,
        stdio: "inherit",
    });

    // Ensure file exists with default content if Claude didn't create it
    if (!existsSync(miseConfigPath)) {
        writeFileSync(miseConfigPath, defaultContent);
    }

    console.log(`Created: ${miseConfigPath}`);
}

// Check if mise.toml exists and offer to create if not
async function ensureMiseConfig(projectPath: string): Promise<void> {
    const miseConfigPath = join(projectPath, "mise.toml");

    if (existsSync(miseConfigPath)) {
        return;
    }

    console.log(`\nNo mise.toml found in project.`);
    const answer = await prompt(
        "Create mise.toml? (auto-detect tools) [Y/n]: ",
        true,
    );

    if (answer === "" || answer === "y" || answer === "yes") {
        detectProjectToolsAndWriteMiseConfig(projectPath);
    } else {
        console.log("Skipping mise.toml creation.");
    }
}

async function exec(
    projectPath: string,
    cmd: string[],
    options: { interactive?: boolean; env?: Record<string, string> } = {},
): Promise<void> {
    // Check Docker is running first
    ensureDockerRunning();

    const fullPath = resolve(projectPath);

    // Ensure directories exist before syncing credentials
    ensureDirs();

    // Sync and refresh credentials from host system
    // await syncCredentials({claudeDir: CLAUDE_DIR});

    // Check for mise.toml and offer to create if not exists
    await ensureMiseConfig(fullPath);

    // Create session lock BEFORE starting container so other sessions
    // see us during their cleanup and don't stop the container prematurely.
    // This prevents a race condition where:
    //   Terminal A cleanup checks for other sessions → finds none → stops container
    //   Terminal B is still setting up but hasn't created its lock yet → container dies
    const projectId = getProjectId(fullPath);
    currentProjectPath = fullPath;
    currentSessionLockFile = createSessionLock(projectId);
    setupSignalHandlers();

    // Start or get container
    const containerName = startProjectContainer(fullPath);

    // Ensure claude binary is available (cached in volume or fresh install).
    // Retry once if a concurrent session stopped the container during setup.
    for (let attempt = 0; attempt < 2; attempt++) {
        if (!isContainerRunning(containerName)) {
            console.log("Container stopped during setup (concurrent session), restarting...");
            startProjectContainer(fullPath);
        }
        try {
            ensureClaudeInContainer(containerName);
            break;
        } catch {
            if (attempt === 1) {
                console.error("Failed to install claude in container");
                process.exit(1);
            }
            // Container may have been stopped mid-install; loop will restart it
        }
    }
    ensureGlobalNpmTools(containerName);

    // Start clipboard server (singleton, shared across all sessions)
    let clipboardPort: number | null = null;
    try {
        clipboardPort = await ensureClipboardServer();
    } catch {
        // Non-fatal: clipboard paste won't work but everything else is fine
    }

    // Verify container is still running before exec.
    // Another session's cleanup could have stopped it between our setup steps.
    if (!isContainerRunning(containerName)) {
        console.log("Container was stopped during setup, restarting...");
        startProjectContainer(fullPath);
    }

    // Build docker exec command
    const projectMountPath = `/project/${projectId}`;

    // Forward host env vars to the container via -e flags (denylist approach).
    // Excludes system/platform vars that are meaningless inside the container.
    const excludeUpper = new Set([...EXCLUDE_ENV_KEYS].map((k) => k.toUpperCase()));

    const execArgs = ["exec", "-w", projectMountPath];

    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (excludeUpper.has(key.toUpperCase())) continue;
        // Skip env vars with Windows paths (useless in Linux container)
        if (/^[A-Za-z]:[/\\]/.test(value)) continue;
        if (/;[A-Za-z]:[/\\]/.test(value)) continue;
        execArgs.push("-e", `${key}=${value}`);
    }

    // Per-session --env options (override/supplement)
    if (options.env) {
        for (const [key, value] of Object.entries(options.env)) {
            execArgs.push("-e", `${key}=${value}`);
        }
    }

    // Clipboard bridge: pass URL + auth token to container so shim scripts can reach host clipboard server
    if (clipboardPort) {
        const clipboardHost = process.platform === "linux" ? "127.0.0.1" : "host.docker.internal";
        execArgs.push("-e", `CCC_CLIPBOARD_URL=http://${clipboardHost}:${clipboardPort}`);
        // Read token from port file for container auth
        try {
            const portFileContent = readFileSync(join(DATA_DIR, "clipboard.port"), "utf-8").trim();
            const clipToken = portFileContent.split(":").slice(1).join(":");
            if (clipToken) {
                execArgs.push("-e", `CCC_CLIPBOARD_TOKEN=${clipToken}`);
            }
        } catch { /* token unavailable - shims will work without auth */ }
    }

    // Node compat: ensure OMC hooks/MCP servers get Node 22 via mise override.
    // BASH_ENV resets it for Claude's Bash tool so project code uses project node.
    // Must be AFTER host env forwarding (to override any host MISE_NODE_VERSION).
    if (cmd[0] === "claude") {
        execArgs.push("-e", "MISE_NODE_VERSION=22");
        execArgs.push("-e", "BASH_ENV=/home/ccc/.bashrc_hooks");
    }

    if (options.interactive !== false) {
        execArgs.push("-it");
    }

    execArgs.push(containerName);

    // For claude, run mise setup and claude as SEPARATE docker exec calls.
    // Running them in a single sh -c caused mise's shell hooks to intercept
    // the exec syscall, producing spurious "Argument list too long" errors.
    if (cmd[0] === "claude") {
        // Step 1: mise setup (trust, install, reshim) — separate exec
        spawnSync(
            "docker",
            [
                "exec", "-w", projectMountPath, containerName,
                "sh", "-c",
                `find ${projectMountPath} -name "mise.toml" -o -name ".mise.toml" 2>/dev/null | xargs -I{} mise trust {} 2>/dev/null; mise install -y 2>/dev/null || true; mise reshim 2>/dev/null || true`,
            ],
            { stdio: "inherit" },
        );

        // Re-verify claude wasn't overwritten by mise reshim (e.g., bun shim at the path)
        ensureClaudeInContainer(containerName);

        // Step 2: run claude directly (no shell wrapper — avoids mise interception)
        execArgs.push(CLAUDE_BIN_PATH, ...cmd.slice(1));
    } else {
        execArgs.push(...cmd);
    }

    spawnSync("docker", execArgs, { stdio: "inherit" });

    // Cleanup on normal exit
    cleanupSession();
}

function showStatus(): void {
    ensureDockerRunning();
    console.log("\n=== CCC Status ===\n");

    // Image status
    if (isImageExists()) {
        console.log("Image: Built ✓");
    } else {
        console.log("Image: Not built");
    }

    // List all ccc containers
    const result = spawnSync(
        "docker",
        [
            "ps",
            "-a",
            "--filter",
            "name=^ccc-",
            "--format",
            "{{.Names}}\t{{.Status}}",
        ],
        { encoding: "utf-8" },
    );
    const containers = (result.stdout ?? "").trim().split("\n").filter(Boolean);

    console.log("\nContainers:");
    if (containers.length === 0) {
        console.log("  (none)");
    } else {
        containers.forEach((c) => {
            const [name, ...status] = c.split("\t");
            console.log(`  - ${name}: ${status.join("\t")}`);
        });
    }

    console.log("");
}

// === Worktree Handlers ===

function handleWorktreeList(cwd: string): void {
    const workspaces = listWorkspaces(cwd);

    if (workspaces.length === 0) {
        console.log("No workspaces found.");
        console.log(`\nCreate one with: ccc @<branch>`);
        return;
    }

    console.log("\n=== Workspaces ===\n");

    for (const ws of workspaces) {
        const containerName = getContainerName(ws.path);
        let status = "";
        try {
            if (isContainerRunning(containerName)) {
                status = " (running)";
            } else if (isContainerExists(containerName)) {
                status = " (stopped)";
            }
        } catch {
            // Docker may not be running
        }

        console.log(`  @${ws.branch}`);
        console.log(`    path: ${ws.path}`);
        if (status) {
            console.log(`    container: ${containerName}${status}`);
        }
    }

    console.log("");
}

async function handleWorktreeCommand(
    cwd: string,
    branch: string,
    subArgs: string[],
    env: Record<string, string>,
): Promise<void> {
    // Validate branch name early (C1 fix)
    try {
        validateBranchName(branch);
    } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        process.exit(1);
    }

    const subCommand = subArgs[0];

    // ccc @branch rm [-f]
    if (subCommand === "rm") {
        const force = subArgs.includes("-f") || subArgs.includes("--force");
        handleWorktreeRemove(cwd, branch, force);
        return;
    }

    // Create or reuse workspace, then run ccc
    const wsPath = getWorkspacePath(cwd, branch);

    if (workspaceExists(cwd, branch)) {
        // Check for branch collision (C2 fix): different branch names can map
        // to the same workspace path (e.g., feature/login → feature-login)
        const meta = readWorkspaceMetadata(wsPath);
        if (meta && meta.branch !== branch) {
            console.error(
                `Error: Workspace exists for branch '${meta.branch}', not '${branch}'.`,
            );
            console.error(
                `Different branches map to the same directory due to '/' → '-' conversion.`,
            );
            process.exit(1);
        }
        console.log(`Using existing workspace: ${wsPath}`);
    } else {
        // Check if submodule setup is needed (not a git repo but has child git repos)
        const submoduleRepos = needsSubmoduleSetup(cwd);
        if (submoduleRepos) {
            console.log(`This directory is not a git repository.`);
            console.log(`Found git repos: ${submoduleRepos.join(", ")}`);
            const answer = await prompt(
                `Initialize as git repo and add them as submodules? (y/N) `,
                true,
            );
            if (answer === "y" || answer === "yes") {
                try {
                    initWithSubmodules(cwd);
                    console.log(`Initialized git repo with submodules.`);
                } catch (e) {
                    console.error(`Error: ${(e as Error).message}`);
                    process.exit(1);
                }
            }
        }

        console.log(`Creating workspace for branch '${branch}'...`);
        try {
            const result = createWorkspace(cwd, branch);
            console.log(`Workspace created: ${result.workspacePath}`);

            for (const repo of result.created) {
                const actionLabel =
                    repo.action === "worktree-existing"
                        ? "existing branch"
                        : repo.action === "worktree-remote"
                          ? "from remote"
                          : "new branch";
                console.log(`  ${repo.name}: worktree (${actionLabel})`);
            }
            for (const name of result.copied) {
                console.log(`  ${name}: copied`);
            }
        } catch (e) {
            console.error(`Error: ${(e as Error).message}`);
            process.exit(1);
        }
    }

    // Collect remaining args that are claude flags (e.g., --continue)
    const claudeFlags = subArgs.filter((a) => a.startsWith("-"));

    // Run ccc in the workspace directory
    if (claudeFlags.length > 0) {
        await exec(
            wsPath,
            ["claude", "--dangerously-skip-permissions", ...claudeFlags],
            { env },
        );
    } else {
        await exec(wsPath, ["claude", "--dangerously-skip-permissions"], {
            env,
        });
    }
}

function handleWorktreeRemove(
    cwd: string,
    branch: string,
    force: boolean,
): void {
    const wsPath = getWorkspacePath(cwd, branch);

    // Check for active sessions before removing (M2/M3 fix)
    const wsProjectId = getProjectId(wsPath);
    const activeSessions = getActiveSessionsForProject(wsProjectId);
    if (activeSessions.length > 0 && !force) {
        console.error(
            `Error: Workspace @${branch} has ${activeSessions.length} active session(s).`,
        );
        console.error(`Stop sessions first or use -f to force removal.`);
        process.exit(1);
    }

    // Stop and remove associated container first
    try {
        ensureDockerRunning();
        const containerName = getContainerName(wsPath);
        if (isContainerExists(containerName)) {
            console.log(`Stopping container ${containerName}...`);
            spawnSync("docker", ["stop", containerName], { stdio: "ignore" });
            spawnSync("docker", ["rm", containerName], { stdio: "ignore" });
        }
    } catch {
        // Docker not running, skip container cleanup
    }

    console.log(`Removing workspace @${branch}...`);
    try {
        const result = removeWorkspace(cwd, branch, { force });

        for (const name of result.removed) {
            console.log(`  removed: ${name}`);
        }
        for (const err of result.errors) {
            console.error(`  error: ${err}`);
        }

        if (result.errors.length > 0 && !force) {
            console.error(`\nSome items could not be removed. Use -f to force.`);
            process.exit(1);
        } else {
            console.log("Workspace removed.");
        }
    } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        process.exit(1);
    }
}

function showHelp(): void {
    console.log(`
ccc - Claude Code Container

USAGE:
    ccc                     Run claude in current project
    ccc shell               Open bash shell in current project
    ccc update              Update claude to latest version
    ccc <command>           Run command in current project

WORKTREES (multi-repo workspace):
    ccc @<branch>           Create worktree workspace + run claude
    ccc @<branch> --continue  Pass claude flags to worktree session
    ccc @                   List all workspaces
    ccc @<branch> rm        Remove workspace (container + worktrees)
    ccc @<branch> rm -f     Force remove dirty worktrees

CONTAINER MANAGEMENT:
    ccc stop                Stop current project's container
    ccc rm                  Remove current project's container
    ccc status              Show all containers status

REMOTE (run on remote host via Tailscale + Mutagen):
    ccc remote <host>       Connect to host (first time: prompts for config)
    ccc remote              Connect using saved config
    ccc remote setup        Setup guide for remote development
    ccc remote check        Check connectivity and sync status
    ccc remote terminate    Stop sync session for this project

OPTIONS:
    --env KEY=VALUE         Set environment variable
    -h, --help              Show this help

EXAMPLES:
    ccc                     # Run Claude in current project
    ccc --continue          # Continue previous Claude session
    ccc shell               # Open shell in current project
    ccc npm install         # Run npm install in container
    ccc --env API_KEY=xxx   # Run with custom env var
    ccc @feature            # Create workspace + run Claude
    ccc @feature/login      # Branch with / (dir name uses -)
    ccc @                   # List workspaces
    ccc @feature rm         # Remove workspace
`);
}

// === Main ===
async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Parse --env flags
    const customEnv: Record<string, string> = {};
    const filteredArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--env" && args[i + 1]) {
            const match = args[i + 1].match(/^([^=]+)=(.*)$/);
            if (match) {
                customEnv[match[1]] = match[2];
            }
            i++;
        } else if (args[i].startsWith("--env=")) {
            const match = args[i].slice(6).match(/^([^=]+)=(.*)$/);
            if (match) {
                customEnv[match[1]] = match[2];
            }
        } else {
            filteredArgs.push(args[i]);
        }
    }

    const command = filteredArgs[0];
    const cwd = process.cwd();

    // @ prefix → worktree workspace commands
    if (command && command.startsWith("@")) {
        const parsed = parseWorktreeArg(command);
        if (parsed) {
            if (parsed.branch === null) {
                handleWorktreeList(cwd);
            } else {
                await handleWorktreeCommand(
                    cwd,
                    parsed.branch,
                    filteredArgs.slice(1),
                    customEnv,
                );
            }
            return;
        }
    }

    switch (command) {
        case "-h":
        case "--help":
        case "help":
            showHelp();
            break;

        case "stop":
            stopProjectContainer(cwd);
            break;

        case "rm":
            removeProjectContainer(cwd);
            break;

        case "status":
            showStatus();
            break;

        case "remote": {
            const subcommand = filteredArgs[1];
            if (subcommand === "setup") {
                await remoteSetup();
            } else if (subcommand === "check") {
                await remoteCheck(cwd);
            } else if (subcommand === "terminate") {
                await remoteTerminate(cwd);
            } else {
                // subcommand is either a host or undefined (use saved config)
                // remaining args after host are passed to ccc on remote
                const host = subcommand;
                const remoteArgs = host ? filteredArgs.slice(2) : [];
                await remoteExec(cwd, host, remoteArgs);
            }
            break;
        }

        case "shell":
            await exec(cwd, ["bash"], { env: customEnv });
            break;

        case "update":
            await exec(cwd, ["claude", "update"], { env: customEnv });
            break;

        case undefined:
            await exec(cwd, ["claude", "--dangerously-skip-permissions"], {
                env: customEnv,
            });
            break;

        default:
            // Check if it's a claude flag (--continue, --resume, etc.)
            if (command.startsWith("-")) {
                await exec(
                    cwd,
                    [
                        "claude",
                        "--dangerously-skip-permissions",
                        ...filteredArgs,
                    ],
                    { env: customEnv },
                );
            } else {
                await exec(cwd, filteredArgs, { env: customEnv });
            }
            break;
    }
}

// Always run main - this module is the entry point
main().catch(console.error);
