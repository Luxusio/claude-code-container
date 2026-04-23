#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync, readFileSync, readdirSync, symlinkSync, copyFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve, basename } from "path";
import { fileURLToPath } from "url";
import { execSync, spawnSync } from "child_process";
import { homedir } from "os";

import {
    ensureNode,
    ensureRust,
    ensureSystemDeps,
    getRustTriple,
    installedUiBinPaths,
    isPostinstallMode,
    getExecutionMode,
    buildElevatedCommand,
    buildUserCommand,
    cleanUiDepsForFreshInstall,
    ensureTauriCliPlatformBinding,
    sidecarBinPaths,
} from "./ui-toolchain.js";

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
    for (const dir of ["src", "scripts"]) {
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
        // Try new label first, fall back to old label for backward compat
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
        return null; // Image doesn't exist
    }
}

// ─── PRIVILEGE HELPERS ───────────────────────────────────────────────────────

/**
 * preauth(mode) — in "user" mode, run `sudo -v` once so the user types their
 * password up front and subsequent sudo calls reuse the timestamp. No-op
 * otherwise.
 */
function preauth(mode) {
    if (mode !== "user") return;
    console.log("Requesting sudo credentials for /usr/local/bin writes...");
    const result = spawnSync("sudo", ["-v"], { stdio: "inherit" });
    if (result.status !== 0) {
        throw new Error("sudo -v failed — cannot proceed without elevated privileges for /usr/local/bin writes.");
    }
}

/**
 * spawnElevated(mode, cmd, args, opts) — run cmd with /usr/local/bin write
 * privileges. In "user" mode, prepends sudo. In already-root modes, runs
 * directly. Throws on non-zero exit.
 */
