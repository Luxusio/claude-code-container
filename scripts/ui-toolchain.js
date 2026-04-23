#!/usr/bin/env node
// scripts/ui-toolchain.js — ESM helper module for ui build toolchain checks
// Imported by scripts/install.js during `npm run install:global`

import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { homedir } from "os";

/**
 * isPostinstallMode(env, argv) — detect whether install.js was invoked as an
 * npm postinstall hook vs. a manual local install.
 *
 * Returns true when any of:
 *   - env.npm_lifecycle_event === 'postinstall' (npm sets this)
 *   - argv contains '--postinstall'
 *
 * @param {NodeJS.ProcessEnv} env - typically process.env
 * @param {string[]} argv - typically process.argv.slice(2)
 * @returns {boolean}
 */
export function isPostinstallMode(env = process.env, argv = process.argv.slice(2)) {
    if (env.npm_lifecycle_event === "postinstall") return true;
    if (argv.includes("--postinstall")) return true;
    return false;
}

/**
 * Run a command and return { status, stdout, stderr }.
 * Never throws — status is null on spawn failure.
 */
function run(cmd, args, opts = {}) {
    return spawnSync(cmd, args, { encoding: "utf-8", ...opts });
}

/**
 * ensureNode() — verify the running Node.js is >= 22.
 * Throws if the version is too old. Does not auto-install (Node is already
 * running the script; auto-installing would require an external restart).
 */
export function ensureNode() {
    const major = process.versions.node.split(".").map(Number)[0];
    if (major < 22) {
        throw new Error(
            `Node.js >= 22 required for Tauri UI build. Current: v${process.versions.node}\n` +
            `Install via mise: mise use -g node@22`
        );
    }
    console.log(`  Node.js v${process.versions.node} — OK`);
}

/**
 * ensureRust() — ensure cargo is available.
 * Strategy: cargo directly → mise which cargo → mise use -g rust@latest → throw (print rustup-init hint)
 */
export function ensureRust() {
    // 1. Try direct cargo
    const direct = run("cargo", ["--version"]);
    if (direct.status === 0) {
        console.log(`  cargo: ${direct.stdout.trim()} — OK`);
        return;
    }

    // 2. Try mise which cargo
    const miseWhich = run("mise", ["which", "cargo"]);
    if (miseWhich.status === 0 && miseWhich.stdout.trim()) {
        const cargoBin = miseWhich.stdout.trim();
        const ver = run(cargoBin, ["--version"]);
        if (ver.status === 0) {
            console.log(`  cargo (via mise): ${ver.stdout.trim()} — OK`);
            // Export the mise-managed cargo into PATH for subsequent child processes
            process.env.PATH = `${cargoBin.replace(/\/cargo$/, "")}:${process.env.PATH}`;
            return;
        }
    }

    // 3. Attempt auto-install via mise
    console.log("  cargo not found — attempting: mise use -g rust@latest ...");
    const miseInstall = run("mise", ["use", "-g", "rust@latest"], { stdio: "inherit" });
    if (miseInstall.status === 0) {
        // Re-check after install
        const miseWhich2 = run("mise", ["which", "cargo"]);
        if (miseWhich2.status === 0 && miseWhich2.stdout.trim()) {
            const cargoBin2 = miseWhich2.stdout.trim();
            process.env.PATH = `${cargoBin2.replace(/\/cargo$/, "")}:${process.env.PATH}`;
            console.log("  Rust installed via mise — OK");
            return;
        }
    }

    // 4. Nothing worked — print manual instructions and throw
    console.error("\n  Failed to install Rust automatically.");
    console.error("  Install manually with:");
    console.error("    curl -sSf https://sh.rustup.rs | sh -s -- -y");
    console.error("  Then restart the install script.");
    throw new Error("cargo is required but could not be installed. See instructions above.");
}

/**
 * ensureSystemDeps(platform) — install or verify platform-specific Tauri runtime deps.
 * Linux: webkit2gtk-4.1, libsoup-3.0, librsvg2, libayatana-appindicator3
 * macOS: Xcode Command Line Tools via xcode-select
 * Windows: WebView2 runtime (check registry key)
 */
