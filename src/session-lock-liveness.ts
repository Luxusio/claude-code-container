import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { canonicalWindowsPowerShellPath, canonicalWindowsTasklistPath } from "./windows-system-powershell.js";

export type SessionLockLiveness = "active" | "stale" | "unknown";

type ProcessStartObservation =
    | { status: "found"; token: string }
    | { status: "present" }
    | { status: "missing" }
    | { status: "unknown" };

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
            if (close < 0) return { status: "unknown" };
            const fields = stat.slice(close + 1).trim().split(/\s+/);
            return fields[19]
                ? { status: "found", token: `linux:${fields[19]}` }
                : { status: "unknown" };
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
            const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
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

export function processStartToken(pid: number): string | null {
    const observed = observeProcessStart(pid);
    return observed.status === "found" ? observed.token : null;
}

export interface SessionLockOwner {
    pid: number;
    startToken?: string;
}

export function sessionLockOwner(content: string): SessionLockOwner | null {
    try {
        const parsed = JSON.parse(content) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const record = parsed as { version?: unknown; pid?: unknown; startToken?: unknown };
            if (record.version !== 2 || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
                || typeof record.startToken !== "string" || record.startToken.length === 0
                || record.startToken.length > 256) {
                return null;
            }
            return { pid: Number(record.pid), startToken: record.startToken };
        }
    } catch {
        // Legacy lock files contain only the decimal PID.
    }
    const legacy = content.trim();
    if (!/^[1-9]\d*$/.test(legacy)) return null;
    const pid = Number(legacy);
    return Number.isSafeInteger(pid) ? { pid } : null;
}

function legacyProcessLiveness(pid: number): SessionLockLiveness {
    if (process.platform === "win32") {
        const observed = observeProcessStart(pid);
        return observed.status === "found" || observed.status === "present"
            ? "active"
            : observed.status === "missing" ? "stale" : "unknown";
    }
    try {
        process.kill(pid, 0);
        return "active";
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return "stale";
        if (code === "EPERM") return "active";
        return "unknown";
    }
}

export function sessionLockLiveness(content: string): SessionLockLiveness {
    const record = sessionLockOwner(content.trim());
    if (!record) return "unknown";
    if (!record.startToken) return legacyProcessLiveness(record.pid);

    const observed = observeProcessStart(record.pid);
    if (observed.status === "missing") return "stale";
    if (observed.status === "found") {
        return observed.token === record.startToken ? "active" : "stale";
    }
    if (observed.status === "present") return "unknown";
    return "unknown";
}
