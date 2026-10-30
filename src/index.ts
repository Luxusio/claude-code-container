#!/usr/bin/env node

import { spawnSync } from "child_process";
import { createContainerExec, resolveContainerExecTools, attachContainerExecClipboardImage } from "./application/container-exec.js";
import { createMiseConfigSetup } from "./application/tooling/mise-config.js";
import { createNativeContainerExecPorts, ensureContainerExecSetupAvailable, ensureContainerExecTools, containerExecReplacementBlockReason } from "./composition/container-exec.js";
import type { ContainerExecOptions } from "./ports/container-exec.js";
import { createWorkspaceOpen } from "./application/workspace/open.js";
import { createWorkspaceOpenPresentation } from "./adapters/workspace/open-presentation.js";
import * as workspaceCliRemoval from "./application/workspace/cli-removal.js";
import * as workspaceRemovalPresentation from "./adapters/workspace-removal-presentation.js";
import { createNativeWorkspaceCliContainerRuntime } from "./adapters/workspace-cli-container-runtime.js";
import { createWorkspaceContentRepairAdmission } from "./application/workspace/content-repair-admission.js";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
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
import { getProjectId, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE, prompt, DATA_DIR, CLI_VERSION, getClaudeDir, getClaudeJsonFile, LAB_RUNNER_PROFILE_NAME } from "./utils.js";

import { hasAnyActiveSessionsExcept, retireClipboardServerFromPortFile } from "./clipboard-server.js";
import { DEFAULT_PROFILE_NAME, defaultProfileDir, ensureDefaultProfileDir, migrateHomeLayout, normalizeProfile } from "./home-layout.js";
import { hasLegacyHomeLayoutContainerMounts } from "./home-layout-container-guard.js";
import { prepareRuntimeBindHome, withRuntimeBindGuard } from "./adapters/runtime-bind-authority.js";
import type { RuntimeBindHomePreparation } from "./ports/runtime-bind-authority.js";
import { formatContainerStartupError } from "./container-restart-guidance.js";
import { maybeAttachCodexClipboardImage } from "./codex-clipboard-image.js";
import { parseWorktreeArg, validateBranchName, listWorkspaces, createWorkspace, removeWorkspace, repairWorkspace, detectBrokenWorktrees, fixBrokenWorktree, getWorkspacePath, assertWorkspaceBranch, assertWorkspaceRootOwnership, strandedBranchRegistrations, terminalSafeLiteral, pasteableArgument, type StrandedBranchRegistration, repairWorkspaceRootOwnership, hasGitMetadata, isWorktreeWorkspace, assertWorkspaceReady, workspaceExists, needsSubmoduleSetup, initWithSubmodules, DamagedWorkspaceMetadataError, MissingWorkspaceRootRegistrationError, canRecreateMissingWorkspaceRootRegistration, WorktreeContentConflictError, setAsideConflictingContent, repairWorkspaceWorktree } from "./worktree.js";
import { getContainerName, ensureDockerRunning, isContainerRunning, isContainerConfirmedStopped, isContainerExists, getContainerIdentity, getManagedProjectContainerIdentity, type ContainerIdentity, isImageExists, getImageLabel, stopProjectContainer, removeProjectContainer, getContainerStatus, ensureCredentialHostDir } from "./docker.js";
import { ensureTools } from "./container-setup.js";
import { createSessionLock, getActiveSessionsForContainer, getSessionLockClaimsForProjectFamily, recreateContainerWithoutInterruptingSessions, withContainerSetupLockAsync, withProjectFamilyLifecycleLock, withProjectFamilyLifecycleLockAsync, cleanupSession } from "./session.js";

export const RUNNING_CONTAINER_UPDATE_DEFERRED_MESSAGE = "Update available; deferred because the existing container is running. It will be applied after the container stops.";
export const INITIALLY_RUNNING_CONTAINER_UPDATE_DEFERRED_MESSAGE = "Update available; deferred because the container was running when this session started. Restart ccc after that session exits to upgrade.";
export const CONTAINER_SETUP_RESTART_MESSAGE = "Container became unavailable during setup, restarting...";

export function containerUpdateDeferredMessage(containerWasInitiallyRunning: boolean): string {
    return containerWasInitiallyRunning
        ? INITIALLY_RUNNING_CONTAINER_UPDATE_DEFERRED_MESSAGE
        : RUNNING_CONTAINER_UPDATE_DEFERRED_MESSAGE;
}

export function ensureSetupContainerAvailable(
    containerId: string,
    restart: () => Promise<string> | string,
    runningProbe: typeof isContainerRunning = isContainerRunning,
    log: (message: string) => void = console.log,
): Promise<string> {
    return ensureContainerExecSetupAvailable(containerId, restart, { running: runningProbe, log });
}

type ContainerSetupLock = <T>(
    containerPrefix: string,
    operation: () => Promise<T> | T,
) => Promise<T>;

export async function withContainerSetupReadiness<T>(
    containerPrefix: string,
    operation: () => Promise<T> | T,
    setupLock: ContainerSetupLock = withContainerSetupLockAsync,
): Promise<T> {
    return setupLock(containerPrefix, operation);
}

