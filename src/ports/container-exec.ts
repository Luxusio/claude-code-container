import type { ToolDefinition } from "../domain/tool-registry.js";
import type { CodexLaunchPreparation } from "../domain/tool-session/codex-launch.js";
import type { SessionAcquisitionRequest, SessionAcquisitionInspection } from "./session-acquisition.js";

export interface ContainerExecOptions {
    interactive?: boolean;
    env?: Record<string, string>;
    tool?: ToolDefinition;
    expectedWorktreeBranch?: string;
    expectedWorktreeSourcePath?: string;
}
export interface ContainerExecStatus { exists: boolean; running: boolean; containerId: string | null; imageId: string | null; }
export interface ContainerExecMount {
    hostPath: string;
    containerPath: string;
    identity: { realpath: string; dev: string; ino: string };
    presence: "core" | "additive";
}
export interface ContainerExecReadinessPorts {
    running(id: string, target: "id"): boolean;
    install(id: string, tool: ToolDefinition): void;
    log(message: string): void;
}
export interface ContainerExecReplacementPorts {
    claims(prefix: string, currentLockFile: string): string[];
    status(name: string): ContainerExecStatus;
    lockName(path: string): string;
}
export interface ContainerExecPorts {
    ensureRuntime(): void;
    resolveProject(path: string): string;
    ensureDirectories(profile?: string): void;
    ensureProjectTools(path: string): Promise<void>;
    projectId(path: string): string;
    environment(): Record<string, string | undefined>;
    platform(): string;
    terminalReady(): boolean;
    timezone(): string | undefined;
    runtime(): string;
    tool(name: string): ToolDefinition | undefined;
    defaultTool(): ToolDefinition;
    detectWorktreeBranch(path: string): string | null;
    assertWorktreeBranch(path: string, branch: string, sourcePath?: string): void;
    familyLock<T>(projectId: string, operation: () => Promise<T> | T): Promise<T>;
    acquireOwnership(request: SessionAcquisitionRequest, inspect: (request: SessionAcquisitionRequest) => SessionAcquisitionInspection): Promise<{ lockFile: string; existingId: string | null }>;
    inspectSessionContainer(path: string, profile?: string): { known: boolean; containerId: string | null };
    ensureClipboard(): Promise<number | null>;
    clipboardPortFile(): string;
    readClipboardPort(path: string): string;
    worktreeMounts(path: string, required: boolean, mountPath: string): ContainerExecMount[];
    containerName(path: string, profile?: string): string;
    containerStatus(name: string): ContainerExecStatus;
    sessionClaims(prefix: string, currentLockFile: string): string[];
    lockName(path: string): string;
    prepareDeviceBroker(path: string, profile?: string): Promise<void>;
    lifecycleLock<T>(prefix: string, operation: () => T): T;
    setupLock<T>(prefix: string, operation: () => Promise<T> | T): Promise<T>;
    startContainer(path: string, ensureDirectories: () => void, mounts: ContainerExecMount[] | undefined, clipboardPortFile: string | undefined, profile: string | undefined,
        onRecreate: (() => void) | undefined, replacement: (recreate: () => void) => boolean,
        onReady: (id: string, handoff: { startedByInvocation: boolean }) => void,
        expectedRunningId: string | undefined, onStarted: (id: string) => void): string;
    setSessionContainer(id: string): void;
    setCleanupEnabled(enabled: boolean): void;
    confirmOwnership(): Promise<void>;
    configLock<T>(operation: () => T, profile?: string): T;
    restoreConfig(id: string, profile?: string): void;
    ensureUv(id: string): void;
    buildMcpConfig(profile: string | undefined, restoreAccess: () => void): string[] | Promise<string[]>;
    setupProxy(id: string): void;
    containerRunning(id: string, target: "id"): boolean;
    installTools(id: string, tool: ToolDefinition): void;
    ensureClaude(id: string): void;
    prepareCodexConfig(id: string, profile?: string): void;
    assertCodexState(id: string, profile?: string): void;
    ensureCodexHarness(id: string, profile?: string): void;
    syncClipboard(id: string, assetDirectory: string): void;
    ensureSocketAccess(id: string): void;
    isRestartRequired(error: unknown): boolean;
    isDockerDesktop(): boolean;
    attachClipboardImage(path: string, command: string[], options: { enabled: boolean; clipboardUrl?: string; clipboardToken?: string }): Promise<{ args: string[] }>;
    runRuntimeSync(runtime: string, args: string[], options: { stdio: "inherit" | "ignore" | ["pipe", "pipe", "pipe"]; encoding?: "utf-8" }): { stdout: string | null };
    forwardedEnvironment(environment: Record<string, string | undefined>): { forwarded: Array<[string, string]>; skippedDueToLimit: string[] };
    createEnvironmentFile(entries: Array<[string, string]>): { path: string; dispose(): void };
    prepareCodexLaunch(runtime: string, prefix: string[], command: string[]): CodexLaunchPreparation;
    recoverCodexCommand(command: string[]): string[];
    runCommand(runtime: string, args: string[], interactive: boolean): Promise<number>;
    cleanupSession(): void;
    progress(message: string): void;
    log(message: string): void;
    error(message: string): void;
    warn(message: string): void;
    assetDirectory: string;
    claudeBinaryPath: string;
    containerEnvironment: readonly [string, string];
}
