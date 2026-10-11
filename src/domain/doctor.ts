export type DoctorSeverity = "ok" | "warn" | "error";
export interface DoctorRuntimeInfo {
    runtime: string;
    version?: string | null;
    flavor: string;
}
export interface DoctorRequest {
    projectId: string;
    containerName: string;
}
export type DoctorImageObservation =
    | { kind: "missing" }
    | { kind: "local" }
    | { kind: "registry"; version: string };
export type DoctorLauncherObservation =
    | { kind: "ready"; description: string }
    | { kind: "update-unmanaged"; description: string }
    | { kind: "missing" };
export type DoctorCheck =
    | { kind: "runtime"; status: "ok" | "error"; info: DoctorRuntimeInfo; version: string | null }
    | { kind: "image"; status: DoctorSeverity; image: DoctorImageObservation; expectedVersion: string }
    | { kind: "container"; status: "ok" | "warn"; state: "running" | "stopped" | "missing"; name: string }
    | { kind: "mise-cache"; status: "ok" | "warn"; volumeName: string; exists: boolean }
    | { kind: "sessions"; status: "ok"; count: number }
    | { kind: "stale-locks"; status: "warn"; count: number }
    | { kind: "claude"; status: "ok" | "warn"; launcher: DoctorLauncherObservation };
export interface DoctorReport {
    ok: boolean;
    checks: DoctorCheck[];
}
