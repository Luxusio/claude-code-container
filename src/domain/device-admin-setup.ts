import type { CommandResult } from "./device-admin-diagnostics.js";
export type HyperVSetupHostResult = { ok: boolean; text: string };
export type SetupRequest = { powershell?: string | null; injectedPowerShell?: boolean; systemRoot?: string;
    stateRoot?: string; mutationLockFile?: string; acceptWindowsEvaluationLicense?: boolean; ownerId?: string };
export type SetupObservation = { ok: boolean; featureName: "Microsoft-Hyper-V-All"; beforeState: string;
    afterState: string; changed: boolean; rebootRequired: boolean; hyperVAdministratorsMember?: boolean;
    membershipChanged?: boolean; managementAccess?: boolean; sessionRefreshRequired?: boolean };
export type HostNetworkResult = { ok: true; switchName: string; gateway: string } | { ok: false; error: string; detail?: string };
export function admitDeviceAdminSetupArgs(args: string[]): { ok: true; confirm: boolean; acceptWindowsEvaluationLicense: boolean } | { ok: false; message: string } {
    const setupArgs = args.slice(2);
    const allowed = new Set(["--confirm", "--accept-windows-evaluation-license"]);
    if (args[1] !== "hyper-v" || setupArgs.some((arg) => !allowed.has(arg))
        || new Set(setupArgs).size !== setupArgs.length
        || (setupArgs.includes("--accept-windows-evaluation-license") && !setupArgs.includes("--confirm"))) {
        return { ok: false, message: "Usage: ccc devices setup hyper-v [--confirm [--accept-windows-evaluation-license]]" };
    }
    return { ok: true, confirm: setupArgs.includes("--confirm"), acceptWindowsEvaluationLicense: setupArgs.includes("--accept-windows-evaluation-license") };
}
export function hyperVSetupFailureDetail(execution: CommandResult | null | undefined): string {
    const output = `${execution?.stderr || ""}\n${execution?.stdout || ""}`;
    const compact = output.replace(/_x[0-9a-f]{4}_/gi, "").replace(/\s+/g, "");
    const allowedCodes = [
        "hyper-v-setup-elevation-failed",
        "hyper-v-setup-pipe-handshake-timeout",
        "hyper-v-setup-pipe-client-mismatch",
        "hyper-v-setup-child-timeout",
        "hyper-v-setup-result-invalid",
        "hyper-v-setup-enable-failed",
        "hyper-v-setup-elevated-operation-failed",
        "hyper-v-setup-command-timeout",
        "hyper-v-setup-user-sid-invalid",
        "hyper-v-setup-pipe-name-invalid",
    ];
    for (const code of allowedCodes) {
        const pattern = new RegExp(`(^|[^a-z0-9-])${code}(?=$|[^a-z0-9-])`);
        if (pattern.test(output) || pattern.test(compact)) return code;
    }
    if (execution?.status === null && /ETIMEDOUT|timed out|timeout/i.test(output)) return "hyper-v-setup-command-timeout";
    return execution?.status === 0 ? "hyper-v-setup-result-invalid" : "hyper-v-setup-host-operation-failed";
}
