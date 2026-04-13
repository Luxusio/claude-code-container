#!/usr/bin/env node

import { spawnSync } from "child_process";
import {
    existsSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    unlinkSync,
} from "fs";
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
    CONTAINER_ENV_KEY,
    CONTAINER_ENV_VALUE,
    prompt,
    DATA_DIR,
    CLI_VERSION,
    getClaudeDir,
    getClaudeJsonFile,
    collectForwardedEnv,
    writeEnvFile,
} from "./utils.js";

import { ensureClipboardServer } from "./clipboard-server.js";
import { maybeAttachCodexClipboardImage } from "./codex-clipboard-image.js";
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
    isDockerDesktop,
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
    ensureTools,
    ensureUvAvailable,
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
import { buildMcpConfig } from "./mcp-forward.js";
import { setupLocalhostProxy } from "./localhost-proxy-setup.js";
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
import { getToolByName, getAllTools, getDefaultTool, type ToolDefinition } from "./tool-registry.js";
import { resolveTool, getDefaultToolPreference, setDefaultToolPreference } from "./tool-detect.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Progress indicator for startup steps (dim text on stderr)
function progress(msg: string): void {
    process.stderr.write(`\x1b[2m▸ ${msg}\x1b[0m\n`);
}


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

export function resolveExecTools(
    cmd: string[],
    optionsTool?: ToolDefinition,
): { setupTool: ToolDefinition; commandTool?: ToolDefinition } {
    const commandTool = optionsTool ?? getToolByName(cmd[0]);
    return {
        setupTool: commandTool ?? getDefaultTool(),
        commandTool,
    };
}

