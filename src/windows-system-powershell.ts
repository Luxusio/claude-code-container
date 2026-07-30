import { spawnSync } from "child_process";
import { lstatSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";

const WINDOWS_SYSTEM32_PATH = "\\\\?\\GLOBALROOT\\SystemRoot\\System32";

export function spawnableWindowsExecutablePath(path: string): string | null {
    if (/^\\\\\?\\[A-Za-z]:\\/.test(path)) return path.slice(4);
    if (/^[A-Za-z]:\\/.test(path)) return path;
    return null;
}

function assertPlainDirectoryPath(path: string): void {
    let current = resolve(path);
    while (true) {
        const metadata = lstatSync(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("windows-system-directory-invalid");
        const parent = dirname(current);
        if (parent === current) return;
        current = parent;
    }
}

export function canonicalWindowsSystemExecutablePath(relativePath: string, testSystemRoot?: string): string | null {
    const segments = relativePath.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) return null;
    const candidate = testSystemRoot
        ? join(resolve(testSystemRoot), "System32", ...segments)
        : join(WINDOWS_SYSTEM32_PATH, ...segments);
    try {
        // path.resolve() cannot preserve the GLOBALROOT device alias while
        // walking its parents. Resolve that trusted alias to its ordinary
        // drive-qualified path first; injected roots still get checked before
        // resolution so a symlink cannot be hidden by realpath.
        if (testSystemRoot) assertPlainDirectoryPath(dirname(candidate));
        const source = lstatSync(candidate);
        if (!source.isFile() || source.isSymbolicLink()) return null;
        const resolved = realpathSync.native(candidate);
        const executable = testSystemRoot ? resolved : spawnableWindowsExecutablePath(resolved);
        if (!executable) return null;
        assertPlainDirectoryPath(dirname(executable));
        const target = lstatSync(executable);
        return target.isFile() && !target.isSymbolicLink() ? executable : null;
    } catch {
        return null;
    }
}

export function canonicalWindowsPowerShellPath(testSystemRoot?: string): string | null {
    return canonicalWindowsSystemExecutablePath("WindowsPowerShell/v1.0/powershell.exe", testSystemRoot);
}

export function canonicalWindowsTasklistPath(testSystemRoot?: string): string | null {
    return canonicalWindowsSystemExecutablePath("tasklist.exe", testSystemRoot);
}

export function windowsHandleBoundTerminationScript(): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        "$RootPid = [int]$env:CCC_WINDOWS_TERMINATE_PID",
        "$Root = [Diagnostics.Process]::GetProcessById($RootPid)",
        "$StartToken = 'windows:' + $Root.StartTime.ToUniversalTime().ToString('o')",
        "if ($StartToken -ne $env:CCC_WINDOWS_TERMINATE_START_TOKEN) { exit 3 }",
        "$Rows = @()",
        "try { $Rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, CreationDate) } catch { $Rows = @() }",
        "$Pending = [Collections.Generic.Queue[int]]::new()",
        "$Pending.Enqueue($RootPid)",
        "$DescendantRows = [Collections.Generic.List[object]]::new()",
        "while ($Pending.Count -gt 0) {",
        "  $ParentPid = $Pending.Dequeue()",
        "  foreach ($Row in $Rows) {",
        "    if ([int]$Row.ParentProcessId -eq $ParentPid) {",
        "      $ChildPid = [int]$Row.ProcessId",
        "      if ($Row.CreationDate -and $Row.CreationDate.ToUniversalTime() -ge $Root.StartTime.ToUniversalTime()) { $DescendantRows.Add($Row); $Pending.Enqueue($ChildPid) }",
        "    }",
        "  }",
        "}",
        "$Descendants = [Collections.Generic.List[Diagnostics.Process]]::new()",
        "foreach ($Row in $DescendantRows) {",
        "  try {",
        "    $ChildPid = [int]$Row.ProcessId",
        "    $Child = [Diagnostics.Process]::GetProcessById($ChildPid)",
        "    $SnapshotToken = 'windows:' + $Row.CreationDate.ToUniversalTime().ToString('o')",
        "    $ObservedToken = 'windows:' + $Child.StartTime.ToUniversalTime().ToString('o')",
        "    if ($ObservedToken -eq $SnapshotToken) { $Descendants.Add($Child) }",
        "  } catch { }",
        "}",
        "for ($Index = $Descendants.Count - 1; $Index -ge 0; $Index--) {",
        "  try { $Descendants[$Index].Kill() } catch { }",
        "}",
        "$Root.Kill()",
        "if (-not $Root.WaitForExit([int]$env:CCC_WINDOWS_TERMINATE_TIMEOUT_MS)) { exit 4 }",
    ].join("; ");
}

export function terminateWindowsProcessByStartToken(
    pid: number,
    expectedStartToken: string,
    timeoutMs = 10_000,
    powershellPath = canonicalWindowsPowerShellPath(),
): {
    ok: boolean;
    pid: number;
    status?: number | null;
    method?: string;
    reason?: string;
    error?: string;
} {
    if (!Number.isInteger(pid) || pid <= 0 || !expectedStartToken.startsWith("windows:") || !powershellPath) {
        return { ok: false, pid, reason: "windows-process-identity-unavailable" };
    }
    const script = windowsHandleBoundTerminationScript();
    const result = spawnSync(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: Math.max(1000, timeoutMs + 1000),
        env: {
            ...process.env,
            CCC_WINDOWS_TERMINATE_PID: String(pid),
            CCC_WINDOWS_TERMINATE_START_TOKEN: expectedStartToken,
            CCC_WINDOWS_TERMINATE_TIMEOUT_MS: String(Math.max(1, timeoutMs)),
        },
    });
    return {
        ok: result.status === 0,
        pid,
        status: result.status,
        method: "process-handle",
        ...(result.status === 3 ? { reason: "process-start-token-mismatch" } : {}),
        ...(result.status === 4 ? { reason: "process-termination-timeout" } : {}),
        ...(result.status === 0 ? {} : {
            error: String(result.stderr || result.error?.message || "").trim() || undefined,
        }),
    };
}