function spawnElevated(mode, cmd, args, opts = {}) {
    const wrapped = buildElevatedCommand(cmd, args, mode);
    console.log(`  Running: ${wrapped.cmd} ${wrapped.args.join(" ")}`);
    const result = spawnSync(wrapped.cmd, wrapped.args, { stdio: "inherit", ...opts });
    if (result.error) {
        throw new Error(`Failed to spawn '${wrapped.cmd}': ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`'${wrapped.cmd} ${wrapped.args.join(" ")}' exited with code ${result.status}`);
    }
}

// ─── UI BUILD CHAIN ─────────────────────────────────────────────────────────

/**
 * runPhase(name, fn) — execute fn(); on any throw, print the error with the
 * phase name and re-throw (so the caller can decide exit vs. warn).
 */
function runPhase(name, fn) {
    console.log(`\n[UI] ${name}...`);
    try {
        fn();
    } catch (e) {
        console.error(`\n[UI] FAILED: ${name}`);
        console.error(e.message || e);
        throw e;
    }
    console.log(`[UI] ${name} — done`);
}

/**
 * spawnPhase(name, cmd, args, opts) — like runPhase but spawns a child
 * process and checks its exit code. Accepts optional asUser and mode in opts
 * to drop privileges for cargo/npm when running as root via sudo.
 */
function spawnPhase(name, cmd, args, opts = {}) {
    runPhase(name, () => {
        let actualCmd = cmd;
        let actualArgs = args;
        if (opts.asUser) {
            const mode = opts.mode ?? getExecutionMode();
            const sudoUser = process.env.SUDO_USER;
            const wrapped = buildUserCommand(cmd, args, mode, sudoUser);
            actualCmd = wrapped.cmd;
            actualArgs = wrapped.args;
        }
        console.log(`  Running: ${actualCmd} ${actualArgs.join(" ")}`);
        const spawnOpts = { stdio: "inherit", ...opts };
        // Strip non-spawnSync keys
        delete spawnOpts.asUser;
        delete spawnOpts.mode;
        const result = spawnSync(actualCmd, actualArgs, spawnOpts);
        if (result.error) {
            throw new Error(`Failed to spawn '${actualCmd}': ${result.error.message}`);
        }
        if (result.status !== 0) {
            throw new Error(`'${actualCmd} ${actualArgs.join(" ")}' exited with code ${result.status}`);
        }
    });
}

function installUi(mode) {
    const uiDir = join(projectRoot, "ui");
    const sidecarDir = join(uiDir, "src-sidecar");

    // Phase 1: Verify Node version
    runPhase("Verify Node.js >= 22", () => ensureNode());

    // Phase 2: Ensure Rust toolchain
    runPhase("Ensure Rust toolchain (cargo)", () => ensureRust());

    // Phase 3: System deps
    runPhase(`Ensure system deps (${process.platform})`, () => ensureSystemDeps(process.platform));

    // Phase 4: Build sidecar (release profile) — run as unprivileged user
    spawnPhase("Build sidecar (cargo build --release)", "cargo", ["build", "--release"], {
        cwd: sidecarDir,
        asUser: true,
        mode,
    });

    // Phase 5: Create triple-suffixed symlink/copy for Tauri externalBin
    runPhase("Create Tauri externalBin triple symlink", () => {
        const triple = getRustTriple();
        const releaseDir = join(sidecarDir, "target", "release");
        const { srcBin, destBin } = sidecarBinPaths(releaseDir, triple);

        if (!existsSync(srcBin)) {
            throw new Error(`Sidecar binary not found at: ${srcBin}`);
        }

        // Remove old symlink/file if it exists
        if (existsSync(destBin)) {
            try { unlinkSync(destBin); } catch (_) {}
        }

        // Try symlink first, fall back to copy (Windows)
        try {
            symlinkSync(srcBin, destBin);
            console.log(`  Symlink: ${basename(destBin)} -> ${basename(srcBin)}`);
        } catch (_) {
            copyFileSync(srcBin, destBin);
            console.log(`  Copied: ${basename(destBin)}`);
        }
    });

    // Phase 6a: Pre-clean to work around npm/cli#4828 (platform-specific
    // optional dependency resolution for native bindings like
    // @tauri-apps/cli-win32-x64-msvc). Without this, npm on Windows may
    // skip installing the platform binding that matches the committed
    // lockfile's host, and Phase 7 fails at @tauri-apps/cli load time.
    runPhase("Pre-clean ui deps (npm/cli#4828)", () => {
        const result = cleanUiDepsForFreshInstall(uiDir);
        if (result.removedNodeModules) console.log("  Removed: ui/node_modules");
        if (result.removedLockfile)    console.log("  Removed: ui/package-lock.json");
        if (!result.removedNodeModules && !result.removedLockfile) {
            console.log("  No existing ui/node_modules or ui/package-lock.json — skipped");
        }
    });

    // Phase 6: Install UI frontend deps — run as unprivileged user
    // --include=optional overrides omit=optional npm config / NPM_CONFIG_OMIT env (npm/cli#4828 variant 2)
    // --os / --cpu override user ~/.npmrc `os` / `cpu` fields at the resolver level (npm/cli#4828 variant 3)
    // --cache: isolate from user global ~/.npm cache (root-owned entries from past sudo cause EACCES)
    const isolatedCache = join(uiDir, "node_modules", ".npm-cache");
    mkdirSync(isolatedCache, { recursive: true });
    spawnPhase("Install UI frontend dependencies (npm install)", "npm",
        [
            "install",
            "--include=optional",
            `--os=${process.platform}`,
            `--cpu=${process.arch}`,
            "--cache", isolatedCache,
        ],
        { cwd: uiDir, asUser: true, mode }
    );

    // Phase 6b: Verify platform binding is installed (npm/cli#4828 variant 2).
    // Some environments suppress optional deps globally via `omit=optional` npm
    // config or NPM_CONFIG_OMIT env. --include=optional above usually overrides
    // that, but we verify and fall back to a direct install if the binding is
    // still missing.
    runPhase("Verify @tauri-apps/cli platform binding (npm/cli#4828)", () => {
        ensureTauriCliPlatformBinding(uiDir);
    });

    // Phase 7: Build Tauri main binary via tauri CLI (--debug --no-bundle).
    // tauri build --debug sets the production compile flag (runtime loads frontendDist, not devUrl).
    // --no-bundle skips .app/.dmg/.deb/.msi packaging (the slow part).
    // beforeBuildCommand in tauri.conf.json runs "npm run build" (Vite) automatically before cargo.
    spawnPhase("Build Tauri main (tauri build --debug --no-bundle)", "npm", ["run", "tauri", "--", "build", "--debug", "--no-bundle"], {
        cwd: uiDir,
        asUser: true,
        mode,
    });

    // Phase 8: Install the resulting native binary
    runPhase("Install ccc-ui binary", () => {
        const paths = installedUiBinPaths(process.platform);

        if (isWindows) {
            // Windows path — direct fs calls, no sudo wrapping
            mkdirSync(paths.binDir, { recursive: true });
            // Find the built .exe in Tauri's debug output (cargo build, not tauri build)
            const standaloneExe = join(uiDir, "src-tauri", "target", "debug", "ccc-ui.exe");
            const destExe = join(paths.binDir, "ccc-ui.exe");
            if (existsSync(standaloneExe)) {
                copyFileSync(standaloneExe, destExe);
                console.log(`  Copied: ${standaloneExe} -> ${destExe}`);
            }
            // Write cmd shim
            const cmdContent = `@echo off\r\n"${destExe}" %*\r\n`;
            writeFileSync(paths.binPath, cmdContent);
            console.log(`  Installed cmd shim: ${paths.binPath}`);
        } else {
            // POSIX: find the raw binary in tauri debug output
            const tauriDebugDir = join(uiDir, "src-tauri", "target", "debug");

            // cargo build produces the binary at target/debug/<Cargo.toml [[bin]] name>
            // Cargo.toml in ui/src-tauri declares `name = "ccc-ui"` so the output is `target/debug/ccc-ui`.
            // (tauri.conf.json productName = "ccc" is only used by the tauri bundler, which we skip.)
            const appBin = join(tauriDebugDir, "ccc-ui");

            if (!existsSync(appBin)) {
                throw new Error(
                    `Tauri debug binary not found at: ${appBin}\n` +
                    "Ensure 'cargo build' (debug) completed successfully."
                );
            }

            // Create distDir with sudo
            spawnElevated(mode, "mkdir", ["-p", paths.distDir]);

            // Copy binary with sudo cp
            const destBin = join(paths.distDir, "ccc-ui");
            spawnElevated(mode, "cp", [appBin, destBin]);
            spawnElevated(mode, "chmod", ["755", destBin]);
            console.log(`  Copied: ${appBin} -> ${destBin}`);

            // Write wrapper to a temp file, then sudo mv it to binPath
            const tmpWrapper = join(projectRoot, ".tmp-ccc-ui-wrapper");
            const wrapperContent = `#!/bin/sh\nexec "${destBin}" "$@"\n`;
            writeFileSync(tmpWrapper, wrapperContent);
            try {
                spawnElevated(mode, "mv", [tmpWrapper, paths.binPath]);
                spawnElevated(mode, "chmod", ["755", paths.binPath]);
                console.log(`  Installed: ${paths.binPath}`);
            } finally {
                // Clean up the temp file if mv failed
                if (existsSync(tmpWrapper)) {
                    try { unlinkSync(tmpWrapper); } catch (_) {}
                }
            }
        }
    });
}

