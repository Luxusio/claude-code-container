#!/usr/bin/env node

import { createInstallerApplication } from "./install/application.mjs";
import { existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync, chmodSync, cpSync, rmSync, readFileSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execSync, execFileSync, spawnSync } from "child_process";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
// Source installs run before compilation; installed distributions use the embedded
// provider package. Neither form depends on a workspace symlink in node_modules.
const powershellModule = [
    join(projectRoot, "packages", "device-lab", "providers", "state", "windows-system-powershell.mjs"),
    join(projectRoot, "dist", "packages", "device-lab", "providers", "state", "windows-system-powershell.mjs"),
].find(path => existsSync(path));
if (!powershellModule) throw new Error("CCC provider runtime is missing; reinstall the complete package.");
const { canonicalWindowsPowerShellPath, hiddenWindowsPowerShellArgs } = await import(pathToFileURL(powershellModule).href);
const distFile = join(projectRoot, "dist", "index.js");
const isWindows = process.platform === "win32";
const runtimeProbeTimeout = 5000;
const imageBuildTimeout = 20 * 60 * 1000;

function getInstallDir() {
    if (isWindows) {
        const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
        return join(localAppData, "Programs", "ccc");
    } else {
        return "/usr/local/bin";
    }
}

/** @param {readonly string[]} files @param {readonly string[]} directories */
function getContentHash(files, directories) {
    const hash = createHash("sha256");
    for (const f of files) {
        hash.update(readFileSync(join(projectRoot, f)));
    }
    for (const dir of directories) {
        hashDirectory(hash, join(projectRoot, dir));
    }
    return hash.digest("hex").substring(0, 12);
}

/** @param {import("crypto").Hash} hash @param {string} dir */
function hashDirectory(hash, dir) {
    const entries = readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        hash.update(fullPath);
        if (entry.isDirectory()) {
            hashDirectory(hash, fullPath);
        } else if (entry.isFile()) {
            hash.update(readFileSync(fullPath));
        }
    }
}

function trustedWindowsPowerShell() {
    const powershell = canonicalWindowsPowerShellPath();
    if (!powershell) throw new Error("Trusted Windows PowerShell is unavailable");
    return powershell;
}

function readUserPath() {
    const out = execFileSync(trustedWindowsPowerShell(), hiddenWindowsPowerShellArgs([
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command", `[Environment]::GetEnvironmentVariable("Path","User")`,
    ]), { encoding: "utf8", windowsHide: true });
    return out.replace(/\r?\n$/, "");
}

/** @param {string} value */
function writeUserPath(value) {
    execFileSync(trustedWindowsPowerShell(), hiddenWindowsPowerShellArgs([
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command", `[Environment]::SetEnvironmentVariable("Path", $env:__CCC_NEW_PATH, "User")`,
    ]), {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, __CCC_NEW_PATH: value },
    });
}

/** Bind actual synchronous native effects; constructing the application performs none. */
function installerApplication() {
    return createInstallerApplication({
        platform: () => isWindows ? "windows" : "unix",
        sourceRoot: () => projectRoot,
        sourceEntry: () => distFile,
        installDirectory: getInstallDir,
        runtimeOverride: () => process.env.CCC_RUNTIME,
        githubTokenConfigured: () => Boolean(process.env.GITHUB_TOKEN),
        sourceBuild: () => { execSync("npm run build", { cwd: projectRoot, stdio: "inherit" }); },
        contentHash: getContentHash,
        runtimeAvailable: runtime => spawnSync(runtime, ["--version"], {
            encoding: "utf-8",
            timeout: runtimeProbeTimeout,
        }).status === 0,
        imageLabel: (runtime, label) => {
            const result = spawnSync(runtime, [
                "inspect", "ccc", "--format", `{{index .Config.Labels "${label}"}}`,
            ], { encoding: "utf-8", timeout: runtimeProbeTimeout });
            return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
        },
        buildContainer: (runtime, hash, includeGithubSecret) => {
            const args = ["build", "-t", "ccc", "--label", `content.hash=${hash}`];
            if (includeGithubSecret) args.push("--secret", "id=github_token,env=GITHUB_TOKEN");
            args.push(".");
            return spawnSync(runtime, args, { cwd: projectRoot, stdio: "inherit", timeout: imageBuildTimeout });
        },
        resolvePath: path => resolve(path),
        joinPath: (...parts) => join(...parts),
        parentPath: path => dirname(path),
        fileUrl: path => pathToFileURL(path).href,
        exists: path => existsSync(path),
        isSymlink: path => lstatSync(path).isSymbolicLink(),
        removeFile: path => { unlinkSync(path); },
        removeDirectory: (path, force) => {
            if (force) rmSync(path, { recursive: true, force: true });
            else rmSync(path, { recursive: true });
        },
        ensureDirectory: path => { mkdirSync(path, { recursive: true }); },
        copy: (source, target, recursive) => {
            if (recursive) cpSync(source, target, { recursive: true });
            else cpSync(source, target);
        },
        readPackage: path => JSON.parse(readFileSync(path, "utf-8")),
        writeText: (path, content) => { writeFileSync(path, content); },
        setMode: (path, mode) => { chmodSync(path, mode); },
        readUserPath,
        writeUserPath: value => { writeUserPath(value); },
        log: message => { console.log(message); },
        warn: (message, detail) => { console.warn(message, detail); },
        error: (message, detail) => {
            if (detail === undefined) console.error(message);
            else console.error(message, detail);
        },
        terminate: code => process.exit(code),
    });
}

/** @param {string} sourceRoot @param {string} targetDir */
export function materializeUnixInstallPayload(sourceRoot, targetDir) {
    return installerApplication().materializeUnixInstallPayload(sourceRoot, targetDir);
}

/** @param {string} targetDir */
export function unixWrapperContent(targetDir) {
    return installerApplication().unixWrapperContent(targetDir);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath && (isWindows ? invokedPath.toLowerCase() === modulePath.toLowerCase() : invokedPath === modulePath)) {
    const args = process.argv.slice(2);
    if (args.includes("--uninstall") || args.includes("-u")) {
        installerApplication().uninstall();
    } else if (args.includes("--postinstall")) {
        installerApplication().postinstall();
    } else {
        installerApplication().install({ skipImage: args.includes("--skip-image") });
    }
}
