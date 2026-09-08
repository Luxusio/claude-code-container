import { createHash } from "crypto";
import { createReadStream, readFileSync, statSync } from "fs";
import { join } from "path";
import { isAdministrator, requestAdministrator, resolveTrustedWindowsPowerShell } from "./hyper-v-windows-library-elevation.mjs";
import { repoRoot } from "./helpers.ts";
import { PRIVILEGED_RESULT_MARKER, validPrivilegedInput, type PrivilegedSetupDiagnosticsInput } from "./hyper-v-windows-setup-diagnostics-privileged.ts";
import { publishHyperVWindowsSetupDiagnostics, type SetupDiagnosticsLog } from "./hyper-v-windows-setup-diagnostics.ts";

// No path crosses this boundary. The elevated child returns the validated, redacted log payload and
// the unelevated parent writes the artifacts under its own repository root — the only side that
// knows where that is. The first version let the child publish, and under the elevation library's
// staging directory its `repoRoot` resolved to the drive root: artifacts landed in C:\results while
// the reported path stayed repo-relative and pointed at nothing.
export type ElevatedSetupDiagnosticsResult =
    | { ok: true; logs: SetupDiagnosticsLog[] }
    | { ok: false; code: string };

export const PRIVILEGED_BUNDLE_RELATIVE_PATH = join("dist", "real-tests", "hyper-v-windows-setup-diagnostics-privileged.mjs");
const MAX_PRIVILEGED_BUNDLE_BYTES = 8 * 1024 * 1024;
// The payload is bounded on the producing side by MAX_LOGS x MAX_LINES_PER_LOG x MAX_LINE_CHARS
// (4 x 120 x 768, about 360 KiB) before base64. This is that with room, and well inside the
// elevation pipe's own frame limit.
const MAX_RESULT_FRAME_CHARS = 2 * 1024 * 1024;

// Why the diagnostic asks for elevation instead of asking the operator to re-run.
//
// The mount needs a privilege the rest of the Level 3 run does not, and it needs it for one
// operation, at the end, only when a guest has already failed to boot. Telling the operator to
// re-run costs them the whole run again — another build, another two-minute boot — to reach the
// same failure with one more right. So the privilege is requested at the moment it is missing, for
// that operation alone, and the unelevated launcher keeps the terminal stdin the evaluation-licence
// question needs.
//
// The mechanism is the one this repository already uses for the same problem in
// hyper-v-windows-library-command.mjs: requestAdministrator stages a digest-verified program in an
// Administrators-only ProgramData root and streams its output back over a token-authenticated named
// pipe. Nothing new is invented here; the inputs are embedded in the digested bytes rather than
// passed as argv, which is the one addition and the reason is in the privileged entry.

export type ElevatedSetupDiagnosticsOutcome =
    | { attempted: false; reason: "not-windows" | "already-elevated" | "bundle-missing" | "probe-failed" | "identity-invalid" }
    | { attempted: true; result: ElevatedSetupDiagnosticsResult }
    | { attempted: true; errorCode: string };

