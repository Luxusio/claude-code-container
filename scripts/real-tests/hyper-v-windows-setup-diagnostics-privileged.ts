// The elevated half of the Windows Setup diagnostic. `requestAdministrator` stages this bundle in
// an Administrators-only ProgramData root, verifies its SHA-256 against the digest the unelevated
// parent computed, and runs it under an elevated node. Everything it needs to know arrives INSIDE
// those bytes.
//
// That is the reason for the global rather than argv or an env var: the digest covers the program,
// so embedding the VM identity puts it inside the integrity check. argv and env sit outside it —
// anything able to influence them between the digest and the elevated mount could point a
// privileged `Mount-VHD` at a different VHDX. The prelude defining this global is concatenated
// ahead of the bundle by the caller and digested with it.
import { fileURLToPath } from "url";
import { hyperVVmName } from "../../src/host-control/hyper-v/index.ts";
import { captureHyperVWindowsSetupDiagnostics } from "./hyper-v-windows-setup-diagnostics.ts";

export const PRIVILEGED_RESULT_MARKER = "CCC_HYPER_V_WINDOWS_SETUP_DIAGNOSTICS_PRIVILEGED_RESULT:";
const VM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PrivilegedSetupDiagnosticsInput = {
    ownerId: string;
    deviceId: string;
    incarnationId: string;
    vmId: string;
    powershell: string;
};

// Re-validated here even though the parent validated before embedding. The parent runs unelevated
// and this does not; a check that only ever ran on the weaker side of a privilege boundary is not a
// check.
//
// The identity rule is `hyperVVmName` itself, called for its throw, rather than a copy of the three
// patterns behind it. A second copy of a rule is how the two halves drift, and this series has
// already paid for that once with a comment naming a value the code had stopped using.
export function validPrivilegedInput(value: unknown): PrivilegedSetupDiagnosticsInput | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { ownerId, deviceId, incarnationId, vmId, powershell } = value as Record<string, unknown>;
    if (typeof ownerId !== "string" || typeof deviceId !== "string" || typeof incarnationId !== "string") return null;
    try {
        hyperVVmName(ownerId, deviceId, incarnationId);
    } catch {
        return null;
    }
    if (typeof vmId !== "string" || !VM_ID_PATTERN.test(vmId)) return null;
    if (typeof powershell !== "string" || powershell.length === 0 || powershell.length > 512) return null;
    return { ownerId, deviceId, incarnationId, vmId, powershell };
}

export function privilegedResultFrame(payload: object): string {
    return `${PRIVILEGED_RESULT_MARKER}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}\n`;
}

export function runPrivilegedSetupDiagnostics(
    embedded: unknown,
    captureImpl = captureHyperVWindowsSetupDiagnostics,
): { status: number; frame: string } {
    const input = validPrivilegedInput(embedded);
    if (!input) {
        return { status: 1, frame: privilegedResultFrame({ ok: false, code: "hyper-v-setup-diagnostics-privileged-input-invalid" }) };
    }
    let result;
    try {
        result = captureImpl({ ...input, platform: "win32" });
    } catch {
        // The unelevated path renders a throw here as hyper-v-setup-diagnostics-unexpected-failure.
        // Matching it rather than letting the throw escape keeps this child's contract at exactly one
        // frame, so the parent never has to tell "crashed" apart from "said nothing".
        return { status: 1, frame: privilegedResultFrame({ ok: false, code: "hyper-v-setup-diagnostics-unexpected-failure" }) };
    }
    // Only what the parent uses crosses back. The success result also carries absolute host paths;
    // the parent already knows its own output root, so shipping them would widen what an elevated
    // child can put on an operator's terminal in exchange for nothing.
    return result.ok === true
        ? { status: 0, frame: privilegedResultFrame({ ok: true, latestRelativePath: result.latestRelativePath }) }
        : { status: 1, frame: privilegedResultFrame({ ok: false, code: result.code }) };
}

// Guarded so the exports above can be imported by tests without the module mounting a VHDX as a
// side effect of `import`.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const { status, frame } = runPrivilegedSetupDiagnostics((globalThis as Record<string, any>).__CCC_HYPER_V_SETUP_DIAGNOSTICS_INPUT);
    process.stdout.write(frame);
    process.exitCode = status;
}
