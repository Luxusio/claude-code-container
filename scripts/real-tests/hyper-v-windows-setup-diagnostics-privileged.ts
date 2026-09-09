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
//
// Two things this deliberately does NOT take from the parent, both found by review after the first
// version took both:
//
//   - The PowerShell path. The parent's copy comes from `where powershell.exe` on the invoking
//     user's PATH, and `where` searches the current directory first. Embedding it meant an elevated
//     process spawning an executable an unelevated user could choose. The digest does not help:
//     it guarantees faithfully running the path the parent picked, which is the problem. Resolved
//     here instead, from \\?\GLOBALROOT\SystemRoot, by the same function the elevation library uses
//     to launch its own child.
//   - The output root. `repoRoot` is derived from `import.meta.url`, and under the staging
//     directory that is two levels below the drive root — so an elevated write landed in
//     C:\results\device-lab-real while the reported path stayed repo-relative and pointed at
//     nothing. Worse than wrong: C:\ lets ordinary users create directories, so an unelevated user
//     could pre-create or junction that path and steer an Administrator write. Artifacts are now
//     written by the unelevated PARENT; this side does not write to the filesystem at all.
import { fileURLToPath, pathToFileURL } from "url";
import { realpathSync } from "fs";
import { hyperVVmName } from "../../src/host-control/hyper-v/index.ts";
import { resolveTrustedWindowsPowerShell } from "./hyper-v-windows-library-elevation.mjs";
import { collectHyperVWindowsSetupDiagnostics } from "./hyper-v-windows-setup-diagnostics.ts";

export const PRIVILEGED_RESULT_MARKER = "CCC_HYPER_V_WINDOWS_SETUP_DIAGNOSTICS_PRIVILEGED_RESULT:";
const VM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PrivilegedSetupDiagnosticsInput = {
    ownerId: string;
    deviceId: string;
    incarnationId: string;
    vmId: string;
};

// Re-validated here even though the parent validates before embedding. The parent runs unelevated
// and this does not; a check that only ever ran on the weaker side of a privilege boundary is not a
// check.
//
// The identity rule is `hyperVVmName` itself, called for its throw, rather than a copy of the three
// patterns behind it. A second copy of a rule is how the two halves drift.
export function validPrivilegedInput(value: unknown): PrivilegedSetupDiagnosticsInput | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { ownerId, deviceId, incarnationId, vmId } = value as Record<string, unknown>;
    if (typeof ownerId !== "string" || typeof deviceId !== "string" || typeof incarnationId !== "string") return null;
    try {
        hyperVVmName(ownerId, deviceId, incarnationId);
    } catch {
        return null;
    }
    if (typeof vmId !== "string" || !VM_ID_PATTERN.test(vmId)) return null;
    return { ownerId, deviceId, incarnationId, vmId };
}

export function privilegedResultFrame(payload: object): string {
    return `${PRIVILEGED_RESULT_MARKER}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}\n`;
}

export function runPrivilegedSetupDiagnostics(
    embedded: unknown,
    dependencies: {
        captureImpl?: typeof collectHyperVWindowsSetupDiagnostics;
        resolvePowerShellImpl?: typeof resolveTrustedWindowsPowerShell;
    } = {},
): { status: number; frame: string } {
    const input = validPrivilegedInput(embedded);
    if (!input) {
        return { status: 1, frame: privilegedResultFrame({ ok: false, code: "hyper-v-setup-diagnostics-privileged-input-invalid" }) };
    }
    let powershell: string;
    try {
        powershell = (dependencies.resolvePowerShellImpl || resolveTrustedWindowsPowerShell)();
    } catch {
        return { status: 1, frame: privilegedResultFrame({ ok: false, code: "hyper-v-setup-diagnostics-powershell-unavailable" }) };
    }
    // No outputRoot, because this side does not write. The first version staged its artifacts under
    // the elevation library's Administrators-only root and returned them — safe, but gratuitous: a
    // failed write there would have discarded logs already paid for with a UAC prompt and a full
    // stop/detach/mount cycle. Collecting without publishing removes the I/O and the failure mode,
    // and leaves this process with no filesystem write at all.
    //
    // It also removes the last live instance of the mechanism behind the original defect: `repoRoot`
    // still evaluates to the drive root inside this bundle, and while nothing on this path read it,
    // "currently overridden by an argument" is a weaker property than "never consulted".
    let result;
    try {
        result = (dependencies.captureImpl || collectHyperVWindowsSetupDiagnostics)({
            ...input,
            powershell,
            platform: "win32",
        });
    } catch {
        // The unelevated path renders a throw here as hyper-v-setup-diagnostics-unexpected-failure.
        // Matching it rather than letting the throw escape keeps this child's contract at exactly one
        // frame, so the parent never has to tell "crashed" apart from "said nothing".
        return { status: 1, frame: privilegedResultFrame({ ok: false, code: "hyper-v-setup-diagnostics-unexpected-failure" }) };
    }
    // Only the validated, redacted log payload crosses back — never a path. The parent publishes it
    // under its own real repository root, which is the only side that knows where that is.
    return result.ok === true
        ? { status: 0, frame: privilegedResultFrame({ ok: true, logs: result.logs }) }
        : { status: 1, frame: privilegedResultFrame({ ok: false, code: result.code }) };
}

// Guarded so the exports above can be imported by tests without the module mounting a VHDX as a
// side effect of `import`. Compared through realpath and pathToFileURL rather than as raw strings:
// the staged path on Windows can differ from argv[1] by casing or 8.3 short name, and a miss here
// would produce no frame at all and an `elevation-child-result-invalid` with nothing to explain it.
export function invokedAsEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
    if (!argv1) return false;
    try {
        return pathToFileURL(realpathSync(argv1)).href === pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
    } catch {
        return false;
    }
}

if (invokedAsEntrypoint(process.argv[1], import.meta.url)) {
    const { status, frame } = runPrivilegedSetupDiagnostics((globalThis as Record<string, any>).__CCC_HYPER_V_SETUP_DIAGNOSTICS_INPUT);
    process.stdout.write(frame);
    process.exitCode = status;
}
