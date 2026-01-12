#!/usr/bin/env node

import {spawnSync} from "child_process";
import {createHash, randomUUID} from "crypto";
import {existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync} from "fs";
import {createInterface} from "readline";
import {homedir} from "os";
import {basename, dirname, join, resolve} from "path";
import {fileURLToPath} from "url";
import {formatScannedFiles, scanVersionFiles, extractVersionHints, formatVersionHints} from "./scanner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === Configuration ===
const dataDir = join(homedir(), ".ccc");
const claudeDir = join(dataDir, "claude");
const miseCacheDir = join(dataDir, "mise");
const locksDir = join(dataDir, "locks");
const imageName = "ccc";

// === Session State ===
let currentSessionLockFile: string | null = null;
let currentProjectPath: string | null = null;

// === Helpers ===
function ensureDirs(): void {
    mkdirSync(dataDir, {recursive: true});
    mkdirSync(claudeDir, {recursive: true});
    mkdirSync(miseCacheDir, {recursive: true});
    mkdirSync(locksDir, {recursive: true});
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
    if (!existsSync(locksDir)) return [];

    return readdirSync(locksDir)
        .filter(f => f.startsWith(`${projectId}-`) && f.endsWith(".lock"));
}

function hasOtherActiveSessions(projectId: string, currentLockFile: string): boolean {
    const sessions = getActiveSessionsForProject(projectId);
    const currentLockName = basename(currentLockFile);
    return sessions.some(s => s !== currentLockName);
}

function cleanupSession(): void {
    if (!currentSessionLockFile || !currentProjectPath) return;

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

function hashPath(path: string): string {
    return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

function getProjectId(projectPath: string): string {
    const name = basename(resolve(projectPath)).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = hashPath(resolve(projectPath));
    return `${name}-${hash}`;
}

function getContainerName(projectPath: string): string {
    return `ccc-${getProjectId(projectPath)}`;
}

function isContainerRunning(containerName: string): boolean {
    const result = spawnSync("docker", ["ps", "-q", "-f", `name=^${containerName}$`], {encoding: "utf-8"});
    return (result.stdout ?? "").trim().length > 0;
}

function isContainerExists(containerName: string): boolean {
    const result = spawnSync("docker", ["ps", "-aq", "-f", `name=^${containerName}$`], {encoding: "utf-8"});
    return (result.stdout ?? "").trim().length > 0;
}

function isImageExists(): boolean {
    const result = spawnSync("docker", ["images", "-q", imageName], {encoding: "utf-8"});
    return (result.stdout ?? "").trim().length > 0;
}

function buildImage(): void {
    console.log("Building ccc image...");

    const packageDir = join(__dirname, "..");
    const dockerfilePath = join(packageDir, "Dockerfile");

    if (!existsSync(dockerfilePath)) {
        console.error(`Dockerfile not found at ${dockerfilePath}`);
        process.exit(1);
    }

    const result = spawnSync("docker", [
        "build",
        "-t", imageName,
        "-f", dockerfilePath,
        packageDir
    ], {stdio: "inherit"});

    if (result.status !== 0 && result.status !== null) {
        console.error("Failed to build image");
        process.exit(1);
    }
    if (result.error) {
        console.error("Failed to build image:", result.error.message);
        process.exit(1);
    }

    console.log("Image built successfully");
}

function ensureImage(): void {
    if (!isImageExists()) {
        buildImage();
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

    const args = [
        "run", "-d",
        "--name", containerName,
        "--network", "host",
        "-v", `${fullPath}:${projectMountPath}`,
        "-v", `${claudeDir}:/claude`,
        "-v", `${miseCacheDir}:/home/ccc/.local/share/mise`,
        "-e", "CLAUDE_CONFIG_DIR=/claude",
        "-w", projectMountPath,
        "--pids-limit", "512",
        imageName
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

// Interactive prompt helper
async function prompt(question: string): Promise<string> {
    const rl = createInterface({input: process.stdin, output: process.stdout});
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

// Detect project tools using Claude CLI and write mise.toml
function detectProjectToolsAndWriteMiseConfig(projectPath: string): void {
    const miseConfigPath = join(projectPath, "mise.toml");

    console.log("Scanning project files...");
    const scannedFiles = scanVersionFiles(projectPath);
    const hints = extractVersionHints(scannedFiles);
    const hintsText = formatVersionHints(hints);
    const filesContext = formatScannedFiles(scannedFiles);

    console.log(`Found ${scannedFiles.size} version file(s), ${hints.length} version hint(s). Analyzing with Claude...`);

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
        stdio: "inherit"
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
    const answer = await prompt("Create mise.toml? (auto-detect tools) [Y/n]: ");

    if (answer === "" || answer === "y" || answer === "yes") {
        detectProjectToolsAndWriteMiseConfig(projectPath);
    } else {
        console.log("Skipping mise.toml creation.");
    }
}

async function exec(projectPath: string, cmd: string[], options: {interactive?: boolean, env?: Record<string, string>} = {}): Promise<void> {
    const fullPath = resolve(projectPath);

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

    const execArgs = [
        "exec",
        "-w", projectMountPath
    ];

    // Pass through host environment variables (except system ones)
    const excludeEnvKeys = new Set([
        "PATH", "HOME", "USER", "SHELL", "LOGNAME", "PWD", "OLDPWD",
        "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID",
        "TMPDIR", "XPC_SERVICE_NAME", "XPC_FLAGS", "SHLVL", "_",
        "LaunchInstanceID", "SECURITYSESSIONID", "SSH_AUTH_SOCK",
        "Apple_PubSub_Socket_Render", "COMMAND_MODE", "COLORTERM",
        "TERM", "ITERM_SESSION_ID", "ITERM_PROFILE", "COLORFGBG",
        "LC_TERMINAL", "LC_TERMINAL_VERSION", "__CF_USER_TEXT_ENCODING",
        "LC_ALL", "LC_CTYPE", "LANG",  // Locale (container has its own)
        "CLAUDE_CONFIG_DIR"  // Already set by container
    ]);

    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !excludeEnvKeys.has(key)) {
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

    // For claude, run mise trust, install, and reshim first
    if (cmd[0] === "claude") {
        // Trust all mise.toml files recursively, install tools, and create shims
        execArgs.push("sh", "-c", `find ${projectMountPath} -name "mise.toml" -o -name ".mise.toml" 2>/dev/null | xargs -I{} mise trust {} 2>/dev/null; mise install -y 2>/dev/null || true; mise reshim 2>/dev/null || true; exec ${cmd.join(" ")}`);
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
    const result = spawnSync("docker", ["ps", "-a", "--filter", "name=^ccc-", "--format", "{{.Names}}\t{{.Status}}"], {encoding: "utf-8"});
    const containers = (result.stdout ?? "").trim().split("\n").filter(Boolean);

    console.log("\nContainers:");
    if (containers.length === 0) {
        console.log("  (none)");
    } else {
        containers.forEach(c => {
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

        case "shell":
            await exec(cwd, ["bash"], {env: customEnv});
            break;

        case undefined:
            await exec(cwd, ["claude", "--dangerously-skip-permissions"], {env: customEnv});
            break;

        default:
            // Check if it's a claude flag (--continue, --resume, etc.)
            if (command.startsWith("-")) {
                await exec(cwd, ["claude", "--dangerously-skip-permissions", ...filteredArgs], {env: customEnv});
            } else {
                await exec(cwd, filteredArgs, {env: customEnv});
            }
            break;
    }
}

main().catch(console.error);
