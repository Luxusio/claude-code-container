import { execFile, spawnSync } from "child_process";
import { lstatSync, promises as fs, realpathSync } from "fs";
import { dirname, join, resolve } from "path";

const WINDOWS_SYSTEM32_PATH = "\\\\?\\GLOBALROOT\\SystemRoot\\System32";

export function spawnableWindowsExecutablePath(path: string): string | null {
    if (/^\\\\\?\\[A-Za-z]:\\/.test(path)) return path.slice(4);
    if (/^[A-Za-z]:\\/.test(path)) return path;
    return null;
}

function directoryParents(path: string): string[] {
    const parents: string[] = [];
    let current = resolve(path);
    while (true) {
        parents.push(current);
        const parent = dirname(current);
        if (parent === current) return parents;
        current = parent;
    }
}

function assertPlainDirectoryPath(path: string): void {
    for (const current of directoryParents(path)) {
        const metadata = lstatSync(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("windows-system-directory-invalid");
    }
}

async function assertPlainDirectoryPathAsync(path: string): Promise<void> {
    for (const current of directoryParents(path)) {
        const metadata = await fs.lstat(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("windows-system-directory-invalid");
    }
}

function windowsExecutableCandidate(relativePath: string, testSystemRoot?: string): string | null {
    const segments = relativePath.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) return null;
    return testSystemRoot
        ? join(resolve(testSystemRoot), "System32", ...segments)
        : join(WINDOWS_SYSTEM32_PATH, ...segments);
}

export function canonicalWindowsSystemExecutablePath(relativePath: string, testSystemRoot?: string): string | null {
    const candidate = windowsExecutableCandidate(relativePath, testSystemRoot);
    if (!candidate) return null;
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

export async function canonicalWindowsSystemExecutablePathAsync(relativePath: string, testSystemRoot?: string): Promise<string | null> {
    const candidate = windowsExecutableCandidate(relativePath, testSystemRoot);
    if (!candidate) return null;
    try {
        if (testSystemRoot) await assertPlainDirectoryPathAsync(dirname(candidate));
        const source = await fs.lstat(candidate);
        if (!source.isFile() || source.isSymbolicLink()) return null;
        const resolved = await fs.realpath(candidate);
        const executable = testSystemRoot ? resolved : spawnableWindowsExecutablePath(resolved);
        if (!executable) return null;
        await assertPlainDirectoryPathAsync(dirname(executable));
        const target = await fs.lstat(executable);
        return target.isFile() && !target.isSymbolicLink() ? executable : null;
    } catch {
        return null;
    }
}

export function canonicalWindowsPowerShellPath(testSystemRoot?: string): string | null {
    return canonicalWindowsSystemExecutablePath("WindowsPowerShell/v1.0/powershell.exe", testSystemRoot);
}

export function canonicalWindowsPowerShellPathAsync(testSystemRoot?: string): Promise<string | null> {
    return canonicalWindowsSystemExecutablePathAsync("WindowsPowerShell/v1.0/powershell.exe", testSystemRoot);
}


/**
 * The one spelling of a Windows process start token's PowerShell expression.
 *
 * There were five: two scripts in device-lab-process-identity.ts, one in
 * device-lab-broker.ts, and two more built inside PowerShell in this file. Every one of them
 * produces a value that is compared for EQUALITY against the others — across processes and
 * across ccc invocations, to decide whether ccc may terminate a process it believes is its
 * own — and nothing bound them together. On linux and macOS the equivalent tokens are
 * identical by construction, because those paths call one function; on Windows they were
 * identical only by coincidence, and an edit to one script would have drifted it from the
 * rest with no test anywhere able to notice.
 *
 * `ToString('o')` is the round-trip specifier: culture-invariant and always Gregorian, so it
 * cannot vary by locale. That was never the risk. The risk was four copies.
 */
export function windowsStartTokenExpression(processVariable: string): string {
    return `${processVariable}.StartTime.ToUniversalTime().ToString('o')`;
}
export function hiddenWindowsPowerShellArgs(args: readonly string[]): string[] {
    const filtered: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const match = /^-([a-z]+)((?::|=).*)?$/i.exec(arg);
        const parameter = match?.[1]?.toLowerCase();
        if (parameter && ["command", "commandwithargs", "cwa", "encodedcommand", "file"].some((terminal) => terminal.startsWith(parameter))) {
            filtered.push(...args.slice(index));
            break;
        }
        if (parameter && "windowstyle".startsWith(parameter)) {
            if (!match?.[2] && index + 1 < args.length && !args[index + 1].startsWith("-")) index += 1;
            continue;
        }
        filtered.push(arg);
    }
    return ["-WindowStyle", "Hidden", ...filtered];
}

export function canonicalWindowsTasklistPath(testSystemRoot?: string): string | null {
    return canonicalWindowsSystemExecutablePath("tasklist.exe", testSystemRoot);
}

export function windowsHandleBoundTerminationScript(): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        "$RootPid = [int]$env:CCC_WINDOWS_TERMINATE_PID",
        "$Root = [Diagnostics.Process]::GetProcessById($RootPid)",
        `$StartToken = 'windows:' + ${windowsStartTokenExpression("$Root")}`,
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
        // CIM CreationDate has microsecond precision; process handles retain 100ns ticks.
        "    $SnapshotTicks = $Row.CreationDate.ToUniversalTime().Ticks",
        "    $ObservedTicks = $Child.StartTime.ToUniversalTime().Ticks",
        "    if (($ObservedTicks - ($ObservedTicks % 10)) -eq $SnapshotTicks) { $Descendants.Add($Child) }",
        "  } catch { }",
        "}",
        "for ($Index = $Descendants.Count - 1; $Index -ge 0; $Index--) {",
        "  try { $Descendants[$Index].Kill() } catch { }",
        "}",
        "$Root.Kill()",
        "if (-not $Root.WaitForExit([int]$env:CCC_WINDOWS_TERMINATE_TIMEOUT_MS)) { exit 4 }",
    ].join("; ");
}

