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
    getProjectId,
    EXCLUDE_ENV_KEYS,
    CONTAINER_ENV_KEY,
    CONTAINER_ENV_VALUE,
    prompt,
    DATA_DIR,
    CLI_VERSION,
    getClaudeDir,
    getClaudeJsonFile,
} from "./utils.js";

import { ensureClipboardServer } from "./clipboard-server.js";
import {
    parseWorktreeArg,
    validateBranchName,
    listWorkspaces,
    createWorkspace,
    removeWorkspace,
    repairWorkspace,
    detectBrokenWorktrees,
    fixBrokenWorktree,
    getWorkspacePath,
    getWorktreeGitMounts,
    workspaceExists,
    needsSubmoduleSetup,
    initWithSubmodules,
} from "./worktree.js";
import {
    getContainerName,
    ensureDockerRunning,
    isContainerRunning,
    isContainerExists,
    isImageExists,
    getImageLabel,
    ensureImage,
    startProjectContainer,
    stopProjectContainer,
    removeProjectContainer,
    syncClipboardShims,
    getContainerStatus,
    getCurrentImageId,
} from "./docker.js";
import {
    ensureClaudeInContainer,
    ensureGlobalNpmTools,
    ensureUvAvailable,
    CLAUDE_BIN_PATH,
} from "./container-setup.js";
import {
    createSessionLock,
    getActiveSessionsForProject,
    cleanupSession,
    setupSignalHandlers,
    setSession,
} from "./session.js";
import { buildMcpConfig } from "./mcp-forward.js";
import { setupLocalhostProxy } from "./localhost-proxy-setup.js";
import {
    runtimeCli,
    setRuntimeOverride,
    getRuntimeInfo,
    formatRuntimeSummary,
    isContainerHostRemote,
} from "./container-runtime.js";
import {
    validateProfileName,
    listProfiles,
    profileExists,
    createProfile,
    removeProfile,
    BUILTIN_PROFILES,
    isBuiltinProfile,
    ensureProfile,
} from "./profile.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Progress indicator for startup steps (dim text on stderr)
function progress(msg: string): void {
    process.stderr.write(`\x1b[2m▸ ${msg}\x1b[0m\n`);
}

// === Configuration ===
const hostClaudeIdeDir = join(homedir(), ".claude", "ide"); // Host IDE lock files

