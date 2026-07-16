#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync, chmodSync, cpSync, rmSync, readFileSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execSync, execFileSync, spawnSync } from "child_process";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const distFile = join(projectRoot, "dist", "index.js");
const isWindows = process.platform === "win32";

function getInstallDir() {
    if (isWindows) {
        const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
        return join(localAppData, "Programs", "ccc");
    } else {
        return "/usr/local/bin";
    }
}

function getContentHash() {
    const files = [
        "Dockerfile",
        "Containerfile",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "scripts/clipboard-shims/xclip",
        "scripts/clipboard-shims/xsel",
        "scripts/clipboard-shims/wl-paste",
        "scripts/clipboard-shims/wl-copy",
        "scripts/clipboard-shims/pbpaste",
    ];
    const hash = createHash("sha256");
    for (const f of files) {
        hash.update(readFileSync(join(projectRoot, f)));
    }
    for (const dir of ["src", "scripts", "x11-mcp", "device-lab-mcp"]) {
        hashDirectory(hash, join(projectRoot, dir));
    }
    return hash.digest("hex").substring(0, 12);
}

function hashDirectory(hash, dir) {
    const entries = readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        hash.update(fullPath);
        if (entry.isDirectory()) {
            hashDirectory(hash, fullPath);
        } else if (entry.isFile()) {
            hash.update(readFileSync(fullPath));
        }
    }
}

// Detect available container runtime. Mirrors src/container-runtime.ts:
// prefer Podman, fall back to Docker. Honours CCC_RUNTIME override.
function detectRuntime() {
    const env = process.env.CCC_RUNTIME;
    if (env === "docker" || env === "podman") return env;
    for (const name of ["podman", "docker"]) {
        const r = spawnSync(name, ["--version"], { encoding: "utf-8" });
        if (r.status === 0) return name;
    }
    return null;
}

function getImageHash(runtime) {
    if (!runtime) return null;
    try {
        for (const label of ["content.hash", "dockerfile.hash"]) {
            const result = spawnSync(runtime, [
                "inspect", "ccc",
                "--format", `{{index .Config.Labels "${label}"}}`
            ], { encoding: "utf-8" });
            if (result.status === 0 && result.stdout.trim()) {
                return result.stdout.trim();
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

function build() {
    console.log("Building...");
    execSync("npm run build", { cwd: projectRoot, stdio: "inherit" });
}

function buildImage() {
    const runtime = detectRuntime();
    if (!runtime) {
        console.log("No container runtime (podman or docker) detected. Skipping image build.");
        console.log("Install podman or docker, then run 'ccc' to auto-pull/build.");
        return;
    }
    console.log(`Using container runtime: ${runtime}`);

    const currentHash = getContentHash();
    const imageHash = getImageHash(runtime);
    if (currentHash === imageHash) {
        console.log(`Container image up to date (hash: ${currentHash})`);
        return;
    }
    console.log(`Content changed (${imageHash || "none"} -> ${currentHash})`);
    console.log(`Rebuilding container image with ${runtime}...`);
    try {
        const buildArgs = ["build", "-t", "ccc", "--label", `content.hash=${currentHash}`];
        if (process.env.GITHUB_TOKEN) {
            buildArgs.push("--secret", `id=github_token,env=GITHUB_TOKEN`);
        }
        buildArgs.push(".");
        const buildResult = spawnSync(runtime, buildArgs, { cwd: projectRoot, stdio: "inherit" });
        if (buildResult.status !== 0) {
            throw new Error(`${runtime} build exited with code ${buildResult.status}`);
        }
        console.log("Container image built.");
    } catch (e) {
        console.error(`Failed to build image with ${runtime}:`, e.message);
    }
}

// Windows User-scope PATH I/O.
//
// We deliberately do NOT use `process.env.PATH` — that's the merged
// (User + System) view of the current process and writing to it can't
// persist. Instead we shell out to PowerShell purely for the two
// primitives `.NET` already exposes for the User scope:
//   - read:  [Environment]::GetEnvironmentVariable("Path", "User")
//   - write: [Environment]::SetEnvironmentVariable("Path", $v, "User")
//
// The new value is passed via an env var ($env:__CCC_NEW_PATH) so there's
// no PowerShell-side quoting at all — backslashes and quotes round-trip
// untouched. All parsing, dedupe, length-checks live in Node below.

const PATH_LIMIT = 32767;

function readUserPath() {
    const out = execFileSync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command", `[Environment]::GetEnvironmentVariable("Path","User")`,
    ], { encoding: "utf8", windowsHide: true });
    return out.replace(/\r?\n$/, "");
}

function writeUserPath(value) {
    execFileSync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command", `[Environment]::SetEnvironmentVariable("Path", $env:__CCC_NEW_PATH, "User")`,
    ], {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, __CCC_NEW_PATH: value },
    });
}

function normalizePathEntry(p) {
    return p.trim().replace(/[\\/]+$/, "").toLowerCase();
}

function splitUserPath(p) {
    return (p || "").split(";").filter(s => s.trim() !== "");
}

function manualPathHint(installDir) {
    console.log("Add it manually in PowerShell:");
    console.log(`  [Environment]::SetEnvironmentVariable("Path", ([Environment]::GetEnvironmentVariable("Path","User") + ";${installDir}"), "User")`);
}

