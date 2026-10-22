import { spawnSync } from "child_process";
import { terminalEnvironment } from "../domain/terminal-environment.js";
import { basename, resolve } from "path";
import type { ContainerExecPorts, ContainerExecReport, ContainerExecReadinessPorts, ContainerExecReplacementPorts, ContainerExecReplacementReason } from "../ports/container-exec.js";
import { runContainerCommand } from "../container-command.js";
import { getProjectId, collectForwardedEnv, writeOwnedEnvFile, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE } from "../utils.js";
import { ensureClipboardSelection, validateClipboardSelection } from "../clipboard-server.js";
import { clipboardPortFile } from "../home-layout.js";
import { runtimeCli, runtimeSpawnSync, getRuntimeInvocation, currentNativeRuntimeInvocation, bindNativeRuntimeInvocation, runWithNativeRuntimeInvocation, type NativeRuntimeInvocation, type BoundNativeRuntimeRunner } from "../container-runtime.js";
import { getToolByName, getDefaultTool } from "../tool-registry.js";
import { isWorktreeWorkspace, assertWorkspaceReady, getWorktreeGitMounts } from "../worktree.js";
import {
    ensureDockerRunning, inspectSessionContainerOwnership, getContainerName, getContainerStatus,
    startProjectContainer, prepareProjectContainerStartup, withProjectContainerStateLockAsync, restoreCodexConfigHostOwnership, isContainerRunning,
    prepareCodexConfigForContainer, syncClipboardShims, ensureContainerManagerSocketAccess, isDockerDesktop,
} from "../docker.js";
import {
    acquireHostSessionOwnership, withProjectFamilyLifecycleLockAsync, withContainerLifecycleLockAsync,
    withContainerSetupLockAsync, getActiveSessionsForContainer,
    beginSessionStartupInHeldLifecycleLock, recordSessionOwnStartInHeldLifecycleLock,
    publishSessionReadyInHeldLifecycleLock,
    setSessionCleanupEnabled, confirmSessionOwnership, cleanupSession, getCurrentSessionOwnershipReceipt,
} from "../session.js";
import { withCodexConfigLock } from "../codex-config-lock.js";
import { ensureUvAvailable, ensureTools, ensureClaudeInContainer, CLAUDE_BIN_PATH } from "../container-setup.js";
import { buildMcpConfig } from "../mcp-forward.js";
import { setupLocalhostProxy } from "../localhost-proxy-setup.js";
import { assertCodexStateAccessible } from "../codex-state-ownership.js";
import { ensureCodexHarness } from "../codex-harness.js";
import { ContainerRestartRequiredError } from "../container-restart-guidance.js";
import { maybeAttachCodexClipboardImage } from "../codex-clipboard-image.js";
import { prepareCodexLaunchSemantic, presentCodexLaunchPreparation } from "../codex-launch.js";
import { buildCodexResumeRecoveryCommand } from "../codex-resume-recovery.js";
import { DEVICE_BROKER_DEFAULT_HOST, ensureHostDeviceBroker } from "@ccc/device-lab/device-lab-broker.js";
import type { ToolDefinition } from "../domain/tool-registry.js";
import {
    ensureContainerExecSetupAvailable as ensureSetupAvailable,
    ensureContainerExecTools as ensureToolsReady,
    containerExecReplacementBlockReason as replacementReason,
} from "../application/container-exec.js";

export function ensureContainerExecSetupAvailable(containerId: string, restart: () => Promise<string> | string,
    ports: Pick<ContainerExecReadinessPorts, "running"> & { log(message: string): void }): Promise<string> {
    return ensureSetupAvailable(containerId, restart, {
        running: ports.running, restarted: () => ports.log("Container became unavailable during setup, restarting..."),
    });
}

export function ensureContainerExecTools(containerId: string, tool: ToolDefinition, restart: () => Promise<string> | string,
    ports: Pick<ContainerExecReadinessPorts, "running" | "install"> & { log(message: string): void }): Promise<string> {
    return ensureToolsReady(containerId, tool, restart, {
        running: ports.running, install: ports.install,
        restarted: () => ports.log("Container became unavailable during setup, restarting..."),
        installFailure: cause => new Error("Failed to install tools in container", { cause }),
    });
}

