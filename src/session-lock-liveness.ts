import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { canonicalWindowsPowerShellPath, canonicalWindowsTasklistPath, hiddenWindowsPowerShellArgs } from "@ccc/device-lab/windows-system-powershell.js";
import { createSessionLockLiveness } from "./application/session-lock-liveness.js";
import { parseProcessStartObservations, type ProcessStartObservation, type SessionLockLiveness } from "./domain/session-lock.js";

export { parseProcessStartObservations, sessionLockOwner } from "./domain/session-lock.js";
export type { SessionLockLiveness, SessionLockOwner } from "./domain/session-lock.js";

function observeWindowsProcessPresence(pid: number): ProcessStartObservation {
    const tasklist = canonicalWindowsTasklistPath();
    if (!tasklist) return { status: "unknown" };
    const result = spawnSync(tasklist, ["/FO", "CSV", "/NH"], {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
    });
    if (result.error || result.status !== 0 || result.stderr?.trim()) return { status: "unknown" };
    const lines = (result.stdout ?? "").split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) return { status: "unknown" };
    let present = false;
    for (const line of lines) {
        const row = /^"(?:[^"]|"")*","([0-9]+)","(?:[^"]|"")*","(?:[^"]|"")*","(?:[^"]|"")*"$/.exec(line);
        if (!row) return { status: "unknown" };
        if (Number(row[1]) === pid) present = true;
    }
    return present ? { status: "present" } : { status: "missing" };
}

function observeProcessStart(pid: number): ProcessStartObservation {
    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
            const close = stat.lastIndexOf(")");
            if (close < 0 || !/^[0-9]+ \(/.test(stat) || Number(stat.slice(0, stat.indexOf(" "))) !== pid) return { status: "unknown" };
            const fields = stat.slice(close + 1).trim().split(/\s+/);
            if (!/^[RSDTtWXZIKP]$/.test(fields[0] ?? "") || !/^[0-9]+$/.test(fields[19] ?? "")
                || !fields.slice(1, 19).every((field) => /^-?[0-9]+$/.test(field))) {
                return { status: "unknown" };
            }
            if (fields[0] === "Z" || fields[0] === "X") return { status: "missing" };
            return { status: "found", token: `linux:${fields[19]}` };
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ENOENT"
                ? { status: "missing" }
                : { status: "unknown" };
        }
    }

    try {
        if (process.platform === "win32") {
            const powershell = canonicalWindowsPowerShellPath();
            if (!powershell) return observeWindowsProcessPresence(pid);
            const script = [
                "$ErrorActionPreference = 'Stop'",
                "$ProgressPreference = 'SilentlyContinue'",
                `try { $P = [System.Diagnostics.Process]::GetProcessById(${pid}) }`,
                "catch [System.ArgumentException] { Write-Output 'MISSING'; exit 0 }",
                "catch { Write-Output 'UNKNOWN'; exit 0 }",
                "try { Write-Output ('FOUND:' + $P.StartTime.ToUniversalTime().Ticks) }",
                "catch { Write-Output 'UNKNOWN' }",
            ].join("\n");
            const result = spawnSync(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", script]), {
                encoding: "utf-8",
                timeout: 5000,
                windowsHide: true,
            });
            if (result.error || result.status !== 0 || result.stderr?.trim()) {
                return observeWindowsProcessPresence(pid);
            }
            const value = result.stdout?.trim() ?? "";
            if (value === "MISSING") return { status: "missing" };
            const found = /^FOUND:([0-9]+)$/.exec(value);
            if (found) {
                return { status: "found", token: `windows:${found[1]}` };
            }
            return observeWindowsProcessPresence(pid);
        }
        const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
            encoding: "utf-8",
            timeout: 1000,
            windowsHide: true,
        });
        if (result.error || result.stderr?.trim()) return { status: "unknown" };
        if (result.status === 1 && !result.stdout?.trim()) return { status: "missing" };
        if (result.status !== 0) return { status: "unknown" };
        const value = result.stdout?.trim() ?? "";
        return value
            ? { status: "found", token: `ps:${value}` }
            : { status: "unknown" };
    } catch {
        return { status: "unknown" };
    }
}

