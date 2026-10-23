import type { ToolDefinition } from "../domain/tool-registry.js";
import type { CodexLaunchSemanticPreparation } from "../domain/tool-session/codex-launch.js";
import type { SessionAcquisitionRequest, SessionAcquisitionInspection, SessionAcquisitionResult, SessionContainerInspection } from "./session-acquisition.js";
import type { ClipboardSelection } from "../domain/clipboard/server-lifecycle.js";
import type { RuntimeBindGuard } from "./runtime-bind-authority.js";

export interface ContainerExecOptions {
    interactive?: boolean;
    env?: Record<string, string>;
    tool?: ToolDefinition;
    worktreeWorkspace?: boolean;
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
    restarted(): void;
    installFailure(cause: unknown): Error;
}
export interface ContainerExecReplacementPorts {
    claims(prefix: string, currentLockFile: string): string[];
    status(name: string): ContainerExecStatus;
    lockName(path: string): string;
}
export type ContainerExecReplacementReason =
    | { reason: "ownership-unverified" | "identity-absent" | "identity-changed" }
    | { reason: "other-claims"; claims: string[] };
export interface ContainerExecClipboardConnection { url?: string; token?: string; }
export interface ContainerExecEnvironmentFacts {
    forwarded: Array<[string, string]>;
    skippedKeys: string[];
    containerMarker: readonly [string, string];
    hostLangPresent: boolean;
    hostTimezone?: string;
    observedTimezone?: string;
}
export interface ContainerExecCommandIntent {
    runtime: "docker" | "podman";
    target: string;
    workdir: string;
    environment: Array<[string, string]>;
    command: { kind: "claude" | "command"; arguments: string[] };
}
export type ContainerExecCodexPreparation =
    | Omit<Extract<CodexLaunchSemanticPreparation, { ok: true }>, "command">
    | Omit<Extract<CodexLaunchSemanticPreparation, { ok: false }>, "command">;
export type ContainerExecReport =
    | { kind: "progress"; phase: "checking" | "starting" | "broker" | "setup" | "uv" | "mcp" | "proxy" | "mise" | "tools" | "clipboard" }
    | { kind: "exec-debug"; projectPath: string; fullPath: string; projectId: string; command: string[] }
    | { kind: "mounts-debug"; mounts: ContainerExecMount[] }
    | { kind: "replacement-blocked"; evidence: ContainerExecReplacementReason }
    | { kind: "broker-failed" | "restore-failed"; cause: unknown }
    | { kind: "ownership-unconfirmed" | "restarted" }
    | { kind: "cleanup-failed"; cause: unknown }
    | { kind: "mcp-forwarded"; names: string[] }
    | { kind: "environment-skipped"; keys: string[] }
    | { kind: "codex-preparation"; result: ContainerExecCodexPreparation };
export interface ContainerExecPorts<Prepared> {
    ensureRuntime(): void;
    resolveProject(path: string): string;
    ensureDirectories(profile?: string): void;
    ensureProjectTools(path: string): Promise<void>;
    projectId(path: string): string;
    debugEnabled(): boolean;
    terminalReady(): boolean;
    runtime(): "docker" | "podman";
    tool(name: string): ToolDefinition | undefined;
    defaultTool(): ToolDefinition;
    isWorktreeWorkspace(path: string): boolean;
    assertWorkspace(path: string, sourcePath?: string): void;
    familyLock<T>(projectId: string, operation: () => Promise<T> | T): Promise<T>;
    acquireOwnership(request: SessionAcquisitionRequest, inspect: (request: SessionAcquisitionRequest) => SessionAcquisitionInspection): Promise<SessionAcquisitionResult>;
    inspectSessionContainer(path: string, profile?: string): SessionContainerInspection;
    verifyStoppedSessionContainerForReplacement(projectPath: string, profile: string | undefined, exactOldId: string, bindGuard: RuntimeBindGuard): boolean;
    ensureClipboard(): Promise<ClipboardSelection | null>;
    validateClipboard(selection: ClipboardSelection | null, guard: RuntimeBindGuard): Promise<ClipboardSelection | null>;
    clipboardPortFile(): string;
    clipboardConnection(selection: ClipboardSelection | null): ContainerExecClipboardConnection;
    worktreeMounts(path: string, required: boolean, mountPath: string): ContainerExecMount[];
    containerName(path: string, profile?: string): string;
    containerStatus(name: string): ContainerExecStatus;
    sessionClaims(prefix: string, currentLockFile: string): string[];
    lockName(path: string): string;
    prepareDeviceBroker(path: string, profile?: string): Promise<void>;
    prepareContainer(): { start: ContainerExecPorts<Prepared>["startContainer"]; initialize(id: string): void };
    stateLock<T>(operation: (guard: RuntimeBindGuard) => Promise<T> | T): Promise<T>;
    lifecycleLock<T>(prefix: string, operation: () => Promise<T> | T): Promise<T>;
    setupLock<T>(prefix: string, operation: () => Promise<T> | T): Promise<T>;
    startContainer(path: string, ensureDirectories: () => void, mounts: ContainerExecMount[] | undefined, clipboardPortFile: string | undefined, profile: string | undefined,
        onRecreate: (() => void) | undefined, replacement: (recreate: () => void) => boolean,
        onReady: (id: string, handoff: { startedByInvocation: boolean }) => void,
        expectedRunningId: string | undefined, onStarted: (id: string) => void, bindGuard?: RuntimeBindGuard, onBeforeMutation?: () => void): string;
    beginSessionStartupInHeldLifecycleLock(): void;
    recordSessionOwnStartInHeldLifecycleLock(id: string): void;
    publishSessionReadyInHeldLifecycleLock(id: string, handoff: { startedByInvocation: boolean }): void;
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
    syncClipboard(id: string): void;
    ensureSocketAccess(id: string): void;
    isRestartRequired(error: unknown): boolean;
    attachClipboardImage(path: string, command: string[], options: { enabled: boolean; clipboardUrl?: string; clipboardToken?: string }): Promise<{ args: string[] }>;
    installProjectTools(target: string, workdir: string): void;
    startClipboardBridge(target: string, connection: ContainerExecClipboardConnection): void;
    observeCommandEnvironment(): ContainerExecEnvironmentFacts;
    prepareCommand(intent: ContainerExecCommandIntent): Prepared;
    prepareCodexCommand(prepared: Prepared): ContainerExecCodexPreparation;
    launchCommand(prepared: Prepared, interaction: { interactive: boolean; terminal: boolean; codexRecovery: boolean }): Promise<number>;
    disposeCommand(prepared: Prepared): void;
    reportConversationFiles(target: string, projectId: string): void;
    setupFailure(cause: unknown): Error;
    setupToolFailure(cause: unknown): Error;
    handoffFailure(): Error;
    invalidRuntimeFailure(): Error;
    cleanupSession(): void;
    report(report: ContainerExecReport): void;
}