export function containerExecReplacementBlockReason(containerName: string, prefix: string, currentLockFile: string,
    expectedId: string, ports: ContainerExecReplacementPorts): string | null {
    const reason = replacementReason(containerName, prefix, currentLockFile, expectedId, ports);
    return reason ? presentContainerExecReplacementReason(reason) : null;
}

export interface ContainerExecNativeBindings {
    ensureDirectories(profile?: string): void;
    ensureProjectTools(path: string): Promise<void>;
    assetDirectory: string;
    trustedCliPath: string;
}

interface PreparedContainerExecCommand {
    runtime: string;
    runner: BoundNativeRuntimeRunner;
    prefix: string[];
    target: string;
    command: string[];
    terminalEnvironment: string[];
    dispose(): void;
}

export function presentContainerExecReplacementReason(evidence: ContainerExecReplacementReason): string {
    switch (evidence.reason) {
        case "ownership-unverified": return "the current session lock ownership could not be verified";
        case "other-claims": return `${evidence.claims.length} live or indeterminate session lock claim(s) remain: ${evidence.claims.join(", ")}`;
        case "identity-absent": return "the container identity could not be verified";
        case "identity-changed": return "the container identity changed before replacement";
    }
}

export function presentContainerExecReport(report: ContainerExecReport): void {
    switch (report.kind) {
        case "progress": {
            const messages = { checking: "Checking container...", starting: "Starting container...", broker: "Preparing device broker...",
                setup: "Synchronizing container setup...", uv: "Ensuring uv...", mcp: "Building MCP config...", proxy: "Setting up localhost proxy...",
                mise: "Installing project tools (mise)...", tools: "Checking tools...", clipboard: "Syncing clipboard shims..." };
            process.stderr.write(`\x1b[2m▸ ${messages[report.phase]}\x1b[0m\n`);
            return;
        }
        case "exec-debug":
            console.error(`[ccc:debug] exec: projectPath=${report.projectPath}`);
            console.error(`[ccc:debug] exec: fullPath=${report.fullPath}`);
            console.error(`[ccc:debug] exec: projectId=${report.projectId}`);
            console.error(`[ccc:debug] exec: mountPath=/project/${report.projectId}`);
            console.error(`[ccc:debug] exec: cmd=${report.command.join(" ")}`);
            return;
        case "mounts-debug":
            console.error(`[ccc:debug] worktreeGitMounts (${report.mounts.length}):`);
            for (const mount of report.mounts) console.error(`[ccc:debug]   ${mount.hostPath} -> ${mount.containerPath}`);
            return;
        case "replacement-blocked": console.error(`[ccc] Automatic container replacement blocked: ${presentContainerExecReplacementReason(report.evidence)}.`); return;
        case "broker-failed": console.warn(`[ccc] WARNING: device broker auto-start failed (${report.cause instanceof Error ? report.cause.message : String(report.cause)}). Host-backed device MCP tools may be unavailable.`); return;
        case "restore-failed": console.warn(`[ccc] Unable to restore Codex config access after command exit: ${report.cause instanceof Error ? report.cause.message : String(report.cause)}`); return;
        case "ownership-unconfirmed": console.warn("[ccc] Unable to confirm session ownership after setup failure."); return;
        case "cleanup-failed": console.warn(`[ccc] Session cleanup failed after command exit: ${report.cause instanceof Error ? report.cause.message : String(report.cause)}`); return;
        case "restarted": console.log("Container became unavailable during setup, restarting..."); return;
        case "mcp-forwarded": console.error(`MCP forwarded: ${report.names.join(", ")}`); return;
        case "environment-skipped": console.error(`Skipped ${report.keys.length} host env var(s) to keep exec size bounded; use --env KEY=VALUE for required overrides.`); return;
        case "codex-preparation": {
            const preparation = presentCodexLaunchPreparation({ ...report.result, command: [] });
            if (!preparation.ok) console.error(`[ccc] ${preparation.error}`);
            else if (preparation.notice) console.error(`[ccc] ${preparation.notice}`);
            return;
        }
    }
}

