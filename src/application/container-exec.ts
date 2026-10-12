import type { ToolDefinition } from "../domain/tool-registry.js";
import type { ContainerExecOptions, ContainerExecPorts, ContainerExecReadinessPorts, ContainerExecReplacementPorts, ContainerExecReplacementReason } from "../ports/container-exec.js";

export async function ensureContainerExecSetupAvailable(containerId: string, restart: () => Promise<string> | string, ports: Pick<ContainerExecReadinessPorts, "running" | "restarted">): Promise<string> {
    if (ports.running(containerId, "id")) return containerId;
    ports.restarted();
    return restart();
}

export async function ensureContainerExecTools(containerId: string, setupTool: ToolDefinition, restart: () => Promise<string> | string, ports: ContainerExecReadinessPorts): Promise<string> {
    let readyContainerId = containerId;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
        readyContainerId = await ensureContainerExecSetupAvailable(readyContainerId, restart, ports);
        try { ports.install(readyContainerId, setupTool); return readyContainerId; }
        catch (error) {
            if (ports.running(readyContainerId, "id")) throw error;
            lastError = error;
        }
    }
    throw ports.installFailure(lastError);
}

export function containerExecReplacementBlockReason(containerName: string, prefix: string, currentLockFile: string, expectedId: string, ports: ContainerExecReplacementPorts): ContainerExecReplacementReason | null {
    const currentLockName = ports.lockName(currentLockFile);
    const claims = ports.claims(prefix, currentLockFile);
    if (claims.filter(claim => claim === currentLockName).length !== 1) return { reason: "ownership-unverified" };
    const others = claims.filter(claim => claim !== currentLockName);
    if (others.length > 0) return { reason: "other-claims", claims: others };
    const status = ports.status(containerName);
    if (!status.exists || !status.containerId) return { reason: "identity-absent" };
    if (status.containerId !== expectedId) return { reason: "identity-changed" };
    return null;
}

export function resolveContainerExecTools<Prepared>(command: string[], optionsTool: ToolDefinition | undefined, ports: Pick<ContainerExecPorts<Prepared>, "tool" | "defaultTool">): { setupTool: ToolDefinition; commandTool?: ToolDefinition } {
    const commandTool = optionsTool ?? ports.tool(command[0]);
    return { setupTool: commandTool ?? ports.defaultTool(), commandTool };
}

export async function attachContainerExecClipboardImage<Prepared>(projectPath: string, command: string[], commandTool: ToolDefinition | undefined, clipboard: { url?: string; token?: string } | undefined, attach: ContainerExecPorts<Prepared>["attachClipboardImage"]): Promise<string[]> {
    if (commandTool?.name !== "codex") return [...command];
    const attached = await attach(projectPath, [...command], { enabled: true, clipboardUrl: clipboard?.url, clipboardToken: clipboard?.token });
    return attached.args;
}

