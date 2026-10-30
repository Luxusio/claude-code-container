#!/usr/bin/env node

import { createInstallerApplication } from "./install/application.mjs";
import { errorCode } from "./install/domain.mjs";
import { constants, existsSync, lstatSync, lchownSync, mkdirSync, mkdtempSync, rmdirSync, realpathSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync, chmodSync, cpSync, rmSync, readFileSync, readdirSync, openSync, fstatSync, closeSync } from "fs";
import { createHash } from "crypto";
import { basename, dirname, join, resolve } from "path";
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

/** @typedef {import('./install/ports.mjs').UnixLauncherAlias} UnixLauncherAlias */
/** @typedef {{path:string, stat:import('fs').Stats}} UnixPathReceipt */
/** @typedef {{link:UnixPathReceipt, value:string, parents:UnixPathReceipt[], files:{path:string,stat:import('fs').Stats,hash:string}[]}} UnixNpmAliasReceipt */
/** @type {WeakMap<UnixLauncherAlias, {alias:UnixNpmAliasReceipt,target:UnixPathReceipt,targetParents:UnixPathReceipt[],uid:number}>} */
const unixLauncherAliasReceipts = new WeakMap();

function unixInvokingUid() {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Unix launcher ownership is unavailable.");
    if (uid !== 0 || process.env.SUDO_UID === undefined) return uid;
    const value = process.env.SUDO_UID;
    if (!/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) {
        throw new Error("Unix launcher repair requires a canonical sudo invoking UID.");
    }
    return Number(value);
}

/** @param {import('fs').Stats} before @param {import('fs').Stats} after @param {boolean} [directory] */
function sameUnixEntry(before, after, directory = false) {
    return before.dev === after.dev && before.ino === after.ino && before.uid === after.uid
        && before.gid === after.gid && before.mode === after.mode
        && (directory || before.nlink === after.nlink && before.size === after.size
            && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
}

/** @param {string} path @param {number} uid */
function unixAliasParents(path, uid) {
    /** @type {UnixPathReceipt[]} */
    const parents = [];
    for (let parent = dirname(path);;) {
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, uid].includes(stat.uid)
            || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) {
            throw new Error("Unix launcher parent is not a qualified physical directory.");
        }
        parents.push({path: parent, stat});
        const next = dirname(parent);
        if (next === parent) return parents;
        parent = next;
    }
}

/** @param {string} path @param {number} uid @param {number} maxBytes @param {boolean} [executable] */
function readUnixAliasFile(path, uid, maxBytes, executable = false) {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || ![0, uid].includes(stat.uid) || stat.nlink !== 1 || stat.size < 1
            || stat.size > maxBytes || (stat.mode & 0o6022) !== 0 || executable && (stat.mode & 0o100) === 0) {
            throw new Error("Unix launcher package file is not qualified.");
        }
        const bytes = readFileSync(descriptor);
        if (!sameUnixEntry(stat, fstatSync(descriptor)) || !sameUnixEntry(stat, lstatSync(path))) {
            throw new Error("Unix launcher package file changed during observation.");
        }
        return {path, stat, bytes, hash: createHash("sha256").update(bytes).digest("hex")};
    } finally { closeSync(descriptor); }
}

/** @param {string} path @param {number} uid @returns {UnixNpmAliasReceipt} */
function captureUnixNpmAlias(path, uid) {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink() || stat.uid !== uid || stat.nlink !== 1) throw new Error("Not an invoking-user npm symlink.");
    const value = readlinkSync(path), entry = realpathSync(path), root = dirname(dirname(entry));
    if (entry !== join(root, "dist", "index.js") || basename(root) !== "claude-code-container"
        || basename(dirname(root)) !== "node_modules") throw new Error("Not the exact CCC npm entry.");
    const parents = [...unixAliasParents(path, uid), ...unixAliasParents(entry, uid)];
    const manifest = readUnixAliasFile(join(root, "package.json"), uid, 65536);
    const metadata = JSON.parse(manifest.bytes.toString("utf8"));
    if (metadata.name !== "claude-code-container" || !metadata.bin || typeof metadata.bin !== "object"
        || !["dist/index.js", "./dist/index.js"].includes(metadata.bin.ccc)) throw new Error("Not the declared CCC npm launcher.");
    const executable = readUnixAliasFile(entry, uid, 8 * 1024 * 1024, true);
    if (!sameUnixEntry(stat, lstatSync(path)) || readlinkSync(path) !== value
        || parents.some(parent => !sameUnixEntry(parent.stat, lstatSync(parent.path), true))) {
        throw new Error("Unix npm launcher identity changed during observation.");
    }
    return {link: {path, stat}, value, parents, files: [manifest, executable]};
}