export function ensureSystemDeps(platform) {
    if (platform === "linux") {
        _ensureLinuxDeps();
    } else if (platform === "darwin") {
        _ensureMacOsDeps();
    } else if (platform === "win32") {
        _ensureWindowsDeps();
    } else {
        console.log(`  System deps: skipping unknown platform ${platform}`);
    }
}

function _ensureLinuxDeps() {
    const packages = [
        "libwebkit2gtk-4.1-dev",
        "libsoup-3.0-dev",
        "librsvg2-dev",
        "libayatana-appindicator3-dev",
        "patchelf",
    ];

    if (existsSync("/etc/debian_version")) {
        console.log("  Detected Debian/Ubuntu — installing Tauri system deps via apt-get...");
        const cmd = ["apt-get", "install", "-y", "--no-install-recommends", ...packages];
        console.log(`  Running: sudo ${cmd.join(" ")}`);
        const result = spawnSync("sudo", cmd, { stdio: "inherit" });
        if (result.status !== 0) {
            throw new Error(
                `apt-get install failed (exit ${result.status}).\n` +
                `Try manually: sudo ${cmd.join(" ")}`
            );
        }
        console.log("  Tauri system deps installed via apt-get — OK");
        return;
    }

    if (existsSync("/etc/redhat-release")) {
        console.log("  Detected RHEL/Fedora — installing Tauri system deps via dnf...");
        // Fedora/RHEL package names differ slightly
        const rpmPackages = [
            "webkit2gtk4.1-devel",
            "libsoup3-devel",
            "librsvg2-devel",
            "libayatana-appindicator-gtk3-devel",
            "patchelf",
        ];
        const cmd = ["dnf", "install", "-y", ...rpmPackages];
        console.log(`  Running: sudo ${cmd.join(" ")}`);
        const result = spawnSync("sudo", cmd, { stdio: "inherit" });
        if (result.status !== 0) {
            throw new Error(
                `dnf install failed (exit ${result.status}).\n` +
                `Try manually: sudo ${cmd.join(" ")}`
            );
        }
        console.log("  Tauri system deps installed via dnf — OK");
        return;
    }

    // Arch Linux / Manjaro
    if (existsSync("/etc/arch-release")) {
        console.log("  Detected Arch Linux — installing Tauri system deps via pacman...");
        const archPackages = [
            "webkit2gtk-4.1",
            "libsoup3",
            "librsvg",
            "libayatana-appindicator",
            "patchelf",
        ];
        const cmd = ["pacman", "-Sy", "--noconfirm", ...archPackages];
        console.log(`  Running: sudo ${cmd.join(" ")}`);
        const result = spawnSync("sudo", cmd, { stdio: "inherit" });
        if (result.status !== 0) {
            throw new Error(
                `pacman install failed (exit ${result.status}).\n` +
                `Try manually: sudo ${cmd.join(" ")}`
            );
        }
        console.log("  Tauri system deps installed via pacman — OK");
        return;
    }

    // Unsupported distro — print manual command
    console.warn("  Unrecognized Linux distro. Install Tauri system deps manually:");
    console.warn("  Debian/Ubuntu:  sudo apt-get install -y " + packages.join(" "));
    console.warn("  Fedora/RHEL:    sudo dnf install -y webkit2gtk4.1-devel libsoup3-devel librsvg2-devel libayatana-appindicator-gtk3-devel patchelf");
    console.warn("  Arch Linux:     sudo pacman -Sy webkit2gtk-4.1 libsoup3 librsvg libayatana-appindicator patchelf");
}

function _ensureMacOsDeps() {
    console.log("  Checking Xcode Command Line Tools...");
    const result = run("xcode-select", ["-p"]);
    if (result.status === 0 && result.stdout.trim()) {
        console.log(`  Xcode CLT: ${result.stdout.trim()} — OK`);
        return;
    }
    throw new Error(
        "Xcode Command Line Tools not installed.\n" +
        "Install with: xcode-select --install\n" +
        "Then re-run: npm run install:global"
    );
}

