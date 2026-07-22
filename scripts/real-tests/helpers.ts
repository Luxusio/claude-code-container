import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { createServer } from "http";
import { homedir, tmpdir } from "os";
import { join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";

export function repositoryRootFromModuleUrl(moduleUrl: string, options?: Parameters<typeof fileURLToPath>[1]) {
    return fileURLToPath(new URL("../..", moduleUrl), options);
}

export const repoRoot = repositoryRootFromModuleUrl(import.meta.url);
export const stateRoot = resolve(process.env.CCC_LAB_STATE_DIR || "/home/ccc/.ccc/labs");
export const providerEnv = {
    ...process.env,
    CCC_LAB_RUNNER: "1",
    CCC_LAB_RUNNER_STATUS: "ready",
    CCC_LAB_STATE_DIR: stateRoot,
    CCC_LAB_RUNNER_UNSUPPORTED_REASON: process.env.CCC_LAB_RUNNER_UNSUPPORTED_REASON,
};

export function realProviderTempRoot(_options?: unknown) {
    const root = join(repoRoot, "results", ".tmp");
    mkdirSync(root, { recursive: true });
    return root;
}

export function hiddenSpawnSync(command, args = [], options: any = {}) {
    return spawnSync(command, args, {
        ...options,
        windowsHide: true,
    });
}

export function commandPath(command) {
    const result = process.platform === "win32"
        ? spawnSync("where", [command], { encoding: "utf-8", env: process.env, windowsHide: true })
        : spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
            encoding: "utf-8",
            env: process.env,
            windowsHide: true,
        });
    if (result.status !== 0) return windowsAppExecutionAliasPath(command) || androidSdkToolPath(command);
    const firstPath = (result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
    return firstPath || windowsAppExecutionAliasPath(command) || androidSdkToolPath(command);
}

export function localCccPathEnv(env = process.env) {
    const cli = join(repoRoot, "dist", "index.js");
    if (!existsSync(cli)) return { ok: false, reason: "dist/index.js is missing; run npm run build before broker autolaunch E2E" };
    const dir = mkdtempSync(join(tmpdir(), "ccc-real-tests-bin-"));
    if (process.platform === "win32") {
        const shim = join(dir, "ccc.cmd");
        writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
    } else {
        const shim = join(dir, "ccc");
        writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
        chmodSync(shim, 0o755);
    }
    return {
        ok: true,
        source: "local-dist",
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
        env: {
            ...env,
            PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${env.PATH || ""}`,
        },
    };
}

export async function freePort() {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
    return address.port;
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

export function stateRelative(path) {
    const rel = relative(stateRoot, resolve(path));
    if (rel === "" || rel.startsWith("..") || resolve(rel) === rel) return null;
    return rel.split(sep).join("/");
}

export function imageCandidates() {
    return [
        process.env.CCC_REAL_LINUX_VM_IMAGE,
        join(stateRoot, "images", "base.qcow2"),
        join(stateRoot, "images", "linux.qcow2"),
        join(stateRoot, "images", "base.raw"),
        join(stateRoot, "images", "linux.raw"),
    ].filter(Boolean);
}

export function findBaseImage() {
    return imageCandidates().find((candidate) => existsSync(candidate)) || null;
}
