#!/usr/bin/env node

import {spawnSync} from "child_process";
import {randomUUID} from "crypto";
import {
    existsSync,
    mkdirSync,
    writeFileSync,
    readdirSync,
    unlinkSync,
    readFileSync,
} from "fs";
import {homedir} from "os";
import {basename, dirname, join, resolve} from "path";
import {fileURLToPath} from "url";
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
import {syncCredentials} from "./credentials.js";

// Re-export for tests
export {hashPath, getProjectId} from "./utils.js";

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
    mkdirSync(DATA_DIR, {recursive: true});
    mkdirSync(CLAUDE_DIR, {recursive: true});
    mkdirSync(locksDir, {recursive: true});
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
    const sessionId = randomUUID();
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

    // Remove our lock file first
    removeSessionLock(currentSessionLockFile);

    // Stop container if no other sessions are using this project
    if (!hasOthers) {
        const containerName = getContainerName(currentProjectPath);
        if (isContainerRunning(containerName)) {
            spawnSync("docker", ["stop", containerName], {stdio: "ignore"});
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

function isContainerRunning(containerName: string): boolean {
    const result = spawnSync(
        "docker",
        ["ps", "-q", "-f", `name=^${containerName}$`],
        {encoding: "utf-8"},
    );
    return (result.stdout ?? "").trim().length > 0;
}

function isContainerExists(containerName: string): boolean {
    const result = spawnSync(
        "docker",
        ["ps", "-aq", "-f", `name=^${containerName}$`],
        {encoding: "utf-8"},
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

function startProjectContainer(projectPath: string): string {
    ensureDirs();
    ensureImage();

    const fullPath = resolve(projectPath);
    const containerName = getContainerName(fullPath);

    if (isContainerRunning(containerName)) {
        return containerName;
    }

    if (isContainerExists(containerName)) {
        spawnSync("docker", ["start", containerName], {stdio: "inherit"});
        return containerName;
    }

    console.log("Creating container...");

    const projectId = getProjectId(fullPath);
    const projectMountPath = `/project/${projectId}`;

    // Ensure host IDE directory exists for mount
    mkdirSync(hostClaudeIdeDir, {recursive: true});

    const args = [
        "run",
        "-d",
        "--name",
        containerName,
        "--network",
        "host",
        "--security-opt",
        "seccomp=unconfined",
        "-v",
        `${fullPath}:${projectMountPath}`,
        "-v",
        `${CLAUDE_DIR}:/home/ccc/.claude`,
        "-v",
        `${CLAUDE_JSON_FILE}:/home/ccc/.claude.json`, // Persist onboarding state
        "-v",
        `${hostClaudeIdeDir}:/home/ccc/.claude/ide`, // Mount host IDE lock files for /ide command
        "-v",
        `${MISE_VOLUME_NAME}:/home/ccc/.local/share/mise`,
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-w",
        projectMountPath,
        "--pids-limit",
        CONTAINER_PID_LIMIT,
        IMAGE_NAME,
    ];

    const result = spawnSync("docker", args, {stdio: "inherit"});
    if (result.status !== 0) {
        console.error("Failed to create container");
        process.exit(1);
    }

    return containerName;
}

function stopProjectContainer(projectPath: string): void {
    const containerName = getContainerName(resolve(projectPath));

    if (!isContainerExists(containerName)) {
        console.log("Container not found");
        return;
    }

    console.log("Stopping container...");
    spawnSync("docker", ["stop", containerName], {stdio: "inherit"});
    console.log("Container stopped");
}

function removeProjectContainer(projectPath: string): void {
    const containerName = getContainerName(resolve(projectPath));

    if (!isContainerExists(containerName)) {
        console.log("Container not found");
        return;
    }

    stopProjectContainer(projectPath);
    console.log("Removing container...");
    spawnSync("docker", ["rm", containerName], {stdio: "inherit"});
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
    const fullPath = resolve(projectPath);

    // Ensure directories exist before syncing credentials
    ensureDirs();

    // Sync and refresh credentials from host system
    await syncCredentials({claudeDir: CLAUDE_DIR});

    // Check for mise.toml and offer to create if not exists
    await ensureMiseConfig(fullPath);

    // Start or get container
    const containerName = startProjectContainer(fullPath);

    // Create session lock and setup cleanup
    const projectId = getProjectId(fullPath);
    currentProjectPath = fullPath;
    currentSessionLockFile = createSessionLock(projectId);
    setupSignalHandlers();

    // Build docker exec command
    const projectMountPath = `/project/${projectId}`;

    const execArgs = ["exec", "-w", projectMountPath];

    // Pass through host environment variables (except system ones)
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !EXCLUDE_ENV_KEYS.has(key)) {
            execArgs.push("-e", `${key}=${value}`);
        }
    }

    // Add --env options (override host env)
    if (options.env) {
        for (const [key, value] of Object.entries(options.env)) {
            execArgs.push("-e", `${key}=${value}`);
        }
    }

    if (options.interactive !== false) {
        execArgs.push("-it");
    }

    execArgs.push(containerName);

    // For claude, run mise setup first
    if (cmd[0] === "claude") {
        // Trust mise.toml files, install tools, then run claude
        // Use bash -l to load .bashrc (mise activation) and use full path to claude binary
        execArgs.push(
            "sh",
            "-c",
            `find ${projectMountPath} -name "mise.toml" -o -name ".mise.toml" 2>/dev/null | xargs -I{} mise trust {} 2>/dev/null; mise install -y 2>/dev/null || true; mise reshim 2>/dev/null || true; exec ${cmd.join(
                " ")}`,
        );
    } else {
        execArgs.push(...cmd);
    }

    spawnSync("docker", execArgs, {stdio: "inherit"});

    // Cleanup on normal exit
    cleanupSession();
}

function showStatus(): void {
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
        {encoding: "utf-8"},
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

function showHelp(): void {
    console.log(`
ccc - Claude Code Container

USAGE:
    ccc                     Run claude in current project
    ccc shell               Open bash shell in current project
    ccc <command>           Run command in current project

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
            await exec(cwd, ["bash"], {env: customEnv});
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
                    ["claude", "--dangerously-skip-permissions", ...filteredArgs],
                    {env: customEnv},
                );
            } else {
                await exec(cwd, filteredArgs, {env: customEnv});
            }
            break;
    }
}

// Always run main - this module is the entry point
main().catch(console.error);
