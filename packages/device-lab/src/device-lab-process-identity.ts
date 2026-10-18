import { execFile, spawnSync } from "child_process";
import { createHash } from "crypto";
import { promises as fs, readFileSync } from "fs";
import { canonicalWindowsPowerShellPath, canonicalWindowsPowerShellPathAsync, hiddenWindowsPowerShellArgs, windowsStartTokenExpression } from "./windows-system-powershell.js";

export type DeviceRuntimeProcessIdentity = {
    pid: number;
    startToken: string;
    commandHash: string;
};

export type DeviceRuntimeProcessObservation = {
    status: "match" | "mismatch" | "exited" | "unavailable";
    current: DeviceRuntimeProcessIdentity | null;
    liveness?: "alive" | "exited" | "unknown";
};

type ProcessIdentityOptions = {
    platform?: NodeJS.Platform;
    remainingMs?: () => number;
    readIdentity?: (pid: number) => DeviceRuntimeProcessIdentity | null;
    probeLiveness?: (pid: number) => "alive" | "exited" | "unknown";
    kill?: (pid: number, signal: NodeJS.Signals) => void;
};

export type ProcessIdentityAsyncOptions = Omit<ProcessIdentityOptions, "readIdentity"> & {
    readIdentity?: (pid: number) => DeviceRuntimeProcessIdentity | null | PromiseLike<DeviceRuntimeProcessIdentity | null>;
};