function _ensureWindowsDeps() {
    console.log("  Checking WebView2 runtime (Windows)...");
    // Check the standard WebView2 registry key
    const webView2Key =
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const result = run("reg", ["query", webView2Key], { shell: true });
    if (result.status === 0) {
        console.log("  WebView2 runtime — OK");
        return;
    }
    console.warn("  WebView2 runtime not found.");
    console.warn("  Download and install from:");
    console.warn("  https://developer.microsoft.com/en-us/microsoft-edge/webview2/");
    throw new Error(
        "WebView2 runtime is required for the Tauri UI on Windows.\n" +
        "Download: https://developer.microsoft.com/en-us/microsoft-edge/webview2/"
    );
}

/**
 * getRustTriple() — return the host target triple (e.g. x86_64-unknown-linux-gnu).
 * Reads from `rustc -vV` output.
 */
export function getRustTriple() {
    const result = run("rustc", ["-vV"]);
    if (result.status !== 0) {
        throw new Error("rustc not available — run ensureRust() first");
    }
    const match = result.stdout.match(/^host:\s+(.+)$/m);
    if (!match) {
        throw new Error("Could not parse rustc target triple from: " + result.stdout);
    }
    return match[1].trim();
}

/**
 * sidecarBinPaths(releaseDir, triple, platform) — resolve the src and dest paths for
 * the Tauri externalBin sidecar binary, accounting for the platform `.exe` suffix.
 *
 * On Windows, Rust produces `ccc-daemon.exe` and Tauri's externalBin bundler
 * expects the triple-suffixed dest to also carry `.exe`
 * (e.g. `ccc-daemon-x86_64-pc-windows-msvc.exe`).
 * On POSIX the suffix is the empty string and behavior is unchanged.
 *
 * @param {string} releaseDir  - absolute path to `target/release` inside sidecarDir
 * @param {string} triple      - Rust host triple from getRustTriple()
 * @param {string} [platform]  - defaults to process.platform
 * @returns {{ srcBin: string, destBin: string, exeSuffix: string }}
 */
export function sidecarBinPaths(releaseDir, triple, platform = process.platform) {
    const exeSuffix = platform === "win32" ? ".exe" : "";
    return {
        srcBin:  join(releaseDir, `ccc-daemon${exeSuffix}`),
        destBin: join(releaseDir, `ccc-daemon-${triple}${exeSuffix}`),
        exeSuffix,
    };
}

/**
 * cleanUiDepsForFreshInstall(uiDir, { fs }) — remove ui/node_modules and
 * ui/package-lock.json before running `npm install` in the global install
 * pathway. This works around npm/cli#4828 where platform-specific optional
 * dependencies (like @tauri-apps/cli-win32-x64-msvc) are skipped when the
 * committed lockfile was generated on a different host platform.
 *
 * The `fs` parameter is injected for unit-testability. By default uses the
 * real node `fs`. The mock must expose `existsSync` and `rmSync`.
 *
 * Semantic choice (FINDING-1 resolution): option (a) — pre-check with
 * `existsSync` and return `{ removedNodeModules: boolean, removedLockfile:
 * boolean }` reflecting whether a removal actually happened. This gives
 * accurate log output ("Pre-clean: removed node_modules, no lockfile found")
 * and makes unit tests discriminating (the return value tracks actual state).
 *
 * Idempotent: safe to call when neither path exists.
 *
 * @param {string} uiDir - absolute path to the `ui/` directory
 * @param {{ fs?: { existsSync: Function, rmSync: Function } }} [opts]
 * @returns {{ removedNodeModules: boolean, removedLockfile: boolean }}
 */
export function cleanUiDepsForFreshInstall(uiDir, opts = {}) {
    const fsMod = opts.fs ?? { existsSync, rmSync };
    const nodeModulesPath = join(uiDir, "node_modules");
    const lockfilePath = join(uiDir, "package-lock.json");

    const hadNodeModules = fsMod.existsSync(nodeModulesPath);
    if (hadNodeModules) {
        fsMod.rmSync(nodeModulesPath, { recursive: true, force: true });
    }

    const hadLockfile = fsMod.existsSync(lockfilePath);
    if (hadLockfile) {
        fsMod.rmSync(lockfilePath, { force: true });
    }

    return {
        removedNodeModules: hadNodeModules,
        removedLockfile: hadLockfile,
    };
}