type WindowsTerminationResult = {
    ok: boolean;
    pid: number;
    status?: number | null;
    method?: string;
    reason?: string;
    error?: string;
};

type WindowsTerminationNativeResult = { status: number | null; stderr?: string; error?: { message?: string } };

function windowsTerminationTimeouts(timeoutMs: number, remainingMs?: () => number) {
    let outerTimeoutMs = Math.max(1000, timeoutMs + 1000);
    let waitTimeoutMs = Math.max(1, timeoutMs);
    if (remainingMs) {
        const remaining = remainingMs();
        if (!Number.isFinite(remaining) || remaining < 1) {
            return null;
        }
        outerTimeoutMs = Math.min(Math.floor(remaining), Math.floor(outerTimeoutMs));
        waitTimeoutMs = Math.min(Math.floor(remaining), Math.floor(waitTimeoutMs));
    }
    return { outerTimeoutMs, waitTimeoutMs };
}

function windowsTerminationOptions(pid: number, expectedStartToken: string, outerTimeoutMs: number, waitTimeoutMs: number) {
    return {
        encoding: "utf8" as const,
        windowsHide: true as const,
        timeout: outerTimeoutMs,
        env: {
            ...process.env,
            CCC_WINDOWS_TERMINATE_PID: String(pid),
            CCC_WINDOWS_TERMINATE_START_TOKEN: expectedStartToken,
            CCC_WINDOWS_TERMINATE_TIMEOUT_MS: String(waitTimeoutMs),
        },
    };
}

function windowsTerminationResult(pid: number, result: WindowsTerminationNativeResult, remainingMs?: () => number): WindowsTerminationResult {
    let expired = false;
    if (result.status === 0 && remainingMs) {
        const remaining = remainingMs();
        expired = !Number.isFinite(remaining) || remaining < 1;
    }
    return {
        ok: result.status === 0 && !expired,
        pid,
        status: result.status,
        method: "process-handle",
        ...(result.status === 3 ? { reason: "process-start-token-mismatch" } : {}),
        ...(result.status === 4 || expired ? { reason: "process-termination-timeout" } : {}),
        ...(result.status === 0 ? {} : {
            error: String(result.stderr || result.error?.message || "").trim() || undefined,
        }),
    };
}

export function terminateWindowsProcessByStartToken(
    pid: number,
    expectedStartToken: string,
    timeoutMs = 10_000,
    powershellPath = canonicalWindowsPowerShellPath(),
    remainingMs?: () => number,
): WindowsTerminationResult {
    if (!Number.isInteger(pid) || pid <= 0 || !expectedStartToken.startsWith("windows:") || !powershellPath) {
        return { ok: false, pid, reason: "windows-process-identity-unavailable" };
    }
    const timeouts = windowsTerminationTimeouts(timeoutMs, remainingMs);
    if (!timeouts) return { ok: false, pid, reason: "process-termination-timeout" };
    const result = spawnSync(powershellPath,
        hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", windowsHandleBoundTerminationScript()]),
        windowsTerminationOptions(pid, expectedStartToken, timeouts.outerTimeoutMs, timeouts.waitTimeoutMs));
    return windowsTerminationResult(pid, result, remainingMs);
}

export async function terminateWindowsProcessByStartTokenAsync(
    pid: number,
    expectedStartToken: string,
    timeoutMs = 10_000,
    powershellPath?: string | null,
    remainingMs?: () => number,
): Promise<WindowsTerminationResult> {
    if (!Number.isInteger(pid) || pid <= 0 || !expectedStartToken.startsWith("windows:") || powershellPath === null || powershellPath === "") {
        return { ok: false, pid, reason: "windows-process-identity-unavailable" };
    }
    if (powershellPath === undefined && remainingMs && !windowsTerminationTimeouts(timeoutMs, remainingMs)) {
        return { ok: false, pid, reason: "process-termination-timeout" };
    }
    const executable = powershellPath === undefined ? await canonicalWindowsPowerShellPathAsync() : powershellPath;
    if (!executable) return { ok: false, pid, reason: "windows-process-identity-unavailable" };
    const timeouts = windowsTerminationTimeouts(timeoutMs, remainingMs);
    if (!timeouts) return { ok: false, pid, reason: "process-termination-timeout" };
    const result = await new Promise<WindowsTerminationNativeResult>((resolve) => {
        execFile(executable,
            hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", windowsHandleBoundTerminationScript()]),
            windowsTerminationOptions(pid, expectedStartToken, timeouts.outerTimeoutMs, timeouts.waitTimeoutMs),
            (error, _stdout, stderr) => resolve({
                status: error ? typeof error.code === "number" ? error.code : null : 0,
                stderr,
                ...(error ? { error } : {}),
            }));
    });
    return windowsTerminationResult(pid, result, remainingMs);
}