export function ensureToolsForSetupContainer(
    containerId: string,
    setupTool: ToolDefinition,
    restart: () => Promise<string> | string,
    runningProbe: typeof isContainerRunning = isContainerRunning,
    installer: typeof ensureTools = ensureTools,
): Promise<string> {
    return ensureContainerExecTools(containerId, setupTool, restart, { running: runningProbe, install: installer, log: console.log });
}
import {
    validateProfileName,
    listProfiles,
    profileExists,
    createProfile,
    removeProfile,
    BUILTIN_PROFILES,
    isBuiltinProfile,
    ensureProfile,
    ensureClaudePermissionDefaults,
} from "./profile.js";
import { getToolByName, getAllTools, getAllCredentialMounts, getDefaultTool, type ToolDefinition } from "./tool-registry.js";
import { resolveTool, getDefaultToolPreference, setDefaultToolPreference } from "./tool-detect.js";
import { formatRuntimeSummary, runtimeSpawnSync, getRuntimeInvocation, runWithNativeRuntimeInvocation, setRuntimeOverride } from "./container-runtime.js";
import { parseRuntimeOverride } from "./domain/container-runtime.js";
import { devicesCliAsync } from "./device-lab-admin.js";
import { labsCli } from "./lab-runner-admin.js";

export function createWorktreeSessionLock(
    projectId: string,
    workspacePath: string,
    profile?: string,
    familyLock: typeof withProjectFamilyLifecycleLock = withProjectFamilyLifecycleLock,
    workspaceGuard: typeof assertWorkspaceReady = assertWorkspaceReady,
    lockCreator: typeof createSessionLock = createSessionLock,
    sourcePath?: string,
): string {
    return familyLock(projectId, () => {
        workspaceGuard(workspacePath, spawnSync, sourcePath, { allowTrackedGitlinks: true });
        return lockCreator(projectId, profile);
    });
}

export function runWorktreeLifecycleOperation<T>(
    workspacePath: string,
    operation: () => T,
    familyLock: typeof withProjectFamilyLifecycleLock = withProjectFamilyLifecycleLock,
    workspaceGuard: typeof assertWorkspaceReady = assertWorkspaceReady,
    sourcePath?: string,
): T {
    const projectId = getProjectId(workspacePath);
    return familyLock(projectId, () => {
        workspaceGuard(workspacePath, spawnSync, sourcePath, { allowTrackedGitlinks: true });
        return operation();
    });
}


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function replaceStoppedContainerWithoutInterruptingSessions(
    containerName: string,
    containerPrefix: string,
    currentLockFile: string,
    expectedContainerId: string,
    expectedImageId: string,
    replace: (containerId: string) => void,
    replacementGuard: typeof recreateContainerWithoutInterruptingSessions = recreateContainerWithoutInterruptingSessions,
    statusProbe: typeof getContainerStatus = getContainerStatus,
    containerWasInitiallyRunning = false,
): boolean {
    if (containerWasInitiallyRunning) return false;
    let stoppedContainerId: string | null = null;
    return replacementGuard(
        containerPrefix,
        currentLockFile,
        () => replace(stoppedContainerId!),
        () => {
            const status = statusProbe(containerName);
            if (
                !status.exists
                || status.running
                || status.containerId !== expectedContainerId
                || status.imageId !== expectedImageId
            ) return false;
            stoppedContainerId = status.containerId;
            return true;
        },
    );
}

export function stoppedContainerReplacementBlockReason(
    containerName: string,
    containerPrefix: string,
    currentLockFile: string,
    stoppedProbe: typeof isContainerConfirmedStopped = isContainerConfirmedStopped,
    sessionProbe: typeof getActiveSessionsForContainer = getActiveSessionsForContainer,
    containerWasInitiallyRunning = false,
): string | null {
    // A later stopped observation must not let this invocation reverse the
    // ownership decision it made after finding an already-running container.
    // The next CCC invocation can recover it after taking a fresh baseline.
    if (containerWasInitiallyRunning) {
        return "the container was running when this session started";
    }
    if (!stoppedProbe(containerName)) {
        return "the container is not confirmed stopped";
    }
    const currentLockName = basename(currentLockFile);
    const otherClaims = sessionProbe(containerPrefix).filter((claim) => claim !== currentLockName);
    return otherClaims.length > 0
        ? `${otherClaims.length} live or indeterminate session lock claim(s) remain`
        : null;
}

export function containerReplacementBlockReason(
    containerName: string,
    containerPrefix: string,
    currentLockFile: string,
    expectedContainerId: string,
    sessionProbe: typeof getActiveSessionsForContainer = getActiveSessionsForContainer,
    statusProbe: typeof getContainerStatus = getContainerStatus,
): string | null {
    return containerExecReplacementBlockReason(containerName, containerPrefix, currentLockFile, expectedContainerId, { claims: sessionProbe, status: statusProbe, lockName: basename });
}


// === Helpers ===
function ensureDirs(profile?: string): void {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const claudeDir = getClaudeDir(profile);
    // A new default-profile folder is marked as the no-profile account (home-layout.ts).
    if (claudeDir === join(defaultProfileDir(), "claude")) ensureDefaultProfileDir();
    mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    ensureClaudePermissionDefaults(claudeDir);
    // Ensure claude.json exists for file mount (onboarding state)
    const claudeJsonFile = getClaudeJsonFile(profile);
    if (!existsSync(claudeJsonFile)) {
        writeFileSync(claudeJsonFile, "{}", { mode: 0o600 });
    }
    // Prepare every coding-agent credential dir unconditionally so any tool the
    // user later invokes already has its host source on disk.
    for (const mount of getAllCredentialMounts()) {
        ensureCredentialHostDir(mount, profile);
    }
}