/**
 * getTauriCliBindingName(platform, arch) — pure mapping of process.platform +
 * process.arch to the @tauri-apps/cli optionalDependencies package name for
 * the current host. This mirrors the binding package names published under the
 * @tauri-apps/cli optionalDependencies field in its package.json.
 *
 * Returns null (not undefined) for unknown platform/arch combinations so
 * callers can use strict equality checks (=== null).
 *
 * @param {string} platform - e.g. process.platform ("darwin", "linux", "win32")
 * @param {string} arch     - e.g. process.arch ("x64", "arm64", "ia32", "arm")
 * @returns {string|null}
 */
export function getTauriCliBindingName(platform, arch) {
    const lookup = {
        "darwin-arm64":  "@tauri-apps/cli-darwin-arm64",
        "darwin-x64":    "@tauri-apps/cli-darwin-x64",
        "linux-x64":     "@tauri-apps/cli-linux-x64-gnu",
        "linux-arm64":   "@tauri-apps/cli-linux-arm64-gnu",
        "linux-arm":     "@tauri-apps/cli-linux-arm-gnueabihf",
        "win32-x64":     "@tauri-apps/cli-win32-x64-msvc",
        "win32-arm64":   "@tauri-apps/cli-win32-arm64-msvc",
        "win32-ia32":    "@tauri-apps/cli-win32-ia32-msvc",
    };
    return lookup[`${platform}-${arch}`] ?? null;
}

/**
 * ensureTauriCliPlatformBinding(uiDir, opts) — probe the expected platform
 * binding for @tauri-apps/cli and fall back to a direct `npm install` of the
 * specific binding if it is missing. Handles environments where npm silently
 * omits platform-specific optional dependencies due to `omit=optional` config,
 * NPM_CONFIG_OMIT env var, or NODE_ENV=production (npm/cli#4828 variant 2).
 *
 * All Node.js module dependencies are injectable via opts for unit testability.
 *
 * @param {string} uiDir - absolute path to the `ui/` directory
 * @param {{
 *   fs?:        { existsSync: Function, readFileSync: Function },
 *   spawnSync?: Function,
 *   platform?:  string,
 *   arch?:      string,
 *   log?:       Function,
 * }} [opts]
 * @returns {{ status: "skipped" } | { status: "present", name: string } | { status: "installed", name: string, version: string }}
 */
export function ensureTauriCliPlatformBinding(uiDir, opts = {}) {
    const fsMod      = opts.fs        ?? { existsSync, readFileSync };
    const spawnFn    = opts.spawnSync ?? spawnSync;
    const platform   = opts.platform  ?? process.platform;
    const arch       = opts.arch      ?? process.arch;
    const log        = opts.log       ?? console.log;

    // Step 1: resolve binding name
    const name = getTauriCliBindingName(platform, arch);
    if (name === null) {
        log("  Platform binding: unknown platform/arch — skipped");
        return { status: "skipped" };
    }

    // Step 2: check if already present
    const bindingDir = join(uiDir, "node_modules", ...name.split("/"));
    if (fsMod.existsSync(bindingDir)) {
        log(`  Platform binding: ${name} — present`);
        return { status: "present", name };
    }

    // Step 3: read installed @tauri-apps/cli version
    const cliPkgPath = join(uiDir, "node_modules", "@tauri-apps", "cli", "package.json");
    let version;
    try {
        const raw = fsMod.readFileSync(cliPkgPath, "utf-8");
        version = JSON.parse(raw).version;
    } catch (_) {
        throw new Error(
            `@tauri-apps/cli is not installed in ${uiDir}/node_modules; run npm install first`
        );
    }

    // Step 4: fallback install
    // --os / --cpu override user ~/.npmrc `os` / `cpu` fields (npm/cli#4828 variant 3)
    const result = spawnFn(
        "npm",
        [
            "install",
            `${name}@${version}`,
            "--no-save",
            "--include=optional",
            `--os=${platform}`,
            `--cpu=${arch}`,
        ],
        {
            cwd:   uiDir,
            stdio: "inherit",
            shell: process.platform === "win32",
        }
    );
    if (result.status !== 0) {
        throw new Error(
            `Fallback install of ${name}@${version} failed (exit ${result.status})`
        );
    }

    // Step 5: re-verify
    if (!fsMod.existsSync(bindingDir)) {
        throw new Error(
            `Fallback install did not place ${name} in node_modules. ` +
            `Your npm is suppressing platform-specific optional dependencies. ` +
            `Check: \`npm config get omit\`, NPM_CONFIG_OMIT env, NODE_ENV. ` +
            `See doc/common/OBS__install__npm-optional-deps-4828.md.`
        );
    }

    log(`  Platform binding: ${name} — installed via fallback at ${version}`);
    return { status: "installed", name, version };
}

