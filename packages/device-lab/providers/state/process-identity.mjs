import { execFile, spawnSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { canonicalWindowsPowerShellPath, canonicalWindowsSystemExecutablePath, hiddenWindowsPowerShellArgs } from "./windows-system-powershell.mjs";

function captureRemainingMs(durationMs, options = {}) {
    const now = options.now || (() => performance.now());
    let previous = now();
    let remaining = Number.isFinite(previous) ? Math.min(Number.MAX_SAFE_INTEGER, durationMs) : 0;
    const clampParent = () => {
        if (options.remainingMs) {
            const parent = options.remainingMs();
            remaining = Number.isFinite(parent) ? Math.max(0, Math.min(remaining, parent)) : 0;
        }
    };
    clampParent();
    return () => {
        const current = now();
        if (!Number.isFinite(current) || !Number.isFinite(previous)) remaining = 0;
        else {
            remaining = Math.max(0, remaining - Math.max(0, current - previous));
            previous = Math.max(previous, current);
        }
        clampParent();
        return remaining;
    };
}

function nativeTimeout(remainingMs, cap = 5000) {
    return Math.min(cap, Math.floor(remainingMs()));
}

function requestedWaitMs(value = 1000) {
    const requested = Number(value);
    return Number.isFinite(requested) ? Math.max(0, requested) : 1000;
}

function terminationAllowance(timeoutMs, phases, overheadMs) {
    return timeoutMs >= (Number.MAX_SAFE_INTEGER - overheadMs) / phases
        ? Number.MAX_SAFE_INTEGER
        : Math.min(Number.MAX_SAFE_INTEGER, overheadMs + phases * timeoutMs);
}

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

function linuxProcessIdentity(pid, remainingMs) {
    try {
        if (!(remainingMs() >= 1)) return null;
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
        if (!(remainingMs() >= 1)) return null;
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

function windowsProcessIdentity(pid, remainingMs) {
    const powershell = canonicalWindowsPowerShellPath();
    if (!powershell) return null;
    const script = windowsProcessIdentityScript(pid);
    const timeout = nativeTimeout(remainingMs);
    if (timeout < 1) return null;
    const result = spawnSync(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", script]), {
        encoding: "utf-8",
        timeout,
        killSignal: "SIGKILL",
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

function windowsProcessIdentityAsync(pid, remainingMs) {
    return new Promise((resolve) => {
        const powershell = canonicalWindowsPowerShellPath();
        if (!powershell) {
            resolve(null);
            return;
        }
        const timeout = nativeTimeout(remainingMs);
        if (timeout < 1) {
            resolve(null);
            return;
        }
        execFile(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", windowsProcessIdentityScript(pid)]), {
            encoding: "utf-8",
            timeout,
            killSignal: "SIGKILL",
            windowsHide: true,
            maxBuffer: 64 * 1024,
        }, (error, stdout) => {
            resolve(error || !stdout?.trim() ? null : parseWindowsProcessIdentity(pid, stdout));
        });
    });
}

function psProcessIdentity(pid, remainingMs) {
    const executable = process.platform === "darwin" ? "/bin/ps" : "ps";
    const startedTimeout = nativeTimeout(remainingMs);
    if (startedTimeout < 1) return null;
    const started = spawnSync(executable, ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8", timeout: startedTimeout, killSignal: "SIGKILL", windowsHide: true });
    const commandTimeout = nativeTimeout(remainingMs);
    if (commandTimeout < 1) return null;
    const command = spawnSync(executable, ["-p", String(pid), "-o", "command="], { encoding: "utf-8", timeout: commandTimeout, killSignal: "SIGKILL", windowsHide: true });
    const startToken = started.status === 0 ? started.stdout?.trim() : "";
    const commandLine = command.status === 0 ? command.stdout?.trim() : "";
    return processIdentity(pid, startToken ? `ps:${startToken}` : null, commandLine);
}

function execFileText(executable, args, remainingMs) {
    return new Promise((resolve) => {
        const timeout = nativeTimeout(remainingMs);
        if (timeout < 1) {
            resolve("");
            return;
        }
        execFile(executable, args, {
            encoding: "utf-8",
            timeout,
            killSignal: "SIGKILL",
            windowsHide: true,
            maxBuffer: 64 * 1024,
        }, (error, stdout) => resolve(error ? "" : stdout?.trim() || ""));
    });
}

async function psProcessIdentityAsync(pid, remainingMs) {
    const executable = process.platform === "darwin" ? "/bin/ps" : "ps";
    const [startToken, commandLine] = await Promise.all([
        execFileText(executable, ["-p", String(pid), "-o", "lstart="], remainingMs),
        execFileText(executable, ["-p", String(pid), "-o", "command="], remainingMs),
    ]);
    return processIdentity(pid, startToken ? `ps:${startToken}` : null, commandLine || null);
}

function readNativeProcessIdentity(pid, remainingMs) {
    if (!validPid(pid) || !(remainingMs() >= 1)) return null;
    if (process.platform === "linux") return linuxProcessIdentity(pid, remainingMs);
    if (process.platform === "win32") return windowsProcessIdentity(pid, remainingMs);
    return psProcessIdentity(pid, remainingMs);
}

export function readProcessIdentity(pid, options = {}) {
    const remainingMs = captureRemainingMs(10_000, options);
    const identity = readNativeProcessIdentity(pid, remainingMs);
    return identity && remainingMs() >= 1 ? identity : null;
}

export async function readProcessIdentityAsync(pid, options = {}) {
    const remainingMs = captureRemainingMs(10_000, options);
    if (!validPid(pid) || !(remainingMs() >= 1)) return null;
    const identity = process.platform === "win32" ? await windowsProcessIdentityAsync(pid, remainingMs)
        : process.platform === "linux" ? linuxProcessIdentity(pid, remainingMs)
            : await psProcessIdentityAsync(pid, remainingMs);
    return identity && remainingMs() >= 1 ? identity : null;
}

export async function waitForProcessIdentity(pid, timeoutMs = 1000, options = {}) {
    const remainingMs = captureRemainingMs(requestedWaitMs(timeoutMs), options);
    const readIdentity = options.readIdentity || ((pid) => readNativeProcessIdentity(pid, remainingMs));
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    while (remainingMs() >= 1) {
        const identity = readIdentity(pid);
        if (!(remainingMs() >= 1)) return null;
        if (identity) return identity;
        if ((options.probeLiveness || probeProcessLiveness)(pid) === "exited") return null;
        const delay = Math.min(50, remainingMs());
        if (!(delay > 0)) break;
        await sleep(delay);
    }
    return null;
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
    const remainingMs = captureRemainingMs(10_000, options);
    if (!runtime?.processIdentity || !validPid(runtime.pid)) return runtime;
    if (!(remainingMs() >= 1)) return runtime;
    const current = (options.readIdentity || ((pid) => readNativeProcessIdentity(pid, remainingMs)))(runtime.pid);
    if (!current
        || current.pid !== runtime.processIdentity.pid
        || current.startToken !== runtime.processIdentity.startToken
        || !(remainingMs() >= 1)) {
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

// An unreaped Linux child has exited even though kill(pid, 0) still succeeds.
// Its empty cmdline cannot supply a full identity, so retain the saved birth check.
function linuxExitedProcessObservation(expected, pid, remainingMs) {
    if (!expected || expected.pid !== pid || !validPid(expected.pid)
        || typeof expected.startToken !== "string" || !/^linux:[0-9]+$/.test(expected.startToken)
        || typeof expected.commandHash !== "string" || !/^[a-f0-9]{64}$/.test(expected.commandHash)) return null;
    try {
        if (!(remainingMs() >= 1)) return null;
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
        const close = stat.lastIndexOf(")");
        if (close < 0 || Number(stat.slice(0, stat.indexOf(" "))) !== pid) return null;
        const fields = stat.slice(close + 1).trim().split(/\s+/);
        if ((fields[0] !== "Z" && fields[0] !== "X") || !/^[0-9]+$/.test(fields[19] || "")) return null;
        const exited = expected.startToken === `linux:${fields[19]}`;
        return { status: exited ? "exited" : "mismatch", current: null, liveness: exited ? "exited" : "alive" };
    } catch {
        return null;
    }
}

export function inspectProcessIdentity(expected, pid, options = {}) {
    const remainingMs = captureRemainingMs(10_000, options);
    const unavailable = { status: "unavailable", current: null, liveness: "unknown" };
    if (!validPid(pid) || !(remainingMs() >= 1)) return unavailable;
    const current = (options.readIdentity || ((pid) => readNativeProcessIdentity(pid, remainingMs)))(pid);
    if (current) {
        const matches = processIdentityMatches(expected, current);
        if (matches && !(remainingMs() >= 1)) return unavailable;
        return {
            status: matches ? "match" : "mismatch",
            current,
            liveness: "alive",
        };
    }
    if (!(remainingMs() >= 1)) return unavailable;
    if (process.platform === "linux" && !options.readIdentity && !options.probeLiveness) {
        const exited = linuxExitedProcessObservation(expected, pid, remainingMs);
        if (exited) return exited.status === "mismatch" || remainingMs() >= 1 ? exited : unavailable;
    }
    if (!(remainingMs() >= 1)) return unavailable;
    const liveness = (options.probeLiveness || probeProcessLiveness)(pid);
    if (!(remainingMs() >= 1)) return unavailable;
    return { status: liveness === "exited" ? "exited" : "unavailable", current: null, liveness };
}

export function signalOwnedRuntimeProcess(runtime, signal = "SIGINT", options = {}) {
    const remainingMs = captureRemainingMs(10_000, options);
    if (!runtime?.runtimeId || !validPid(runtime.pid) || !runtime.processIdentity) {
        return { attempted: false, signaled: false, reason: "runtime-process-identity-missing" };
    }
    let observation = inspectProcessIdentity(runtime.processIdentity, runtime.pid, { ...options, remainingMs });
    if (observation.status === "match" && !(remainingMs() >= 1)) {
        observation = { status: "unavailable", current: null, liveness: "unknown" };
    }
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
    const remainingMs = options.remainingMs;
    const phaseRemainingMs = captureRemainingMs(timeoutMs, options);
    let first = true;
    while (remainingMs() >= 1 && ((first && timeoutMs === 0) || phaseRemainingMs() > 0)) {
        const liveness = (options.probeLiveness || probeProcessLiveness)(pid);
        if (!(remainingMs() >= 1) || (timeoutMs > 0 && !(phaseRemainingMs() > 0))) return false;
        if (liveness === "exited") return true;
        first = false;
        const delay = Math.min(50, phaseRemainingMs(), remainingMs());
        if (!(delay > 0)) break;
        await (options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
    }
    return false;
}

export async function terminateOwnedRuntimeProcess(runtime, label, options = {}) {
    const timeoutMs = requestedWaitMs(options.timeoutMs ?? 1000);
    const remainingMs = captureRemainingMs(terminationAllowance(timeoutMs, 3, 30_000), options);
    return terminateRuntimeProcess(runtime, label, timeoutMs, { ...options, remainingMs });
}

async function terminateRuntimeProcess(runtime, label, timeoutMs, options) {
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
        if (await waitForRuntimeProcessExit(runtime?.pid, timeoutMs, options)) {
            if (options.remainingMs() >= 1) return { exited: true, signaled: true };
        }
    }
    return {
        exited: false,
        signaled: true,
        error: `${label} process did not exit after SIGINT/SIGTERM/SIGKILL: ${runtime?.pid}`,
    };
}

export async function terminateOwnedRuntimeProcessTree(runtime, label, options = {}) {
    const timeoutMs = requestedWaitMs(options.timeoutMs ?? 1000);
    const windows = (options.platform || process.platform) === "win32";
    const remainingMs = captureRemainingMs(terminationAllowance(timeoutMs, windows ? 1 : 3, windows ? 20_000 : 40_000), options);
    const observation = inspectProcessIdentity(runtime?.processIdentity, runtime?.pid, { ...options, remainingMs });
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
    if (!windows) {
        return terminateRuntimeProcess(runtime, label, timeoutMs, {
            ...options,
            remainingMs,
            kill: (_pid, signal) => (options.killTree || process.kill)(-runtime.pid, signal),
        });
    }

    const taskkill = options.taskkill || ((pid) => {
        const taskkillPath = canonicalWindowsSystemExecutablePath("taskkill.exe");
        const timeout = nativeTimeout(remainingMs, 10_000);
        if (timeout < 1) return null;
        return taskkillPath
            ? spawnSync(taskkillPath, ["/PID", String(pid), "/T", "/F"], {
                encoding: "utf-8",
                timeout,
                windowsHide: true,
            })
            : { status: null, stdout: "", stderr: "", error: new Error("windows-system-taskkill-unavailable") };
    });
    if (!(remainingMs() >= 1)) {
        return {
            exited: false,
            signaled: false,
            reason: "runtime-process-identity-unavailable",
            error: `${label} process identity could not be verified: runtime-process-identity-unavailable`,
        };
    }
    const result = taskkill(runtime.pid);
    const observedExit = await waitForRuntimeProcessExit(runtime.pid, timeoutMs, { ...options, remainingMs });
    const output = `${result?.stderr || ""}\n${result?.stdout || ""}`.trim();
    const exited = observedExit && remainingMs() >= 1;
    return {
        exited,
        signaled: result?.status === 0,
        method: "taskkill-tree",
        status: result?.status ?? null,
        ...(!exited ? { error: output || `${label} process tree did not exit` } : {}),
    };
}
