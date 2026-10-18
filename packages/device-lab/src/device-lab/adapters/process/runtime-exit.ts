import { execFile, spawnSync } from "child_process";
import { closeSync, constants as fsConstants, openSync, promises as fs, readSync } from "fs";
import { performance } from "perf_hooks";
import type { DeviceRuntimeProcessIdentity } from "../../../device-lab-process-identity.js";
import { canonicalWindowsPowerShellPath, canonicalWindowsPowerShellPathAsync, hiddenWindowsPowerShellArgs, windowsStartTokenExpression } from "../../../windows-system-powershell.js";

export type RuntimeExitObservation = "ended" | "still-running" | "unavailable";

export interface RuntimeExitOptions {
    platform?: NodeJS.Platform;
    now?: () => number;
    sleep?: (milliseconds: number) => void;
    readProcStat?: (pid: number, timeoutMs: number, maxBytes: number) => string;
    run?: (executable: string, args: string[], options: {
        encoding: "utf8";
        timeout: number;
        maxBuffer: number;
        killSignal: "SIGKILL";
        windowsHide: true;
    }) => { status: number | null; stdout: string; stderr?: string; error?: unknown; signal?: string | null };
    powershellPath?: string | null;
}

type RuntimeExitRunner = NonNullable<RuntimeExitOptions["run"]>;
type RuntimeExitProbeResult = ReturnType<RuntimeExitRunner>;

export interface AsyncRuntimeExitOptions extends Omit<RuntimeExitOptions, "sleep" | "readProcStat" | "run"> {
    sleep?: (milliseconds: number) => void | PromiseLike<void>;
    readProcStat?: (pid: number, timeoutMs: number, maxBytes: number) => string | PromiseLike<string>;
    run?: (...args: Parameters<RuntimeExitRunner>) => RuntimeExitProbeResult | PromiseLike<RuntimeExitProbeResult>;
}

const MAX_PROBE_BYTES = 4096;
const sleepControl = new Int32Array(new SharedArrayBuffer(4));
const windowsBirth = /^windows:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{7}Z$/;

function validPsBirth(value: string): boolean {
    return value.length > 0 && value === value.trim() && Buffer.byteLength(value, "utf8") <= MAX_PROBE_BYTES - 3
        && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}

function validBirth(token: string, platform: NodeJS.Platform): boolean {
    if (platform === "linux") return /^linux:[0-9]+$/.test(token);
    if (platform === "darwin") return token.startsWith("ps:") && validPsBirth(token.slice(3));
    return platform === "win32" && windowsBirth.test(token);
}

function expectedProcess(value: unknown, platform: NodeJS.Platform): DeviceRuntimeProcessIdentity | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const expected = value as Partial<DeviceRuntimeProcessIdentity>;
    return Number.isSafeInteger(expected.pid) && Number(expected.pid) > 0
        && typeof expected.startToken === "string" && validBirth(expected.startToken, platform)
        && typeof expected.commandHash === "string" && /^[a-f0-9]{64}$/.test(expected.commandHash)
        ? { pid: Number(expected.pid), startToken: expected.startToken, commandHash: expected.commandHash } : null;
}

function linuxObservation(expected: DeviceRuntimeProcessIdentity, text: string): RuntimeExitObservation {
    if (Buffer.byteLength(text, "utf8") > MAX_PROBE_BYTES) return "unavailable";
    const close = text.lastIndexOf(")");
    if (close < 0 || !text.startsWith(`${expected.pid} (`)) return "unavailable";
    const fields = text.slice(close + 1).trim().split(/\s+/);
    if (!/^[RSDZTtXxKWPI]$/.test(fields[0] || "") || !/^[0-9]+$/.test(fields[19] || "")) return "unavailable";
    if (`linux:${fields[19]}` !== expected.startToken || fields[0] === "Z" || fields[0] === "X") return "ended";
    return "still-running";
}