/** @param {string} targetBin @returns {UnixLauncherAlias[]} */
function observeUnixLauncherAliases(targetBin) {
    const target = resolve(targetBin), uid = unixInvokingUid();
    const targetStat = lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error("Published Unix launcher is not a regular file.");
    const pathCandidates = (process.env.PATH || "").split(":").map(directory => resolve(directory || process.cwd(), "ccc"));
    const targetIndex = pathCandidates.findIndex(path => {
        try { return realpathSync(path) === realpathSync(target); } catch { return false; }
    });
    const candidates = [...new Set([join(dirname(process.execPath), "ccc"), ...pathCandidates])];
    /** @type {UnixLauncherAlias[]} */
    const aliases = [];
    for (const path of candidates) {
        if (path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || path === target) continue;
        let stat;
        try { stat = lstatSync(path); } catch (cause) { if (errorCode(cause) === "ENOENT") continue; throw cause; }
        let resolved;
        try { resolved = realpathSync(path); } catch { continue; } // Preserve dangling aliases.
        if (resolved === realpathSync(target)) continue;
        const index = pathCandidates.indexOf(path), preempts = index >= 0 && (targetIndex < 0 || index < targetIndex);
        try {
            const receipt = captureUnixNpmAlias(path, uid);
            // Canonical-only installation needs no alias authority. Qualify
            // this extra boundary only when a known npm link needs publication.
            const targetParents = unixAliasParents(target, uid);
            const alias = {path, kind: /** @type {const} */ ("known-npm"), preempts};
            unixLauncherAliasReceipts.set(alias, {alias: receipt, target: {path: target, stat: targetStat}, targetParents, uid});
            aliases.push(alias);
        } catch {
            if (preempts && (stat.isFile() || stat.isSymbolicLink())) aliases.push({path, kind: "shadowing", preempts});
        }
    }
    return aliases;
}

