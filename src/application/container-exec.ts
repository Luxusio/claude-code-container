import type { ToolDefinition } from "../domain/tool-registry.js";
import type { ContainerExecOptions, ContainerExecPorts, ContainerExecReadinessPorts, ContainerExecReplacementPorts } from "../ports/container-exec.js";

export function ensureContainerExecSetupAvailable(containerId: string, restart: () => string, ports: Pick<ContainerExecReadinessPorts, "running" | "log">): string {
    if (ports.running(containerId, "id")) return containerId;
    ports.log("Container became unavailable during setup, restarting...");
    return restart();
}

export function ensureContainerExecTools(containerId: string, setupTool: ToolDefinition, restart: () => string, ports: ContainerExecReadinessPorts): string {
    let readyContainerId = containerId;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
        readyContainerId = ensureContainerExecSetupAvailable(readyContainerId, restart, ports);
        try { ports.install(readyContainerId, setupTool); return readyContainerId; }
        catch (error) {
            if (ports.running(readyContainerId, "id")) throw error;
            lastError = error;
        }
    }
    throw new Error("Failed to install tools in container", { cause: lastError });
}

export function containerExecReplacementBlockReason(containerName: string, prefix: string, currentLockFile: string, expectedId: string, ports: ContainerExecReplacementPorts): string | null {
    const currentLockName = ports.lockName(currentLockFile);
    const claims = ports.claims(prefix, currentLockFile);
    if (claims.filter(claim => claim === currentLockName).length !== 1) return "the current session lock ownership could not be verified";
    const others = claims.filter(claim => claim !== currentLockName);
    if (others.length > 0) return `${others.length} live or indeterminate session lock claim(s) remain: ${others.join(", ")}`;
    const status = ports.status(containerName);
    if (!status.exists || !status.containerId) return "the container identity could not be verified";
    if (status.containerId !== expectedId) return "the container identity changed before replacement";
    return null;
}

export function resolveContainerExecTools(command: string[], optionsTool: ToolDefinition | undefined, ports: Pick<ContainerExecPorts, "tool" | "defaultTool">): { setupTool: ToolDefinition; commandTool?: ToolDefinition } {
    const commandTool = optionsTool ?? ports.tool(command[0]);
    return { setupTool: commandTool ?? ports.defaultTool(), commandTool };
}

export async function attachContainerExecClipboardImage(projectPath: string, command: string[], commandTool: ToolDefinition | undefined, clipboard: { url?: string; token?: string } | undefined, attach: ContainerExecPorts["attachClipboardImage"]): Promise<string[]> {
    if (commandTool?.name !== "codex") return [...command];
    const attached = await attach(projectPath, [...command], { enabled: true, clipboardUrl: clipboard?.url, clipboardToken: clipboard?.token });
    return attached.args;
}

