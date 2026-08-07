import { execFile, spawnSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { canonicalWindowsPowerShellPath, canonicalWindowsSystemExecutablePath, hiddenWindowsPowerShellArgs } from "./windows-system-powershell.mjs";

function validPid(pid) {
    return Number.isInteger(pid) && pid > 0;
}

function processIdentity(pid, startToken, commandLine) {
    if (!startToken || !commandLine) return null;
    return {
        pid,
        startToken,
        commandHash: createHash("sha256").update(commandLine).digest("hex"),
    };
}

function linuxProcessIdentity(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
        const command = readFileSync(`/proc/${pid}/cmdline`).toString("utf-8").split("\0").filter(Boolean).join(" ");
        const close = stat.lastIndexOf(")");
        if (close < 0) return null;
        const fields = stat.slice(close + 1).trim().split(/\s+/);
        const startTicks = fields[19];
        return processIdentity(pid, startTicks ? `linux:${startTicks}` : null, command);
    } catch {
        return null;
    }
}

function windowsProcessIdentity(pid) {
    const powershell = canonicalWindowsPowerShellPath();
    if (!powershell) return null;
    const script = windowsProcessIdentityScript(pid);
    const result = spawnSync(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", script]), {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout?.trim()) return null;
    return parseWindowsProcessIdentity(pid, result.stdout);
}

function windowsProcessIdentityScript(pid) {
    return `$P = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; $H = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($P -and $H) { [pscustomobject]@{ startToken = $H.StartTime.ToUniversalTime().ToString('o'); commandLine = [string]$P.CommandLine } | ConvertTo-Json -Compress }`;
}

function parseWindowsProcessIdentity(pid, output) {
    try {
        const parsed = JSON.parse(output);
        return processIdentity(pid, parsed.startToken ? `windows:${parsed.startToken}` : null, parsed.commandLine);
    } catch {
        return null;
    }
}

function windowsProcessIdentityAsync(pid) {
    return new Promise((resolve) => {
        const powershell = canonicalWindowsPowerShellPath();
        if (!powershell) {
            resolve(null);
            return;
        }
        execFile(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", windowsProcessIdentityScript(pid)]), {
            encoding: "utf-8",
            timeout: 5000,
            windowsHide: true,
            maxBuffer: 64 * 1024,
        }, (error, stdout) => {
            resolve(error || !stdout?.trim() ? null : parseWindowsProcessIdentity(pid, stdout));
        });
    });
}

