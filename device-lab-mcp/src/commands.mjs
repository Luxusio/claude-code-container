import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { DISPLAY, PACKAGE_ROOT } from "./context.mjs";
import { hiddenWindowsPowerShellArgs } from "./state/windows-system-powershell.mjs";

export const DEVICE_COMMAND_TIMEOUT_MS = 120_000;
export const DEVICE_COMMAND_MAX_TIMEOUT_MS = 600_000;
export const DEVICE_COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
export const DEVICE_COMMAND_MAX_BUFFER_LIMIT_BYTES = 64 * 1024 * 1024;
export const DEVICE_COMMAND_DISCOVERY_TIMEOUT_MS = 5_000;

function boundedPositiveInteger(value, fallback, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(Math.max(1, Math.trunc(parsed)), maximum);
}

function textCommandOptions(options = {}) {
    return {
        encoding: "utf-8",
        env: { ...process.env, DISPLAY, ...(options.env || {}) },
        timeout: boundedPositiveInteger(options.timeout, DEVICE_COMMAND_TIMEOUT_MS, DEVICE_COMMAND_MAX_TIMEOUT_MS),
        maxBuffer: boundedPositiveInteger(options.maxBuffer, DEVICE_COMMAND_MAX_BUFFER_BYTES, DEVICE_COMMAND_MAX_BUFFER_LIMIT_BYTES),
        windowsHide: true,
    };
}

function quoteWindowsCommandArg(value) {
    if (!/[ \t"&|<>^]/.test(value)) return value;
    return `"${String(value).replace(/(["^&|<>])/g, "^$1")}"`;
}

function spawnInvocation(cmd, args = []) {
    if (process.platform === "win32" && /^(?:powershell|pwsh)(?:\.exe)?$/i.test(String(cmd).split(/[\\/]/).at(-1) || "")) {
        return { cmd, args: hiddenWindowsPowerShellArgs(args) };
    }
    if (process.platform === "win32" && /\.(bat|cmd)$/i.test(String(cmd))) {
        const commandLine = [quoteWindowsCommandArg(cmd), ...args.map(quoteWindowsCommandArg)].join(" ");
        return { cmd: "cmd.exe", args: ["/d", "/s", "/c", commandLine] };
    }
    return { cmd, args };
}

export function run(cmd, args, options = {}) {
    const invocation = spawnInvocation(cmd, args);
    return spawnSync(invocation.cmd, invocation.args, textCommandOptions(options));
}

export function runWithTimeout(cmd, args, timeoutMs, options = {}) {
    const invocation = spawnInvocation(cmd, args);
    return spawnSync(invocation.cmd, invocation.args, textCommandOptions({ ...options, timeout: timeoutMs }));
}

export function runWithInput(cmd, args, input, options = {}) {
    const invocation = spawnInvocation(cmd, args);
    return spawnSync(invocation.cmd, invocation.args, {
        ...textCommandOptions(options),
        input,
    });
}

export function runBuffer(cmd, args, options = {}) {
    const invocation = spawnInvocation(cmd, args);
    return spawnSync(invocation.cmd, invocation.args, {
        env: { ...process.env, DISPLAY },
        timeout: boundedPositiveInteger(options.timeout, DEVICE_COMMAND_TIMEOUT_MS, DEVICE_COMMAND_MAX_TIMEOUT_MS),
        maxBuffer: boundedPositiveInteger(options.maxBuffer, DEVICE_COMMAND_MAX_BUFFER_BYTES, DEVICE_COMMAND_MAX_BUFFER_LIMIT_BYTES),
        windowsHide: true,
    });
}

export function commandPath(command) {
    if (typeof command !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(command)) return null;
    const discoveryOptions = {
        encoding: "utf-8",
        env: process.env,
        timeout: DEVICE_COMMAND_DISCOVERY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
    };
    const result = process.platform === "win32"
        ? spawnSync("where", [command], discoveryOptions)
        : spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
            ...discoveryOptions,
        });
    if (result.status !== 0) return windowsAppExecutionAliasPath(command) || androidSdkToolPath(command);
    const firstPath = (result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
    return firstPath || windowsAppExecutionAliasPath(command) || androidSdkToolPath(command);
}

function windowsAppExecutionAliasPath(command) {
    if (process.platform !== "win32") return null;
    const executableNames = /\.(exe|bat|cmd)$/i.test(command)
        ? [command]
        : [command, `${command}.exe`, `${command}.bat`, `${command}.cmd`];
    const roots = [
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps") : null,
        process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Local", "Microsoft", "WindowsApps") : null,
        join(homedir(), "AppData", "Local", "Microsoft", "WindowsApps"),
    ].filter(Boolean);
    for (const root of [...new Set(roots)]) {
        for (const executable of executableNames) {
            const candidate = join(root, executable);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

function androidSdkToolPath(command) {
    const executableNames = process.platform === "win32" && !/\.(exe|bat|cmd)$/i.test(command)
        ? [command, `${command}.exe`, `${command}.bat`, `${command}.cmd`]
        : [command];
    for (const sdk of androidSdkCandidates()) {
        const subdirs = androidToolSubdirs(sdk, command);
        for (const subdir of subdirs) {
            for (const executable of executableNames) {
                const candidate = join(sdk, subdir, executable);
                if (existsSync(candidate)) return candidate;
            }
        }
    }
    return null;
}

function androidSdkCandidates() {
    return [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : null,
        process.env.APPDATA ? join(process.env.APPDATA, "Android", "Sdk") : null,
        join(homedir(), "AppData", "Local", "Android", "Sdk"),
        join(homedir(), "Android", "Sdk"),
        join(homedir(), "Library", "Android", "sdk"),
        "/opt/android-sdk",
        "/usr/local/android-sdk",
    ].filter(Boolean);
}

function androidToolSubdirs(sdk, command) {
    if (command === "adb") return ["platform-tools"];
    if (command === "emulator") return ["emulator"];
    if (command === "avdmanager") {
        const versioned = [];
        try {
            for (const entry of readdirSync(join(sdk, "cmdline-tools"), { withFileTypes: true })) {
                if (entry.isDirectory()) versioned.push(`cmdline-tools/${entry.name}/bin`);
            }
        } catch {
            // Android command-line tools are optional.
        }
        return ["cmdline-tools/latest/bin", ...versioned, "cmdline-tools/bin", "tools/bin"];
    }
    return [];
}

export function localBinPath(command) {
    const candidates = [
        join(PACKAGE_ROOT, "node_modules/.bin", command),
        join(PACKAGE_ROOT, "../device-lab-mcp/node_modules/.bin", command),
        join(process.cwd(), "device-lab-mcp/node_modules/.bin", command),
    ];
    return candidates.find((candidate) => existsSync(candidate)) || null;
}
