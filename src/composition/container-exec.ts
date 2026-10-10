import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { basename, resolve } from "path";
import type { ContainerExecPorts } from "../ports/container-exec.js";
import { runContainerCommand } from "../container-command.js";
import { getProjectId, collectForwardedEnv, writeOwnedEnvFile, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE } from "../utils.js";
import { ensureClipboardServer } from "../clipboard-server.js";
import { clipboardPortFile } from "../home-layout.js";
import { runtimeCli } from "../container-runtime.js";
import { getToolByName, getDefaultTool } from "../tool-registry.js";
import { detectWorktreeWorkspaceBranch, assertWorkspaceBranch, getWorktreeGitMounts } from "../worktree.js";
import {
    ensureDockerRunning, inspectSessionContainerOwnership, getContainerName, getContainerStatus,
    startProjectContainer, restoreCodexConfigHostOwnership, isContainerRunning,
    prepareCodexConfigForContainer, syncClipboardShims, ensureContainerManagerSocketAccess, isDockerDesktop,
} from "../docker.js";
import {
    acquireHostSessionOwnership, withProjectFamilyLifecycleLockAsync, withContainerLifecycleLock,
    withContainerSetupLockAsync, getActiveSessionsForContainer, setSessionContainerId,
    setSessionCleanupEnabled, confirmSessionOwnership, cleanupSession,
} from "../session.js";
import { withCodexConfigLock } from "../codex-config-lock.js";
import { ensureUvAvailable, ensureTools, ensureClaudeInContainer, CLAUDE_BIN_PATH } from "../container-setup.js";
import { buildMcpConfig } from "../mcp-forward.js";
import { setupLocalhostProxy } from "../localhost-proxy-setup.js";
import { assertCodexStateAccessible } from "../codex-state-ownership.js";
import { ensureCodexHarness } from "../codex-harness.js";
import { ContainerRestartRequiredError } from "../container-restart-guidance.js";
import { maybeAttachCodexClipboardImage } from "../codex-clipboard-image.js";
import { prepareCodexLaunch } from "../codex-launch.js";
import { buildCodexResumeRecoveryCommand } from "../codex-resume-recovery.js";
import { DEVICE_BROKER_DEFAULT_HOST, ensureHostDeviceBroker } from "@ccc/device-lab/device-lab-broker.js";

export interface ContainerExecNativeBindings {
    ensureDirectories(profile?: string): void;
    ensureProjectTools(path: string): Promise<void>;
    assetDirectory: string;
    trustedCliPath: string;
}

export function createNativeContainerExecPorts(bindings: ContainerExecNativeBindings): ContainerExecPorts {
    return {
        ensureRuntime: ensureDockerRunning,
        resolveProject: resolve,
        ensureDirectories: profile => bindings.ensureDirectories(profile),
        ensureProjectTools: path => bindings.ensureProjectTools(path),
        projectId: getProjectId,
        environment: () => process.env,
        platform: () => process.platform,
        terminalReady: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
        timezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
        runtime: runtimeCli,
        tool: getToolByName,
        defaultTool: getDefaultTool,
        detectWorktreeBranch: detectWorktreeWorkspaceBranch,
        assertWorktreeBranch: (path, branch, source) => assertWorkspaceBranch(path, branch, spawnSync, source),
        familyLock: withProjectFamilyLifecycleLockAsync,
        acquireOwnership: acquireHostSessionOwnership,
        inspectSessionContainer: inspectSessionContainerOwnership,
        ensureClipboard: ensureClipboardServer,
        clipboardPortFile,
        readClipboardPort: path => readFileSync(path, "utf-8"),
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
        lifecycleLock: withContainerLifecycleLock,
        setupLock: withContainerSetupLockAsync,
        startContainer: startProjectContainer,
        setSessionContainer: setSessionContainerId,
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
        syncClipboard: syncClipboardShims,
        ensureSocketAccess: ensureContainerManagerSocketAccess,
        isRestartRequired: error => error instanceof ContainerRestartRequiredError,
        isDockerDesktop,
        attachClipboardImage: maybeAttachCodexClipboardImage,
        runRuntimeSync(runtime, args, options) {
            const result = spawnSync(runtime, args, options);
            return { stdout: options.encoding ? (result.stdout == null ? null : String(result.stdout)) : null };
        },
        forwardedEnvironment: collectForwardedEnv,
        createEnvironmentFile: writeOwnedEnvFile,
        prepareCodexLaunch,
        recoverCodexCommand: buildCodexResumeRecoveryCommand,
        runCommand: runContainerCommand,
        cleanupSession,
        progress: message => process.stderr.write(`\x1b[2m▸ ${message}\x1b[0m\n`),
        log: message => console.log(message),
        error: message => console.error(message),
        warn: message => console.warn(message),
        assetDirectory: bindings.assetDirectory,
        claudeBinaryPath: CLAUDE_BIN_PATH,
        containerEnvironment: [CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE],
    };
}