function psProcessIdentity(pid) {
    const executable = process.platform === "darwin" ? "/bin/ps" : "ps";
    const started = spawnSync(executable, ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8", timeout: 5000, windowsHide: true });
    const command = spawnSync(executable, ["-p", String(pid), "-o", "command="], { encoding: "utf-8", timeout: 5000, windowsHide: true });
    const startToken = started.status === 0 ? started.stdout?.trim() : "";
    const commandLine = command.status === 0 ? command.stdout?.trim() : "";
    return processIdentity(pid, startToken ? `ps:${startToken}` : null, commandLine);
}

function execFileText(executable, args) {
    return new Promise((resolve) => {
        execFile(executable, args, {
            encoding: "utf-8",
            timeout: 5000,
            windowsHide: true,
            maxBuffer: 64 * 1024,
        }, (error, stdout) => resolve(error ? "" : stdout?.trim() || ""));
    });
}

async function psProcessIdentityAsync(pid) {
    const executable = process.platform === "darwin" ? "/bin/ps" : "ps";
    const [startToken, commandLine] = await Promise.all([
        execFileText(executable, ["-p", String(pid), "-o", "lstart="]),
        execFileText(executable, ["-p", String(pid), "-o", "command="]),
    ]);
    return processIdentity(pid, startToken ? `ps:${startToken}` : null, commandLine || null);
}

export function readProcessIdentity(pid) {
    if (!validPid(pid)) return null;
    if (process.platform === "linux") return linuxProcessIdentity(pid);
    if (process.platform === "win32") return windowsProcessIdentity(pid);
    return psProcessIdentity(pid);
}

export async function readProcessIdentityAsync(pid) {
    if (!validPid(pid)) return null;
    if (process.platform === "win32") return windowsProcessIdentityAsync(pid);
    if (process.platform === "linux") return readProcessIdentity(pid);
    return psProcessIdentityAsync(pid);
}

export async function waitForProcessIdentity(pid, timeoutMs = 1000, options = {}) {
    const requestedTimeoutMs = Number(timeoutMs);
    const boundedTimeoutMs = Number.isFinite(requestedTimeoutMs) ? Math.max(0, requestedTimeoutMs) : 1000;
    const readIdentity = options.readIdentity || readProcessIdentity;
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + boundedTimeoutMs;
    do {
        const identity = readIdentity(pid);
        if (identity) return identity;
        if ((options.probeLiveness || probeProcessLiveness)(pid) === "exited") return null;
        if (Date.now() >= deadline) break;
        await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return readIdentity(pid);
}

export function processIdentityMatches(expected, current) {
    return Boolean(expected
        && current
        && validPid(expected.pid)
        && expected.pid === current.pid
        && typeof expected.startToken === "string"
        && expected.startToken === current.startToken
        && typeof expected.commandHash === "string"
        && expected.commandHash === current.commandHash);
}

export function refreshOwnedRuntimeProcessIdentity(runtime, options = {}) {
    if (!runtime?.processIdentity || !validPid(runtime.pid)) return runtime;
    const current = (options.readIdentity || readProcessIdentity)(runtime.pid);
    if (!current
        || current.pid !== runtime.processIdentity.pid
        || current.startToken !== runtime.processIdentity.startToken) {
        return runtime;
    }
    return { ...runtime, processIdentity: current };
}

function probeProcessLiveness(pid) {
    if (!validPid(pid)) return "unknown";
    try {
        process.kill(pid, 0);
        return "alive";
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
        if (code === "ESRCH") return "exited";
        if (code === "EPERM") return "alive";
        return "unknown";
    }
}

export function inspectProcessIdentity(expected, pid, options = {}) {
    if (!validPid(pid)) return { status: "unavailable", current: null, liveness: "unknown" };
    const current = (options.readIdentity || readProcessIdentity)(pid);
    if (current) {
        return {
            status: processIdentityMatches(expected, current) ? "match" : "mismatch",
            current,
            liveness: "alive",
        };
    }
    const liveness = (options.probeLiveness || probeProcessLiveness)(pid);
    return { status: liveness === "exited" ? "exited" : "unavailable", current: null, liveness };
}

export function signalOwnedRuntimeProcess(runtime, signal = "SIGINT", options = {}) {
    if (!runtime?.runtimeId || !validPid(runtime.pid) || !runtime.processIdentity) {
        return { attempted: false, signaled: false, reason: "runtime-process-identity-missing" };
    }
    const observation = inspectProcessIdentity(runtime.processIdentity, runtime.pid, options);
    if (observation.status !== "match") {
        const reason = observation.status === "mismatch"
            ? "runtime-process-identity-mismatch"
            : observation.status === "exited"
                ? "runtime-process-exited"
                : "runtime-process-identity-unavailable";
        return {
            attempted: false,
            signaled: false,
            reason,
            ...(observation.current ? { current: observation.current } : {}),
            ...(observation.status === "exited" ? { exited: true } : {}),
            observation,
        };
    }
    try {
        (options.kill || process.kill)(runtime.pid, signal);
        return { attempted: true, signaled: true, pid: runtime.pid, signal };
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
        return {
            attempted: true,
            signaled: false,
            exited: code === "ESRCH",
            pid: runtime.pid,
            signal,
            reason: code === "ESRCH" ? "runtime-process-exited" : "runtime-process-signal-failed",
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function waitForRuntimeProcessExit(pid, timeoutMs, options = {}) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        if ((options.probeLiveness || probeProcessLiveness)(pid) === "exited") return true;
        await (options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(50);
    }
    return (options.probeLiveness || probeProcessLiveness)(pid) === "exited";
}

export async function terminateOwnedRuntimeProcess(runtime, label, options = {}) {
    const requestedTimeoutMs = Number(options.timeoutMs ?? 1000);
    const timeoutMs = Number.isFinite(requestedTimeoutMs) ? Math.max(0, requestedTimeoutMs) : 1000;
    for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"]) {
        const result = signalOwnedRuntimeProcess(runtime, signal, options);
        if (result.reason === "runtime-process-exited") return { exited: true, signaled: false, reason: result.reason };
        if (!result.signaled) {
            return {
                exited: false,
                signaled: false,
                reason: result.reason,
                error: `${label} process identity could not be verified: ${result.reason}`,
            };
        }
        if (await waitForRuntimeProcessExit(runtime?.pid, timeoutMs, options)) return { exited: true, signaled: true };
    }
    return {
        exited: false,
        signaled: true,
        error: `${label} process did not exit after SIGINT/SIGTERM/SIGKILL: ${runtime?.pid}`,
    };
}

export async function terminateOwnedRuntimeProcessTree(runtime, label, options = {}) {
    const observation = inspectProcessIdentity(runtime?.processIdentity, runtime?.pid, options);
    if (observation.status !== "match") {
        const reason = observation.status === "mismatch"
            ? "runtime-process-identity-mismatch"
            : observation.status === "exited"
                ? "runtime-process-exited"
                : "runtime-process-identity-unavailable";
        return {
            exited: observation.status === "exited",
            signaled: false,
            reason,
            ...((observation.status !== "exited") ? { error: `${label} process identity could not be verified: ${reason}` } : {}),
        };
    }
    if ((options.platform || process.platform) !== "win32") {
        return terminateOwnedRuntimeProcess(runtime, label, {
            ...options,
            kill: (_pid, signal) => (options.killTree || process.kill)(-runtime.pid, signal),
        });
    }

    const taskkill = options.taskkill || ((pid) => {
        const taskkillPath = canonicalWindowsSystemExecutablePath("taskkill.exe");
        return taskkillPath
            ? spawnSync(taskkillPath, ["/PID", String(pid), "/T", "/F"], {
                encoding: "utf-8",
                timeout: 10_000,
                windowsHide: true,
            })
            : { status: null, stdout: "", stderr: "", error: new Error("windows-system-taskkill-unavailable") };
    });
    const result = taskkill(runtime.pid);
    const requestedTimeoutMs = Number(options.timeoutMs ?? 1000);
    const timeoutMs = Number.isFinite(requestedTimeoutMs) ? Math.max(0, requestedTimeoutMs) : 1000;
    const exited = await waitForRuntimeProcessExit(runtime.pid, timeoutMs, options);
    const output = `${result?.stderr || ""}\n${result?.stdout || ""}`.trim();
    return {
        exited,
        signaled: result?.status === 0,
        method: "taskkill-tree",
        status: result?.status ?? null,
        ...(!exited ? { error: output || `${label} process tree did not exit` } : {}),
    };
}