// === Helpers ===
function ensureDirs(profile?: string): void {
    mkdirSync(DATA_DIR, { recursive: true });
    const claudeDir = getClaudeDir(profile);
    mkdirSync(claudeDir, { recursive: true });
    // Ensure claude.json exists for file mount (onboarding state)
    const claudeJsonFile = getClaudeJsonFile(profile);
    if (!existsSync(claudeJsonFile)) {
        writeFileSync(claudeJsonFile, "{}", { mode: 0o600 });
    }
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

    if (existsSync(miseConfigPath) || existsSync(join(projectPath, ".mise.toml"))) {
        return;
    }

    const versionFiles = scanVersionFiles(projectPath);
    if (versionFiles.size === 0) {
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
    options: { interactive?: boolean } = {},
    profile?: string,
): Promise<void> {
    // Check Docker is running first
    ensureDockerRunning();

    const fullPath = resolve(projectPath);

    // Ensure directories exist before syncing credentials
    ensureDirs(profile);


    // Check for mise.toml and offer to create if not exists
    await ensureMiseConfig(fullPath);

    // Create session lock BEFORE starting container so other sessions
    // see us during their cleanup and don't stop the container prematurely.
    // This prevents a race condition where:
    //   Terminal A cleanup checks for other sessions → finds none → stops container
    //   Terminal B is still setting up but hasn't created its lock yet → container dies
    const projectId = getProjectId(fullPath);
    const sessionLockFile = createSessionLock(projectId, profile);
    setSession(sessionLockFile, fullPath, profile);
    setupSignalHandlers();

    // Start clipboard server early — must complete before container creation so
    // the port file exists and can be bind-mounted (file mount requires the file
    // to already exist at docker run time).
    const clipboardPort = await ensureClipboardServer().catch(() => null);
    const clipboardPortFile = join(DATA_DIR, "clipboard.port");

    // Detect worktree mounts (source .git directories needed for git operations)
    const worktreeMounts = getWorktreeGitMounts(fullPath);

    // Single docker inspect to get container status (replaces 3-4 separate docker commands)
    const targetContainer = getContainerName(fullPath, profile);
    progress("Checking container...");
    const containerStatus = getContainerStatus(targetContainer);
    const wasAlreadyRunning = containerStatus.running;

    // Auto-upgrade container if image has been rebuilt
    if (containerStatus.exists) {
        const currentImageId = getCurrentImageId();
        if (currentImageId && containerStatus.imageId && containerStatus.imageId !== currentImageId) {
            const activeSessions = getActiveSessionsForProject(projectId);
            if (activeSessions.length <= 1) {
                const oldImageId = containerStatus.imageId;

                progress("Upgrading container to new image...");
                const cli = runtimeCli();
                spawnSync(cli, ["stop", targetContainer], { stdio: "ignore" });
                spawnSync(cli, ["rm", targetContainer], { stdio: "ignore" });

                // Remove old image (now dangling). Silently fails if still in use by other containers.
                if (oldImageId) {
                    spawnSync(cli, ["rmi", oldImageId], { stdio: "ignore" });
                }
            } else {
                console.log("Update available, but other sessions are active. Restart ccc after closing other sessions to upgrade.");
            }
        }
    }

    // Start or get container (with extra mounts for worktree workspaces)
    if (!wasAlreadyRunning) progress("Starting container...");
    const containerName = startProjectContainer(
        fullPath,
        () => ensureDirs(profile),
        worktreeMounts.length > 0 ? worktreeMounts : undefined,
        clipboardPortFile,
        profile,
    );

    // Skip heavy setup if container was already running (another session set it up)
    if (!wasAlreadyRunning) {
        // Ensure claude binary is available (cached in volume or fresh install).
        // Retry once if a concurrent session stopped the container during setup.
        progress("Checking claude binary...");
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!isContainerRunning(containerName)) {
                console.log("Container stopped during setup (concurrent session), restarting...");
                startProjectContainer(fullPath, () => ensureDirs(profile), undefined, undefined, profile);
            }
            try {
                ensureClaudeInContainer(containerName);
                break;
            } catch {
                if (attempt === 1) {
                    console.error("Failed to install claude in container");
                    process.exit(1);
                }
            }
        }

        // Run independent setup steps in parallel after claude is installed.
        progress("Configuring environment...");
        const [, , , forwardedMcp] = await Promise.all([
            Promise.resolve(ensureGlobalNpmTools(containerName)),
            Promise.resolve(ensureUvAvailable(containerName)),
            Promise.resolve(syncClipboardShims(containerName, __dirname)),
            Promise.resolve(buildMcpConfig(profile)),
            Promise.resolve(setupLocalhostProxy(containerName)),
        ]);

        if (forwardedMcp.length > 0) {
            console.error(`MCP forwarded: ${forwardedMcp.join(", ")}`);
        }

        // Verify container is still running before exec.
        if (!isContainerRunning(containerName)) {
            console.log("Container was stopped during setup, restarting...");
            startProjectContainer(fullPath, () => ensureDirs(profile), undefined, undefined, profile);
        }
    } else {
        // Container already running — only rebuild MCP config (lightweight, may have changed)
        const forwardedMcp = await buildMcpConfig(profile);
        if (forwardedMcp.length > 0) {
            console.error(`MCP forwarded: ${forwardedMcp.join(", ")}`);
        }
    }

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

    // Locale: forward host LANG/LC_* (no longer excluded).
    // If host has no LANG set, inject en_US.UTF-8 as fallback.
    if (!process.env.LANG) {
        execArgs.push("-e", "LANG=en_US.UTF-8");
    }

    // Timezone: detect host timezone and forward to container.
    // Priority: TZ env var → Intl API detection → UTC fallback.
    const hostTz = process.env.TZ
        || Intl.DateTimeFormat().resolvedOptions().timeZone
        || "UTC";
    execArgs.push("-e", `TZ=${hostTz}`);

    // Profile: env vars handled by mise.toml [env], not by ccc

    // Clipboard bridge: pass URL + auth token to container so shim scripts can reach host clipboard server
    if (clipboardPort) {
        const clipboardHost = (process.platform === "linux" && !isContainerHostRemote()) ? "127.0.0.1" : "host.docker.internal";
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
    // mise install can be slow on first run (downloads tool binaries).
    // Running them in a single sh -c caused mise's shell hooks to intercept
    // the exec syscall, producing spurious "Argument list too long" errors.
    if (cmd[0] === "claude") {
        // Step 1: mise setup (trust, install, reshim) — only on first session startup.
        // Skipped when container was already running: a previous session already ran this.
        if (!wasAlreadyRunning) {
            progress("Installing project tools (mise)...");
            spawnSync(
                runtimeCli(),
                [
                    "exec", "-w", projectMountPath, containerName,
                    "sh", "-c",
                    `find ${projectMountPath} -name "mise.toml" -o -name ".mise.toml" 2>/dev/null | xargs -I{} mise trust {} 2>/dev/null; mise install -y 2>/dev/null || true; mise reshim 2>/dev/null || true`,
                ],
                { stdio: "inherit" },
            );

            // Re-verify claude wasn't overwritten by mise reshim (e.g., bun shim at the path)
            ensureClaudeInContainer(containerName);
        }

        // Step 2: run claude directly (no shell wrapper — avoids mise interception)
        execArgs.push(CLAUDE_BIN_PATH, ...cmd.slice(1));
    } else {
        execArgs.push(...cmd);
    }

    const result = spawnSync(runtimeCli(), execArgs, { stdio: "inherit" });

    // Cleanup on normal exit
    cleanupSession();
    process.exit(result.status ?? 1);
}