function tryAddInstallDirToUserPath(installDir) {
    if (!existsSync(installDir)) {
        console.log(`PATH update skipped (DIR_NOT_FOUND): ${installDir}`);
        return;
    }
    let current;
    try {
        current = readUserPath();
    } catch (e) {
        console.log(`PATH update skipped (READ_ERROR): ${e.message}`);
        manualPathHint(installDir);
        return;
    }
    const parts = splitUserPath(current);
    const target = normalizePathEntry(installDir);
    if (parts.some(p => normalizePathEntry(p) === target)) {
        console.log("Already on User PATH.");
        return;
    }
    const next = [...parts, installDir].join(";");
    if (next.length >= PATH_LIMIT) {
        console.log(`PATH update skipped (PATH_TOO_LONG): ${next.length} >= ${PATH_LIMIT}`);
        manualPathHint(installDir);
        return;
    }
    try {
        writeUserPath(next);
        console.log("Added to User PATH. Open a new terminal to pick it up.");
    } catch (e) {
        console.log(`PATH update skipped (WRITE_ERROR): ${e.message}`);
        manualPathHint(installDir);
    }
}

function tryRemoveInstallDirFromUserPath(installDir) {
    let current;
    try {
        current = readUserPath();
    } catch {
        return; // best-effort during uninstall
    }
    const parts = splitUserPath(current);
    const target = normalizePathEntry(installDir);
    const kept = parts.filter(p => normalizePathEntry(p) !== target);
    if (kept.length === parts.length) return;
    try {
        writeUserPath(kept.join(";"));
        console.log("Removed from User PATH.");
    } catch {
        // best-effort
    }
}

function linkBinary() {
    const installDir = getInstallDir();

    if (isWindows) {
        mkdirSync(installDir, { recursive: true });
        const cmdPath = join(installDir, "ccc.cmd");
        const cmdContent = `@echo off\r\nnode "${distFile}" %*\r\n`;
        writeFileSync(cmdPath, cmdContent);
        console.log(`Installed: ${cmdPath}`);

        tryAddInstallDirToUserPath(installDir);
        return;
    }

    const targetDir = join(installDir, "ccc-dist");
    const targetBin = join(installDir, "ccc");
    try {
        try {
            const stat = lstatSync(targetBin);
            if (stat.isSymbolicLink()) unlinkSync(targetBin);
        } catch (e) {
            if (e.code !== "ENOENT") throw e;
        }

        if (existsSync(targetDir)) rmSync(targetDir, { recursive: true });
        cpSync(join(projectRoot, "dist"), targetDir, { recursive: true });
        cpSync(join(projectRoot, "Dockerfile"), join(targetDir, "Dockerfile"));
        cpSync(join(projectRoot, "Containerfile"), join(targetDir, "Containerfile"));
        cpSync(join(projectRoot, "scripts"), join(targetDir, "scripts"), { recursive: true });

        const srcPkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
        const pkgContent = JSON.stringify({ type: "module", version: srcPkg.version }, null, 2);
        writeFileSync(join(targetDir, "package.json"), pkgContent);

        const wrapperContent = `#!/usr/bin/env node
import("${targetDir}/index.js");
`;
        writeFileSync(targetBin, wrapperContent);
        chmodSync(targetBin, 0o755);
        console.log(`Installed: ${targetBin}`);
    } catch (e) {
        if (e.code === "EACCES") {
            console.error("Permission denied. Run with sudo:");
            console.error("  sudo npm run install:global");
            process.exit(1);
        }
        throw e;
    }
}

function install() {
    build();
    buildImage();
    linkBinary();
    console.log("\nDone! Run 'ccc --help' to verify.");
}

function postinstall() {
    // npm runs this after `npm install`. Do NOT recurse into `npm install` here.
    // In the source repo, dev will run `npm run install:global` for /usr/local/bin.
    // When installed as a global package, npm already wires the `bin` field.
    // We only build dist/ so the package is usable out of the box.
    const inNodeModules = projectRoot.includes(`${"node_modules"}${isWindows ? "\\" : "/"}`);
    if (inNodeModules) {
        // Global/local npm install: dist/ is shipped in the tarball, skip build.
        return;
    }
    // Source repo after plain `npm install`: ensure dist/ is fresh.
    try {
        build();
    } catch (e) {
        console.warn("Build skipped:", e.message);
    }
}

function uninstall() {
    const installDir = getInstallDir();

    if (isWindows) {
        const cmdPath = join(installDir, "ccc.cmd");
        if (existsSync(cmdPath)) {
            unlinkSync(cmdPath);
            console.log(`Removed: ${cmdPath}`);
        } else {
            console.log("Not installed.");
        }
        tryRemoveInstallDirFromUserPath(installDir);
        return;
    }

    const targetDir = join(installDir, "ccc-dist");
    const targetBin = join(installDir, "ccc");
    try {
        let removed = false;
        if (existsSync(targetBin)) {
            unlinkSync(targetBin);
            console.log(`Removed: ${targetBin}`);
            removed = true;
        }
        if (existsSync(targetDir)) {
            rmSync(targetDir, { recursive: true });
            console.log(`Removed: ${targetDir}`);
            removed = true;
        }
        if (!removed) console.log("Not installed.");
    } catch (e) {
        if (e.code === "EACCES") {
            console.error("Permission denied. Run with sudo:");
            console.error("  sudo npm run uninstall:global");
            process.exit(1);
        }
        throw e;
    }
}

const args = process.argv.slice(2);
if (args.includes("--uninstall") || args.includes("-u")) {
    uninstall();
} else if (args.includes("--postinstall")) {
    postinstall();
} else {
    install();
}