function exitWaitContext(expectedIdentity: unknown, timeoutMs: number, options: Pick<RuntimeExitOptions, "platform" | "now">) {
    const platform = options.platform || process.platform;
    const expected = expectedProcess(expectedIdentity, platform);
    if (!expected || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
    const now = options.now || (() => performance.now());
    const started = now();
    if (!Number.isFinite(started)) return null;
    return { platform, expected, now, deadline: started + Math.min(timeoutMs, 2_147_483_647) };
}

function exitProbeArgs(identity: DeviceRuntimeProcessIdentity, platform: NodeJS.Platform): string[] {
    return platform === "darwin" ? ["-p", String(identity.pid), "-o", "lstart=", "-o", "state="]
        : hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command",
            `try { $P = Get-Process -Id ${identity.pid} -ErrorAction Stop; [Console]::Out.Write('windows:' + ${windowsStartTokenExpression("$P")}) } catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { [Console]::Out.Write('ended') } else { exit 2 } }`]);
}

function exitProbeSettings(timeout: number): Parameters<RuntimeExitRunner>[2] {
    return { encoding: "utf8", timeout, maxBuffer: MAX_PROBE_BYTES, killSignal: "SIGKILL", windowsHide: true };
}

function classifyExitProbe(identity: DeviceRuntimeProcessIdentity, platform: NodeJS.Platform, result: RuntimeExitProbeResult): RuntimeExitObservation {
    if (result.error || result.signal || Buffer.byteLength(result.stdout, "utf8") > MAX_PROBE_BYTES
        || Buffer.byteLength(result.stderr || "", "utf8") > MAX_PROBE_BYTES) return "unavailable";
    const output = result.stdout.trim();
    if (platform === "darwin") {
        if (result.status === 1 && !output && !result.stderr?.trim()) return "ended";
        if (result.status !== 0 || result.stderr?.trim()) return "unavailable";
        const match = /^(.+?)\s+([IRSTUZ])(?:<|N)?X?E?V?L?s?\+?$/.exec(output);
        if (!match || !validPsBirth(match[1])) return "unavailable";
        if (match[2] === "Z") return "ended";
        // lstart inherits locale and TZ, so a changed live birth string cannot prove PID reuse.
        return `ps:${match[1]}` === identity.startToken ? "still-running" : "unavailable";
    }
    if (result.status !== 0 || result.stderr?.trim()) return "unavailable";
    if (output === "ended") return "ended";
    if (!windowsBirth.test(output)) return "unavailable";
    return output === identity.startToken ? "still-running" : "ended";
}

function linuxReadFailure(error: unknown): RuntimeExitObservation {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "ended" : "unavailable";
}

function completedObservation(observation: RuntimeExitObservation, completed: number, deadline: number): RuntimeExitObservation | null {
    if (!Number.isFinite(completed) || completed > deadline) return "unavailable";
    if (observation === "ended" || completed === deadline) return observation;
    return null;
}

/** Observe only the saved incarnation. A reused PID proves its predecessor ended,
 * and never grants permission to signal the process now holding that PID. */