function showStatus(): void {
    ensureDockerRunning();
    console.log(`\n=== CCC Status (CLI v${CLI_VERSION}) ===\n`);

    // Image status
    if (isImageExists()) {
        const label = getImageLabel("ccc", "cli.version");
        if (label === null) {
            console.log("Image: Built locally (dev)");
        } else if (label === CLI_VERSION) {
            console.log(`Image: Registry (v${label})`);
        } else {
            console.log(`Image: Registry (v${label} -- update available: v${CLI_VERSION})`);
        }
    } else {
        console.log("Image: Not found (will auto-pull on first run)");
    }

    // List all ccc containers
    const result = spawnSync(
        runtimeCli(),
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
            const [name, ...statusParts] = c.split("\t");
            const statusStr = statusParts.join("\t");
            // Parse profile from container name: ccc-{projectId}--p--{profile}
            const profileMatch = name.match(/--p--(.+)$/);
            const profileSuffix = profileMatch ? `  (profile: ${profileMatch[1]})` : "";
            // Determine running/stopped label
            const runningLabel = statusStr.toLowerCase().startsWith("up") ? "running" : "stopped";
            console.log(`  ${name}  ${runningLabel}${profileSuffix}`);
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

/**
 * Prepare worktree workspace (create or reuse), return the workspace path.
 * Does NOT execute any command — the caller runs the standard command dispatch.
 */
async function prepareWorktree(
    cwd: string,
    branch: string,
): Promise<string> {
    // Validate branch name early (C1 fix)
    try {
        validateBranchName(branch);
    } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        process.exit(1);
    }

    const wsPath = getWorkspacePath(cwd, branch);

    if (workspaceExists(cwd, branch)) {
        // Check for branch collision (C2 fix): different branch names can map
        // to the same workspace path (e.g., feature/login → feature-login)
        const gitResult = spawnSync(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: wsPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        const actualBranch = (gitResult.stdout ?? "").trim();
        if (actualBranch && actualBranch !== branch) {
            console.error(
                `Error: Workspace exists for branch '${actualBranch}', not '${branch}'.`,
            );
            console.error(
                `Different branches map to the same directory due to '/' → '-' conversion.`,
            );
            process.exit(1);
        }
        console.log(`Using existing workspace: ${wsPath}`);

        // Repair: create worktrees for nested git repos that are missing
        const repaired = repairWorkspace(cwd, wsPath, branch);
        for (const repo of repaired) {
            console.log(`  ${repo.name}: worktree (repaired)`);
        }

        // Detect broken worktrees (directories with content but not valid worktrees)
        const broken = detectBrokenWorktrees(cwd, wsPath);
        if (broken.length > 0) {
            console.log(`Found ${broken.length} broken worktree(s):`);
            for (const entry of broken) {
                console.log(`  ${entry.name}: has content but is not a valid worktree`);
            }
            const answer = await prompt(
                `Stash content and recreate as proper worktrees? (y/N) `,
                true,
            );
            if (answer === "y" || answer === "yes") {
                for (const entry of broken) {
                    const fixed = fixBrokenWorktree(cwd, wsPath, entry.name, branch);
                    if (fixed) {
                        console.log(`  ${entry.name}: fixed (content preserved)`);
                    } else {
                        console.log(`  ${entry.name}: failed to fix (content unchanged)`);
                    }
                }
            }
        }
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

    return wsPath;
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
            const cli = runtimeCli();
            spawnSync(cli, ["stop", containerName], { stdio: "ignore" });
            spawnSync(cli, ["rm", containerName], { stdio: "ignore" });
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

PROFILES (separate claude credential directories):
    CCC_PROFILE=<name> ccc      Run with profile
    ccc profile list            List all profiles
    ccc profile add <name>      Create profile
    ccc profile rm <name>       Remove profile

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
    ccc doctor              Health check and diagnostics
    ccc runtime             Print detected container runtime + flavor
    ccc clean               Clean stopped containers and images
    ccc clean --volumes     Also remove cached volumes
    ccc clean --all         Remove everything (including running)
    ccc clean --dry-run     Show what would be removed

REMOTE (run on remote host via Tailscale + Mutagen):
    ccc remote <host>       Connect to host (first time: prompts for config)
    ccc remote              Connect using saved config
    ccc remote setup        Setup guide for remote development
    ccc remote check        Check connectivity and sync status
    ccc remote terminate    Stop sync session for this project

OPTIONS:
    -p, --profile <name>    Use named profile
    --runtime <name>        Force container runtime: docker or podman
                            (overrides auto-detect and CCC_RUNTIME env)
    -h, --help              Show this help

ENVIRONMENT:
    CCC_RUNTIME             docker | podman (default: auto-detect, podman preferred)
    CCC_RUNTIME_SOCKET      override detected runtime socket path (advanced)
    CCC_SELINUX_RELABEL     auto | force | off (default: auto)

EXAMPLES:
    ccc                     # Run Claude in current project
    ccc --continue          # Continue previous Claude session
    ccc shell               # Open shell in current project
    ccc npm install         # Run npm install in container
    CCC_PROFILE=work ccc    # Run with 'work' profile
    ccc @feature            # Create workspace + run Claude
    ccc @feature/login      # Branch with / (dir name uses -)
    ccc @                   # List workspaces
    ccc @feature rm         # Remove workspace
`);
}

// === Arg Parsing ===
export function parseArgs(args: string[]): {
    worktreeArg?: string;
    filteredArgs: string[];
    runtime?: string;
} {
    const filteredArgs: string[] = [];
    let worktreeArg: string | undefined;
    let runtime: string | undefined;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith("@")) {
            worktreeArg = a;
            continue;
        }
        if (a === "--runtime") {
            runtime = args[++i];
            continue;
        }
        if (a.startsWith("--runtime=")) {
            runtime = a.slice("--runtime=".length);
            continue;
        }
        filteredArgs.push(a);
    }

    return { worktreeArg, filteredArgs, runtime };
}

// === Main ===
async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Unified parsing: @branch and remaining args
    const { worktreeArg, filteredArgs, runtime } = parseArgs(args);

    // --runtime override takes effect before any container CLI spawn.
    if (runtime !== undefined) {
        try {
            setRuntimeOverride(runtime);
        } catch (e) {
            console.error((e as Error).message);
            process.exit(1);
        }
    }

    // Profile from CCC_PROFILE env var
    const profile = process.env.CCC_PROFILE || undefined;
    if (profile !== undefined) {
        if (!validateProfileName(profile)) {
            console.error(`Error: Invalid CCC_PROFILE="${profile}". Use lowercase letters, digits, ., _, - only.`);
            process.exit(1);
        }
        if (!profileExists(profile)) {
            if (isBuiltinProfile(profile)) {
                ensureProfile(profile);
                console.log(`Auto-created built-in profile "${profile}".`);
            } else {
                console.error(`Error: Profile "${profile}" does not exist. Create it with: ccc profile add ${profile}`);
                process.exit(1);
            }
        }
    }

    let command = filteredArgs[0];
    let cwd = process.cwd();

    // @ prefix → worktree workspace
    if (worktreeArg) {
        const parsed = parseWorktreeArg(worktreeArg);
        if (parsed) {
            if (parsed.branch === null) {
                handleWorktreeList(cwd);
                return;
            }

            // ccc @branch rm [-f] — worktree-specific command
            if (command === "rm") {
                const force = filteredArgs.includes("-f") || filteredArgs.includes("--force");
                handleWorktreeRemove(cwd, parsed.branch, force);
                return;
            }

            // All other commands: prepare workspace, then fall through to standard switch
            cwd = await prepareWorktree(cwd, parsed.branch);
            // command stays as filteredArgs[0]
        }
    }

    switch (command) {
        case "-h":
        case "--help":
        case "help":
            showHelp();
            break;

        case "stop":
            stopProjectContainer(cwd, profile);
            break;

        case "rm":
            removeProjectContainer(cwd, profile);
            break;

        case "status":
            showStatus();
            break;

        case "doctor": {
            const { runDoctor } = await import("./doctor.js");
            const healthy = runDoctor(cwd);
            process.exit(healthy ? 0 : 1);
            break;
        }

        case "runtime": {
            try {
                const info = getRuntimeInfo();
                console.log(formatRuntimeSummary(info));
                process.exit(0);
            } catch (e) {
                console.error((e as Error).message);
                process.exit(1);
            }
            break;
        }

        case "clean": {
            const cleanFlags = filteredArgs.slice(1);
            const { cleanContainers } = await import("./clean.js");
            await cleanContainers({
                volumes: cleanFlags.includes("--volumes"),
                all: cleanFlags.includes("--all"),
                dryRun: cleanFlags.includes("--dry-run"),
                yes: cleanFlags.includes("--yes") || cleanFlags.includes("-y"),
            });
            break;
        }

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

        case "profile": {
            const sub = filteredArgs[1];
            const name = filteredArgs[2];
            switch (sub) {
                case "list": {
                    const profiles = listProfiles();
                    if (profiles.length === 0) {
                        console.log("No profiles found. Create one with: ccc profile add <name>");
                    } else {
                        console.log("\n=== Profiles ===\n");
                        for (const p of profiles) {
                            const tag = isBuiltinProfile(p) ? "  [built-in]" : "";
                            console.log(`  ${p}${tag}`);
                        }
                        console.log("");
                    }
                    break;
                }
                case "add": {
                    if (!name) {
                        console.error("Usage: ccc profile add <name>");
                        process.exit(1);
                    }
                    if (!validateProfileName(name)) {
                        console.error(`Error: Invalid profile name "${name}".`);
                        process.exit(1);
                    }
                    if (profileExists(name)) {
                        console.error(`Error: Profile "${name}" already exists.`);
                        process.exit(1);
                    }
                    createProfile(name, BUILTIN_PROFILES[name]?.settings);
                    console.log(`Profile "${name}" created.`);
                    console.log(`Use with: CCC_PROFILE=${name} ccc`);
                    break;
                }
                case "rm": {
                    if (!name) {
                        console.error("Usage: ccc profile rm <name>");
                        process.exit(1);
                    }
                    if (!profileExists(name)) {
                        console.error(`Error: Profile "${name}" does not exist.`);
                        process.exit(1);
                    }
                    removeProfile(name);
                    console.log(`Profile "${name}" removed.`);
                    break;
                }
                default:
                    console.error("Usage: ccc profile <list|add|rm> [name]");
                    process.exit(1);
            }
            break;
        }

        case "shell":
            await exec(cwd, ["bash"], {}, profile);
            break;

        case "update":
            await exec(cwd, ["claude", "update"], {}, profile);
            break;

        case undefined:
            await exec(cwd, ["claude", "--dangerously-skip-permissions"], {}, profile);
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
                    {},
                    profile,
                );
            } else {
                await exec(cwd, filteredArgs, {}, profile);
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