function validPid(pid: unknown): pid is number {
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

function processIdentityProbeTimeoutMs(remainingMs?: () => number): number {
    if (!remainingMs) return 5000;
    const remaining = remainingMs();
    return Number.isFinite(remaining) && remaining >= 1 ? Math.min(5000, Math.floor(remaining)) : 0;
}

function linuxProcessStartToken(pid: number, remainingMs?: () => number): string | null {
    if (!processIdentityProbeTimeoutMs(remainingMs)) return null;
    try {
        return parseLinuxProcessStartToken(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
        return null;
    }
}

function parseLinuxProcessStartToken(stat: string): string | null {
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    return fields[19] ? `linux:${fields[19]}` : null;
}

function linuxCommandLine(command: Buffer): string {
    return command.toString("utf8").split("\0").filter(Boolean).join(" ");
}

function psExecutable(platform: NodeJS.Platform): string {
    return platform === "darwin" ? "/bin/ps" : "ps";
}

function psArgs(pid: number, field: "lstart=" | "command="): string[] {
    return ["-p", String(pid), "-o", field];
}

function identityProbeOptions(timeout: number) {
    return { encoding: "utf8" as const, timeout, killSignal: "SIGKILL" as const, windowsHide: true };
}

function windowsProcessStartToken(pid: number, remainingMs?: () => number): string | null {
    const powershell = canonicalWindowsPowerShellPath();
    if (!powershell) return null;
    const script = `$P = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($P) { [Console]::Out.Write(${windowsStartTokenExpression("$P")}) }`;
    const timeout = processIdentityProbeTimeoutMs(remainingMs);
    if (!timeout) return null;
    const result = spawnSync(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", script]), identityProbeOptions(timeout));
    const value = result.status === 0 ? result.stdout?.trim() : "";
    return value ? `windows:${value}` : null;
}

function psProcessStartToken(pid: number, platform: NodeJS.Platform, remainingMs?: () => number): string | null {
    const executable = psExecutable(platform);
    const timeout = processIdentityProbeTimeoutMs(remainingMs);
    if (!timeout) return null;
    const result = spawnSync(executable, psArgs(pid, "lstart="), identityProbeOptions(timeout));
    const value = result.status === 0 ? result.stdout?.trim() : "";
    return value ? `ps:${value}` : null;
}

export function readDeviceRuntimeProcessStartToken(pid: unknown, options: Pick<ProcessIdentityOptions, "platform" | "remainingMs"> = {}): string | null {
    if (!validPid(pid) || !processIdentityProbeTimeoutMs(options.remainingMs)) return null;
    const platform = options.platform || process.platform;
    const token = platform === "linux" ? linuxProcessStartToken(pid, options.remainingMs)
        : platform === "win32" ? windowsProcessStartToken(pid, options.remainingMs)
            : psProcessStartToken(pid, platform, options.remainingMs);
    return token && processIdentityProbeTimeoutMs(options.remainingMs) ? token : null;
}

function identity(pid: number, startToken: string | null, commandLine: string | null): DeviceRuntimeProcessIdentity | null {
    if (!startToken || !commandLine) return null;
    return {
        pid,
        startToken,
        commandHash: createHash("sha256").update(commandLine).digest("hex"),
    };
}

function linuxProcessIdentity(pid: number, remainingMs?: () => number): DeviceRuntimeProcessIdentity | null {
    try {
        const command = linuxCommandLine(readFileSync(`/proc/${pid}/cmdline`));
        return identity(pid, linuxProcessStartToken(pid, remainingMs), command);
    } catch {
        return null;
    }
}

function windowsProcessIdentity(pid: number, remainingMs?: () => number): DeviceRuntimeProcessIdentity | null {
    const powershell = canonicalWindowsPowerShellPath();
    if (!powershell) return null;
    const script = windowsProcessIdentityScript(pid);
    const timeout = processIdentityProbeTimeoutMs(remainingMs);
    if (!timeout) return null;
    const result = spawnSync(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", script]), identityProbeOptions(timeout));
    if (result.status !== 0 || !result.stdout?.trim()) return null;
    return parseWindowsProcessIdentity(pid, result.stdout);
}

function windowsProcessIdentityScript(pid: number): string {
    return `$P = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; $H = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($P -and $H) { [pscustomobject]@{ startToken = ${windowsStartTokenExpression("$H")}; commandLine = [string]$P.CommandLine } | ConvertTo-Json -Compress }`;
}

export const windowsProcessIdentityScriptForTest = windowsProcessIdentityScript;

function parseWindowsProcessIdentity(pid: number, output: string): DeviceRuntimeProcessIdentity | null {
    try {
        const parsed = JSON.parse(output) as { startToken?: unknown; commandLine?: unknown };
        return identity(
            pid,
            // Trimmed like the standalone reader trims its stdout. Nothing `o` emits can carry
            // whitespace, so this bites nothing today — but the two paths normalising
            // differently is how a harmless script edit becomes a token mismatch.
            typeof parsed.startToken === "string" ? `windows:${parsed.startToken.trim()}` : null,
            typeof parsed.commandLine === "string" ? parsed.commandLine : null,
        );
    } catch {
        return null;
    }
}

async function windowsProcessIdentityAsync(pid: number, remainingMs?: () => number): Promise<DeviceRuntimeProcessIdentity | null> {
    const powershell = await canonicalWindowsPowerShellPathAsync();
    if (!powershell) return null;
    const output = await execFileText(powershell,
        hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", windowsProcessIdentityScript(pid)]), remainingMs);
    return output ? parseWindowsProcessIdentity(pid, output) : null;
}

function psProcessIdentity(pid: number, platform: NodeJS.Platform, remainingMs?: () => number): DeviceRuntimeProcessIdentity | null {
    const executable = psExecutable(platform);
    const timeout = processIdentityProbeTimeoutMs(remainingMs);
    if (!timeout) return null;
    const command = spawnSync(executable, psArgs(pid, "command="), identityProbeOptions(timeout));
    const commandLine = command.status === 0 ? command.stdout?.trim() : "";
    return identity(pid, psProcessStartToken(pid, platform, remainingMs), commandLine || null);
}

function execFileText(executable: string, args: string[], remainingMs?: () => number): Promise<string> {
    const timeout = processIdentityProbeTimeoutMs(remainingMs);
    if (!timeout) return Promise.resolve("");
    return new Promise((resolve) => {
        execFile(executable, args, {
            ...identityProbeOptions(timeout),
            maxBuffer: 64 * 1024,
        }, (error, stdout) => resolve(error ? "" : stdout?.trim() || ""));
    });
}

async function psProcessIdentityAsync(pid: number, platform: NodeJS.Platform, remainingMs?: () => number): Promise<DeviceRuntimeProcessIdentity | null> {
    const executable = psExecutable(platform);
    const commandLine = await execFileText(executable, psArgs(pid, "command="), remainingMs);
    const startToken = await execFileText(executable, psArgs(pid, "lstart="), remainingMs);
    return identity(pid, startToken ? `ps:${startToken}` : null, commandLine || null);
}

async function linuxProcessIdentityAsync(pid: number, remainingMs?: () => number): Promise<DeviceRuntimeProcessIdentity | null> {
    try {
        const command = linuxCommandLine(await fs.readFile(`/proc/${pid}/cmdline`));
        if (!processIdentityProbeTimeoutMs(remainingMs)) return null;
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        return identity(pid, parseLinuxProcessStartToken(stat), command);
    } catch {
        return null;
    }
}

function readNativeDeviceRuntimeProcessIdentity(pid: unknown, options: ProcessIdentityOptions): DeviceRuntimeProcessIdentity | null {
    if (!validPid(pid) || !processIdentityProbeTimeoutMs(options.remainingMs)) return null;
    const platform = options.platform || process.platform;
    return platform === "linux" ? linuxProcessIdentity(pid, options.remainingMs)
        : platform === "win32" ? windowsProcessIdentity(pid, options.remainingMs)
            : psProcessIdentity(pid, platform, options.remainingMs);
}

export function readDeviceRuntimeProcessIdentity(pid: unknown, options: ProcessIdentityOptions = {}): DeviceRuntimeProcessIdentity | null {
    const current = readNativeDeviceRuntimeProcessIdentity(pid, options);
    return current && processIdentityProbeTimeoutMs(options.remainingMs) ? current : null;
}

async function readNativeDeviceRuntimeProcessIdentityAsync(pid: number, options: ProcessIdentityAsyncOptions): Promise<DeviceRuntimeProcessIdentity | null> {
    const platform = options.platform || process.platform;
    return platform === "linux" ? linuxProcessIdentityAsync(pid, options.remainingMs)
        : platform === "win32" ? windowsProcessIdentityAsync(pid, options.remainingMs)
            : psProcessIdentityAsync(pid, platform, options.remainingMs);
}

export async function readDeviceRuntimeProcessIdentityAsync(pid: unknown, options: ProcessIdentityAsyncOptions = {}): Promise<DeviceRuntimeProcessIdentity | null> {
    if (!validPid(pid) || !processIdentityProbeTimeoutMs(options.remainingMs)) return null;
    const current = await (options.readIdentity || ((value: number) => readNativeDeviceRuntimeProcessIdentityAsync(value, options)))(pid);
    return current && processIdentityProbeTimeoutMs(options.remainingMs) ? current : null;
}

export function deviceRuntimeProcessIdentityMatches(expected: unknown, current: unknown): boolean {
    if (!expected || typeof expected !== "object" || Array.isArray(expected)
        || !current || typeof current !== "object" || Array.isArray(current)) return false;
    const expectedIdentity = expected as Partial<DeviceRuntimeProcessIdentity>;
    const currentIdentity = current as Partial<DeviceRuntimeProcessIdentity>;
    return validPid(expectedIdentity.pid)
        && expectedIdentity.pid === currentIdentity.pid
        && typeof expectedIdentity.startToken === "string"
        && expectedIdentity.startToken === currentIdentity.startToken
        && typeof expectedIdentity.commandHash === "string"
        && expectedIdentity.commandHash === currentIdentity.commandHash;
}

export function probeDeviceRuntimeProcessLiveness(pid: unknown): "alive" | "exited" | "unknown" {
    if (!validPid(pid)) return "unknown";
    try {
        process.kill(pid, 0);
        return "alive";
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : null;
        if (code === "ESRCH") return "exited";
        if (code === "EPERM") return "alive";
        return "unknown";
    }
}

export function inspectDeviceRuntimeProcessIdentity(
    expected: unknown,
    pid: unknown,
    options: ProcessIdentityOptions = {},
): DeviceRuntimeProcessObservation {
    if (!validPid(pid) || !processIdentityProbeTimeoutMs(options.remainingMs)) return { status: "unavailable", current: null, liveness: "unknown" };
    const readIdentity = options.readIdentity || ((value: number) => readNativeDeviceRuntimeProcessIdentity(value, options));
    const current = readIdentity(pid);
    const observation = classifyCurrentIdentity(expected, current, options.remainingMs);
    return observation || inspectMissingIdentity(pid, options);
}

function classifyCurrentIdentity(
    expected: unknown,
    current: DeviceRuntimeProcessIdentity | null,
    remainingMs?: () => number,
): DeviceRuntimeProcessObservation | null {
    const hasTime = processIdentityProbeTimeoutMs(remainingMs) > 0;
    if (current) {
        const matches = deviceRuntimeProcessIdentityMatches(expected, current);
        if (matches && !hasTime) return { status: "unavailable", current: null, liveness: "unknown" };
        return {
            status: matches ? "match" : "mismatch",
            current,
            liveness: "alive",
        };
    }
    if (!hasTime) return { status: "unavailable", current: null, liveness: "unknown" };
    return null;
}

function inspectMissingIdentity(pid: number, options: Pick<ProcessIdentityOptions, "remainingMs" | "probeLiveness">): DeviceRuntimeProcessObservation {
    const liveness = (options.probeLiveness || probeDeviceRuntimeProcessLiveness)(pid);
    if (!processIdentityProbeTimeoutMs(options.remainingMs)) return { status: "unavailable", current: null, liveness: "unknown" };
    return { status: liveness === "exited" ? "exited" : "unavailable", current: null, liveness };
}

export async function inspectDeviceRuntimeProcessIdentityAsync(
    expected: unknown,
    pid: unknown,
    options: ProcessIdentityAsyncOptions = {},
): Promise<DeviceRuntimeProcessObservation> {
    if (!validPid(pid) || !processIdentityProbeTimeoutMs(options.remainingMs)) return { status: "unavailable", current: null, liveness: "unknown" };
    const expectedRecord = expected as Partial<DeviceRuntimeProcessIdentity> | null;
    const saved = expectedRecord && typeof expectedRecord === "object" && !Array.isArray(expectedRecord)
        ? { pid: expectedRecord.pid, startToken: expectedRecord.startToken, commandHash: expectedRecord.commandHash } : expected;
    const readIdentity = options.readIdentity || ((value: number) => readNativeDeviceRuntimeProcessIdentityAsync(value, options));
    const current = await readIdentity(pid);
    const observation = classifyCurrentIdentity(saved, current, options.remainingMs);
    return observation || inspectMissingIdentity(pid, options);
}

function admitRuntimeSignal(runtime: unknown) {
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
        return { refusal: { attempted: false, ok: false, reason: "runtime-process-metadata-missing" } };
    }
    const record = runtime as Record<string, unknown>;
    if (typeof record.runtimeId !== "string" || !validPid(record.pid) || !record.processIdentity) {
        return { refusal: { attempted: false, ok: false, reason: "runtime-process-identity-missing" } };
    }
    return { record: { pid: record.pid, processIdentity: record.processIdentity } };
}

function signalObservedRuntimeProcess(
    pid: number,
    signal: NodeJS.Signals,
    observation: DeviceRuntimeProcessObservation,
    options: Pick<ProcessIdentityOptions, "remainingMs" | "kill">,
) {
    if (observation.status !== "match") {
        if (observation.status === "exited") {
            return { attempted: false, ok: true, stale: true, reason: "runtime-process-exited", observation };
        }
        return {
            attempted: false,
            ok: false,
            reason: observation.status === "mismatch"
                ? "runtime-process-identity-mismatch"
                : "runtime-process-identity-unavailable",
            observation,
        };
    }
    if (!processIdentityProbeTimeoutMs(options.remainingMs)) {
        const unavailable: DeviceRuntimeProcessObservation = { status: "unavailable", current: null, liveness: "unknown" };
        return { attempted: false, ok: false, reason: "runtime-process-identity-unavailable", observation: unavailable };
    }
    try {
        (options.kill || process.kill)(pid, signal);
        return { attempted: true, ok: true, pid, signal };
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : null;
        return {
            attempted: true,
            ok: code === "ESRCH",
            stale: code === "ESRCH",
            pid,
            signal,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export function signalDeviceRuntimeProcess(runtime: unknown, signal: NodeJS.Signals = "SIGINT", options: ProcessIdentityOptions = {}) {
    const admitted = admitRuntimeSignal(runtime);
    if (admitted.refusal) return admitted.refusal;
    const { pid, processIdentity } = admitted.record;
    return signalObservedRuntimeProcess(pid, signal, inspectDeviceRuntimeProcessIdentity(processIdentity, pid, options), options);
}

export async function signalDeviceRuntimeProcessAsync(runtime: unknown, signal: NodeJS.Signals = "SIGINT", options: ProcessIdentityAsyncOptions = {}) {
    const admitted = admitRuntimeSignal(runtime);
    if (admitted.refusal) return admitted.refusal;
    const { pid, processIdentity } = admitted.record;
    const observation = await inspectDeviceRuntimeProcessIdentityAsync(processIdentity, pid, options);
    // No yield between the final allowance check and the caller's authority-checking kill.
    return signalObservedRuntimeProcess(pid, signal, observation, options);
}