function fileDigest(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(path);
        stream.on("error", reject);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

// The prelude is concatenated AHEAD of the bundle and digested with it, so the VM identity the
// elevated child will mount is covered by the same integrity check as the code that mounts it.
// JSON.stringify cannot break out of the expression regardless of the values: it escapes quote,
// backslash and C0, U+2028/U+2029 are legal in string literals on this runtime, lone surrogates are
// escaped, and there is no template, HTML or eval context to escape into. The caller validates the
// input before reaching here as well, but the safety is stringify, not the patterns.
export function privilegedProgramPrelude(input: PrivilegedSetupDiagnosticsInput): string {
    return `globalThis.__CCC_HYPER_V_SETUP_DIAGNOSTICS_INPUT = ${JSON.stringify(input)};\n`;
}

export function decodePrivilegedResultFrame(stdout: string): ElevatedSetupDiagnosticsResult | null {
    const frames = String(stdout).split(/\r?\n/).filter((line) => line.startsWith(PRIVILEGED_RESULT_MARKER));
    // Exactly one. Zero means the child never reported; more than one means something else on that
    // stream can imitate the marker, and picking the first would let it choose the answer.
    if (frames.length !== 1) return null;
    const encoded = frames[0].slice(PRIVILEGED_RESULT_MARKER.length);
    if (encoded.length > MAX_RESULT_FRAME_CHARS || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
    let parsed: any;
    try {
        parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.ok === true) {
        // Shape only. The payload is re-validated and re-redacted by publishHyperVWindowsSetupDiagnostics
        // on this side, through the same validatedLogs the producer used, so a child that skipped
        // redaction cannot get text past the parent.
        return Array.isArray(parsed.logs) ? { ok: true, logs: parsed.logs as SetupDiagnosticsLog[] } : null;
    }
    if (parsed.ok === false) {
        // The bracket body is restricted to printable ASCII, not merely to "no ] and no newline".
        // This string is printed to an operator's terminal and arrives from a process running as
        // Administrator; the previous class allowed ESC, CR, BEL and bidi overrides through — up to
        // 1024 of them. The path field on this same boundary already had an allowlist and this did
        // not, which is the asymmetry review caught.
        return typeof parsed.code === "string" && /^[a-z0-9][a-z0-9-]{0,127}(\[[\x20-\x5C\x5E-\x7E]{0,1024}\])?$/.test(parsed.code)
            ? { ok: false, code: parsed.code }
            : null;
    }
    return null;
}

export async function requestElevatedSetupDiagnostics(
    input: PrivilegedSetupDiagnosticsInput,
    dependencies: any = {},
): Promise<ElevatedSetupDiagnosticsOutcome> {
    const platform = dependencies.platform || process.platform;
    if (platform !== "win32") return { attempted: false, reason: "not-windows" };
    // Validated on THIS side too, before a prompt is raised. The child re-validates because it holds
    // the privilege, but an identity that could never be accepted there should not cost the operator
    // a UAC dialog to find out. It also makes the prelude comment true: it says it stringifies a
    // validated object, and until now nothing had validated it at that point.
    if (!validPrivilegedInput(input)) return { attempted: false, reason: "identity-invalid" };
    const resolvePowerShell = dependencies.resolveTrustedWindowsPowerShellImpl || resolveTrustedWindowsPowerShell;
    const probe = dependencies.isAdministratorImpl || isAdministrator;
    let powerShellPath: string;
    try {
        powerShellPath = resolvePowerShell();
        // Already elevated and the mount still failed for privilege: UAC has nothing left to give,
        // and prompting would ask the operator to grant a right they are already exercising.
        if (probe({ powerShellPath })) return { attempted: false, reason: "already-elevated" };
    } catch {
        return { attempted: false, reason: "probe-failed" };
    }
    const bundlePath = dependencies.bundlePath || join(repoRoot, PRIVILEGED_BUNDLE_RELATIVE_PATH);
    const statImpl = dependencies.statSyncImpl || statSync;
    const readImpl = dependencies.readFileSyncImpl || readFileSync;
    let programBytes: Buffer;
    try {
        const size = statImpl(bundlePath).size;
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PRIVILEGED_BUNDLE_BYTES) return { attempted: false, reason: "bundle-missing" };
        programBytes = Buffer.concat([Buffer.from(privilegedProgramPrelude(input), "utf8"), readImpl(bundlePath)]);
    } catch {
        return { attempted: false, reason: "bundle-missing" };
    }
    const nodePath = dependencies.nodePath || process.execPath;
    const digestFile = dependencies.fileDigestImpl || fileDigest;
    const request = dependencies.requestAdministratorImpl || requestAdministrator;
    const elevated = await request({
        powerShellPath,
        nodePath,
        nodeDigest: await digestFile(nodePath),
        programBytes,
        programDigest: createHash("sha256").update(programBytes).digest("hex"),
    });
    if (elevated.errorCode) return { attempted: true, errorCode: String(elevated.errorCode) };
    const decoded = decodePrivilegedResultFrame(elevated.stdout || "");
    return decoded ? { attempted: true, result: decoded } : { attempted: true, errorCode: "elevation-child-result-invalid" };
}
