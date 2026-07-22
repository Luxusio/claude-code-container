import { execFile, spawnSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { canonicalWindowsPowerShellPath } from "./windows-system-powershell.js";

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
    readIdentity?: (pid: number) => DeviceRuntimeProcessIdentity | null;
    probeLiveness?: (pid: number) => "alive" | "exited" | "unknown";
    kill?: (pid: number, signal: NodeJS.Signals) => void;
};

function validPid(pid: unknown): pid is number {
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

function identity(pid: number, startToken: string | null, commandLine: string | null): DeviceRuntimeProcessIdentity | null {
    if (!startToken || !commandLine) return null;
    return {
        pid,
        startToken,
        commandHash: createHash("sha256").update(commandLine).digest("hex"),
    };
}

function linuxProcessIdentity(pid: number): DeviceRuntimeProcessIdentity | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const command = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean).join(" ");
        const close = stat.lastIndexOf(")");
        if (close < 0) return null;
        const fields = stat.slice(close + 1).trim().split(/\s+/);
        return identity(pid, fields[19] ? `linux:${fields[19]}` : null, command);
    } catch {
        return null;
    }
}

function windowsProcessIdentity(pid: number): DeviceRuntimeProcessIdentity | null {
    const powershell = canonicalWindowsPowerShellPath();
    if (!powershell) return null;
    const script = windowsProcessIdentityScript(pid);
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout?.trim()) return null;
    return parseWindowsProcessIdentity(pid, result.stdout);
}

function windowsProcessIdentityScript(pid: number): string {
    return `$P = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if ($P) { [pscustomobject]@{ startToken = $P.CreationDate.ToUniversalTime().ToString('o'); commandLine = [string]$P.CommandLine } | ConvertTo-Json -Compress }`;
}

function parseWindowsProcessIdentity(pid: number, output: string): DeviceRuntimeProcessIdentity | null {
    try {
        const parsed = JSON.parse(output) as { startToken?: unknown; commandLine?: unknown };
        return identity(
            pid,
            typeof parsed.startToken === "string" ? `windows:${parsed.startToken}` : null,
            typeof parsed.commandLine === "string" ? parsed.commandLine : null,
        );
    } catch {
        return null;
    }
}

function windowsProcessIdentityAsync(pid: number): Promise<DeviceRuntimeProcessIdentity | null> {
    return new Promise((resolve) => {
        const powershell = canonicalWindowsPowerShellPath();
        if (!powershell) {
            resolve(null);
            return;
        }
        execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", windowsProcessIdentityScript(pid)], {
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true,
            maxBuffer: 64 * 1024,
        }, (error, stdout) => {
            resolve(error || !stdout?.trim() ? null : parseWindowsProcessIdentity(pid, stdout));
        });
    });
}

function psProcessIdentity(pid: number, platform: NodeJS.Platform): DeviceRuntimeProcessIdentity | null {
    const executable = platform === "darwin" ? "/bin/ps" : "ps";
    const started = spawnSync(executable, ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const command = spawnSync(executable, ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const startToken = started.status === 0 ? started.stdout?.trim() : "";
    const commandLine = command.status === 0 ? command.stdout?.trim() : "";
    return identity(pid, startToken ? `ps:${startToken}` : null, commandLine || null);
}

function execFileText(executable: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
        execFile(executable, args, {
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true,
            maxBuffer: 64 * 1024,
        }, (error, stdout) => resolve(error ? "" : stdout?.trim() || ""));
    });
}

async function psProcessIdentityAsync(pid: number, platform: NodeJS.Platform): Promise<DeviceRuntimeProcessIdentity | null> {
    const executable = platform === "darwin" ? "/bin/ps" : "ps";
    const [startToken, commandLine] = await Promise.all([
        execFileText(executable, ["-p", String(pid), "-o", "lstart="]),
        execFileText(executable, ["-p", String(pid), "-o", "command="]),
    ]);
    return identity(pid, startToken ? `ps:${startToken}` : null, commandLine || null);
}

export function readDeviceRuntimeProcessIdentity(pid: unknown, options: ProcessIdentityOptions = {}): DeviceRuntimeProcessIdentity | null {
    if (!validPid(pid)) return null;
    const platform = options.platform || process.platform;
    if (platform === "linux") return linuxProcessIdentity(pid);
    if (platform === "win32") return windowsProcessIdentity(pid);
    return psProcessIdentity(pid, platform);
}

export async function readDeviceRuntimeProcessIdentityAsync(pid: unknown): Promise<DeviceRuntimeProcessIdentity | null> {
    if (!validPid(pid)) return null;
    if (process.platform === "win32") return windowsProcessIdentityAsync(pid);
    if (process.platform === "linux") return readDeviceRuntimeProcessIdentity(pid);
    return psProcessIdentityAsync(pid, process.platform);
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
    if (!validPid(pid)) return { status: "unavailable", current: null, liveness: "unknown" };
    const readIdentity = options.readIdentity || ((value: number) => readDeviceRuntimeProcessIdentity(value, options));
    const current = readIdentity(pid);
    if (current) {
        return {
            status: deviceRuntimeProcessIdentityMatches(expected, current) ? "match" : "mismatch",
            current,
            liveness: "alive",
        };
    }
    const liveness = (options.probeLiveness || probeDeviceRuntimeProcessLiveness)(pid);
    return { status: liveness === "exited" ? "exited" : "unavailable", current: null, liveness };
}

export function signalDeviceRuntimeProcess(runtime: unknown, signal: NodeJS.Signals = "SIGINT", options: ProcessIdentityOptions = {}) {
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
        return { attempted: false, ok: false, reason: "runtime-process-metadata-missing" };
    }
    const record = runtime as Record<string, unknown>;
    if (typeof record.runtimeId !== "string" || !validPid(record.pid) || !record.processIdentity) {
        return { attempted: false, ok: false, reason: "runtime-process-identity-missing" };
    }
    const observation = inspectDeviceRuntimeProcessIdentity(record.processIdentity, record.pid, options);
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
    try {
        (options.kill || process.kill)(record.pid, signal);
        return { attempted: true, ok: true, pid: record.pid, signal };
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : null;
        return {
            attempted: true,
            ok: code === "ESRCH",
            stale: code === "ESRCH",
            pid: record.pid,
            signal,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