/**
 * One observation for many pids, in a single process.
 *
 * `observeProcessStart` costs one `powershell.exe` per pid on Windows, and the session-lock
 * filter calls it once per candidate lock file — stale or not — on every `ccc` invocation. A
 * host carrying a dozen leftover locks therefore paid a dozen launches before anything else
 * happened, which is why the operator's report of PowerShell windows "너무 많이" varied between
 * runs: it scales with lock count, not with the work being done.
 *
 * Returns a map keyed by pid. A pid the batch could not answer for is simply absent, and the
 * caller falls back to the single-pid path for it — the batch is an optimisation, never the
 * authority on liveness, and a lock whose owner cannot be observed must still be preserved.
 */
export function observeProcessStarts(pids: readonly number[]): Map<number, ProcessStartObservation> {
    const observations = new Map<number, ProcessStartObservation>();
    const unique = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    // Fewer than two owners is not worth a batch, and batching them is actively worse: the
    // batch would be one launch, and if it cannot answer — a denied PowerShell, say — the
    // single-pid probe still runs, so one lock would cost two launches where it used to cost
    // one. Two existing tests caught exactly this by failing, because they mock `spawnSync`
    // as a SEQUENCE and my extra call consumed the first answer. The saving is real only when
    // there is something to save: N locks become one launch instead of N, and the worst case
    // stays N+1 when the batch itself fails.
    if (unique.length < 2) return observations;
    if (process.platform !== "win32") return observations;
    // Wrapped, because every other process observation in the lock filter happens inside a
    // `try { ... } catch { return true }` that fails closed, and this one is called above that
    // guard. A throw escaping here would take down the whole `ccc` invocation rather than
    // costing one extra probe. The empty map means "ask per pid", never "assume stale".
    try {
        return runProcessStartBatch(unique);
    } catch {
        return observations;
    }
}

function runProcessStartBatch(unique: number[]): Map<number, ProcessStartObservation> {
    const observations = new Map<number, ProcessStartObservation>();
    const powershell = canonicalWindowsPowerShellPath();
    if (!powershell) return observations;
    // Single quotes and concatenation, matching every other script that is already proven on
    // the operator's host. The first version used `"$id MISSING"` — double quotes inside a
    // `-Command` payload, which nothing else in these files does. If that quoting had been
    // wrong the script would exit non-zero, the map would come back empty, every pid would
    // fall through to the old path, and the only symptom would be the operator reporting no
    // improvement: a silent failure indistinguishable from the fix not working. There is no
    // PowerShell in this container to prove it either way, so the safe spelling wins.
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `foreach ($id in @(${unique.join(",")})) {`,
        "  try { $P = [System.Diagnostics.Process]::GetProcessById($id) }",
        "  catch [System.ArgumentException] { Write-Output ([string]$id + ' MISSING'); continue }",
        "  catch { Write-Output ([string]$id + ' UNKNOWN'); continue }",
        "  try { Write-Output ([string]$id + ' FOUND:' + $P.StartTime.ToUniversalTime().Ticks) }",
        "  catch { Write-Output ([string]$id + ' UNKNOWN') }",
        "}",
    ].join("\n");
    const result = spawnSync(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", script]), {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
    });
    if (result.error || result.status !== 0 || result.stderr?.trim()) return observations;
    return parseProcessStartObservations(result.stdout ?? "", unique);
}
export function processStartToken(pid: number): string | null {
    const observed = observeProcessStart(pid);
    return observed.status === "found" ? observed.token : null;
}

export function sessionLockLiveness(
    content: string,
    // Pre-observed pids, when the caller had several locks to examine and asked for them in one
    // process. Absent or `unknown` entries fall through to the single-pid path; every other
    // observation is reused by the application classifier.
    observed?: ReadonlyMap<number, ProcessStartObservation>,
): SessionLockLiveness {
    return createSessionLockLiveness({
        getPlatform: () => process.platform,
        observeProcessStart: (pid) => observeProcessStart(pid),
        probeLegacyProcess: (pid) => {
            if (process.platform === "linux" && observeProcessStart(pid).status === "missing") {
                throw Object.assign(new Error("Session owner has exited."), { code: "ESRCH" });
            }
            process.kill(pid, 0);
            return undefined;
        },
    })(content, observed);
}