/** @param {UnixLauncherAlias} observation @param {string} targetBin */
function publishUnixLauncherAlias(observation, targetBin) {
    const receipt = unixLauncherAliasReceipts.get(observation);
    unixLauncherAliasReceipts.delete(observation);
    if (!receipt || observation.kind !== "known-npm" || receipt.alias.link.path !== observation.path
        || receipt.target.path !== resolve(targetBin)) throw new Error("Unix npm launcher publication has no captured receipt.");
    const {alias, target, targetParents, uid} = receipt;
    function revalidate() {
        const current = captureUnixNpmAlias(alias.link.path, uid);
        if (!sameUnixEntry(alias.link.stat, current.link.stat) || current.value !== alias.value
            || current.files.some((file, index) => file.path !== alias.files[index].path
                || file.hash !== alias.files[index].hash || !sameUnixEntry(file.stat, alias.files[index].stat))
            || alias.parents.some(parent => !sameUnixEntry(parent.stat, lstatSync(parent.path), true))
            || targetParents.some(parent => !sameUnixEntry(parent.stat, lstatSync(parent.path), true))
            || !sameUnixEntry(target.stat, lstatSync(target.path))) throw new Error("Captured Unix npm launcher or published target changed.");
    }
    revalidate();
    const guard = `${alias.link.path}.ccc-install-lock`;
    mkdirSync(guard, {mode: 0o700});
    const guardStat = lstatSync(guard), stage = join(guard, "ccc");
    /** @type {import('fs').Stats | undefined} */
    let stageStat;
    try {
        symlinkSync(target.path, stage);
        const created = lstatSync(stage);
        stageStat = created;
        if (created.uid !== alias.link.stat.uid || created.gid !== alias.link.stat.gid) {
            lchownSync(stage, alias.link.stat.uid, alias.link.stat.gid);
        }
        stageStat = lstatSync(stage);
        revalidate();
        if (!sameUnixEntry(guardStat, lstatSync(guard), true) || !sameUnixEntry(stageStat, lstatSync(stage))
            || readlinkSync(stage) !== target.path) throw new Error("Owned Unix launcher stage changed.");
        renameSync(stage, alias.link.path);
    } finally {
        if (!sameUnixEntry(guardStat, lstatSync(guard), true)) throw new Error(`Unix launcher repair guard changed; retained ${guard}.`);
        if (existsSync(stage)) {
            if (!stageStat || !sameUnixEntry(stageStat, lstatSync(stage))) throw new Error(`Unix launcher repair stage changed; retained ${guard}.`);
            unlinkSync(stage);
        }
        rmdirSync(guard);
    }
    return undefined;
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

/** @param {number} uid @param {number} gid */
function recoverSourceBuildOwnership(uid, gid) {
    /** @typedef {{path: string, stat: import("fs").Stats}} Entry */
    /** @type {Entry[][]} */
    const repairs = [];
    /** @param {Entry} entry @param {Entry[]} ancestors @param {boolean} recursive */
    function scan(entry, ancestors, recursive) {
        const { path, stat } = entry;
        if (stat.isSymbolicLink()) return;
        if (stat.uid === 0 && ((!stat.isDirectory() && !stat.isFile())
            || (stat.mode & 0o6000) !== 0 || (stat.isFile() && stat.nlink > 1))) {
            throw new Error(`Cannot recover source build ownership: unsafe root-owned entry ${JSON.stringify(path)}.`);
        }
        if (recursive && stat.isDirectory()) {
            for (const name of readdirSync(path)) {
                const child = join(path, name);
                scan({ path: child, stat: lstatSync(child) }, [...ancestors, entry], true);
            }
        }
        // Children precede parents so earlier repairs do not invalidate ancestor observations.
        if (stat.uid === 0) repairs.push([...ancestors, entry]);
    }
    for (const parts of [["dist"], ["packages", "hyper-v", "dist"], ["packages", "device-lab", "dist"], ["node_modules", "@ccc"]]) {
        /** @type {Entry[]} */
        const ancestors = [];
        let path = projectRoot;
        for (const part of ["", ...parts]) {
            path = join(path, part);
            let stat;
            try {
                stat = lstatSync(path);
            } catch (cause) {
                if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") break;
                throw cause;
            }
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new Error(`Cannot recover source build ownership: expected a physical directory at ${JSON.stringify(path)}.`);
            }
            ancestors.push({ path, stat });
        }
        if (ancestors.length === parts.length + 1) {
            scan(ancestors[ancestors.length - 1], ancestors.slice(0, -1), parts[0] !== "node_modules");
        }
    }
    let completed = 0;
    try {
        for (const chain of repairs) {
            for (const { path, stat } of chain) {
                const current = lstatSync(path);
                if (current.dev !== stat.dev || current.ino !== stat.ino || current.mode !== stat.mode
                    || current.uid !== stat.uid || current.gid !== stat.gid || current.nlink !== stat.nlink) {
                    throw new Error(`Source build ownership entry changed after preflight: ${JSON.stringify(path)}.`);
                }
            }
            lchownSync(chain[chain.length - 1].path, uid, gid);
            completed++;
        }
    } catch (cause) {
        throw new Error(`Cannot recover source build ownership (${completed} ownership updates completed; earlier changes retained): ${nativeFailureDetail(cause)}`, { cause });
    }
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
        case "cli-installed": console.log(`\nCLI installed. Run '${event.command || "ccc"} --help' to verify.`); break;
        case "unix-launcher-alias-updated": console.log(`Updated CCC npm launcher: ${event.path} -> ${event.target}`); break;
        case "unix-launcher-shadowed": console.warn(`CCC launcher at ${event.path} was preserved because its ownership could not be qualified. Use ${event.target} explicitly; this command still precedes it on PATH.`); break;
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
        sourceBuild: () => {
            if (!isWindows && process.getuid?.() === 0
                && (process.env.SUDO_UID !== undefined || process.env.SUDO_GID !== undefined)) {
                const { SUDO_UID: uidText, SUDO_GID: gidText } = process.env;
                const uid = Number(uidText);
                const gid = Number(gidText);
                if (typeof uidText !== "string" || !/^[1-9]\d*$/.test(uidText)
                    || typeof gidText !== "string" || !/^(0|[1-9]\d*)$/.test(gidText)
                    || uid > 2147483647 || gid > 2147483647) {
                    throw new Error("Cannot build source: sudo must provide canonical SUDO_UID (1..2147483647) and SUDO_GID (0..2147483647).");
                }
                recoverSourceBuildOwnership(uid, gid);
                execFileSync(process.execPath, ["-e", `
                    delete process.env.HOME;
                    const home = require("node:os").homedir();
                    if (!home) throw new Error("Cannot resolve the sudo invoking user's home directory.");
                    process.env.HOME = home;
                    for (const key of Object.keys(process.env)) {
                        if (/^npm_config_(cache|userconfig)$/i.test(key)) delete process.env[key];
                    }
                    try {
                        require("node:child_process").execSync("npm run build", { stdio: "inherit" });
                    } catch (cause) {
                        if (typeof cause.status === "number") process.exit(cause.status);
                        throw cause;
                    }
                `], { cwd: projectRoot, stdio: "inherit", uid, gid });
                return;
            }
            execSync("npm run build", { cwd: projectRoot, stdio: "inherit" });
        },
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
        basePath: path => basename(path),
        realPath: path => realpathSync(path),
        pathKind: path => {
            let stat;
            try {
                stat = lstatSync(path);
            } catch (cause) {
                if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return "missing";
                throw cause;
            }
            if (stat.isSymbolicLink()) return "symlink";
            if (stat.isDirectory()) return "directory";
            if (stat.isFile()) return "file";
            return "other";
        },
        createExclusiveDirectory: path => { mkdirSync(path, { mode: 0o700 }); },
        createTemporaryDirectory: prefix => mkdtempSync(prefix),
        removeEmptyDirectory: path => { rmdirSync(path); },
        renamePath: (source, destination) => { renameSync(source, destination); },
        exists: path => existsSync(path),
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
        observeUnixLauncherAliases,
        publishUnixLauncherAlias,
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
    const quotedPaths = [process.execPath, entryPoint].map(path => `'${path.replace(/'/g, "'\\''")}'`);
    return `#!/bin/sh\nexec ${quotedPaths[0]} ${quotedPaths[1]} "$@"\n`;
}

// Node resolves the module URL through symlinks, including macOS /var aliases.
// Compare the same filesystem identity without dispatching an imported module.
let directEntry = false;
try {
    if (process.argv[1]) {
        const invokedPath = realpathSync(process.argv[1]);
        const modulePath = realpathSync(fileURLToPath(import.meta.url));
        directEntry = isWindows ? invokedPath.toLowerCase() === modulePath.toLowerCase() : invokedPath === modulePath;
    }
} catch { /* A missing argv entry cannot name this module. */ }
if (directEntry) {
    const args = process.argv.slice(2);
    if (args.includes("--uninstall") || args.includes("-u")) {
        installerApplication().uninstall();
    } else {
        const [major, minor] = process.versions.node.split(".").map(Number);
        if (major < 20 || (major === 20 && minor < 19)) {
            throw new Error(`CCC installation requires Node.js >=20.19.0 (current: ${process.versions.node}). Run the installer with a supported Node.js version, for example: mise exec node@22 -- npm run install:global.`);
        }
        if (args.includes("--postinstall")) {
            installerApplication().postinstall();
        } else {
            installerApplication().install({ skipImage: args.includes("--skip-image") });
        }
    }
}