/**
 * installedUiBinPaths(platform) — single source of truth for UI binary install locations.
 * Returns { binDir, binPath, distDir }
 *
 * POSIX:
 *   binDir   = /usr/local/bin/ccc-ui-dist
 *   binPath  = /usr/local/bin/ccc-ui
 *   distDir  = /usr/local/bin/ccc-ui-dist
 *
 * Windows:
 *   binDir   = %LOCALAPPDATA%\Programs\ccc\ui
 *   binPath  = %LOCALAPPDATA%\Programs\ccc\ui\ccc-ui.cmd
 *   distDir  = %LOCALAPPDATA%\Programs\ccc\ui
 */
export function installedUiBinPaths(platform) {
    if (platform === "win32") {
        const localAppData =
            process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
        const binDir = join(localAppData, "Programs", "ccc", "ui");
        return {
            binDir,
            binPath: join(binDir, "ccc-ui.cmd"),
            spawnPath: join(binDir, "ccc-ui.exe"),
            distDir: binDir,
        };
    } else {
        const base = "/usr/local/bin";
        return {
            binDir: join(base, "ccc-ui-dist"),
            binPath: join(base, "ccc-ui"),
            spawnPath: join(base, "ccc-ui"),
            distDir: join(base, "ccc-ui-dist"),
        };
    }
}

/**
 * getExecutionMode(uid, env, platform) → "user" | "sudo-user" | "root-bare" | "windows"
 *
 * Determines how install.js should handle privilege separation for cargo/npm
 * builds vs /usr/local/bin writes.
 *
 * "user": normal unprivileged invocation. Sudo needed for /usr/local/bin.
 * "sudo-user": running as root via sudo with SUDO_USER set. Already root;
 *              must drop to SUDO_USER for cargo/npm so rustup's $HOME check
 *              doesn't fail.
 * "root-bare": running as root with no SUDO_USER (unusual — maybe in a
 *              rootful container). Print warning; cargo may fail.
 * "windows": Windows has no sudo concept; %LOCALAPPDATA% is per-user so
 *            no elevation is needed.
 */
export function getExecutionMode(
    uid = (typeof process.getuid === "function" ? process.getuid() : 1000),
    env = process.env,
    platform = process.platform,
) {
    if (platform === "win32") return "windows";
    if (uid !== 0) return "user";
    if (env.SUDO_USER && env.SUDO_USER !== "root") return "sudo-user";
    return "root-bare";
}

/**
 * buildElevatedCommand(cmd, args, mode) → { cmd, args }
 *
 * Wraps `cmd args` with sudo if mode is "user", otherwise returns unchanged.
 * Pure function — does not spawn.
 */
export function buildElevatedCommand(cmd, args, mode) {
    if (mode === "user") {
        return { cmd: "sudo", args: [cmd, ...args] };
    }
    // sudo-user (already root), root-bare (already root), windows (no sudo)
    return { cmd, args: [...args] };
}

/**
 * buildUserCommand(cmd, args, mode, sudoUser) → { cmd, args }
 *
 * Wraps `cmd args` with `sudo -u <sudoUser> -H -E` if mode is "sudo-user",
 * otherwise returns unchanged. Pure function — does not spawn.
 */
export function buildUserCommand(cmd, args, mode, sudoUser) {
    if (mode === "sudo-user") {
        if (!sudoUser) {
            throw new Error("buildUserCommand: sudoUser required in sudo-user mode");
        }
        return { cmd: "sudo", args: ["-u", sudoUser, "-H", "-E", cmd, ...args] };
    }
    // user (already the user), root-bare (no target to drop to), windows (no sudo)
    return { cmd, args: [...args] };
}