const DEFAULT_MISE_CONFIG_CONTENT = `[tools]
# No tools detected - add your tools here
# node = "22"
`;

// Detect project tools using Claude CLI and write mise.toml
function runProjectToolDetection(projectPath: string, miseConfigPath: string, scannedFiles: Map<string, string>): undefined {
    const hints = extractVersionHints(scannedFiles);
    const hintsText = formatVersionHints(hints);
    const filesContext = formatScannedFiles(scannedFiles);

    console.log(
        `Found ${scannedFiles.size} version file(s), ${hints.length} version hint(s). Analyzing with Claude...`,
    );

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
${DEFAULT_MISE_CONFIG_CONTENT}`;

    spawnSync("claude", ["-p", promptText, "--allowedTools", "Read,Write"], {
        encoding: "utf-8",
        cwd: projectPath,
        timeout: 60000,
        stdio: "inherit",
    });

    return undefined;
}

export function resolveExecTools(
    cmd: string[],
    optionsTool?: ToolDefinition,
): { setupTool: ToolDefinition; commandTool?: ToolDefinition } {
    return resolveContainerExecTools(cmd, optionsTool, { tool: getToolByName, defaultTool: getDefaultTool });
}

/**
 * Build the in-container command line for a tool. defaultFlags are placed:
 *   - AFTER the subcommand when args[0] is a known subcommand that accepts them
 *   - dropped entirely when args[0] is a known subcommand that rejects them
 *   - BEFORE all args otherwise (default-chat mode or unrecognized leading arg)
 *
 * Per-subcommand placement is required for tools whose top-level flags are
 * actually defined on each subcommand (e.g. codex's
 * --dangerously-bypass-approvals-and-sandbox). Placing them before the
 * subcommand silently neutralizes them on the subcommand path.
 */
export function buildToolInvocation(tool: ToolDefinition, args: string[]): string[] {
    const first = args[0];
    if (first && tool.subcommands?.includes(first)) {
        const rest = args.slice(1);
        const accepts = tool.subcommandsAcceptingDefaultFlags?.includes(first) ?? false;
        if (accepts) {
            return [tool.binary, first, ...tool.defaultFlags, ...rest];
        }
        return [tool.binary, first, ...rest];
    }
    return [tool.binary, ...tool.defaultFlags, ...args];
}

export async function maybeAttachCodexClipboardImageForCommand(
    projectPath: string,
    cmd: string[],
    commandTool?: ToolDefinition,
    clipboard?: { url?: string; token?: string },
    attachClipboardImage: typeof maybeAttachCodexClipboardImage = maybeAttachCodexClipboardImage,
): Promise<string[]> {
    return attachContainerExecClipboardImage(projectPath, cmd, commandTool, clipboard, attachClipboardImage);
}

const miseConfigSetup = createMiseConfigSetup({
    configPath: (projectPath, kind) => join(projectPath, kind === "primary" ? "mise.toml" : ".mise.toml"),
    skipMarkerPath: projectPath => join(DATA_DIR, "mise-prompt-skipped", getProjectId(projectPath)),
    exists: existsSync,
    scanVersionFiles,
    chooseCreation: async () => {
        const answer = await prompt(
            "Create mise.toml? (auto-detect tools) [Y/n]: ",
            true,
        );
        if (answer === "" || answer === "y" || answer === "yes") return "create";
        return answer === "n" || answer === "no" ? "remember-skip" : "skip-once";
    },
    runToolDetection: runProjectToolDetection,
    writeDefaultConfig: path => {
        writeFileSync(path, DEFAULT_MISE_CONFIG_CONTENT);
        return undefined;
    },
    rememberSkip: path => {
        mkdirSync(dirname(path), {recursive: true});
        writeFileSync(path, "");
        return undefined;
    },
    report: event => {
        switch (event.kind) {
            case "missing-config":
                console.log(`\nNo mise.toml found in project.`);
                break;
            case "scanning":
                console.log("Scanning project files...");
                break;
            case "created":
                console.log(`Created: ${event.path}`);
                break;
            case "skipping":
                console.log("Skipping mise.toml creation.");
                break;
            case "remembered":
                console.log(`Remembered for this project. To ask again, delete: ${event.path}`);
                break;
            case "preference-save-failed":
                console.warn("Could not save mise prompt preference; you may be asked again next time.");
                break;
        }
        return undefined;
    },
});

// Check if mise.toml exists and offer to create if not
export async function ensureMiseConfig(projectPath: string): Promise<void> {
    return miseConfigSetup.ensure(projectPath);
}

const containerExec = createContainerExec(createNativeContainerExecPorts({
    ensureDirectories: ensureDirs,
    ensureProjectTools: ensureMiseConfig,
    assetDirectory: __dirname,
    trustedCliPath: __filename,
}));

async function exec(projectPath: string, cmd: string[], options: ContainerExecOptions = {}, profile?: string): Promise<void> {
    const invocation = getRuntimeInvocation();
    const status = await runWithNativeRuntimeInvocation(invocation, () => containerExec.exec(projectPath, cmd, options, profile));
    process.exit(status);
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
    const result = runtimeSpawnSync([
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
/**
 * Repairs one broken worktree, and when the repair cannot merge the content, says why and
 * offers the one mechanical step that unblocks it.
 *
 * Choosing which version of a file wins is the operator's call, so ccc does not make it. What
 * it can do is move the local versions somewhere safe so the branch's versions can be checked
 * out, which loses nothing and is undone by moving them back.
 */
const admitWorkspaceContentRepair = createWorkspaceContentRepairAdmission({
    repairConfirmed: (cwd, wsPath, name, branch, confirmed) => fixBrokenWorktree(cwd, wsPath, name, branch, confirmed),
    isContentConflict: (cause): cause is WorktreeContentConflictError => cause instanceof WorktreeContentConflictError,
    report: event => {
        switch (event.kind) {
            case "outcome":
                console.log(event.fixed
                    ? `  ${event.name}: fixed (${event.afterSetAside ? "remaining content" : "content"} preserved)`
                    : `  ${event.name}: failed to fix (content unchanged)`);
                break;
            case "failure":
                console.log(`  ${event.name}: failed to fix - ${(event.cause as { message: unknown }).message}`);
                break;
            case "conflicts":
                console.log(`  ${event.name}: cannot merge - these files differ between your copy and branch '${event.branch}':`);
                for (const path of event.cause.conflicts) console.log(`      ${relative(event.cause.worktreeRoot, path)}`);
                console.log("      Nothing was changed or lost; the directory is exactly as it was.");
                console.log("      ccc can move your versions aside so the branch's versions can be checked out.");
                console.log("      Your versions stay on disk and can be moved back or merged by hand.");
                break;
            case "refusal":
                console.log(`  ${event.name}: left unrepaired (content unchanged)`);
                break;
            case "set-aside":
                console.log(`  ${event.name}: your versions moved to ${event.preserved}`);
                break;
            case "retry-failure":
                console.log(`  ${event.name}: failed to fix - ${(event.cause as { message: unknown }).message}`);
                console.log(`      Your set-aside versions remain in ${event.preserved}`);
                break;
        }
    },
    confirmConflictRepair: async () => {
        const answer = await prompt("  Move them aside and repair? (y/N) ", true);
        return answer === "y" || answer === "yes";
    },
    setAsideConflicts: (root, conflicts) => setAsideConflictingContent(root, conflicts),
});

function repairBrokenWorktree(
    cwd: string,
    wsPath: string,
    name: string,
    branch: string,
): Promise<void> {
    return admitWorkspaceContentRepair(cwd, wsPath, name, branch);
}

const workspaceOpenPresentation = createWorkspaceOpenPresentation({
    prompt: question => prompt(question, true),
    report: message => { console.log(message); return undefined; },
    reportError: message => { console.error(message); return undefined; },
    safeLiteral: text => terminalSafeLiteral(text),
});
const workspaceOpen = createWorkspaceOpen({
    path: (cwd, branch) => getWorkspacePath(cwd, branch),
    projectId: path => getProjectId(path),
    family: (projectId, attempt) => withProjectFamilyLifecycleLockAsync(projectId, attempt),
    validateBranch: branch => { validateBranchName(branch); return undefined; },
    exists: (cwd, branch) => workspaceExists(cwd, branch),
    hasGitMetadata: cwd => hasGitMetadata(cwd),
    repairRoot: (path, cwd, branch) => { repairWorkspaceRootOwnership(path, cwd, branch); return undefined; },
    assertOwner: (path, cwd) => { assertWorkspaceRootOwnership(path, cwd); return undefined; },
    missingRegistration: error => error instanceof MissingWorkspaceRootRegistrationError,
    registrationPreflight: (path, cwd, branch) => {
        let fence: (() => void) | undefined;
        const possible = canRecreateMissingWorkspaceRootRegistration(path, cwd, branch, assertUnchanged => { fence = assertUnchanged; });
        const captured = fence;
        return possible ? { assertUnchanged: captured ? () => { captured(); return undefined; } : undefined } : null;
    },
    recoverRegistration: (path, cwd, branch, preflight) => {
        let failure: string | undefined;
        const repaired = repairWorkspaceRootOwnership(path, cwd, branch, {
            confirmedMissingRegistration: true,
            reportFailure: reason => { failure = reason; },
            preflightFence: preflight.assertUnchanged,
        });
        return { repaired, failure };
    },
    inspectWorkspace: path => { assertWorkspaceReady(path); return undefined; },
    assertWorkspace: (path, cwd, allowTrackedGitlinks) => {
        assertWorkspaceReady(path, spawnSync, cwd, { allowTrackedGitlinks });
        return undefined;
    },
    repairNested: (cwd, path, branch) => repairWorkspace(cwd, path, branch),
    broken: (cwd, path) => detectBrokenWorktrees(cwd, path),
    repairContent: (cwd, path, name, branch) => repairBrokenWorktree(cwd, path, name, branch),
    submoduleRepos: cwd => needsSubmoduleSetup(cwd),
    initSubmodules: cwd => { initWithSubmodules(cwd); return undefined; },
    create: (cwd, branch) => createWorkspace(cwd, branch),
    damage: error => error instanceof DamagedWorkspaceMetadataError ? { message: error.message, repairs: error.repairs } : null,
    repairRegistration: repair => repairWorkspaceWorktree(repair),
    confirm: workspaceOpenPresentation.confirm,
    report: workspaceOpenPresentation.report,
    recoveryError: workspaceOpenPresentation.recoveryError,
});

async function prepareWorktree(cwd: string, branch: string): Promise<string> {
    const outcome = await workspaceOpen.open(cwd, branch);
    if (outcome.kind === "refused") {
        workspaceOpenPresentation.refusal(outcome);
        process.exit(1);
    }
    return outcome.path;
}

export function withWorkspaceRemovalLifecycleLock<T>(
    projectId: string,
    force: boolean,
    operation: () => T,
    lifecycleLock: typeof withProjectFamilyLifecycleLock = withProjectFamilyLifecycleLock,
    activeSessions: typeof getSessionLockClaimsForProjectFamily = getSessionLockClaimsForProjectFamily,
): T {
    return workspaceCliRemoval.withWorkspaceRemovalLifecycleLock(projectId, force, operation, lifecycleLock, activeSessions);
}

export function listWorkspaceContainerNames(
    workspacePath: string,
    runner?: typeof spawnSync,
    cli?: string,
): string[] {
    return workspaceCliRemoval.listWorkspaceContainerNames(workspacePath, createNativeWorkspaceCliContainerRuntime(runner, cli), getContainerName);
}

export function removeWorkspaceContainerByIdentity(
    containerName: string,
    identityProbe: typeof getContainerIdentity = getContainerIdentity,
    runner?: typeof spawnSync,
    cli?: string,
    existsProbe: typeof isContainerExists = isContainerExists,
): boolean {
    return workspaceCliRemoval.removeWorkspaceContainerByIdentity(containerName, identityProbe, createNativeWorkspaceCliContainerRuntime(runner, cli), existsProbe);
}

export function removeManagedWorkspaceContainerByIdentity(
    containerName: string,
    workspacePath: string,
    identityProbe: typeof getManagedProjectContainerIdentity = getManagedProjectContainerIdentity,
    runner?: typeof spawnSync,
    cli?: string,
    existsProbe: typeof isContainerExists = isContainerExists,
): boolean {
    return workspaceCliRemoval.removeManagedWorkspaceContainerByIdentity(containerName, workspacePath, identityProbe, createNativeWorkspaceCliContainerRuntime(runner, cli), existsProbe);
}

export function removeWorkspaceContainers(
    workspacePath: string,
    listContainers: (workspacePath: string) => string[] = listWorkspaceContainerNames,
    removeContainer: (containerName: string, workspacePath: string) => boolean = removeManagedWorkspaceContainerByIdentity,
): string[] {
    return workspaceCliRemoval.removeWorkspaceContainers(workspacePath, listContainers, removeContainer);
}

export type WorkspaceContainerRemoval = {
    containerName: string;
    identity: ContainerIdentity;
};

export function prepareWorkspaceContainerRemovalPlan(
    workspacePath: string,
    listContainers: (workspacePath: string) => string[] = listWorkspaceContainerNames,
    identityProbe: (
        containerName: string,
        workspacePath: string,
    ) => ContainerIdentity | null = getManagedProjectContainerIdentity,
    existsProbe: typeof isContainerExists = isContainerExists,
): WorkspaceContainerRemoval[] {
    return workspaceCliRemoval.prepareWorkspaceContainerRemovalPlan(workspacePath, listContainers, identityProbe, existsProbe);
}

export function removePreparedWorkspaceContainers(
    plan: readonly WorkspaceContainerRemoval[],
    runner?: typeof spawnSync,
    cli?: string,
): string[] {
    return workspaceCliRemoval.removePreparedWorkspaceContainers(plan, createNativeWorkspaceCliContainerRuntime(runner, cli), isContainerExists);
}

// Extracted so it can be tested. Inline, this branch was reachable only by running the CLI,
// and the previous change to it shipped with no test at all — the suite stayed green while the
// operator was told to use a flag that could not help them. It is one line of logic; the reason
// it is a function is that a line no test can reach is a line that drifts.
// Deliberately no longer says "Use -f to force". Every refusal `removeWorkspace` produces now
// carries its own remedy, and they are not all the same one: an unreadable directory needs a
// chmod BEFORE -f, and -f refuses it until then. A standing line telling the operator to use
// -f contradicted the specific line printed directly above it — which is the same shape as
// `forceWouldNotHelp`, the flag this replaced, and the reason it existed.
export function workspaceRemovalAdvice(
    force: boolean,
    removed: readonly string[] = [],
): string {
    return workspaceRemovalPresentation.workspaceRemovalAdvice(force, removed);
}

export function workspaceRemovalCompleted(
    result: { errors: string[] },
): boolean {
    return workspaceCliRemoval.workspaceRemovalCompleted(result);
}

export function removeWorkspaceThenContainers<T extends { errors: string[] }>(
    removeWorkspaceOperation: () => T,
    removeContainersOperation: () => string[],
): { result: T; removedContainers: string[] } {
    return workspaceCliRemoval.removeWorkspaceThenContainers(removeWorkspaceOperation, removeContainersOperation);
}

const invokeWorkspaceCliRemoval = Reflect.apply;

function handleWorktreeRemove(cwd: string, branch: string, force: boolean): void {
    const log = (message: string): undefined => {
        const receiver = console;
        invokeWorkspaceCliRemoval(receiver.log, receiver, [message]);
        return undefined;
    };
    const error = (message: string): undefined => {
        const receiver = console;
        invokeWorkspaceCliRemoval(receiver.error, receiver, [message]);
        return undefined;
    };
    let outcome = workspaceCliRemoval.createWorkspaceRemoval({
        resolveSource: sourcePath => resolve(sourcePath),
        selectWorkspacePath: () => getWorkspacePath,
        selectProjectId: () => getProjectId,
        selectFamilyLock: () => withProjectFamilyLifecycleLock,
        selectClaims: () => getSessionLockClaimsForProjectFamily,
        selectOwnershipAssertion: () => (path, name, source, options) => {
            assertWorkspaceBranch(path, name, spawnSync, source, options);
            return undefined;
        },
        selectRuntimeReadiness: () => {
            const ready = ensureDockerRunning;
            return () => {
                ready();
                return undefined;
            };
        },
        selectContainerName: () => getContainerName,
        selectManagedIdentity: () => getManagedProjectContainerIdentity,
        selectExists: () => isContainerExists,
        selectContainerRuntime: () => createNativeWorkspaceCliContainerRuntime(),
        selectRemoveWorkspace: () => removeWorkspace,
        publish: (event) => workspaceRemovalPresentation.renderWorkspaceRemovalProgress(event, force, log, error),
        selectStrandedRegistrations: () => strandedBranchRegistrations,
    })({ sourcePath: cwd, branch, force });
    if (outcome.kind === "removed") {
        try {
            if (outcome.stranded.length > 0) error(strandedBranchNotice(branch, outcome.stranded));
            return;
        } catch (presentationError) {
            outcome = { kind: "failed", error: presentationError, result: outcome.result };
        }
    }
    if (outcome.kind === "failed") {
        error(`Error: ${(outcome.error as Error).message}`);
        const removalNote = workspaceRemovalFailureNote(outcome.error, force);
        if (removalNote) error(removalNote);
    }
    const receiver = process;
    invokeWorkspaceCliRemoval(receiver.exit, receiver, [1]);
}

// The CLI adds ownership guidance to failed outcomes; the application preserves the error.
// Keep this public assertion wrapper on the same admission policy as the removal operation.
export function assertRemovableWorkspace(
    workspacePath: string,
    branch: string,
    sourcePath: string,
    spawn: typeof spawnSync = spawnSync,
): void {
    return workspaceCliRemoval.assertRemovableWorkspace(workspacePath, branch, sourcePath, (path, name, source, options) => {
        assertWorkspaceBranch(path, name, spawn, source, options);
        return undefined;
    });
}

/**
 * What is still holding the branch after a successful removal, and the commands that clear it.
 *
 * Extracted from the print site so it can be asserted directly: every defect this notice has
 * had was a defect in its TEXT, and the text was the one thing no test read. The first version
 * named `git worktree prune`, which does nothing to a locked registration. The second named
 * `git worktree unlock` with no argument, which exits 129. The third named
 * `git worktree unlock <the first locked path>` and "prune there", which fixes one repository
 * out of however many are listed and leaves the operator's next `ccc @<branch>` refusing on
 * the second — and said nothing at all about a listed repository that was stranded but not
 * locked.
 *
 * So: one line per repository, unlock before prune because prune alone will not clear a locked
 * one, and `-C` on every command because `git worktree unlock` is scoped to the repository
 * that recorded the registration — run in the wrong one of the listed repositories it exits
 * 128, and the sentence that just printed two repositories cannot say "there".
 */
export function strandedBranchNotice(
    branch: string,
    stranded: StrandedBranchRegistration[],
): string {
    return workspaceRemovalPresentation.strandedBranchNotice(branch, stranded, () => terminalSafeLiteral, () => pasteableArgument);
}

export function workspaceRemovalFailureNote(error: unknown, force: boolean): string | null {
    return workspaceRemovalPresentation.workspaceRemovalFailureNote(error, force);
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

PROFILES (separate Claude and Codex logins; "default" is used without CCC_PROFILE):
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
    ccc devices             Show device-lab status for this owner
    ccc devices list        List current-project device definitions
    ccc devices list --all-projects
                            List device definitions across all projects
    ccc devices create <backend> <id>
                            Create an owner-scoped device definition
    ccc devices start <id>  Start a device (Windows Sandbox defaults minimized)
    ccc devices reboot <id> Reboot a Hyper-V Windows or Linux VM
    ccc devices status <id> Show broker-owned device status
    ccc devices backends    Show device backend prerequisites
    ccc devices doctor      Device-lab diagnostics
    ccc devices smoke       Non-destructive device backend smoke checks
    ccc devices smoke --real-provider
                            Opt-in real provider readiness smoke checks
    ccc devices setup hyper-v
                            Diagnose Hyper-V host setup without changing Windows
    ccc devices setup hyper-v --confirm
                            Request elevation and enable Hyper-V; never reboots automatically
    ccc devices stop <id>   Stop a current-project device definition
    ccc devices stop --all-projects
                            Stop devices across all projects
    ccc devices delete <id> Delete a current-project stopped device definition
    ccc devices prune       Remove stopped current-project device definitions
    ccc devices prune --all-projects
                            Remove stopped definitions across all projects
    ccc devices broker status [--verbose]
    ccc labs                Show lab-runner container VM readiness
    ccc labs smoke          Non-starting lab-runner VM readiness smoke check
    ccc labs shell          Open bash in the built-in lab-runner profile
    ccc labs run <command>  Run a command in the built-in lab-runner profile
    ccc runtime             Show detected container runtime
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
    --runtime <name>        Use docker or podman for this invocation
    --default <tool>        Set default tool (claude/gemini/codex/opencode)
    --default               Show current default tool
    -v, --version           Show the CCC CLI version
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

export function informationalCommand(args: string[]): "help" | "version" | null {
    const { filteredArgs } = parseArgs(args);
    let command: string | undefined;
    for (let i = 0; i < filteredArgs.length; i += 1) {
        if ((filteredArgs[i] === "--env" || filteredArgs[i] === "--runtime") && i + 1 < filteredArgs.length) {
            i += 1;
            continue;
        }
        command = filteredArgs[i];
        break;
    }
    if (command === "-h" || command === "--help" || command === "help") return "help";
    if (command === "-v" || command === "--version" || command === "version") return "version";
    return null;
}

// Move a pre-layout ~/.ccc into profiles/ and run/ (doc/common/REQ__ccc-home-layout.md).
// Host-side only: inside a ccc container ~/.ccc holds container state, not the host layout.
function migrateHostHomeLayout(preparation?: RuntimeBindHomePreparation): void {
    if (process.env[CONTAINER_ENV_KEY] === CONTAINER_ENV_VALUE) return;
    try {
        withRuntimeBindGuard(preparation ?? DATA_DIR, guard => migrateHomeLayout({
            // Sessions of an older ccc use ~/.ccc/locks even when run/locks exists.
            hasLiveSessions: () => [join(DATA_DIR, "locks"), join(DATA_DIR, "run", "locks")]
                .some((directory) => hasAnyActiveSessionsExcept(null, directory)),
            retireLegacyClipboard: retireClipboardServerFromPortFile,
            hasContainerMounts: () => hasLegacyHomeLayoutContainerMounts(guard),
        }), { waitMs: 10_000 });
    } catch (error) {
        console.error(`ccc: ~/.ccc layout migration skipped (${(error as Error).message}); the old paths keep working.`);
    }
}

// === Main ===
export async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Unified parsing: @branch and remaining args
    const { worktreeArg, filteredArgs } = parseArgs(args);

    // Informational commands must never validate profiles, create worktrees,
    // start containers, or reconcile the host device broker.
    const informational = informationalCommand(args);
    if (informational === "help") {
        showHelp();
        return;
    }
    if (informational === "version") {
        console.log(CLI_VERSION);
        return;
    }

    // Resolve the runtime before inspecting containers for layout migration.
    // An override may own stopped containers whose legacy bind paths must stay.
    const extraEnv: Record<string, string> = {};
    const cmdArgs: string[] = [];
    let explicitRuntime = false;
    for (let i = 0; i < filteredArgs.length; i++) {
        if (filteredArgs[i] === "--env" && i + 1 < filteredArgs.length) {
            const kv = filteredArgs[++i];
            const eqIdx = kv.indexOf("=");
            if (eqIdx > 0) extraEnv[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
        } else if (filteredArgs[i] === "--runtime") {
            try {
                if (i + 1 >= filteredArgs.length) throw new Error("--runtime requires docker or podman");
                setRuntimeOverride(filteredArgs[++i]);
                explicitRuntime = true;
            } catch (e) {
                console.error((e as Error).message);
                process.exit(1);
            }
        } else {
            cmdArgs.push(filteredArgs[i]);
        }
    }
    if (!explicitRuntime) {
        try { parseRuntimeOverride(process.env.CCC_RUNTIME, "environment"); }
        catch (error) {
            console.error((error as Error).message);
            process.exit(1);
        }
    }
    const envOpt = Object.keys(extraEnv).length > 0 ? { env: extraEnv } : {};

    const homePreparation = process.env[CONTAINER_ENV_KEY] === CONTAINER_ENV_VALUE
        ? undefined : prepareRuntimeBindHome(DATA_DIR);
    migrateHostHomeLayout(homePreparation);

    // Profile from CCC_PROFILE env var; "default" is the no-profile account.
    const requestedProfile = process.env.CCC_PROFILE || undefined;
    if (requestedProfile !== undefined && !validateProfileName(requestedProfile)) {
        console.error(`Error: Invalid CCC_PROFILE="${requestedProfile}". Use lowercase letters, digits, ., _, - only.`);
        process.exit(1);
    }
    const profile = normalizeProfile(requestedProfile);
    if (profile !== undefined) {
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
    const defaultIdx = cmdArgs.indexOf("--default");
    if (defaultIdx !== -1) {
        const nextArg = cmdArgs[defaultIdx + 1];
        if (nextArg && !nextArg.startsWith("-")) {
            if (!getToolByName(nextArg)) {
                console.error(`Unknown tool: ${nextArg}. Available: ${getAllTools().map(t => t.name).join(", ")}`);
                process.exit(1);
            }
            try {
                setDefaultToolPreference(nextArg);
            } catch (error) {
                console.error(`Error: ${(error as Error).message}`);
                process.exit(1);
            }
            console.log(`Default tool set to: ${nextArg}`);
            return;
        } else {
            console.log(`Default tool: ${getDefaultToolPreference() ?? "claude"}`);
            return;
        }
    }

    let command = cmdArgs[0];
    let cwd = process.cwd();
    let worktreeWorkspace = false;
    let expectedWorktreeSourcePath: string | undefined;

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
            expectedWorktreeSourcePath = cwd;
            cwd = await prepareWorktree(cwd, parsed.branch);
            worktreeWorkspace = true;
            // command stays as cmdArgs[0] (parseArgs already separated @branch)
        }
    }
    worktreeWorkspace ||= isWorktreeWorkspace(cwd);

    switch (command) {
        case "-h":
        case "--help":
        case "help":
            showHelp();
            break;

        case "-v":
        case "--version":
        case "version":
            console.log(CLI_VERSION);
            break;

        case "stop":
            if (worktreeWorkspace) {
                runWorktreeLifecycleOperation(cwd, () => {
                    stopProjectContainer(cwd, profile, { force: cmdArgs.includes("--force") || cmdArgs.includes("-f") });
                }, withProjectFamilyLifecycleLock, assertWorkspaceReady, expectedWorktreeSourcePath);
            } else {
                stopProjectContainer(cwd, profile, { force: cmdArgs.includes("--force") || cmdArgs.includes("-f") });
            }
            break;

        case "rm":
            if (worktreeWorkspace) {
                runWorktreeLifecycleOperation(cwd, () => {
                    removeProjectContainer(cwd, profile, { force: cmdArgs.includes("--force") || cmdArgs.includes("-f") });
                }, withProjectFamilyLifecycleLock, assertWorkspaceReady, expectedWorktreeSourcePath);
            } else {
                removeProjectContainer(cwd, profile, { force: cmdArgs.includes("--force") || cmdArgs.includes("-f") });
            }
            break;

        case "status":
            showStatus();
            break;

        case "runtime":
            console.log(formatRuntimeSummary());
            break;

        case "doctor": {
            const { runDoctor } = await import("./doctor.js");
            const healthy = runDoctor(cwd);
            process.exit(healthy ? 0 : 1);
            break;
        }

        case "devices": {
            const status = await devicesCliAsync(cmdArgs.slice(1), cwd, profile);
            if (cmdArgs[1] === "broker" && cmdArgs[2] === "serve" && status === 0) {
                return;
            }
            process.exit(status);
            break;
        }

        case "labs": {
            const subcommand = cmdArgs[1] || "status";
            if (subcommand === "shell") {
                ensureProfile(LAB_RUNNER_PROFILE_NAME);
                await exec(cwd, ["bash"], { ...envOpt, worktreeWorkspace, expectedWorktreeSourcePath }, LAB_RUNNER_PROFILE_NAME);
                break;
            }
            if (subcommand === "run") {
                const labCommand = cmdArgs.slice(2);
                if (labCommand.length === 0) {
                    console.error("Usage: ccc labs run <command>");
                    process.exit(1);
                }
                ensureProfile(LAB_RUNNER_PROFILE_NAME);
                await exec(cwd, labCommand, { ...envOpt, worktreeWorkspace, expectedWorktreeSourcePath }, LAB_RUNNER_PROFILE_NAME);
                break;
            }
            const status = labsCli(cmdArgs.slice(1), cwd);
            process.exit(status);
            break;
        }

        case "clean": {
            const cleanFlags = cmdArgs.slice(1);
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
            const subcommand = cmdArgs[1];
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
                const remoteArgs = host ? cmdArgs.slice(2) : [];
                await remoteExec(cwd, host, remoteArgs);
            }
            break;
        }

        case "profile": {
            const sub = cmdArgs[1];
            const name = cmdArgs[2];
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
                    if (name === DEFAULT_PROFILE_NAME) {
                        console.error(`Error: "${DEFAULT_PROFILE_NAME}" is the account used without CCC_PROFILE; it always exists.`);
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
                    if (!validateProfileName(name)) {
                        console.error(`Error: Invalid profile name "${name}".`);
                        process.exit(1);
                    }
                    if (name === DEFAULT_PROFILE_NAME) {
                        console.error(`Error: the "${DEFAULT_PROFILE_NAME}" profile cannot be removed; it holds the credentials used without CCC_PROFILE.`);
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
            await exec(cwd, ["bash"], { ...envOpt, worktreeWorkspace, expectedWorktreeSourcePath }, profile);
            break;

        case "update": {
            const tool = resolveTool(process.env);
            await exec(cwd, tool.updateCommand, { tool, ...envOpt, worktreeWorkspace, expectedWorktreeSourcePath }, profile);
            break;
        }

        case undefined: {
            const tool = resolveTool(process.env);
            await exec(cwd, buildToolInvocation(tool, []), { tool, ...envOpt, worktreeWorkspace, expectedWorktreeSourcePath }, profile);
            break;
        }

        default:
            const tool = getToolByName(command);
            if (tool) {
                const toolArgs = cmdArgs.slice(1);
                await exec(cwd, buildToolInvocation(tool, toolArgs), { tool, ...envOpt, worktreeWorkspace, expectedWorktreeSourcePath }, profile);
            } else if (command.startsWith("-")) {
                const defTool = resolveTool(process.env);
                await exec(cwd, buildToolInvocation(defTool, cmdArgs), { tool: defTool, ...envOpt, worktreeWorkspace, expectedWorktreeSourcePath }, profile);
            } else {
                await exec(cwd, cmdArgs, { ...envOpt, worktreeWorkspace, expectedWorktreeSourcePath }, profile);
            }
            break;
    }
}

/** The CLI error boundary also releases claims from failed startup. */
export function runCli(): Promise<void> {
    return main().catch((err) => {
        try { cleanupSession(); } catch (cleanupError) {
            console.error(`[ccc] cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
        console.error(formatContainerStartupError(err, Boolean(process.env.DEBUG)));
        process.exit(1);
    });
}

let isDirectEntry = false;
if (process.argv[1]) {
    try {
        isDirectEntry = pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(__filename)).href;
    } catch {
        // Missing or unresolvable entry paths do not authorize automatic startup.
    }
}
if (isDirectEntry) void runCli();