export function createContainerExec<Prepared>(ports: ContainerExecPorts<Prepared>) {
    async function exec(
        projectPath: string,
        cmd: string[],
        options: ContainerExecOptions = {},
        profile?: string,
    ): Promise<number> {
        // Check Docker is running first
        ports.ensureRuntime();

        const fullPath = ports.resolveProject(projectPath);

        // Ensure directories exist before syncing credentials
        ports.ensureDirectories(profile);


        // Check for mise.toml and offer to create if not exists
        await ports.ensureProjectTools(fullPath);

        // Create session lock BEFORE starting container so other sessions
        // see us during their cleanup and don't stop the container prematurely.
        // This prevents a race condition where:
        //   Terminal A cleanup checks for other sessions → finds none → stops container
        //   Terminal B is still setting up but hasn't created its lock yet → container dies
        const projectId = ports.projectId(fullPath);
        if (ports.debugEnabled()) ports.report({ kind: "exec-debug", projectPath, fullPath, projectId, command: cmd });
        const { setupTool, commandTool } = resolveContainerExecTools(cmd, options.tool, ports);
        const shouldEnsureTool = commandTool !== undefined || options.tool !== undefined;
        const worktreeBranch = options.expectedWorktreeBranch ?? ports.detectWorktreeBranch(fullPath);
        const acquire = () => ports.acquireOwnership({
            projectId, projectPath: fullPath, profile,
            toolName: (commandTool ?? options.tool)?.name ?? "command",
        }, (request) => {
            const runtime = ports.runtime();
            if (runtime !== "docker" && runtime !== "podman") throw ports.invalidRuntimeFailure();
            return { ...ports.inspectSessionContainer(request.projectPath, request.profile), runtime };
        });
        const { lockFile: sessionLockFile } = worktreeBranch
            ? await ports.familyLock(projectId, () => {
                ports.assertWorktreeBranch(fullPath, worktreeBranch, options.expectedWorktreeSourcePath);
                return acquire();
            })
            : await acquire();

        // Start clipboard server early — must complete before container creation so
        // the port file exists and can be bind-mounted (file mount requires the file
        // to already exist at docker run time).
        const clipboardPort = await ports.ensureClipboard().catch(() => null);
        const clipboardPortFile = ports.clipboardPortFile();

        // Detect worktree mounts (source .git directories needed for git operations)
        const worktreeMounts = ports.worktreeMounts(
            fullPath,
            worktreeBranch !== null,
            `/project/${projectId}`,
        );
        if (ports.debugEnabled() && worktreeMounts.length > 0) ports.report({ kind: "mounts-debug", mounts: worktreeMounts });

        // Single docker inspect to get container status (replaces 3-4 separate docker commands)
        const targetContainer = ports.containerName(fullPath, profile);
        ports.report({ kind: "progress", phase: "checking" });
        const containerStatus = ports.containerStatus(targetContainer);
        let wasAlreadyRunning = containerStatus.running;
        const sessionContainerPrefix = profile ? `${projectId}--p--${profile}` : projectId;
        // Image and numeric-user upgrades are reconciled together by startProjectContainer.
        // It retains the previous immutable image/mount evidence until Codex state
        // migration completes, under the startup and existing session guards.

        // Start or get container (with extra mounts for worktree workspaces)
        if (!wasAlreadyRunning) ports.report({ kind: "progress", phase: "starting" });
        ports.report({ kind: "progress", phase: "broker" });
        await ports.prepareDeviceBroker(fullPath, profile).catch((error) => {
            ports.report({ kind: "broker-failed", cause: error });
        });
        const recreateInsideLifecycleLock = (recreate: () => void) => {
            const blockedReason = containerExecReplacementBlockReason(
                targetContainer,
                sessionContainerPrefix,
                sessionLockFile,
                containerStatus.containerId ?? "",
                { claims: ports.sessionClaims, status: ports.containerStatus, lockName: ports.lockName },
            );
            if (blockedReason) {
                if (ports.debugEnabled()) ports.report({ kind: "replacement-blocked", evidence: blockedReason });
                return false;
            }
            recreate();
            return true;
        };
        const invocationStartedContainers = new Set<string>();
        const startContainer = async (
            mounts = worktreeMounts.length > 0 ? worktreeMounts : undefined,
            portFile: string | undefined = clipboardPortFile,
            onRecreate: (() => void) | undefined = () => { wasAlreadyRunning = false; },
        ): Promise<string> => {
            return ports.lifecycleLock(sessionContainerPrefix, () => {
                let readyContainerId: string | null = null;
                ports.startContainer(
                    fullPath,
                    () => ports.ensureDirectories(profile),
                    mounts,
                    portFile,
                    profile,
                    onRecreate,
                    recreateInsideLifecycleLock,
                    (containerId, handoff) => {
                        readyContainerId = containerId;
                        ports.setSessionContainer(containerId);
                        if (handoff.startedByInvocation) invocationStartedContainers.add(containerId);
                        ports.setCleanupEnabled(invocationStartedContainers.has(containerId));
                    },
                    containerStatus.running ? containerStatus.containerId ?? undefined : undefined,
                    (containerId) => {
                        invocationStartedContainers.add(containerId);
                        ports.setSessionContainer(containerId);
                        ports.setCleanupEnabled(true);
                    },
                );
                if (!readyContainerId) {
                    throw ports.handoffFailure();
                }
                return readyContainerId;
            });
        };
        const projectMountPath = `/project/${projectId}`;
        // A running container is not necessarily setup-ready. Hold the distinct
        // setup lock from start/handoff through the complete preparation phase, so
        // a simultaneous joiner cannot exec while the creator is still installing
        // commands or configuring the container.
        ports.report({ kind: "progress", phase: "setup" });
        let containerName = await ports.setupLock(sessionContainerPrefix, async () => {
            let readyContainerName = await startContainer();
            await ports.confirmOwnership();
            ports.configLock(() => ports.restoreConfig(readyContainerName, profile), profile);

            // Skip heavy setup if the container was already running before this
            // launch; the setup lock guarantees a simultaneous creator has finished
            // that work before this joiner reaches the lightweight path.
            if (!wasAlreadyRunning) {
                // Setup steps. spawnSync blocks the event loop so wrapping in Promise.all
                // doesn't actually parallelize — run each step with its own progress line
                // so the user can see exactly where time is being spent.
                ports.report({ kind: "progress", phase: "uv" });
                ports.ensureUv(readyContainerName);

                ports.report({ kind: "progress", phase: "mcp" });
                const forwardedMcp = await ports.buildMcpConfig(profile, () => ports.restoreConfig(readyContainerName, profile));

                ports.report({ kind: "progress", phase: "proxy" });
                ports.setupProxy(readyContainerName);

                if (forwardedMcp.length > 0) {
                    ports.report({ kind: "mcp-forwarded", names: forwardedMcp });
                }

                // Verify container is still running before exec.
                readyContainerName = await ensureContainerExecSetupAvailable(
                    readyContainerName, () => startContainer(undefined, undefined, undefined),
                    { running: ports.containerRunning, restarted: () => ports.report({ kind: "restarted" }) },
                );
                await ports.confirmOwnership();
            } else {
                // Container already running — only rebuild MCP config (lightweight, may have changed)
                const forwardedMcp = await ports.buildMcpConfig(profile, () => ports.restoreConfig(readyContainerName, profile));
                if (forwardedMcp.length > 0) {
                    ports.report({ kind: "mcp-forwarded", names: forwardedMcp });
                }
            }

            if (!wasAlreadyRunning) {
                ports.report({ kind: "progress", phase: "mise" });
                ports.installProjectTools(readyContainerName, projectMountPath);
            }

            // This is deliberately the final restart-capable readiness step. A
            // late setup checkpoint may have returned a replacement container, so
            // prove/install the requested command against that final pinned ID.
            if (shouldEnsureTool) {
                ports.report({ kind: "progress", phase: "tools" });
                readyContainerName = await ensureContainerExecTools(
                    readyContainerName, setupTool, () => startContainer(undefined, undefined, undefined),
                    { running: ports.containerRunning, install: ports.installTools, restarted: () => ports.report({ kind: "restarted" }), installFailure: cause => ports.setupToolFailure(cause) },
                );
                await ports.confirmOwnership();
            }
            if (commandTool?.name === "claude") {
                // Re-verify after mise because a project shim can replace the fixed
                // command path while setup owns the readiness lock.
                ports.ensureClaude(readyContainerName);
            } else if (commandTool?.name === "codex") {
                ports.configLock(() => ports.prepareCodexConfig(readyContainerName, profile), profile);
                ports.assertCodexState(readyContainerName, profile);
                ports.ensureCodexHarness(readyContainerName, profile);
            }
            ports.report({ kind: "progress", phase: "clipboard" });
            ports.syncClipboard(readyContainerName);
            // Runs for new, restarted, reused and deferred containers alike, on the final ID.
            ports.ensureSocketAccess(readyContainerName);
            return readyContainerName;
        }).catch(async (error) => {
            // A native start may succeed before its subsequent setup helper fails.
            // Settle that captured start's guardian authorization before cleanup.
            try {
                await ports.confirmOwnership();
            } catch {
                try {
                    ports.report({ kind: "ownership-unconfirmed" });
                } catch { /* A diagnostic must not replace the setup failure. */ }
            }
            if (ports.isRestartRequired(error)) throw error;
            throw ports.setupFailure(error);
        });

        const clipboard = ports.clipboardConnection(clipboardPort);
        const resolvedCmd = await attachContainerExecClipboardImage(
            fullPath, cmd, commandTool, clipboard, ports.attachClipboardImage,
        );
        ports.startClipboardBridge(containerName, clipboard);
        const environment = ports.observeCommandEnvironment();
        if (environment.skippedKeys.length > 0) ports.report({ kind: "environment-skipped", keys: environment.skippedKeys });
        const envEntries: Array<[string, string]> = [
            [...environment.containerMarker],
            ...environment.forwarded,
            ["MISE_TRUSTED_CONFIG_PATHS", projectMountPath],
        ];
        if (!environment.hostLangPresent) envEntries.push(["LANG", "en_US.UTF-8"]);
        envEntries.push(["TZ", environment.hostTimezone || environment.observedTimezone || "UTC"]);
        if (clipboard.url) {
            envEntries.push(["CCC_CLIPBOARD_URL", clipboard.url]);
            if (clipboard.token) envEntries.push(["CCC_CLIPBOARD_TOKEN", clipboard.token]);
        }
        // Tool compatibility overrides follow host forwarding; explicit session overrides win last.
        if (commandTool?.needsNodeRuntime) {
            envEntries.push(["MISE_NODE_VERSION", "22"], ["BASH_ENV", "/home/ccc/.bashrc_hooks"]);
        }
        if (options.env) envEntries.push(...Object.entries(options.env));

        let preparationStatus: number | null = null;
        let resultStatus: number;
        // Artifact creation failures remain under the outer CLI cleanup authority.
        const prepared = ports.prepareCommand({
            runtime: ports.runtime(), target: containerName, workdir: projectMountPath,
            environment: envEntries,
            command: commandTool?.name === "claude"
                ? { kind: "claude", arguments: cmd.slice(1) }
                : { kind: "command", arguments: resolvedCmd },
        });
        try {
            if (commandTool?.name === "codex" && options.interactive !== false) {
                const preparation = ports.prepareCodexCommand(prepared);
                if (!preparation.ok) preparationStatus = preparation.status;
                if (!preparation.ok || preparation.reason) ports.report({ kind: "codex-preparation", result: preparation });
            }
            // Terminal observation follows preparation even for a refused Codex launch.
            const terminal = options.interactive !== false && ports.terminalReady();

            await ports.confirmOwnership();
            if (preparationStatus === null) {
                ports.setCleanupEnabled(true);
                await ports.confirmOwnership();
                resultStatus = await ports.launchCommand(prepared, { interactive: options.interactive !== false, terminal, codexRecovery: terminal && commandTool?.name === "codex" });
            } else {
                resultStatus = preparationStatus;
            }
        } finally {
            try {
                ports.configLock(() => ports.restoreConfig(containerName, profile), profile);
            } catch (error) {
                try {
                    ports.report({ kind: "restore-failed", cause: error });
                } catch { /* A diagnostic must not replace the command outcome. */ }
            } finally {
                try {
                    ports.disposeCommand(prepared);
                } finally {
                    try {
                        ports.cleanupSession();
                    } catch {
                        try {
                            ports.report({ kind: "cleanup-failed" });
                        } catch { /* A diagnostic must not replace the command outcome. */ }
                    }
                }
            }
        }

        if (ports.debugEnabled()) ports.reportConversationFiles(containerName, projectId);

        return resultStatus;
    }

    return { exec };
}