export function waitForExpectedRuntimeExitSync(
    expectedIdentity: unknown,
    timeoutMs: number,
    options: RuntimeExitOptions = {},
): RuntimeExitObservation {
    const context = exitWaitContext(expectedIdentity, timeoutMs, options);
    if (!context) return "unavailable";
    const { platform, expected, now, deadline } = context;
    const sleep = options.sleep || ((milliseconds: number) => { Atomics.wait(sleepControl, 0, 0, milliseconds); });
    const run: NonNullable<RuntimeExitOptions["run"]> = options.run || ((executable, args, settings) => spawnSync(executable, args, settings));
    const readProcStat = options.readProcStat || ((pid: number, remainingMs: number, maxBytes: number) => {
        const probeDeadline = Math.min(deadline, now() + remainingMs);
        if (now() >= probeDeadline) throw new Error("runtime-exit-probe-expired");
        const descriptor = openSync(`/proc/${pid}/stat`, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        try {
            if (now() >= probeDeadline) throw new Error("runtime-exit-probe-expired");
            const bytes = Buffer.allocUnsafe(maxBytes + 1);
            const count = readSync(descriptor, bytes, 0, bytes.length, null);
            if (count > maxBytes) throw new Error("runtime-exit-probe-output-too-large");
            return bytes.subarray(0, count).toString("utf8");
        } finally { closeSync(descriptor); }
    });
    function observe(identity: DeviceRuntimeProcessIdentity): RuntimeExitObservation {
        try {
            const remaining = Math.floor(deadline - now());
            if (remaining <= 0) return "unavailable";
            if (platform === "linux") {
                try { return linuxObservation(identity, readProcStat(identity.pid, remaining, MAX_PROBE_BYTES)); }
                catch (error) { return linuxReadFailure(error); }
            }
            const executable = platform === "darwin" ? "/bin/ps"
                : options.powershellPath === undefined ? canonicalWindowsPowerShellPath() : options.powershellPath;
            if (!executable) return "unavailable";
            const args = exitProbeArgs(identity, platform);
            const timeout = Math.floor(deadline - now());
            if (timeout <= 0) return "unavailable";
            return classifyExitProbe(identity, platform, run(executable, args, exitProbeSettings(timeout)));
        } catch { return "unavailable"; }
    }
    let last: RuntimeExitObservation = "unavailable";
    while (true) {
        if (deadline - now() < 1) return last;
        const observation = observe(expected);
        const completed = now();
        const complete = completedObservation(observation, completed, deadline);
        if (complete) return complete;
        last = observation;
        const remaining = deadline - completed;
        if (remaining <= 0) return last;
        try { sleep(Math.min(50, remaining)); } catch { return "unavailable"; }
    }
}

function runExitProbeAsync(executable: string, args: string[], settings: Parameters<RuntimeExitRunner>[2]): Promise<RuntimeExitProbeResult> {
    return new Promise(resolve => {
        execFile(executable, args, settings, (error, stdout, stderr) => {
            // execFile wraps a normal nonzero exit in Error; spawnSync reports only status.
            const failedToObserve = error && (typeof error.code !== "number" || error.killed || error.signal);
            resolve({
                status: error ? typeof error.code === "number" ? error.code : null : 0,
                stdout,
                stderr,
                ...(failedToObserve ? { error } : {}),
                ...(error?.signal ? { signal: error.signal } : {}),
            });
        });
    });
}

/** Await the same saved-incarnation observations without holding the broker event loop. */
export async function waitForExpectedRuntimeExitAsync(
    expectedIdentity: unknown,
    timeoutMs: number,
    options: AsyncRuntimeExitOptions = {},
): Promise<RuntimeExitObservation> {
    const context = exitWaitContext(expectedIdentity, timeoutMs, options);
    if (!context) return "unavailable";
    const { platform, expected, now, deadline } = context;
    const sleep = options.sleep || ((milliseconds: number) => new Promise<void>(resolve => { setTimeout(resolve, milliseconds); }));
    const run = options.run || runExitProbeAsync;
    const readProcStat = options.readProcStat || (async (pid: number, remainingMs: number, maxBytes: number) => {
        const probeDeadline = Math.min(deadline, now() + remainingMs);
        if (now() >= probeDeadline) throw new Error("runtime-exit-probe-expired");
        const descriptor = await fs.open(`/proc/${pid}/stat`, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        try {
            if (now() >= probeDeadline) throw new Error("runtime-exit-probe-expired");
            const bytes = Buffer.allocUnsafe(maxBytes + 1);
            const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, null);
            if (bytesRead > maxBytes) throw new Error("runtime-exit-probe-output-too-large");
            return bytes.subarray(0, bytesRead).toString("utf8");
        } finally { await descriptor.close(); }
    });
    async function observe(identity: DeviceRuntimeProcessIdentity): Promise<RuntimeExitObservation> {
        try {
            const remaining = Math.floor(deadline - now());
            if (remaining <= 0) return "unavailable";
            if (platform === "linux") {
                try { return linuxObservation(identity, await readProcStat(identity.pid, remaining, MAX_PROBE_BYTES)); }
                catch (error) { return linuxReadFailure(error); }
            }
            const executable = platform === "darwin" ? "/bin/ps"
                : options.powershellPath === undefined ? await canonicalWindowsPowerShellPathAsync() : options.powershellPath;
            if (!executable) return "unavailable";
            const timeout = Math.floor(deadline - now());
            if (timeout <= 0) return "unavailable";
            const result = await run(executable, exitProbeArgs(identity, platform), exitProbeSettings(timeout));
            return classifyExitProbe(identity, platform, result);
        } catch { return "unavailable"; }
    }
    let last: RuntimeExitObservation = "unavailable";
    while (true) {
        if (deadline - now() < 1) return last;
        const observation = await observe(expected);
        const completed = now();
        const complete = completedObservation(observation, completed, deadline);
        if (complete) return complete;
        last = observation;
        const remaining = deadline - completed;
        if (remaining <= 0) return last;
        try { await sleep(Math.min(50, remaining)); } catch { return "unavailable"; }
    }
}
