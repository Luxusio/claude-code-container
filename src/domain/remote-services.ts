export interface RemoteConfig {
    host: string;
    user: string;
    remotePath: string;
}

export function isValidHostOrUser(value: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(value) && value.length > 0 && value.length <= 253;
}

export type RemoteSignal = "SIGINT" | "SIGTERM";
export interface RemoteHeartbeat { unref(): undefined; cancel(): undefined; }
export interface RemotePrompt { result: Promise<string>; cancel(): undefined; }
export interface RemoteSleep { completion: Promise<void>; cancel(): undefined; }
export interface RemoteSshChannel {
    onClose(callback: (code: number | null) => void): undefined;
    onError(callback: (error: unknown) => void): undefined;
    kill(signal: RemoteSignal): boolean;
}
export interface RemoteForwardedEnvPlan {
    forwarded: Array<[string, string]>;
    skippedDueToLimit: string[];
    totalBytes: number;
}

export type RemoteTool = "tailscale" | "mutagen";
export interface RemoteToolObservation {
    installed: boolean;
    version?: string;
}
export interface RemoteContainer {
    name: string;
    id: string;
}
export type RemoteReservationResult<Evidence = unknown> =
    | { kind: "reserved"; container: RemoteContainer }
    | { kind: "failed"; reason: "start-failed" | "missing-container-id"; evidence: Evidence };
export type RemoteOperationResult<Evidence = unknown> =
    | { ok: true }
    | { ok: false; evidence: Evidence };
export type RemoteStopResult<Evidence = unknown> =
    | { kind: "stopped" | "busy" }
    | { kind: "failed"; evidence: Evidence };
export interface RemoteSyncAuthority {
    localPath: string;
    user: string;
    host: string;
    projectId: string;
}
export interface RemoteSyncBinding extends RemoteSyncAuthority {
    containerId: string;
}
export interface RemoteSyncHandle {
    identifier: string;
    name: string;
    binding: RemoteSyncBinding;
}
export interface RemoteObservedSync<Evidence = unknown> {
    kind: "observed";
    identifier: string;
    name: string;
    binding: RemoteSyncBinding | null;
    paused: boolean;
    watching: boolean;
    failed: boolean;
    evidence: Evidence;
}
export type RemoteSyncInventory<Evidence = unknown> =
    | { kind: "known"; sessions: RemoteObservedSync<Evidence>[]; evidence: Evidence }
    | { kind: "unknown"; evidence: Evidence };
export type RemoteSyncObservation<Evidence = unknown> =
    | { kind: "missing" }
    | { kind: "unknown"; evidence: Evidence }
    | { kind: "conflict"; evidence: Evidence }
    | RemoteObservedSync<Evidence>;

export type RemoteFailureKind =
    | "image-missing" | "config-unresolved" | "config-invalid" | "start-failed" | "missing-container-id"
    | "project-prepare-failed" | "sync-terminate-failed" | "sync-resume-failed"
    | "sync-create-failed" | "sync-missing" | "sync-unknown" | "sync-conflict" | "sync-pause-failed"
    | "sync-failed" | "sync-timeout" | "stop-failed";

export type RemotePrerequisiteRefusal =
    | "mutagen-required" | "config-invalid" | "host-invalid" | "host-unreachable" | "user-invalid" | "config-required";
export interface RemoteFailure<Evidence = unknown> { kind: "failed"; reason: RemoteFailureKind; evidence?: Evidence; }
export interface RemoteCancellation { kind: "cancelled"; signal: RemoteSignal; }
export interface RemoteFault { kind: "fault"; error: unknown; }
export type RemoteCleanupPhase =
    | "cancel-heartbeat" | "release-reservation" | "remove-session-lock" | "dispose-prompt" | "cancel-sleep"
    | "signal-child" | "remove-SIGINT-listener" | "remove-SIGTERM-listener";
export type RemoteCleanupFailure<Evidence = unknown> =
    | { kind: "release-failed"; evidence: Evidence }
    | { kind: "cleanup-fault"; phase: RemoteCleanupPhase; error: unknown };
export type RemoteExecutionResult<Evidence = unknown> =
    | { kind: "completed"; exitCode: number }
    | { kind: "refused"; reason: RemotePrerequisiteRefusal }
    | RemoteFailure<Evidence> | RemoteCancellation | RemoteFault;
export type RemoteExecutionOutcome<Evidence = unknown> = RemoteExecutionResult<Evidence> & {
    cleanupFailures: RemoteCleanupFailure<Evidence>[];
};
export type RemoteSyncEnsureOutcome<Evidence = unknown> =
    | { kind: "ready"; handle: RemoteSyncHandle } | RemoteFailure<Evidence> | RemoteCancellation | RemoteFault;
export type RemoteSyncWaitOutcome<Evidence = unknown> =
    | { kind: "ready" } | RemoteFailure<Evidence> | RemoteCancellation | RemoteFault;
export type RemoteTerminateOutcome<Evidence = unknown> =
    | { kind: "completed"; state: "inactive" | "terminated" } | RemoteFailure<Evidence> | RemoteFault;

/** Native presentation consumes finite notices and facts; evidence stays opaque inward. */
export type RemoteEvent<Evidence = unknown> =
    | { kind:
        | "setup-start" | "setup-tools-missing" | "setup-usage" | "setup-architecture" | "setup-requirements"
        | "status-start" | "status-tools" | "status-config" | "status-config-missing" | "status-sync"
        | "status-sync-unavailable" | "status-sync-unknown" | "status-sync-conflict" | "status-end"
        | "mutagen-required" | "config-invalid" | "config-saved" | "config-required" | "image-missing"
        | "starting" | "refresh-failed" | "stopping" | "peer-active" | "pausing"
        | "sync-replacing" | "sync-resuming" | "sync-waiting" | "sync-completed" | "sync-poll"
        | "sync-timeout" | "sync-inactive" | "sync-terminated" }
    | { kind: "tool-status"; tool: RemoteTool; observation: RemoteToolObservation }
    | { kind: "tool-install-guide"; tool: RemoteTool }
    | { kind: "status-config-saved"; config: RemoteConfig; containerName: string }
    | { kind: "host-status"; reachable: boolean }
    | { kind: "status-sync-active"; sessionName: string; observation: RemoteObservedSync<Evidence> }
    | { kind: "status-sync-missing"; sessionName: string }
    | { kind: "saved-config"; config: RemoteConfig }
    | { kind: "host-invalid" | "host-unreachable" | "connecting"; host: string }
    | { kind: "user-invalid"; user: string }
    | { kind: "env-skipped"; count: number }
    | { kind: "ssh-error" | "unexpected-error"; error: unknown }
    | { kind: "sync-existing" | "sync-failed"; observation: RemoteObservedSync<Evidence> }
    | { kind: "sync-creating"; localPath: string; containerDisplayName: string; projectId: string; host: string }
    | { kind: "sync-terminating"; sessionName: string };