export function createContainerExec(ports: ContainerExecPorts) {
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
        if (ports.environment().DEBUG) {
            ports.error(`[ccc:debug] exec: projectPath=${projectPath}`);
            ports.error(`[ccc:debug] exec: fullPath=${fullPath}`);
            ports.error(`[ccc:debug] exec: projectId=${projectId}`);
            ports.error(`[ccc:debug] exec: mountPath=/project/${projectId}`);
            ports.error(`[ccc:debug] exec: cmd=${cmd.join(" ")}`);
        }
        const { setupTool, commandTool } = resolveContainerExecTools(cmd, options.tool, ports);
        const shouldEnsureTool = commandTool !== undefined || options.tool !== undefined;
        const worktreeBranch = options.expectedWorktreeBranch ?? ports.detectWorktreeBranch(fullPath);
        const acquire = () => ports.acquireOwnership({
            projectId, projectPath: fullPath, profile,
            toolName: (commandTool ?? options.tool)?.name ?? "command",
        }, (request) => {
            const runtime = ports.runtime();
            if (runtime !== "docker" && runtime !== "podman") throw new Error("Invalid session container runtime.");
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
        if (ports.environment().DEBUG && worktreeMounts.length > 0) {
            ports.error(`[ccc:debug] worktreeGitMounts (${worktreeMounts.length}):`);
            for (const m of worktreeMounts) {
                ports.error(`[ccc:debug]   ${m.hostPath} -> ${m.containerPath}`);
            }
        }

        // Single docker inspect to get container status (replaces 3-4 separate docker commands)
        const targetContainer = ports.containerName(fullPath, profile);
        ports.progress("Checking container...");
        const containerStatus = ports.containerStatus(targetContainer);
        let wasAlreadyRunning = containerStatus.running;
        const sessionContainerPrefix = profile ? `${projectId}--p--${profile}` : projectId;
        // Image and numeric-user upgrades are reconciled together by startProjectContainer.
        // It retains the previous immutable image/mount evidence until Codex state
        // migration completes, under the startup and existing session guards.

        // Start or get container (with extra mounts for worktree workspaces)
        if (!wasAlreadyRunning) ports.progress("Starting container...");
        ports.progress("Preparing device broker...");
        await ports.prepareDeviceBroker(fullPath, profile).catch((error) => {
            ports.warn(`[ccc] WARNING: device broker auto-start failed (${error instanceof Error ? error.message : String(error)}). Host-backed device MCP tools may be unavailable.`);
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
                if (ports.environment().DEBUG) ports.error(`[ccc] Automatic container replacement blocked: ${blockedReason}.`);
                return false;
            }
            recreate();
            return true;
        };
        const invocationStartedContainers = new Set<string>();
        const startContainer = (
            mounts = worktreeMounts.length > 0 ? worktreeMounts : undefined,
            portFile: string | undefined = clipboardPortFile,
            onRecreate: (() => void) | undefined = () => { wasAlreadyRunning = false; },
        ): string => {
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
                    throw new Error("Container became unavailable before the session handoff.");
                }
                return readyContainerId;
            });
        };
        const projectMountPath = `/project/${projectId}`;
        const runMiseInstall = (readyContainerName: string) => {
            // Keep mise's stderr visible — that's where it streams download/build
            // progress. This remains non-fatal by design, but simultaneous joiners
            // must not pass the setup lock while the first install is still active.
            ports.runRuntimeSync(
                ports.runtime(),
                [
                    "exec", "-w", projectMountPath, readyContainerName,
                    "sh", "-c", "mise trust -a >/dev/null 2>&1 || true; mise install -y || true",
                ],
                { stdio: "inherit" },
            );
        };
        // A running container is not necessarily setup-ready. Hold the distinct
        // setup lock from start/handoff through the complete preparation phase, so
        // a simultaneous joiner cannot exec while the creator is still installing
        // commands or configuring the container.
        ports.progress("Synchronizing container setup...");
        let containerName = await ports.setupLock(sessionContainerPrefix, async () => {
            let readyContainerName = startContainer();
            await ports.confirmOwnership();
            ports.configLock(() => ports.restoreConfig(readyContainerName, profile), profile);

            // Skip heavy setup if the container was already running before this
            // launch; the setup lock guarantees a simultaneous creator has finished
            // that work before this joiner reaches the lightweight path.
            if (!wasAlreadyRunning) {
                // Setup steps. spawnSync blocks the event loop so wrapping in Promise.all
                // doesn't actually parallelize — run each step with its own progress line
                // so the user can see exactly where time is being spent.
                ports.progress("Ensuring uv...");
                ports.ensureUv(readyContainerName);

                ports.progress("Building MCP config...");
                const forwardedMcp = await ports.buildMcpConfig(profile, () => ports.restoreConfig(readyContainerName, profile));

                ports.progress("Setting up localhost proxy...");
                ports.setupProxy(readyContainerName);

                if (forwardedMcp.length > 0) {
                    ports.error(`MCP forwarded: ${forwardedMcp.join(", ")}`);
                }

                // Verify container is still running before exec.
                readyContainerName = ensureContainerExecSetupAvailable(
                    readyContainerName, () => startContainer(undefined, undefined, undefined),
                    { running: ports.containerRunning, log: ports.log },
                );
                await ports.confirmOwnership();
            } else {
                // Container already running — only rebuild MCP config (lightweight, may have changed)
                const forwardedMcp = await ports.buildMcpConfig(profile, () => ports.restoreConfig(readyContainerName, profile));
                if (forwardedMcp.length > 0) {
                    ports.error(`MCP forwarded: ${forwardedMcp.join(", ")}`);
                }
            }

            if (!wasAlreadyRunning) {
                ports.progress("Installing project tools (mise)...");
                runMiseInstall(readyContainerName);
            }

            // This is deliberately the final restart-capable readiness step. A
            // late setup checkpoint may have returned a replacement container, so
            // prove/install the requested command against that final pinned ID.
            if (shouldEnsureTool) {
                ports.progress("Checking tools...");
                readyContainerName = ensureContainerExecTools(
                    readyContainerName, setupTool, () => startContainer(undefined, undefined, undefined),
                    { running: ports.containerRunning, install: ports.installTools, log: ports.log },
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
            ports.progress("Syncing clipboard shims...");
            ports.syncClipboard(readyContainerName, ports.assetDirectory);
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
                    ports.warn("[ccc] Unable to confirm session ownership after setup failure.");
                } catch { /* A diagnostic must not replace the setup failure. */ }
            }
            if (ports.isRestartRequired(error)) throw error;
            const detail = error instanceof Error ? `: ${error.message}` : "";
            throw new Error(`Container setup failed${detail}`, { cause: error });
        });

        // Build docker exec command
        const clipboardHost = clipboardPort
            ? ((ports.platform() === "linux" && !ports.isDockerDesktop()) ? "127.0.0.1" : "host.docker.internal")
            : null;
        let clipboardToken: string | null = null;
        if (clipboardPort) {
            try {
                const portFileContent = ports.readClipboardPort(ports.clipboardPortFile()).trim();
                clipboardToken = portFileContent.split(":").slice(1).join(":") || null;
            } catch {
                clipboardToken = null;
            }
        }

        const clipboardUrl = clipboardHost && clipboardPort
            ? `http://${clipboardHost}:${clipboardPort}`
            : undefined;

        let resolvedCmd = [...cmd];
        resolvedCmd = await attachContainerExecClipboardImage(
            fullPath, resolvedCmd, commandTool,
            { url: clipboardUrl, token: clipboardToken ?? undefined }, ports.attachClipboardImage,
        );

        // Spin up the in-container X11 clipboard bridge (Xvfb :99 + sync daemon)
        // on every session. Idle Xvfb is ~15-30MB RAM so running it always is
        // cheaper than branching per-tool and lets GUI MCPs / Electron apps work
        // out of the box even if no clipboard server is up (sync loop just idles).
        // Script is idempotent; reuses an existing bridge.
        {
            const bridgeEnv: string[] = [];
            if (clipboardUrl) bridgeEnv.push("-e", `CCC_CLIPBOARD_URL=${clipboardUrl}`);
            if (clipboardToken) bridgeEnv.push("-e", `CCC_CLIPBOARD_TOKEN=${clipboardToken}`);
            ports.runRuntimeSync(ports.runtime(), [
                "exec", "-d", ...bridgeEnv, containerName,
                "/usr/local/bin/ccc-x11-bridge",
            ], { stdio: "ignore" });
        }

        const execArgs = ["exec", "-w", projectMountPath];

        // Collect all env vars into a temp file and pass --env-file to docker exec.
        // This avoids the OS ARG_MAX limit ("Argument list too long") that occurs when
        // forwarding many environment variables as repeated -e KEY=VALUE flags.
        const forwardedEnvPlan = ports.forwardedEnvironment(ports.environment());
        if (forwardedEnvPlan.skippedDueToLimit.length > 0) {
            ports.error(
                `Skipped ${forwardedEnvPlan.skippedDueToLimit.length} host env var(s) to keep exec size bounded; use --env KEY=VALUE for required overrides.`,
            );
        }

        const envEntries: Array<[string, string]> = [
            // Container marker: enables per-project env separation via mise.toml [env]
            [...ports.containerEnvironment],
            ...forwardedEnvPlan.forwarded,
            ["MISE_TRUSTED_CONFIG_PATHS", projectMountPath],
        ];

        // Locale: forward host LANG/LC_* (no longer excluded).
        // If host has no LANG set, inject en_US.UTF-8 as fallback.
        if (!ports.environment().LANG) {
            envEntries.push(["LANG", "en_US.UTF-8"]);
        }

        // Timezone: detect host timezone and forward to container.
        // Priority: TZ env var → Intl API detection → UTC fallback.
        const hostTz = ports.environment().TZ
            || ports.timezone()
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

        let preparationStatus: number | null = null;
        let resultStatus: number;
        const envFile = ports.createEnvironmentFile(envEntries);
        try {
            execArgs.push("--env-file", envFile.path);

            if (commandTool?.name === "codex" && options.interactive !== false) {
                const preparation = ports.prepareCodexLaunch(ports.runtime(), [...execArgs, containerName], resolvedCmd);
                if (!preparation.ok) {
                    ports.error(`[ccc] ${preparation.error}`);
                    preparationStatus = preparation.status;
                } else {
                    resolvedCmd = preparation.command;
                    if (preparation.notice) ports.error(`[ccc] ${preparation.notice}`);
                }
            }

            if (options.interactive !== false && ports.terminalReady()) {
                execArgs.push("-it");
                if (commandTool?.name === "codex" && preparationStatus === null) {
                    resolvedCmd = ports.recoverCodexCommand(resolvedCmd);
                }
            }

            execArgs.push(containerName);

            if (commandTool?.name === "claude") {
                // Run claude directly (no shell wrapper — avoids mise interception)
                execArgs.push(ports.claudeBinaryPath, ...cmd.slice(1));
            } else {
                execArgs.push(...resolvedCmd);
            }

            await ports.confirmOwnership();
            if (preparationStatus === null) {
                ports.setCleanupEnabled(true);
                await ports.confirmOwnership();
                resultStatus = await ports.runCommand(ports.runtime(), execArgs, options.interactive !== false);
            } else {
                resultStatus = preparationStatus;
            }
        } finally {
            try {
                ports.configLock(() => ports.restoreConfig(containerName, profile), profile);
            } catch (error) {
                try {
                    ports.warn(`[ccc] Unable to restore Codex config access after command exit: ${error instanceof Error ? error.message : String(error)}`);
                } catch { /* A diagnostic must not replace the command outcome. */ }
            } finally {
                try {
                    envFile.dispose();
                } finally {
                    try {
                        ports.cleanupSession();
                    } catch {
                        try {
                            ports.warn("[ccc] Session cleanup failed after command exit.");
                        } catch { /* A diagnostic must not replace the command outcome. */ }
                    }
                }
            }
        }

        if (ports.environment().DEBUG) {
            // Check conversation directory state after Claude exits
            const claudeProjectDir = `/home/ccc/.claude/projects/-project-${projectId}`;
            const checkResult = ports.runRuntimeSync(ports.runtime(), [
                "exec", containerName, "sh", "-c",
                `ls -1 "${claudeProjectDir}"/*.jsonl 2>/dev/null | wc -l; echo "dir:${claudeProjectDir}"`,
            ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
            const output = (checkResult.stdout ?? "").trim();
            ports.error(`[ccc:debug] post-exit conversation check: ${output}`);
        }

        return resultStatus;
    }

    return { exec };
}
