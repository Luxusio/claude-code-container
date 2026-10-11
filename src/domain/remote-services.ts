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
export interface RemoteObservedSync<Evidence = unknown> {
    kind: "observed";
    endpointMatches: boolean;
    paused: boolean;
    watching: boolean;
    failed: boolean;
    evidence: Evidence;
}
export type RemoteSyncObservation<Evidence = unknown> =
    | { kind: "unavailable" }
    | RemoteObservedSync<Evidence>;

export type RemoteFailureKind =
    | "image-missing" | "config-unresolved" | "start-failed" | "missing-container-id"
    | "project-prepare-failed" | "sync-terminate-failed" | "sync-resume-failed"
    | "sync-create-failed" | "sync-missing" | "sync-failed" | "sync-timeout" | "stop-failed";

/** Native presentation consumes finite notices and facts; evidence stays opaque inward. */
export type RemoteEvent<Evidence = unknown> =
    | { kind:
        | "setup-start" | "setup-tools-missing" | "setup-usage" | "setup-architecture" | "setup-requirements"
        | "status-start" | "status-tools" | "status-config" | "status-config-missing" | "status-sync"
        | "status-sync-unavailable" | "status-end"
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
