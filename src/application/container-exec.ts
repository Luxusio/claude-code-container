import type { ToolDefinition } from "../domain/tool-registry.js";
import type { RuntimeBindGuard } from "../ports/runtime-bind-authority.js";
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
        const worktreeWorkspace = options.worktreeWorkspace === true || ports.isWorktreeWorkspace(fullPath);
        let ownershipAcquired = false;
        const failures: unknown[] = [];
        let resultStatus = 0;
        let conversationContainerName: string | undefined;
        const acquire = async () => {
            const ownership = await ports.acquireOwnership({
                projectId, projectPath: fullPath, profile,
                toolName: (commandTool ?? options.tool)?.name ?? "command",
            }, (request) => {
                const runtime = ports.runtime();
                if (runtime !== "docker" && runtime !== "podman") throw ports.invalidRuntimeFailure();
                return { ...ports.inspectSessionContainer(request.projectPath, request.profile), runtime };
            });
            ownershipAcquired = true;
            return ownership;
        };
        try {
            const acquired = worktreeWorkspace
                ? await ports.familyLock(projectId, () => {
                    ports.assertWorkspace(fullPath, options.expectedWorktreeSourcePath);
                    return acquire();
                })
                : await acquire();
            const sessionLockFile = acquired.lockFile;
            const existingOnly = acquired.existingOnly === true;
            const existingOnlyContainerId = existingOnly ? acquired.existingId : null;
            const existingOnlyFailure = () => new Error("Existing-only session requires the same identified container; only its verified activation is allowed, with image updates deferred and replacement and automatic cleanup disabled.");
            let requiresLiveVerification = acquired.requiresLiveVerification === true;
            if (existingOnly && (!existingOnlyContainerId || !/^[a-f0-9]{64}$/i.test(existingOnlyContainerId))) {
                throw existingOnlyFailure();
            }

            // Start clipboard server early — must complete before container creation so
            // the port file exists and can be bind-mounted (file mount requires the file
            // to already exist at docker run time).
            let clipboardSelection = await ports.ensureClipboard().catch(() => null);
            // The session's service endpoint may advance while an existing
            // container retains its exact legacy file bind. Native startup
            // still validates that mount; new clients use the selected pair.
            const clipboardMountPath = clipboardSelection?.generation
                ? ports.clipboardPortFile() : clipboardSelection?.portFile;

            // Detect worktree mounts (source .git directories needed for git operations)
            const worktreeMounts = ports.worktreeMounts(
                fullPath,
                worktreeWorkspace,
                `/project/${projectId}`,
            );
            if (ports.debugEnabled() && worktreeMounts.length > 0) ports.report({ kind: "mounts-debug", mounts: worktreeMounts });

            // Single docker inspect to get container status (replaces 3-4 separate docker commands)
            const targetContainer = ports.containerName(fullPath, profile);
            ports.report({ kind: "progress", phase: "checking" });
            const containerStatus = ports.containerStatus(targetContainer);
            if (existingOnly) {
                if (!containerStatus.exists || typeof containerStatus.running !== "boolean"
                    || containerStatus.containerId !== existingOnlyContainerId) throw existingOnlyFailure();
                ports.report({ kind: "recovery-retained", message: (acquired.recoveryWarning || "Predecessor cleanup remains pending.")
                    .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512) });
            }
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
            const recreateInsideLifecycleLock = (recreate: () => void, bindGuard: RuntimeBindGuard) => {
                if (existingOnly) return false;
                if (requiresLiveVerification) {
                    const oldId = containerStatus.containerId;
                    if (!oldId || !ports.verifyStoppedSessionContainerForReplacement(fullPath, profile, oldId, bindGuard)) return false;
                    requiresLiveVerification = false;
                }
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
            // Once this invocation has observed a ready or positively started
            // target, later readiness retries must retain that exact identity.
            let expectedStartupContainerId = (existingOnly ? existingOnlyContainerId
                : containerStatus.running ? containerStatus.containerId : null) ?? undefined;
            let startupIntentPublished = false;
            let startup: ReturnType<ContainerExecPorts<Prepared>["prepareContainer"]>;
            const startContainer = async (
                mounts = worktreeMounts.length > 0 ? worktreeMounts : undefined,
                portFile: string | undefined = clipboardMountPath,
                onRecreate: (() => void) | undefined = () => { wasAlreadyRunning = false; },
            ): Promise<string> => {
                const readyId = await ports.stateLock(async bindGuard => {
                    clipboardSelection = await ports.validateClipboard(clipboardSelection, bindGuard);
                    // Validation and native bind share this held global capability.
                    const selectedPortFile = clipboardSelection && (clipboardSelection.generation
                        ? portFile === clipboardMountPath : clipboardSelection.portFile === portFile)
                        ? portFile : undefined;
                    return ports.lifecycleLock(sessionContainerPrefix, () => {
                        let readyContainerId: string | null = null;
                        startup.start(
                            fullPath,
                            () => ports.ensureDirectories(profile),
                            mounts,
                            selectedPortFile,
                            profile,
                            onRecreate,
                            recreate => recreateInsideLifecycleLock(recreate, bindGuard),
                            (containerId, handoff) => {
                                if (existingOnly && (containerId !== existingOnlyContainerId || handoff.startedByInvocation)) throw existingOnlyFailure();
                                requiresLiveVerification = false;
                                readyContainerId = containerId;
                                expectedStartupContainerId = containerId;
                                if (handoff.startedByInvocation) invocationStartedContainers.add(containerId);
                                ports.publishSessionReadyInHeldLifecycleLock(containerId, {
                                    startedByInvocation: !existingOnly && invocationStartedContainers.has(containerId),
                                });
                            },
                            expectedStartupContainerId,
                            (containerId) => {
                                if (existingOnly) throw existingOnlyFailure();
                                expectedStartupContainerId = containerId;
                                invocationStartedContainers.add(containerId);
                                ports.recordSessionOwnStartInHeldLifecycleLock(containerId);
                            },
                            bindGuard,
                            () => {
                                if (existingOnly) throw existingOnlyFailure();
                                if (startupIntentPublished || invocationStartedContainers.size > 0) return;
                                ports.beginSessionStartupInHeldLifecycleLock();
                                startupIntentPublished = true;
                            },
                        );
                        if (!readyContainerId) {
                            throw ports.handoffFailure();
                        }
                        return readyContainerId;
                    });
                });
                await ports.confirmOwnership();
                startup.initialize(readyId);
                return readyId;
            };
            const projectMountPath = `/project/${projectId}`;
            // A running container is not necessarily setup-ready. Hold the distinct
            // setup lock from start/handoff through the complete preparation phase, so
            // a simultaneous joiner cannot exec while the creator is still installing
            // commands or configuring the container.
            ports.report({ kind: "progress", phase: "setup" });
            let containerName = await ports.setupLock(sessionContainerPrefix, async () => {
                startup = existingOnly
                    ? ports.prepareContainer({ existingContainerId: existingOnlyContainerId! })
                    : ports.prepareContainer();
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

            const clipboard = ports.clipboardConnection(clipboardSelection);
            const resolvedCmd = await attachContainerExecClipboardImage(
                fullPath, cmd, commandTool, { ...clipboard, url: clipboard.hostUrl ?? clipboard.url }, ports.attachClipboardImage,
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
                if (clipboard.generation) envEntries.push(["CCC_CLIPBOARD_GENERATION", clipboard.generation]);
            }
            // Tool compatibility overrides follow host forwarding; explicit session overrides win last.
            if (commandTool?.needsNodeRuntime) {
                envEntries.push(["MISE_NODE_VERSION", "22"], ["BASH_ENV", "/home/ccc/.bashrc_hooks"]);
            }
            if (options.env) envEntries.push(...Object.entries(options.env));

            let preparationStatus: number | null = null;
            let prepared: Prepared | undefined;
            try {
                prepared = ports.prepareCommand({
                    runtime: ports.runtime(), target: containerName, workdir: projectMountPath,
                    environment: envEntries,
                    command: commandTool?.name === "claude"
                        ? { kind: "claude", arguments: cmd.slice(1) }
                        : { kind: "command", arguments: resolvedCmd },
                });
                if (commandTool?.name === "codex" && options.interactive !== false) {
                    const preparation = ports.prepareCodexCommand(prepared);
                    if (!preparation.ok) preparationStatus = preparation.status;
                    if (!preparation.ok || preparation.reason) ports.report({ kind: "codex-preparation", result: preparation });
                }
                // Terminal observation follows preparation even for a refused Codex launch.
                const terminal = options.interactive !== false && ports.terminalReady();

                await ports.confirmOwnership();
                if (preparationStatus === null) {
                    ports.setCleanupEnabled(!existingOnly);
                    await ports.confirmOwnership();
                    resultStatus = await ports.launchCommand(prepared, { interactive: options.interactive !== false, terminal, codexRecovery: terminal && commandTool?.name === "codex" });
                } else {
                    resultStatus = preparationStatus;
                }
            } catch (error) {
                failures.push(error);
            } finally {
                try {
                    ports.configLock(() => ports.restoreConfig(containerName, profile), profile);
                } catch (error) {
                    try {
                        ports.report({ kind: "restore-failed", cause: error });
                    } catch { /* A diagnostic must not replace the command outcome. */ }
                }
                try { if (prepared !== undefined) ports.disposeCommand(prepared); }
                catch (error) { failures.push(error); }
            }
            conversationContainerName = containerName;
        } catch (error) {
            failures.push(error);
        } finally {
            if (ownershipAcquired) {
                try { ports.cleanupSession(); }
                catch (error) {
                    failures.push(error);
                    try { ports.report({ kind: "cleanup-failed", cause: error }); }
                    catch { /* Diagnostics cannot erase cleanup or command failures. */ }
                }
            }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Container command and finalization failed", { cause: failures[0] });

        if (ports.debugEnabled() && conversationContainerName !== undefined) ports.reportConversationFiles(conversationContainerName, projectId);

        return resultStatus;
    }

    return { exec };
}
