#!/usr/bin/env node

import { spawnSync } from "child_process";
import {
    existsSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
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
    CONTAINER_ENV_KEY,
    CONTAINER_ENV_VALUE,
    prompt,
    DATA_DIR,
    CLAUDE_DIR,
    CLAUDE_JSON_FILE,
} from "./utils.js";
import { syncCredentials } from "./credentials.js";
import { ensureClipboardServer } from "./clipboard-server.js";
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
import {
    getContainerName,
    isDockerRunning,
    ensureDockerRunning,
    isContainerRunning,
    isContainerExists,
    isImageExists,
    ensureImage,
    startProjectContainer,
    stopProjectContainer,
    removeProjectContainer,
    buildDockerRunArgs,
    syncClipboardShims,
    type DockerRunArgsOptions,
} from "./docker.js";
import {
    ensureClaudeInContainer,
    ensureGlobalNpmTools,
    saveClaudeBinaryToVolume,
    CLAUDE_BIN_PATH,
} from "./container-setup.js";
import {
    createSessionLock,
    getActiveSessionsForProject,
    cleanupSession,
    setupSignalHandlers,
    setSession,
} from "./session.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === Configuration ===
const hostClaudeIdeDir = join(homedir(), ".claude", "ide"); // Host IDE lock files

// === Helpers ===
function ensureDirs(): void {
    mkdirSync(DATA_DIR, { recursive: true });
    mkdirSync(CLAUDE_DIR, { recursive: true });
    // Ensure claude.json exists for file mount (onboarding state)
    if (!existsSync(CLAUDE_JSON_FILE)) {
        writeFileSync(CLAUDE_JSON_FILE, "{}", { mode: 0o600 });
    }
    ensureBrowserMcp();
}

export function ensureBrowserMcp(): void {
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
            "chrome-devtools-mcp",
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

    writeFileSync(CLAUDE_JSON_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
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
    const sessionLockFile = createSessionLock(projectId);
    setSession(sessionLockFile, fullPath);
    setupSignalHandlers();

    // Start or get container
    const containerName = startProjectContainer(fullPath, ensureDirs);

    // Ensure claude binary is available (cached in volume or fresh install).
    // Retry once if a concurrent session stopped the container during setup.
    for (let attempt = 0; attempt < 2; attempt++) {
        if (!isContainerRunning(containerName)) {
            console.log("Container stopped during setup (concurrent session), restarting...");
            startProjectContainer(fullPath, ensureDirs);
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
        startProjectContainer(fullPath, ensureDirs);
    }

    // Sync clipboard shims (ensures container has latest version after code updates)
    syncClipboardShims(containerName, __dirname);

    // Build docker exec command
    const projectMountPath = `/project/${projectId}`;

    // Forward host env vars to the container via -e flags (denylist approach).
    // Excludes system/platform vars that are meaningless inside the container.
    const excludeUpper = new Set([...EXCLUDE_ENV_KEYS].map((k) => k.toUpperCase()));

    const execArgs = ["exec", "-w", projectMountPath];

    // Container marker: enables per-project env separation via mise.toml [env] conditionals
    execArgs.push("-e", `${CONTAINER_ENV_KEY}=${CONTAINER_ENV_VALUE}`);

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
        } catch { /* token unavailable - clipboard will fail with 401 */ }
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

    const result = spawnSync("docker", execArgs, { stdio: "inherit" });

    // Cleanup on normal exit
    cleanupSession();
    process.exit(result.status ?? 1);
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

// Run main only when executed directly (not when imported by test frameworks)
if (!process.env.VITEST) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