export async function maybeAttachCodexClipboardImageForCommand(
    projectPath: string,
    cmd: string[],
    commandTool?: ToolDefinition,
    clipboard?: { url?: string; token?: string },
    attachClipboardImage: typeof maybeAttachCodexClipboardImage = maybeAttachCodexClipboardImage,
): Promise<string[]> {
    if (commandTool?.name !== "codex") {
        return [...cmd];
    }

    const attached = await attachClipboardImage(projectPath, [...cmd], {
        enabled: true,
        clipboardUrl: clipboard?.url,
        clipboardToken: clipboard?.token,
    });
    return attached.args;
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
    options: { interactive?: boolean; env?: Record<string, string>; tool?: ToolDefinition } = {},
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
    if (process.env.DEBUG) {
        console.error(`[ccc:debug] exec: projectPath=${projectPath}`);
        console.error(`[ccc:debug] exec: fullPath=${fullPath}`);
        console.error(`[ccc:debug] exec: projectId=${projectId}`);
        console.error(`[ccc:debug] exec: mountPath=/project/${projectId}`);
        console.error(`[ccc:debug] exec: cmd=${cmd.join(" ")}`);
    }
    const { setupTool, commandTool } = resolveExecTools(cmd, options.tool);
    const sessionLockFile = createSessionLock(projectId, profile);
    setSession(sessionLockFile, fullPath, profile, (commandTool ?? setupTool).name);
    setupSignalHandlers();

    // Start clipboard server early — must complete before container creation so
    // the port file exists and can be bind-mounted (file mount requires the file
    // to already exist at docker run time).
    const clipboardPort = await ensureClipboardServer().catch(() => null);
    const clipboardPortFile = join(DATA_DIR, "clipboard.port");

    // Detect worktree mounts (source .git directories needed for git operations)
    const worktreeMounts = getWorktreeGitMounts(fullPath);
    if (process.env.DEBUG && worktreeMounts.length > 0) {
        console.error(`[ccc:debug] worktreeGitMounts (${worktreeMounts.length}):`);
        for (const m of worktreeMounts) {
            console.error(`[ccc:debug]   ${m.hostPath} -> ${m.containerPath}`);
        }
    }

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
                spawnSync("docker", ["stop", targetContainer], { stdio: "ignore" });
                spawnSync("docker", ["rm", targetContainer], { stdio: "ignore" });

                // Remove old image (now dangling). Silently fails if still in use by other containers.
                if (oldImageId) {
                    spawnSync("docker", ["rmi", oldImageId], { stdio: "ignore" });
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
        // Ensure tools are installed (claude via curl + npm tools from registry).
        // Retry once if a concurrent session stopped the container during setup.
        progress("Checking tools...");
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!isContainerRunning(containerName)) {
                console.log("Container stopped during setup (concurrent session), restarting...");
                startProjectContainer(fullPath, () => ensureDirs(profile), undefined, undefined, profile);
            }
            try {
                ensureTools(containerName, setupTool);
                break;
            } catch {
                if (attempt === 1) {
                    console.error("Failed to install tools in container");
                    process.exit(1);
                }
            }
        }

        // Run independent setup steps in parallel after tools are installed.
        progress("Configuring environment...");
        const [, , forwardedMcp] = await Promise.all([
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
    const clipboardHost = clipboardPort
        ? ((process.platform === "linux" && !isDockerDesktop()) ? "127.0.0.1" : "host.docker.internal")
        : null;
    let clipboardToken: string | null = null;
    if (clipboardPort) {
        try {
            const portFileContent = readFileSync(join(DATA_DIR, "clipboard.port"), "utf-8").trim();
            clipboardToken = portFileContent.split(":").slice(1).join(":") || null;
        } catch {
            clipboardToken = null;
        }
    }

    let resolvedCmd = [...cmd];
    resolvedCmd = await maybeAttachCodexClipboardImageForCommand(
        fullPath,
        resolvedCmd,
        commandTool,
        {
            url: clipboardHost && clipboardPort ? `http://${clipboardHost}:${clipboardPort}` : undefined,
            token: clipboardToken ?? undefined,
        },
    );

    const execArgs = ["exec", "-w", projectMountPath];

    // Collect all env vars into a temp file and pass --env-file to docker exec.
    // This avoids the OS ARG_MAX limit ("Argument list too long") that occurs when
    // forwarding many environment variables as repeated -e KEY=VALUE flags.
    const forwardedEnvPlan = collectForwardedEnv(process.env);
    if (forwardedEnvPlan.skippedDueToLimit.length > 0) {
        console.error(
            `Skipped ${forwardedEnvPlan.skippedDueToLimit.length} host env var(s) to keep exec size bounded; use --env KEY=VALUE for required overrides.`,
        );
    }

    const envEntries: Array<[string, string]> = [
        // Container marker: enables per-project env separation via mise.toml [env]
        [CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE],
        ...forwardedEnvPlan.forwarded,
    ];

    // Locale: forward host LANG/LC_* (no longer excluded).
    // If host has no LANG set, inject en_US.UTF-8 as fallback.
    if (!process.env.LANG) {
        envEntries.push(["LANG", "en_US.UTF-8"]);
    }

    // Timezone: detect host timezone and forward to container.
    // Priority: TZ env var → Intl API detection → UTC fallback.
    const hostTz = process.env.TZ
        || Intl.DateTimeFormat().resolvedOptions().timeZone
        || "UTC";
    envEntries.push(["TZ", hostTz]);

    // Profile: env vars handled by mise.toml [env], not by ccc

    // Clipboard bridge: pass URL + auth token to container so shim scripts can reach host clipboard server
    if (clipboardPort) {
        envEntries.push(["CCC_CLIPBOARD_URL", `http://${clipboardHost}:${clipboardPort}`]);
        if (clipboardToken) {
            envEntries.push(["CCC_CLIPBOARD_TOKEN", clipboardToken]);
        }
    }

    // Node compat: ensure OMC hooks/MCP servers get Node 22 via mise override.
    // BASH_ENV resets it for Claude's Bash tool so project code uses project node.
    // Must be AFTER host env forwarding (to override any host MISE_NODE_VERSION).
    if (commandTool?.needsNodeRuntime) {
        envEntries.push(["MISE_NODE_VERSION", "22"]);
        envEntries.push(["BASH_ENV", "/home/ccc/.bashrc_hooks"]);
    }

    // options.env: per-session overrides from --env KEY=VALUE CLI flag (applied last)
    if (options.env) {
        for (const [key, value] of Object.entries(options.env)) {
            envEntries.push([key, value]);
        }
    }

    const envFile = writeEnvFile(envEntries);
    execArgs.push("--env-file", envFile);

    if (options.interactive !== false) {
        execArgs.push("-it");
    }

    execArgs.push(containerName);

    // For claude, run mise setup and claude as SEPARATE docker exec calls.
    // mise install can be slow on first run (downloads tool binaries).
    // Running them in a single sh -c caused mise's shell hooks to intercept
    // the exec syscall, producing spurious "Argument list too long" errors.
    if (commandTool?.name === "claude") {
        // Step 1: mise setup (trust, install, reshim) — only on first session startup.
        // Skipped when container was already running: a previous session already ran this.
        if (!wasAlreadyRunning) {
            progress("Installing project tools (mise)...");
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
        }

        // Step 2: run claude directly (no shell wrapper — avoids mise interception)
        execArgs.push(CLAUDE_BIN_PATH, ...cmd.slice(1));
    } else {
        // mise setup only, then direct command
        spawnSync("docker", [
            "exec", "-w", projectMountPath, containerName,
            "sh", "-c",
            `find ${projectMountPath} -name "mise.toml" -o -name ".mise.toml" 2>/dev/null | xargs -I{} mise trust {} 2>/dev/null; mise install -y 2>/dev/null || true; mise reshim 2>/dev/null || true`,
        ], { stdio: "inherit" });
        execArgs.push(...resolvedCmd);
    }

    const result = spawnSync("docker", execArgs, { stdio: "inherit" });
    try { unlinkSync(envFile); } catch { /* ignore cleanup error */ }

    if (process.env.DEBUG) {
        // Check conversation directory state after Claude exits
        const claudeProjectDir = `/home/ccc/.claude/projects/-project-${projectId}`;
        const checkResult = spawnSync("docker", [
            "exec", containerName, "sh", "-c",
            `ls -1 "${claudeProjectDir}"/*.jsonl 2>/dev/null | wc -l; echo "dir:${claudeProjectDir}"`,
        ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        const output = (checkResult.stdout ?? "").trim();
        console.error(`[ccc:debug] post-exit conversation check: ${output}`);
    }

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
    ccc                     Run default AI tool in current project
    ccc shell               Open bash shell in current project
    ccc update              Update default tool to latest version
    ccc <command>           Run command in current project

TOOLS:
    ccc claude              Run Claude Code
    ccc gemini              Run Gemini CLI
    ccc codex               Run Codex
    ccc opencode            Run OpenCode

PROFILES (separate claude credential directories):
    CCC_PROFILE=<name> ccc      Run with profile
    ccc profile list            List all profiles
    ccc profile add <name>      Create profile
    ccc profile rm <name>       Remove profile

WORKTREES (multi-repo workspace):
    ccc @<branch>           Create worktree workspace + run default tool
    ccc @<branch> --continue  Pass flags to worktree session
    ccc @                   List all workspaces
    ccc @<branch> rm        Remove workspace (container + worktrees)
    ccc @<branch> rm -f     Force remove dirty worktrees

CONTAINER MANAGEMENT:
    ccc stop                Stop current project's container
    ccc rm                  Remove current project's container
    ccc status              Show all containers status
    ccc doctor              Health check and diagnostics
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
    --env KEY=VALUE         Set environment variable
    --default <tool>        Set default tool (claude/gemini/codex/opencode)
    --default               Show current default tool
    -h, --help              Show this help

EXAMPLES:
    ccc                     # Run default tool in current project
    ccc claude              # Run Claude Code
    ccc gemini              # Run Gemini CLI
    ccc --continue          # Continue previous session (default tool)
    ccc shell               # Open shell in current project
    ccc npm install         # Run npm install in container
    CCC_PROFILE=work ccc    # Run with 'work' profile
    ccc --env API_KEY=xxx   # Run with custom env var
    ccc --default gemini    # Set Gemini as default tool
    ccc @feature            # Create workspace + run default tool
    ccc @feature/login      # Branch with / (dir name uses -)
    ccc @                   # List workspaces
    ccc @feature rm         # Remove workspace
`);
}

// === Arg Parsing ===
export function parseArgs(args: string[]): {
    worktreeArg?: string;
    filteredArgs: string[];
} {
    const filteredArgs: string[] = [];
    let worktreeArg: string | undefined;

    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("@")) {
            worktreeArg = args[i];
        } else {
            filteredArgs.push(args[i]);
        }
    }

    return { worktreeArg, filteredArgs };
}

// === Main ===
async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Unified parsing: @branch and remaining args
    const { worktreeArg, filteredArgs } = parseArgs(args);

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

    // Handle --default flag
    const defaultIdx = filteredArgs.indexOf("--default");
    if (defaultIdx !== -1) {
        const nextArg = filteredArgs[defaultIdx + 1];
        if (nextArg && !nextArg.startsWith("-")) {
            if (!getToolByName(nextArg)) {
                console.error(`Unknown tool: ${nextArg}. Available: ${getAllTools().map(t => t.name).join(", ")}`);
                process.exit(1);
            }
            setDefaultToolPreference(nextArg);
            console.log(`Default tool set to: ${nextArg}`);
            return;
        } else {
            console.log(`Default tool: ${getDefaultToolPreference() ?? "claude"}`);
            return;
        }
    }

    // Parse --env KEY=VALUE flags before dispatching so they are removed from
    // the command args and forwarded to exec() as options.env overrides.
    const extraEnv: Record<string, string> = {};
    const cmdArgs: string[] = [];
    for (let i = 0; i < filteredArgs.length; i++) {
        if (filteredArgs[i] === "--env" && i + 1 < filteredArgs.length) {
            const kv = filteredArgs[i + 1];
            const eqIdx = kv.indexOf("=");
            if (eqIdx > 0) extraEnv[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
            i++; // consume the value arg
        } else {
            cmdArgs.push(filteredArgs[i]);
        }
    }
    const envOpt = Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {};

    let command = cmdArgs[0];
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
                const force = cmdArgs.includes("-f") || cmdArgs.includes("--force");
                handleWorktreeRemove(cwd, parsed.branch, force);
                return;
            }

            // All other commands: prepare workspace, then fall through to standard switch
            if (process.env.DEBUG) {
                console.error(`[ccc:debug] worktree: originalCwd=${cwd} branch=${parsed.branch}`);
            }
            cwd = await prepareWorktree(cwd, parsed.branch);
            // command stays as filteredArgs[0] (parseArgs already separated @branch)
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
            await exec(cwd, ["bash"], { ...envOpt }, profile);
            break;

        case "update": {
            const tool = resolveTool(process.env);
            await exec(cwd, tool.updateCommand, { tool, ...envOpt }, profile);
            break;
        }

        case undefined: {
            const tool = resolveTool(process.env);
            await exec(cwd, [tool.binary, ...tool.defaultFlags], { tool, ...envOpt }, profile);
            break;
        }

        default:
            const tool = getToolByName(command);
            if (tool) {
                const toolArgs = cmdArgs.slice(1);
                await exec(cwd, [tool.binary, ...tool.defaultFlags, ...toolArgs], { tool, ...envOpt }, profile);
            } else if (command.startsWith("-")) {
                const defTool = resolveTool(process.env);
                await exec(cwd, [defTool.binary, ...defTool.defaultFlags, ...cmdArgs], { tool: defTool, ...envOpt }, profile);
            } else {
                await exec(cwd, cmdArgs, { ...envOpt }, profile);
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