// ─── CLI INSTALL ─────────────────────────────────────────────────────────────

function install() {
    const postinstall = isPostinstallMode();

    // Guard: if running as npm postinstall hook inside the source repo itself
    // (i.e. developer ran `npm install` in the cloned repo), skip entirely
    // — BEFORE requesting sudo credentials. Otherwise a harmless `npm install`
    // during development would prompt the user for sudo on every invocation.
    // We detect this via INIT_CWD (set by npm to the directory where npm was invoked).
    // Also check for a harness marker file as a belt-and-suspenders fallback.
    if (postinstall) {
        const initCwd = process.env.INIT_CWD;
        const isOwnRepo =
            (initCwd && resolve(initCwd) === resolve(projectRoot)) ||
            existsSync(join(projectRoot, "doc", "harness", "manifest.yaml"));
        if (isOwnRepo) {
            console.log("Skipping postinstall: running in source repo (use npm run install:global instead)");
            return;
        }
    }

    const mode = getExecutionMode();

    if (mode === "root-bare") {
        console.warn("[WARN] Running as root with no SUDO_USER set.");
        console.warn("[WARN] Cargo/npm build commands may fail with rustup's $HOME check.");
        console.warn("[WARN] Prefer running as a normal user: npm run install:global");
    }

    // Preemptive sudo (no-op unless mode === "user")
    preauth(mode);

    if (!postinstall) {
        // Local install mode: run npm install + build as usual
        console.log("Installing dependencies...");
        execSync("npm install", { cwd: projectRoot, stdio: "inherit" });

        console.log("Building...");
        execSync("npm run build", { cwd: projectRoot, stdio: "inherit" });
    }

    // Container image rebuild — skip entirely in postinstall mode
    if (!postinstall) {
        // Detect container runtime (prefers podman, falls back to docker)
        const runtime = detectRuntime();
        if (!runtime) {
            console.log("No container runtime (podman or docker) detected. Skipping image build.");
            console.log("Install podman or docker, then run 'ccc' to auto-pull/build.");
        } else {
            console.log(`Using container runtime: ${runtime}`);

            const currentHash = getContentHash();
            const imageHash = getImageHash(runtime);
            const needsRebuild = currentHash !== imageHash;

            if (needsRebuild) {
                console.log(`Content changed (${imageHash || "none"} -> ${currentHash})`);

                // No need to stop containers or remove old image.
                // `<runtime> build -t ccc` overwrites the tag; old image becomes <none>.
                console.log(`Rebuilding container image with ${runtime}...`);
                try {
                    const buildArgs = [
                        "build", "-t", "ccc",
                        "--label", `content.hash=${currentHash}`,
                    ];
                    // Pass GITHUB_TOKEN as build secret when set.
                    //   - docker: BuildKit >= 18.09 supports `--secret id=X,env=VAR`
                    //   - podman: buildah >= 1.29 / podman >= 4.3 supports the same form
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
            } else {
                console.log(`Container image up to date (hash: ${currentHash})`);
            }
        }

        const installDir = getInstallDir();

        if (isWindows) {
            mkdirSync(installDir, { recursive: true });
            const cmdPath = join(installDir, "ccc.cmd");
            const cmdContent = `@echo off\r\nnode "${distFile}" %*\r\n`;
            writeFileSync(cmdPath, cmdContent);
            console.log(`Installed: ${cmdPath}`);

            // Check PATH
            const pathDirs = (process.env.PATH || "").split(";");
            if (!pathDirs.some(p => p.toLowerCase() === installDir.toLowerCase())) {
                console.log(`\nAdd to PATH (run in PowerShell as Admin):`);
                console.log(`  [Environment]::SetEnvironmentVariable("Path", $env:Path + ";${installDir}", "User")`);
            }
        } else {
            // POSIX: use spawnElevated for /usr/local/bin writes
            const targetDir = join(installDir, "ccc-dist");
            const targetBin = join(installDir, "ccc");

            // Remove old symlink (if it's a symlink; regular file wrappers are overwritten below)
            try {
                const stat = lstatSync(targetBin);
                if (stat.isSymbolicLink()) {
                    spawnElevated(mode, "rm", [targetBin]);
                }
            } catch (e) {
                if (e.code !== "ENOENT") throw e;
            }

            // Remove old dist directory
            if (existsSync(targetDir)) {
                spawnElevated(mode, "rm", ["-rf", targetDir]);
            }

            // Copy dist/ to targetDir (recursive)
            spawnElevated(mode, "cp", ["-R", join(projectRoot, "dist"), targetDir]);

            // Copy Dockerfile + Containerfile (either works; podman build prefers
            // Containerfile, docker build prefers Dockerfile; both are identical).
            spawnElevated(mode, "cp", [join(projectRoot, "Dockerfile"), join(targetDir, "Dockerfile")]);
            if (existsSync(join(projectRoot, "Containerfile"))) {
                spawnElevated(mode, "cp", [join(projectRoot, "Containerfile"), join(targetDir, "Containerfile")]);
            }

            // Copy scripts directory (needed for Docker build context)
            spawnElevated(mode, "cp", ["-R", join(projectRoot, "scripts"), join(targetDir, "scripts")]);

            // Write a reduced package.json to a temp file, then sudo mv
            const srcPkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
            const pkgContent = JSON.stringify({ type: "module", version: srcPkg.version }, null, 2);
            const tmpPkg = join(projectRoot, ".tmp-ccc-package.json");
            writeFileSync(tmpPkg, pkgContent);
            try {
                spawnElevated(mode, "mv", [tmpPkg, join(targetDir, "package.json")]);
            } finally {
                if (existsSync(tmpPkg)) {
                    try { unlinkSync(tmpPkg); } catch (_) {}
                }
            }

            // Write wrapper script to temp, then sudo mv
            const wrapperContent = `#!/usr/bin/env node\nimport("${targetDir}/index.js");\n`;
            const tmpBin = join(projectRoot, ".tmp-ccc-bin");
            writeFileSync(tmpBin, wrapperContent);
            try {
                spawnElevated(mode, "mv", [tmpBin, targetBin]);
                spawnElevated(mode, "chmod", ["755", targetBin]);
                console.log(`Installed: ${targetBin}`);
            } finally {
                if (existsSync(tmpBin)) {
                    try { unlinkSync(tmpBin); } catch (_) {}
                }
            }
        }
    }

    // ── UI BUILD CHAIN ────────────────────────────────────────────────────────
    // In local mode: any failure exits 1 — UI install is not optional.
    // In postinstall mode: failure prints a warning + exits 0 so npm install succeeds.
    console.log("\n=== Building and installing ccc UI (Tauri app) ===");
    try {
        installUi(mode);
    } catch (e) {
        if (postinstall) {
            console.warn("\n[ui] UI build failed during postinstall — CLI install succeeded.");
            console.warn("[ui] Error: " + (e.message || e));
            console.warn("[ui] Manual recovery:");
            console.warn("      cd <install-location>/ui");
            console.warn("      npm install && npm run build");
            console.warn("      cd src-tauri && cargo build");
            console.warn("[ui] Or re-run: npm install -g claude-code-container");
            // Do NOT exit 1 — npm install should still succeed.
        } else {
            console.error("\n[UI] Unexpected failure during UI install:");
            console.error(e.message || e);
            process.exit(1);
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    console.log("\nDone! Run 'ccc --help' to verify.");
    console.log("      Run 'ccc ui' to launch the desktop app.");
}

function uninstall() {
    const mode = getExecutionMode();
    if (mode === "user") {
        preauth(mode);
    }

    const installDir = getInstallDir();

    if (isWindows) {
        const cmdPath = join(installDir, "ccc.cmd");
        if (existsSync(cmdPath)) {
            unlinkSync(cmdPath);
            console.log(`Removed: ${cmdPath}`);
        } else {
            console.log("CLI not installed.");
        }

        // Remove UI artifacts
        const uiPaths = installedUiBinPaths(process.platform);
        if (existsSync(uiPaths.binPath)) {
            unlinkSync(uiPaths.binPath);
            console.log(`Removed: ${uiPaths.binPath}`);
        }
        if (existsSync(uiPaths.binDir)) {
            rmSync(uiPaths.binDir, { recursive: true });
            console.log(`Removed: ${uiPaths.binDir}`);
        }
    } else {
        const targetDir = join(installDir, "ccc-dist");
        const targetBin = join(installDir, "ccc");

        let removed = false;
        if (existsSync(targetBin)) {
            spawnElevated(mode, "rm", [targetBin]);
            console.log(`Removed: ${targetBin}`);
            removed = true;
        }
        if (existsSync(targetDir)) {
            spawnElevated(mode, "rm", ["-rf", targetDir]);
            console.log(`Removed: ${targetDir}`);
            removed = true;
        }

        // Also remove UI artifacts
        const uiPaths = installedUiBinPaths(process.platform);
        if (existsSync(uiPaths.binPath)) {
            spawnElevated(mode, "rm", [uiPaths.binPath]);
            console.log(`Removed: ${uiPaths.binPath}`);
            removed = true;
        }
        if (existsSync(uiPaths.binDir)) {
            spawnElevated(mode, "rm", ["-rf", uiPaths.binDir]);
            console.log(`Removed: ${uiPaths.binDir}`);
            removed = true;
        }

        if (!removed) {
            console.log("Not installed.");
        }
    }
}

// Main
const args = process.argv.slice(2);
if (args.includes("--uninstall") || args.includes("-u")) {
    uninstall();
} else {
    install();
}
