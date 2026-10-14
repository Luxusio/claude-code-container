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

/** @param {unknown} cause */
function nativeFailureDetail(cause) {
    return cause && typeof cause === "object" && "message" in cause ? cause.message : undefined;
}

/** @param {string} installDir */
function manualPathHint(installDir) {
    console.log("Add it manually in PowerShell:");
    console.log(`  [Environment]::SetEnvironmentVariable("Path", ([Environment]::GetEnvironmentVariable("Path","User") + ";${installDir}"), "User")`);
}

/** @param {import("./install/ports.mjs").InstallerEvent} event */
function present(event) {
    switch (event.kind) {
        case "building": console.log("Building..."); break;
        case "runtime-unavailable":
            console.log("No container runtime (podman or docker) detected. Skipping image build.");
            console.log("Install podman or docker, then run 'ccc' to auto-pull/build."); break;
        case "runtime-selected": console.log(`Using container runtime: ${event.runtime}`); break;
        case "image-current": console.log(`Container image up to date (hash: ${event.hash})`); break;
        case "image-rebuilding":
            console.log(`Content changed (${event.previousHash || "none"} -> ${event.hash})`);
            console.log(`Rebuilding container image with ${event.runtime}...`); break;
        case "image-built": console.log("Container image built."); break;
        case "image-build-failed": {
            const detail = nativeFailureDetail(event.cause);
            if (detail === undefined) console.error(`Failed to build image with ${event.runtime}:`);
            else console.error(`Failed to build image with ${event.runtime}:`, detail);
            break;
        }
        case "path-directory-missing": console.log(`PATH update skipped (DIR_NOT_FOUND): ${event.installDir}`); break;
        case "path-read-failed":
            console.log(`PATH update skipped (READ_ERROR): ${nativeFailureDetail(event.cause)}`);
            manualPathHint(event.installDir); break;
        case "path-write-failed":
            console.log(`PATH update skipped (WRITE_ERROR): ${nativeFailureDetail(event.cause)}`);
            manualPathHint(event.installDir); break;
        case "path-too-long":
            console.log(`PATH update skipped (PATH_TOO_LONG): ${event.length} >= ${event.limit}`);
            manualPathHint(event.installDir); break;
        case "path-present": console.log("Already on User PATH."); break;
        case "path-added": console.log("Added to User PATH. Open a new terminal to pick it up."); break;
        case "path-removed": console.log("Removed from User PATH."); break;
        case "installed": console.log(`Installed: ${event.path}`); break;
        case "removed": console.log(`Removed: ${event.path}`); break;
        case "not-installed": console.log("Not installed."); break;
        case "permission-denied":
            console.error("Permission denied. Run with sudo:");
            console.error(`  sudo npm run ${event.operation}:global`); break;
        case "cli-installed": console.log("\nCLI installed. Run 'ccc --help' to verify."); break;
        case "image-ready": console.log("Container image ready."); break;
        case "image-partial-success": console.log("Container image build failed; CLI installation succeeded. Retry the image build when the container runtime is available."); break;
        case "image-skipped": console.log(`Container image build skipped (${event.reason}).`); break;
    }
    return undefined;
}

/** Bind actual synchronous native effects; constructing the application performs none. */
function installerApplication() {
    return createInstallerApplication({
        platform: () => isWindows ? "windows" : "unix",
        sourceRoot: () => projectRoot,
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
            try {
                const result = spawnSync(runtime, args, { cwd: projectRoot, stdio: "inherit", timeout: imageBuildTimeout });
                if (result.error) return { status: "failed", cause: result.error };
                if (result.signal) return { status: "failed", cause: new Error(`${runtime} build terminated by ${result.signal}`) };
                if (result.status !== 0) return {
                    status: "failed",
                    cause: new Error(`${runtime} build ${result.status === null ? "ended without an exit code" : `exited with code ${result.status}`}`),
                };
                return { status: "ready" };
            } catch (cause) {
                return { status: "failed", cause };
            }
        },
        resolvePath: path => resolve(path),
        joinPath: (...parts) => join(...parts),
        parentPath: path => dirname(path),
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
        writeUnixPackage: (sourceRoot, targetDir) => {
            const source = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf-8"));
            writeFileSync(join(targetDir, "package.json"), JSON.stringify({ type: "module", version: source.version, imports: source.imports }, null, 2));
        },
        unixWrapperContent,
        writeUnixLauncher: (path, targetDir) => {
            writeFileSync(path, unixWrapperContent(targetDir));
            chmodSync(path, 0o755);
        },
        writeWindowsLauncher: path => { writeFileSync(path, `@echo off\r\nnode "${distFile}" %*\r\n`); },
        readUserPath,
        writeUserPath: value => { writeUserPath(value); },
        present,
        terminate: code => process.exit(code),
    });
}

/** @param {string} sourceRoot @param {string} targetDir */
export function materializeUnixInstallPayload(sourceRoot, targetDir) {
    return installerApplication().materializeUnixInstallPayload(sourceRoot, targetDir);
}

/** @param {string} targetDir */
export function unixWrapperContent(targetDir) {
    const entryPoint = join(resolve(targetDir), "dist", "index.js");
    return `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(entryPoint).href)});\n`;
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
