export type SetupObservation = { ok: boolean; featureName: "Microsoft-Hyper-V-All"; beforeState: string;
    afterState: string; changed: boolean; rebootRequired: boolean; hyperVAdministratorsMember?: boolean;
    membershipChanged?: boolean; managementAccess?: boolean; sessionRefreshRequired?: boolean };
export type HostNetworkResult = { ok: true; switchName: string; gateway: string };
export type SetupRequest = { acceptWindowsEvaluationLicense?: boolean; ownerId?: string };
export type SetupFailureReason = "not-windows" | "powershell-missing" | "root-invalid" | "diagnostic-failed" | "feature-failed" | "mutation-failed" | "network-invalid" | "network-failed";
export type SetupProbe<Value, Evidence> = { state: "available"; value: Value; evidence?: Evidence } | { state: "failed" | "invalid"; evidence?: Evidence };
export type SetupContext<Evidence> = { ok: true } | { ok: false; reason: SetupFailureReason; evidence?: Evidence };
export type SetupResult<Evidence> =
    | { ok: false; reason: SetupFailureReason; evidence?: Evidence }
    | { ok: true; mode: "diagnostic"; readiness: import("./device-admin-diagnostics.js").HyperVReadiness; linuxImage: import("./device-admin-diagnostics.js").HyperVLinuxImageReadiness; licenseAccepted: boolean; evidence?: Evidence }
    | { ok: true; mode: "confirmed"; observation: SetupObservation; network: Extract<HostNetworkResult, { ok: true }>; receipt: Evidence | null; evidence?: Evidence };