export function createNativeContainerExecPorts(bindings: ContainerExecNativeBindings): ContainerExecPorts<PreparedContainerExecCommand> {
    let invocation: NativeRuntimeInvocation | undefined;
    function inRuntime<T>(operation: () => T): T {
        const current = currentNativeRuntimeInvocation();
        invocation ??= current ?? getRuntimeInvocation();
        return runWithNativeRuntimeInvocation(current ?? invocation, operation);
    }
    const ports: ContainerExecPorts<PreparedContainerExecCommand> = {
        ensureRuntime: ensureDockerRunning,
        resolveProject: resolve,
        ensureDirectories: profile => bindings.ensureDirectories(profile),
        ensureProjectTools: path => bindings.ensureProjectTools(path),
        projectId: getProjectId,
        debugEnabled: () => Boolean(process.env.DEBUG),
        terminalReady: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
        runtime: runtimeCli,
        tool: getToolByName,
        defaultTool: getDefaultTool,
        isWorktreeWorkspace,
        assertWorkspace: (path, source) => assertWorkspaceReady(path, spawnSync, source, { allowTrackedGitlinks: true }),
        familyLock: withProjectFamilyLifecycleLockAsync,
        acquireOwnership: acquireHostSessionOwnership,
        inspectSessionContainer: inspectSessionContainerOwnership,
        ensureClipboard: () => ensureClipboardSelection(getCurrentSessionOwnershipReceipt()),
        validateClipboard: validateClipboardSelection,
        clipboardPortFile,
        clipboardConnection(selection) {
            if (!selection) return {};
            const host = process.platform === "linux" && !isDockerDesktop() ? "127.0.0.1" : "host.docker.internal";
            return { url: `http://${host}:${selection.port}`, token: selection.token };
        },
        worktreeMounts: getWorktreeGitMounts,
        containerName: getContainerName,
        containerStatus: getContainerStatus,
        sessionClaims: getActiveSessionsForContainer,
        lockName: basename,
        async prepareDeviceBroker(path, profile) {
            const result = await ensureHostDeviceBroker({ cwd: path, profile, trustedCliPaths: [bindings.trustedCliPath],
                bindHost: DEVICE_BROKER_DEFAULT_HOST, probeHost: DEVICE_BROKER_DEFAULT_HOST, timeoutMs: 250, startupTimeoutMs: 2500 });
            if (!("ok" in result) || result.ok !== true) {
                const detail = "error" in result && result.error ? `${result.error}${"detail" in result && result.detail ? `: ${result.detail}` : ""}` : "unknown error";
                const diagnostic = "diagnostics" in result && Array.isArray(result.diagnostics) && result.diagnostics.length > 0 ? ` ${result.diagnostics.join("; ")}.` : "";
                console.warn(`[ccc] WARNING: device broker auto-start failed (${detail}).${diagnostic} Host-backed device MCP tools may be unavailable.`);
            }
        },
        lifecycleLock: withContainerLifecycleLockAsync,
        setupLock: withContainerSetupLockAsync,
        startContainer: startProjectContainer,
        prepareContainer: prepareProjectContainerStartup,
        stateLock: withProjectContainerStateLockAsync,
        beginSessionStartupInHeldLifecycleLock,
        recordSessionOwnStartInHeldLifecycleLock,
        publishSessionReadyInHeldLifecycleLock,
        setCleanupEnabled: setSessionCleanupEnabled,
        confirmOwnership: confirmSessionOwnership,
        configLock: withCodexConfigLock,
        restoreConfig: restoreCodexConfigHostOwnership,
        ensureUv: ensureUvAvailable,
        buildMcpConfig,
        setupProxy: setupLocalhostProxy,
        containerRunning: isContainerRunning,
        installTools: ensureTools,
        ensureClaude: ensureClaudeInContainer,
        prepareCodexConfig: prepareCodexConfigForContainer,
        assertCodexState: assertCodexStateAccessible,
        ensureCodexHarness,
        syncClipboard: id => syncClipboardShims(id, bindings.assetDirectory),
        ensureSocketAccess: ensureContainerManagerSocketAccess,
        isRestartRequired: error => error instanceof ContainerRestartRequiredError,
        attachClipboardImage: maybeAttachCodexClipboardImage,
        installProjectTools(target, workdir) {
            // Keep download progress visible and retain the existing nonfatal shell.
            runtimeSpawnSync(["exec", "-w", workdir, target, "sh", "-c",
                "mise trust -a >/dev/null 2>&1 || true; mise install -y || true"], { stdio: "inherit" });
        },
        startClipboardBridge(target, connection) {
            // The bridge starts for every session and reuses an existing X11 daemon.
            const environment: string[] = [];
            if (connection.url) environment.push("-e", `CCC_CLIPBOARD_URL=${connection.url}`);
            if (connection.token) environment.push("-e", `CCC_CLIPBOARD_TOKEN=${connection.token}`);
            runtimeSpawnSync(["exec", "-d", ...environment, target, "/usr/local/bin/ccc-x11-bridge"], { stdio: "ignore" });
        },
        observeCommandEnvironment() {
            const forwarded = collectForwardedEnv(process.env);
            const hostTimezone = process.env.TZ;
            return {
                forwarded: forwarded.forwarded,
                skippedKeys: forwarded.skippedDueToLimit,
                containerMarker: [CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE],
                hostLangPresent: Boolean(process.env.LANG),
                hostTimezone,
                observedTimezone: hostTimezone ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone,
            };
        },
        prepareCommand(intent) {
            // The use case owns this artifact's lifetime, including nested cleanup.
            const file = writeOwnedEnvFile(intent.environment);
            return {
                runtime: intent.runtime, runner: bindNativeRuntimeInvocation(getRuntimeInvocation()), prefix: ["exec", "-w", intent.workdir, "--env-file", file.path], target: intent.target,
                command: intent.command.kind === "claude" ? [CLAUDE_BIN_PATH, ...intent.command.arguments] : [...intent.command.arguments],
                terminalEnvironment: terminalEnvironment(process.env, process.platform, intent.environment)
                    .flatMap(([key, value]) => ["-e", `${key}=${value}`]),
                dispose: () => file.dispose(),
            };
        },
        prepareCodexCommand(prepared) {
            const result = prepareCodexLaunchSemantic(prepared.runtime, [...prepared.prefix, prepared.target], prepared.command,
                (_runtime, args, options) => prepared.runner.spawnSync(args, options));
            if (result.ok) prepared.command = presentCodexLaunchPreparation(result).command;
            if (result.ok) return { ok: true, ...(result.reason ? { reason: result.reason } : {}) };
            return { ok: false, status: result.status, reason: result.reason, ...(result.cause === undefined ? {} : { cause: result.cause }) };
        },
        launchCommand(prepared, interaction) {
            const command = interaction.codexRecovery ? buildCodexResumeRecoveryCommand(prepared.command) : prepared.command;
            return runContainerCommand(prepared.runtime,
                [...prepared.prefix, ...(interaction.terminal ? ["-it", ...prepared.terminalEnvironment] : []), prepared.target, ...command], interaction.interactive, prepared.runner);
        },
        disposeCommand: prepared => prepared.dispose(),
        reportConversationFiles(target, projectId) {
            const directory = `/home/ccc/.claude/projects/-project-${projectId}`;
            const result = runtimeSpawnSync(["exec", target, "sh", "-c",
                `ls -1 "${directory}"/*.jsonl 2>/dev/null | wc -l; echo "dir:${directory}"`],
                { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
            console.error(`[ccc:debug] post-exit conversation check: ${(result.stdout ?? "").trim()}`);
        },
        setupFailure(cause) {
            const detail = cause instanceof Error ? `: ${cause.message}` : "";
            return new Error(`Container setup failed${detail}`, { cause });
        },
        setupToolFailure: cause => new Error("Failed to install tools in container", { cause }),
        handoffFailure: () => new Error("Container became unavailable before the session handoff."),
        invalidRuntimeFailure: () => new Error("Invalid session container runtime."),
        cleanupSession,
        report: presentContainerExecReport,
    };
    // These ports keep their operation binding across awaited prompts and returned work.
    return {
        ...ports,
        ensureRuntime: () => {
            invocation = getRuntimeInvocation();
            return inRuntime(ports.ensureRuntime);
        },
        runtime: () => inRuntime(ports.runtime),
        ensureDirectories: profile => inRuntime(() => ports.ensureDirectories(profile)),
        ensureProjectTools: path => inRuntime(() => ports.ensureProjectTools(path)),
        familyLock: (path, operation) => inRuntime(() => ports.familyLock(path, operation)),
        acquireOwnership: (request, inspect) => inRuntime(() => ports.acquireOwnership(request, inspect)),
        inspectSessionContainer: (path, profile) => inRuntime(() => ports.inspectSessionContainer(path, profile)),
        ensureClipboard: () => inRuntime(ports.ensureClipboard),
        clipboardConnection: selection => inRuntime(() => ports.clipboardConnection(selection)),
        validateClipboard: (selection, guard) => inRuntime(() => ports.validateClipboard(selection, guard)),
        worktreeMounts: (...args) => inRuntime(() => ports.worktreeMounts(...args)),
        containerStatus: name => inRuntime(() => ports.containerStatus(name)),
        lifecycleLock: (path, operation) => inRuntime(() => ports.lifecycleLock(path, operation)),
        setupLock: (path, operation) => inRuntime(() => ports.setupLock(path, operation)),
        startContainer: (...args) => inRuntime(() => ports.startContainer(...args)),
        prepareContainer: () => inRuntime(ports.prepareContainer),
        stateLock: operation => inRuntime(() => ports.stateLock(operation)),
        beginSessionStartupInHeldLifecycleLock: () => inRuntime(ports.beginSessionStartupInHeldLifecycleLock),
        recordSessionOwnStartInHeldLifecycleLock: id => inRuntime(() => ports.recordSessionOwnStartInHeldLifecycleLock(id)),
        publishSessionReadyInHeldLifecycleLock: (id, handoff) => inRuntime(() => ports.publishSessionReadyInHeldLifecycleLock(id, handoff)),
        setCleanupEnabled: enabled => inRuntime(() => ports.setCleanupEnabled(enabled)),
        confirmOwnership: () => inRuntime(ports.confirmOwnership),
        configLock: (operation, profile) => inRuntime(() => ports.configLock(operation, profile)),
        restoreConfig: (id, profile) => inRuntime(() => ports.restoreConfig(id, profile)),
        ensureUv: id => inRuntime(() => ports.ensureUv(id)),
        buildMcpConfig: (...args) => inRuntime(() => ports.buildMcpConfig(...args)),
        setupProxy: id => inRuntime(() => ports.setupProxy(id)),
        containerRunning: (...args) => inRuntime(() => ports.containerRunning(...args)),
        installTools: (...args) => inRuntime(() => ports.installTools(...args)),
        ensureClaude: id => inRuntime(() => ports.ensureClaude(id)),
        prepareCodexConfig: (...args) => inRuntime(() => ports.prepareCodexConfig(...args)),
        assertCodexState: (...args) => inRuntime(() => ports.assertCodexState(...args)),
        ensureCodexHarness: (...args) => inRuntime(() => ports.ensureCodexHarness(...args)),
        syncClipboard: id => inRuntime(() => ports.syncClipboard(id)),
        ensureSocketAccess: id => inRuntime(() => ports.ensureSocketAccess(id)),
        installProjectTools: (...args) => inRuntime(() => ports.installProjectTools(...args)),
        startClipboardBridge: (...args) => inRuntime(() => ports.startClipboardBridge(...args)),
        prepareCommand: intent => inRuntime(() => ports.prepareCommand(intent)),
        prepareCodexCommand: prepared => inRuntime(() => ports.prepareCodexCommand(prepared)),
        launchCommand: (...args) => inRuntime(() => ports.launchCommand(...args)),
        reportConversationFiles: (...args) => inRuntime(() => ports.reportConversationFiles(...args)),
        cleanupSession: () => inRuntime(ports.cleanupSession),
    };
}
