// src/clipboard-server.ts - Singleton HTTP clipboard server for host-container clipboard bridge
//
// This file serves dual purpose:
// 1. Standalone entry point: when spawned as detached process, starts HTTP server
// 2. Library: exports ensureClipboardServer() and stopClipboardServerIfLast() for index.ts

import { createServer, request as httpRequest, type IncomingMessage, type Server } from "http";
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "child_process";
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { StringDecoder } from "string_decoder";
import {
    constants,
    fstatSync,
    lstatSync,
    fchmodSync,
    ftruncateSync,
    fsyncSync,
    existsSync,
    readFileSync,
    readSync,
    realpathSync,
    type BigIntStats,
    writeFileSync,
    copyFileSync,
    readdirSync,
    openSync,
    closeSync,
    mkdirSync,
    linkSync,
    unlinkSync,
} from "fs";
import { join, dirname, basename, relative, isAbsolute, sep, resolve } from "path";
import { platform } from "os";
import { fileURLToPath } from "url";
import { CLIPBOARD_FILES_CONTAINER_DIR } from "./utils.js";
import { cccHome, clipboardFilesDir, clipboardPortFile, clipboardStartingLock, helperBinDir, locksDir } from "./home-layout.js";
import { tryAcquireClipboardStartupLock, recoverDeadClipboardStartupLock, releaseClipboardStartupLock } from "./clipboard-startup-lock.js";
import { clipboardPortMayHaveBindUsers } from "./clipboard-bind-users.js";
import { prepareRuntimeBindHome, withRuntimeBindGuardAsync, readRuntimeBindAuthority, assertRuntimeBindAuthorityCurrent } from "./adapters/runtime-bind-authority.js";
import { getRuntimeInvocation, peekRuntimeInvocation, runWithNativeRuntimeInvocation, validateNativeRuntimeInvocation } from "./container-runtime.js";
import { nativeSessionOwnershipMatches, captureNativeSessionOwnership } from "./adapters/session-ownership.js";
import type { SessionOwnershipReceipt } from "./ports/session-ownership.js";
import type { RuntimeBindGuard, RuntimeBindHomePreparation } from "./ports/runtime-bind-authority.js";
import type { NativeRuntimeInvocation } from "./ports/container-runtime-invocation.js";
import type { ClipboardPublication } from "./ports/clipboard/server-lifecycle.js";
import type { ClipboardPortRecord, ClipboardSelection } from "./domain/clipboard/server-lifecycle.js";
import { sessionLockLiveness } from "./session-lock-liveness.js";
import { canonicalWindowsPowerShellPath, hiddenWindowsPowerShellArgs } from "@ccc/device-lab/windows-system-powershell.js";

import { createClipboardSnapshotReader, createClipboardSnapshotState, buildImageFileClipboardFallbackFromPaths as buildImageFileFallback } from "./application/clipboard/snapshot.js";
import { createClipboardTextWriter } from "./application/clipboard/text-write.js";
import type { ClipboardCaptureObservation, ClipboardMarkerObservation } from "./ports/clipboard/snapshot.js";
import type { ClipboardTextWriteResult, PreparedClipboardTextWrite } from "./ports/clipboard/text-write.js";
import { createClipboardServerLifecycle } from "./application/clipboard/server-lifecycle.js";
import { CACHE_TTL_MS, shouldReuseClipboardCache, buildImageMimeReadOrder, isSupportedImageTarget, type ClipboardPlatform, type ClipboardSnapshot as PolicyClipboardSnapshot } from "./domain/clipboard/snapshot.js";
import { MAX_CLIPBOARD_TEXT_BYTES, CLIPBOARD_WRITE_TIMEOUT_MS } from "./domain/clipboard/text-write.js";
import { CLIPBOARD_SERVER_ORPHAN_GRACE_MS, clipboardServerOrphanWatchdogState } from "./domain/clipboard/server-lifecycle.js";
export { CLIPBOARD_SERVER_ORPHAN_GRACE_MS, clipboardServerOrphanWatchdogState };
export { CACHE_TTL_MS, shouldReuseClipboardCache, buildImageMimeReadOrder, MAX_CLIPBOARD_TEXT_BYTES };
export type { ClipboardPlatform };

// === Version (for auto-restart on upgrade) ===
// Fixed compiled policy closure preserves upgrade detection after application extraction.
const DARWIN_HELPER_ASSET = "../scripts/clipboard-helper-darwin.m";
// Capture the shipped helper independently: source-based callers may lack
// compiled policy files, but must still qualify the native helper they run.
const darwinHelperSource = (() => {
    try { return readFileSync(join(dirname(fileURLToPath(import.meta.url)), DARWIN_HELPER_ASSET), "utf-8"); }
    catch { return undefined; }
})();
function getServerHash(): string {
    try {
        const directory = dirname(fileURLToPath(import.meta.url));
        const files = [
            "clipboard-server.js",
            "domain/clipboard/snapshot.js",
            "domain/clipboard/text-write.js",
            "domain/clipboard/server-lifecycle.js",
            "application/clipboard/snapshot.js",
            "application/clipboard/text-write.js",
            "application/clipboard/server-lifecycle.js",
            "clipboard-bind-users.js",
            "adapters/runtime-bind-authority.js",
            "adapters/runtime-bind-users.js",
            "application/runtime-bind-admission.js",
            DARWIN_HELPER_ASSET,
        ];
        const hash = createHash("sha256").update("ccc-clipboard-policy-v2\0");
        for (const file of files) {
            const content = file === DARWIN_HELPER_ASSET ? darwinHelperSource : readFileSync(join(directory, file), "utf-8");
            if (content === undefined) throw new Error("Clipboard helper source is unavailable");
            hash.update(file).update("\0").update(String(Buffer.byteLength(content, "utf8")))
                .update("\0").update(content).update("\0");
        }
        return hash.digest("hex").slice(0, 12);
    } catch { return "unknown"; }
}
const SERVER_VERSION = getServerHash();
const DARWIN_HELPER_SOURCE_HASH = darwinHelperSource === undefined ? null
    : createHash("sha256").update(darwinHelperSource).digest("hex").slice(0, 16);

function currentClipboardPortFile(): string {
    return /^[a-f0-9]{12}$/.test(SERVER_VERSION)
        ? join(dirname(clipboardPortFile()), `clipboard.${SERVER_VERSION}.port`) : clipboardPortFile();
}

function clipboardStartupPath(portFile: string): string {
    const legacy = clipboardPortFile();
    return dirname(portFile) === dirname(legacy) && /^clipboard\.[a-f0-9]{12}\.port$/.test(basename(portFile))
        ? portFile.replace(/\.port$/, ".starting") : clipboardStartingLock();
}

// === Constants ===
// Paths resolve on every use: the ~/.ccc layout can migrate after this module loads
// (doc/common/REQ__ccc-home-layout.md).
const CLIPBOARD_SERVER_ORPHAN_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;


const SHUTDOWN_TIMEOUT_MS = 2000;
const DAEMON_START_TIMEOUT_MS = 5000;
const WRITER_SETTLEMENT = "writer-settlement-v1";


const PS_MARKER = "<<<CCC_CB_DONE>>>";



// === Security Helpers ===
function safeCompare(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

// === Platform Detection ===


function detectPlatform(): ClipboardPlatform {
    const plat = platform();

    if (plat === "darwin") return "darwin";

    if (plat === "win32") return "windows";

    if (plat === "linux") {
        // Check for WSL
        try {
            const release = readFileSync("/proc/version", "utf-8");
            if (/microsoft|wsl/i.test(release) && canRunPowerShellExe()) return "wsl";
        } catch { /* not WSL */ }

        // Check for Wayland
        if (process.env.WAYLAND_DISPLAY) return "linux-wayland";

        // Check for X11
        if (process.env.DISPLAY) return "linux-x11";

        // Headless fallback: try X11 tools first
        return "linux-x11";
    }

    return "unsupported";
}

function clipboardPowerShellPath(): string | null {
    if (process.platform === "win32") return canonicalWindowsPowerShellPath();
    if (process.platform !== "linux") return null;
    try {
        if (!/microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"))) return null;
    } catch {
        return null;
    }
    return canonicalWindowsPowerShellPath("/mnt/c/Windows");
}

function canRunPowerShellExe(): boolean {
    try {
        const powershell = clipboardPowerShellPath();
        if (!powershell) return false;
        const result = spawnSync(powershell, hiddenWindowsPowerShellArgs([
            "-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "exit 0",
        ]), {
            timeout: 1000,
            stdio: "ignore",
            windowsHide: true,
        });
        return !result.error && result.status === 0;
    } catch {
        return false;
    }
}

/** Write text as stdin data, never as shell or PowerShell source. */
interface PreparedHostCommand { command: string; args: string[]; input: Buffer }
function prepareClipboardTextWriter(bytes: Buffer, plat: ClipboardPlatform): PreparedHostCommand | null {
    let command: string;
    let args: string[];
    let input = bytes;
    switch (plat) {
        case "darwin":
            command = "pbcopy";
            args = [];
            break;
        case "linux-x11":
            command = "xclip";
            args = ["-selection", "clipboard", "-in", "-target", "UTF8_STRING"];
            break;
        case "linux-wayland":
            command = "wl-copy";
            args = ["--type", "text/plain;charset=utf-8"];
            break;
        case "windows":
        case "wsl": {
            const powershell = clipboardPowerShellPath();
            if (!powershell) return null;
            command = powershell;
            args = hiddenWindowsPowerShellArgs([
                "-STA", "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference = 'Stop'; try { " +
                "Add-Type -AssemblyName System.Windows.Forms; " +
                "$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); " +
                "if ($text.Length -eq 0) { [Windows.Forms.Clipboard]::Clear() } " +
                "else { [Windows.Forms.Clipboard]::SetText($text) }; exit 0 " +
                "} catch { exit 1 }",
            ]);
            input = Buffer.from(bytes.toString("base64"), "ascii");
            break;
        }
        default:
            return null;
    }

    return { command, args, input };
}

function prepareNativeClipboardTextWrite(bytes: Buffer, plat: ClipboardPlatform): PreparedClipboardTextWrite {
    const prepared = prepareClipboardTextWriter(bytes, plat);
    if (!prepared) return { kind: "unavailable" };
    return { kind: "ready", write: async (timeoutMs): Promise<ClipboardTextWriteResult> => ({
        kind: await executeHostCommand(prepared, plat, timeoutMs) ? "written" : "failed",
    }) };
}

function executeHostCommand(
    prepared: PreparedHostCommand,
    plat: ClipboardPlatform,
    timeoutMs: number,
): Promise<boolean> {
    return new Promise((resolve) => {
        let child: ChildProcess;
        try {
            child = spawn(prepared.command, prepared.args, {
                stdio: ["pipe", "ignore", "ignore"],
                shell: false,
                windowsHide: true,
                ...(plat === "darwin" ? { env: { ...process.env, LC_CTYPE: "UTF-8" } } : {}),
            });
        } catch {
            resolve(false);
            return;
        }
        let settled = false;
        const finish = (success: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(success);
        };
        const terminate = () => {
            if (settled) return;
            finish(false);
            try { child.kill("SIGKILL"); } catch { /* Failure still settles; termination is not proven. */ }
        };
        const timer = setTimeout(terminate, timeoutMs);
        child.once("error", () => finish(false));
        child.once("exit", (code) => finish(code === 0));
        child.stdin!.on("error", terminate);
        try { child.stdin!.end(prepared.input); } catch { terminate(); }
    });
}

const MAX_HOST_OPEN_URL_BYTES = 8192;

function parseHostOpenUrl(text: string): string | null {
    try {
        const body: unknown = JSON.parse(text);
        if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body).length !== 1 || !("url" in body) || typeof body.url !== "string"
            || !/^https?:\/\//i.test(body.url) || /[\u0000-\u0020\u007f\\]/.test(body.url)) return null;
        const url = new URL(body.url);
        return (url.protocol === "http:" || url.protocol === "https:") && url.hostname
            && !url.username && !url.password ? url.href : null;
    } catch { return null; }
}

/** Launch the host's default browser. URLs never become command or script source. */
function openHostUrl(url: string, plat: ClipboardPlatform): Promise<boolean> | null {
    let prepared: PreparedHostCommand;
    switch (plat) {
        case "darwin":
            prepared = { command: "/usr/bin/open", args: [url], input: Buffer.alloc(0) };
            break;
        case "linux-x11":
        case "linux-wayland":
            prepared = { command: "/usr/bin/xdg-open", args: [url], input: Buffer.alloc(0) };
            break;
        case "windows":
        case "wsl": {
            const powershell = clipboardPowerShellPath();
            if (!powershell) return null;
            prepared = { command: powershell, args: hiddenWindowsPowerShellArgs([
                "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference = 'Stop'; try { " +
                "$url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); " +
                "$start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName = $url; " +
                "$start.UseShellExecute = $true; [Diagnostics.Process]::Start($start) | Out-Null; exit 0 " +
                "} catch { exit 1 }",
            ]), input: Buffer.from(Buffer.from(url, "utf8").toString("base64"), "ascii") };
            break;
        }
        default:
            return null;
    }
    return executeHostCommand(prepared, plat, CLIPBOARD_WRITE_TIMEOUT_MS);
}

class ClipboardUploadError extends Error {
    constructor(readonly status: number) {
        super("Invalid clipboard upload");
    }
}

function readClipboardUpload(req: IncomingMessage, maximumBytes = MAX_CLIPBOARD_TEXT_BYTES): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (error?: ClipboardUploadError, text?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            req.removeListener("data", onData);
            req.removeListener("end", onEnd);
            req.removeListener("aborted", onAbort);
            if (error) {
                req.pause();
                reject(error);
            } else resolve(text!);
        };
        const onData = (chunk: Buffer) => {
            size += chunk.length;
            if (size > maximumBytes) finish(new ClipboardUploadError(413));
            else chunks.push(chunk);
        };
        const onEnd = () => {
            if (!req.complete) return finish(new ClipboardUploadError(400));
            try {
                // Preserve an initial UTF-8 BOM as well as all whitespace.
                const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
                if (text.includes("\0")) return finish(new ClipboardUploadError(400));
                finish(undefined, text);
            } catch {
                finish(new ClipboardUploadError(400));
            }
        };
        const onAbort = () => finish(new ClipboardUploadError(400));
        const timer = setTimeout(() => finish(new ClipboardUploadError(408)), CLIPBOARD_WRITE_TIMEOUT_MS);
        req.on("data", onData);
        req.once("end", onEnd);
        req.once("aborted", onAbort);
        req.once("error", onAbort);
    });
}

// === AppleScript Data Parsing ===

/**
 * Parse macOS osascript image data output.
 * osascript returns clipboard image data as AppleScript data literal:
 *   «data PNGf89504E470D0A1A0A...»
 * This is hex-encoded, NOT raw binary. We must extract and decode the hex.
 * If the buffer already contains raw PNG binary (starts with PNG magic), return as-is.
 * Returns null if the data cannot be parsed as image data.
 */
export function parseAppleScriptImageData(buf: Buffer): Buffer | null {
    if (buf.length === 0) return null;

    // Already raw PNG binary? (PNG magic: 0x89 0x50 0x4E 0x47)
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        return buf;
    }

    // Try to parse «data XXXX<hex>» format
    const str = buf.toString("utf-8");
    const match = str.match(/«data \w{4}([0-9A-Fa-f\s]+)»/);
    if (!match) return null;

    const hexStr = match[1].replace(/\s+/g, "");
    if (hexStr.length === 0 || hexStr.length % 2 !== 0) return null;

    return Buffer.from(hexStr, "hex");
}

// === Persistent macOS Native Helper ===
// Mirrors the Windows PowerShell pattern: one persistent process for fast clipboard reads.
// Uses a compiled Objective-C binary that accesses NSPasteboard directly (~5ms per read).

function darwinHelperBinary(): string | null {
    return DARWIN_HELPER_SOURCE_HASH ? join(helperBinDir(), `clipboard-helper-darwin-${DARWIN_HELPER_SOURCE_HASH}`) : null;
}
let persistentDarwin: ChildProcess | null = null;

/**
 * Parse JSON output from the native macOS clipboard helper.
 * Format matches Windows PowerShell output for consistency.
 */
export function parseDarwinHelperOutput(output: string): Omit<ClipboardSnapshot, "timestamp"> | null {
    if (!output) return null;
    try {
        const json = JSON.parse(output);
        if (!validNativeSnapshotShape(json)) return null;
        const rawTargets = json.targets;
        const targets = Array.isArray(rawTargets) ? rawTargets
            : typeof rawTargets === "string" ? [rawTargets]
            : [];
        const imagePng = decodeClipboardImage(json.imagePng);
        if (json.imagePng && !imagePng) return null;
        return {
            marker: typeof json.changeCount === "number" || typeof json.changeCount === "string"
                ? String(json.changeCount)
                : null,
            targets: capturedClipboardTargets(targets, imagePng, json.text),
            text: json.text ? Buffer.from(json.text, "utf-8") : null,
            imagePng,
            imageBmp: null,
        };
    } catch {
        return null;
    }
}

type DarwinHelperDirectory = { path: string; stat: BigIntStats };

function safeDarwinHelperDirectory(stat: BigIntStats): boolean {
    return stat.isDirectory() && !stat.isSymbolicLink()
        && (!process.getuid || (stat.uid === BigInt(process.getuid()) && (stat.mode & 0o022n) === 0n));
}

function captureDarwinHelperDirectories(helperDirectory: string, createMissing = false): DarwinHelperDirectory[] | null {
    try {
        const root = resolve(cccHome()), directory = resolve(helperDirectory);
        const suffix = relative(root, directory);
        if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return null;
        const paths = [root];
        for (const part of suffix.split(sep)) paths.push(join(paths.at(-1)!, part));
        return paths.map(path => {
            let stat: BigIntStats;
            try { stat = lstatSync(path, { bigint: true }); }
            catch (error) {
                if (!createMissing || path === root || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                // Validate each existing parent before creating its direct child.
                mkdirSync(path, { mode: 0o700 });
                stat = lstatSync(path, { bigint: true });
            }
            if (!safeDarwinHelperDirectory(stat)) throw new Error("Unsafe clipboard helper directory");
            return { path, stat };
        });
    } catch { return null; }
}

function darwinHelperDirectoriesMatch(directories: readonly DarwinHelperDirectory[]): boolean {
    try {
        return directories.every(before => {
            const current = lstatSync(before.path, { bigint: true });
            return safeDarwinHelperDirectory(current) && current.dev === before.stat.dev
                && current.ino === before.stat.ino && current.birthtimeNs === before.stat.birthtimeNs;
        });
    } catch { return false; }
}

/** Qualify the captured helper generation and its owned directory chain. */
function isDarwinHelperReady(): string | null {
    if (platform() !== "darwin") return null;
    const binary = darwinHelperBinary();
    if (!binary) return null;
    const directories = captureDarwinHelperDirectories(dirname(binary));
    if (!directories) return null;
    try {
        const stat = lstatSync(binary);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0
            || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o100) === 0))) return null;
        return darwinHelperDirectoriesMatch(directories) ? binary : null;
    } catch { return null; }
}

/**
 * Background compile: build the Objective-C helper binary if needed.
 * Non-blocking — uses async spawn so the server can serve requests immediately.
 * First requests fall back to osascript; once compile finishes, native helper is used.
 */
function compileDarwinHelperAsync(): void {
    let sourcePath: string | undefined;
    let outputPath: string | undefined;
    let sourceReceipt: BigIntStats | undefined;
    let outputReceipt: BigIntStats | undefined;
    const removeOwned = (path: string | undefined, receipt: BigIntStats | undefined) => {
        if (!path || !receipt) return;
        try {
            const current = lstatSync(path, { bigint: true });
            if (current.isFile() && !current.isSymbolicLink() && current.dev === receipt.dev
                && current.ino === receipt.ino && current.birthtimeNs === receipt.birthtimeNs) unlinkSync(path);
        } catch { /* A missing or replaced stage is not ours to remove. */ }
    };
    const cleanup = () => { removeOwned(sourcePath, sourceReceipt); removeOwned(outputPath, outputReceipt); };
    try {
        const binary = darwinHelperBinary();
        if (!binary || darwinHelperSource === undefined || isDarwinHelperReady()) return;
        const binDir = dirname(binary);
        const directories = captureDarwinHelperDirectories(binDir, true);
        if (!directories || !darwinHelperDirectoriesMatch(directories)) return;
        const nonce = randomBytes(16).toString("hex");
        sourcePath = join(binDir, `.clipboard-helper-${nonce}.m`);
        outputPath = join(binDir, `.clipboard-helper-${nonce}.bin`);
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
        const sourceFd = openSync(sourcePath, flags, 0o600);
        try { sourceReceipt = fstatSync(sourceFd, { bigint: true }); writeFileSync(sourceFd, darwinHelperSource); }
        finally { closeSync(sourceFd); }
        const outputFd = openSync(outputPath, flags, 0o700);
        try { outputReceipt = fstatSync(outputFd, { bigint: true }); }
        finally { closeSync(outputFd); }
        const child = spawn("cc", [
            "-framework", "AppKit", "-framework", "Foundation", "-O2", "-o", outputPath, sourcePath,
        ], { stdio: "ignore" });
        child.once("error", cleanup);
        child.once("close", code => {
            try {
                if (code !== 0) return;
                if (!darwinHelperDirectoriesMatch(directories)) return;
                // The compiler may replace its output. Capture only a private,
                // complete regular file in this exclusively reserved stage.
                const compiled = lstatSync(outputPath!, { bigint: true });
                if (!compiled.isFile() || compiled.isSymbolicLink() || compiled.nlink !== 1n || compiled.size === 0n
                    || (process.getuid && compiled.uid !== BigInt(process.getuid()))) return;
                outputReceipt = compiled;
                const fd = openSync(outputPath!, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
                try {
                    const opened = fstatSync(fd, { bigint: true });
                    if (!portPathMatches(opened, compiled)) return;
                    fchmodSync(fd, 0o700);
                    fsyncSync(fd);
                } finally { closeSync(fd); }
                // No replace: concurrent compilers and older running binaries
                // keep their exact files and processes.
                if (!darwinHelperDirectoriesMatch(directories)) return;
                linkSync(outputPath!, binary);
            } catch { /* Compilation failure keeps the existing fallback. */ }
            finally { cleanup(); }
        });
    } catch { cleanup(); /* Compilation unavailable: retain the native fallback. */ }
}

function ensurePersistentDarwin(): ChildProcess | null {
    if (persistentDarwin && !persistentDarwin.killed && persistentDarwin.exitCode === null && persistentDarwin.stdin?.writable) {
        return persistentDarwin;
    }

    if (persistentDarwin && !persistentDarwin.killed) {
        try { persistentDarwin.kill(); } catch { /* ignore */ }
    }
    persistentDarwin = null;

    const binaryPath = isDarwinHelperReady();
    if (!binaryPath) return null;

    const child = spawn(binaryPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });

    child.stderr?.on("data", () => { /* drain */ });
    child.on("error", () => { if (persistentDarwin === child) persistentDarwin = null; });
    child.stdin?.on("error", () => { /* active frame handles failure */ });
    child.on("exit", () => { if (persistentDarwin === child) persistentDarwin = null; });

    persistentDarwin = child;
    return persistentDarwin;
}

async function runDarwinCommand(command = "READ", timeout = 5000): Promise<string | null> {
    let helper: ChildProcess | null;
    try { helper = ensurePersistentDarwin(); } catch { throw new ClipboardReadError(); }
    if (!helper) return null; // Native helper not installed; use the existing fallback.
    return readNativeFrame(helper, `${command}\n`, timeout, killPersistentDarwin);
}

function killPersistentDarwin(): void {
    if (persistentDarwin && !persistentDarwin.killed) {
        persistentDarwin.kill();
        persistentDarwin = null;
    }
}

// === Async Command Execution (for parallel reads) ===

/**
 * Async version of execCommand using spawn instead of spawnSync.
 * Allows parallel process execution via Promise.all.
 */
export function execCommandAsync(cmd: string, args: string[], timeout = 5000): Promise<{ stdout: Buffer; status: number }> {
    return new Promise((resolve) => {
        try {
            const child = spawn(cmd, args, {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });

            const chunks: Buffer[] = [];
            child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
            child.stderr?.on("data", () => {}); // drain

            const timer = setTimeout(() => {
                try { child.kill(); } catch { /* ignore */ }
                resolve({ stdout: Buffer.concat(chunks), status: 1 });
            }, timeout);

            child.on("close", (code) => {
                clearTimeout(timer);
                resolve({ stdout: Buffer.concat(chunks), status: code ?? 1 });
            });

            child.on("error", () => {
                clearTimeout(timer);
                resolve({ stdout: Buffer.alloc(0), status: 1 });
            });
        } catch {
            resolve({ stdout: Buffer.alloc(0), status: 1 });
        }
    });
}

// === Clipboard Reading (platform-specific) ===

function execCommand(cmd: string, args: string[], timeout = 5000): { stdout: Buffer; status: number } {
    try {
        const result = spawnSync(cmd, args, {
            timeout,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        }) as SpawnSyncReturns<Buffer>;
        return { stdout: result.stdout ?? Buffer.alloc(0), status: result.status ?? 1 };
    } catch {
        return { stdout: Buffer.alloc(0), status: 1 };
    }
}

// === Persistent PowerShell (Windows/WSL) ===
// One hidden PowerShell process kept alive for the server's lifetime.
// Eliminates ~1-2s startup per clipboard read.

let persistentPS: ChildProcess | null = null;
let psAssemblyLoaded = false;

function ensurePersistentPS(): ChildProcess {
    if (persistentPS && !persistentPS.killed && persistentPS.exitCode === null && persistentPS.stdin?.writable) {
        return persistentPS;
    }

    // Kill stale process if it exists but is no longer healthy
    if (persistentPS && !persistentPS.killed) {
        try { persistentPS.kill(); } catch { /* ignore */ }
    }
    persistentPS = null;
    psAssemblyLoaded = false;

    const powershell = clipboardPowerShellPath();
    if (!powershell) throw new Error("trusted Windows PowerShell is unavailable");
    const ps = spawn(powershell, hiddenWindowsPowerShellArgs([
        "-STA", "-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-",
    ]), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });

    ps.stderr?.on("data", () => { /* drain stderr */ });
    ps.on("error", () => { if (persistentPS === ps) { persistentPS = null; psAssemblyLoaded = false; } });
    ps.stdin?.on("error", () => { /* active frame handles failure */ });
    // Guard: only null the reference if this is still the active process (avoids race with replacement)
    ps.on("exit", () => { if (persistentPS === ps) { persistentPS = null; psAssemblyLoaded = false; } });

    persistentPS = ps;

    return persistentPS;
}

// PowerShell 5.1 stdin/stdout inherit host code pages. Keep source ASCII on
// the wire and explicitly encode responses for readNativeFrame's UTF-8 decoder.
export function windowsClipboardCommand(command: string): string {
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    return `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding; . ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`;
}

async function runPSCommand(command: string, timeout = 8000): Promise<string> {
    let ps: ChildProcess;
    try { ps = ensurePersistentPS(); } catch { throw new ClipboardReadError(); }
    const prefix = psAssemblyLoaded ? "" : "Add-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\n";
    const output = await readNativeFrame(ps, `${windowsClipboardCommand(prefix + command)}\n'${PS_MARKER}'\n`, psAssemblyLoaded ? timeout : 8000, killPersistentPS);
    psAssemblyLoaded = true;
    return output;
}

class ClipboardReadError extends Error {
    constructor() { super("Clipboard read unavailable"); }
}

// getCachedClipboard serializes whole transactions, so only one command owns
// each helper's stdout. A delimiter must occupy a complete line: clipboard
// text containing its literal spelling is ordinary JSON data.
function readNativeFrame(child: ChildProcess, command: string, timeout: number, reset: () => void): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!child.stdin?.writable || !child.stdout || child.killed || child.exitCode !== null) {
            reset();
            reject(new ClipboardReadError());
            return;
        }
        const decoder = new StringDecoder("utf8");
        let output = "";
        let settled = false;
        const finish = (body?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.stdout!.removeListener("data", onData);
            child.stdout!.removeListener("end", onFailure);
            child.removeListener("exit", onFailure);
            child.removeListener("error", onFailure);
            child.stdin!.removeListener("error", onFailure);
            if (body === undefined) {
                try { child.kill(); } catch { /* ignore */ }
                reset();
                reject(new ClipboardReadError());
            } else resolve(body);
        };
        const onFailure = () => finish();
        const onData = (chunk: Buffer) => {
            output += decoder.write(chunk);
            const match = /(?:^|\r?\n)<<<CCC_CB_DONE>>>\r?\n/.exec(output);
            if (match) finish(output.slice(0, match.index).trim());
        };
        const timer = setTimeout(onFailure, timeout);
        child.stdout.on("data", onData);
        child.stdout.once("end", onFailure);
        child.once("exit", onFailure);
        child.once("error", onFailure);
        child.stdin.once("error", onFailure);
        try { child.stdin.write(command); } catch { onFailure(); }
    });
}

function killPersistentPS(): void {
    if (persistentPS && !persistentPS.killed) {
        persistentPS.kill();
        persistentPS = null;
        psAssemblyLoaded = false;
    }
}

// === Clipboard Cache ===
 // Short no-marker fallback; marker platforms can reuse longer safely.
type ClipboardSnapshot = PolicyClipboardSnapshot<Buffer>;
const clipboardState = createClipboardSnapshotState<Buffer>();









const IMAGE_FILE_EXTENSIONS = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".webp",
    ".avif",
    ".tif",
    ".tiff",
];

const WINDOWS_IMAGE_FILE_EXTENSIONS = IMAGE_FILE_EXTENSIONS;





export function isImageFilePath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return IMAGE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function copiedClipboardFileContainerPath(destName: string): string {
    return `${CLIPBOARD_FILES_CONTAINER_DIR}/${destName}`;
}

function copyImageFileToClipboardShare(filePath: string): Buffer | null {
    if (!isImageFilePath(filePath) || !existsSync(filePath)) return null;
    try {
        mkdirSync(clipboardFilesDir(), { recursive: true });
        const destName = `${Date.now()}-${randomBytes(4).toString("hex")}-${basename(filePath)}`;
        copyFileSync(filePath, join(clipboardFilesDir(), destName));
        return Buffer.from(copiedClipboardFileContainerPath(destName), "utf-8");
    } catch {
        return null;
    }
}

export function parseClipboardFileUriList(input: string): string[] {
    return input
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#") && line !== "copy" && line !== "cut")
        .map((line) => {
            if (line.startsWith("file://")) {
                try {
                    return decodeURIComponent(new URL(line).pathname);
                } catch {
                    return "";
                }
            }
            return line;
        })
        .filter(Boolean);
}

export function parseClipboardImagePathText(input: string): string[] {
    const text = input.trim();
    if (!text || /[\r\n]/.test(text)) return [];
    const unquoted = text.replace(/^['"](.+)['"]$/, "$1").trim();
    if (!isImageFilePath(unquoted)) return [];
    if (/^[a-zA-Z]:[\\/]/.test(unquoted) || unquoted.startsWith("/") || unquoted.startsWith("~/")) {
        return [unquoted];
    }
    if (unquoted.startsWith("file://")) return parseClipboardFileUriList(unquoted);
    return [];
}

export function buildImageFileClipboardFallbackFromPaths(
    paths: string[],
    options: {
        readImageFile?: (filePath: string) => Buffer | null;
        copyImageFile?: (filePath: string) => Buffer | null;
    } = {},
): Omit<ClipboardSnapshot, "timestamp"> {
    const readImageFile = options.readImageFile ?? ((filePath: string) => {
        if (!isImageFilePath(filePath)) return null;
        try {
            const body = readFileSync(filePath);
            return body.length > 0 ? body : null;
        } catch {
            return null;
        }
    });
    const copyImageFile = options.copyImageFile ?? copyImageFileToClipboardShare;

    return buildImageFileFallback(paths, readImageFile, copyImageFile);
}



export function parseWindowsClipboardSnapshot(output: string): Omit<ClipboardSnapshot, "timestamp"> | null {
    if (!output) return null;
    try {
        const json = JSON.parse(output);
        if (!validNativeSnapshotShape(json)) return null;
        const rawTargets = json.targets;
        const targets = Array.isArray(rawTargets) ? rawTargets
            : typeof rawTargets === "string" ? [rawTargets]
            : [];
        const imagePng = decodeClipboardImage(json.imagePng);
        if (json.imagePng && !imagePng) return null;
        return {
            marker: typeof json.marker === "number" || typeof json.marker === "string"
                ? String(json.marker)
                : null,
            targets: capturedClipboardTargets(targets, imagePng, imagePng ? null : json.text),
            text: imagePng ? null : json.text ? Buffer.from(json.text, "utf-8") : null,
            imagePng,
            imageBmp: null,
        };
    } catch {
        return null;
    }
}

function validNativeSnapshotShape(value: unknown): value is { targets: string | string[]; text?: string | null; imagePng?: string | null; marker?: unknown; changeCount?: unknown } {
    if (!value || typeof value !== "object") return false;
    const json = value as Record<string, unknown>;
    return (typeof json.targets === "string" || (Array.isArray(json.targets) && json.targets.every(t => typeof t === "string")))
        && (json.text == null || typeof json.text === "string")
        && (json.imagePng == null || typeof json.imagePng === "string");
}

function decodeClipboardImage(value: string | null | undefined): Buffer | null {
    if (!value) return null;
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 && bytes.toString("base64") === value ? bytes : null;
}

function capturedClipboardTargets(targets: string[], image: Buffer | null, text: string | null | undefined): string[] {
    const captured = targets.filter(target => {
        if (isSupportedImageTarget(target)) return image !== null;
        if (target.includes("text/plain") || target === "STRING" || target === "UTF8_STRING") return Boolean(text);
        return true;
    });
    if (image && !captured.includes("image/png")) captured.push("image/png");
    return captured;
}

function psSingleQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

const WINDOWS_CLIPBOARD_SEQUENCE_TYPE = "CCCClipboardSequence";

export function buildWindowsClipboardChangeMarkerCommand(): string {
    return [
        `if (-not (${psSingleQuote(WINDOWS_CLIPBOARD_SEQUENCE_TYPE)} -as [type])) {`,
        "  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CCCClipboardSequence { [DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber(); }'",
        "}",
        "[CCCClipboardSequence]::GetClipboardSequenceNumber()",
    ].join("; ");
}

export function buildWindowsClipboardReadCommand(
    sharedHostDir = clipboardFilesDir(),
    sharedContainerDir = CLIPBOARD_FILES_CONTAINER_DIR,
): string {
    const extensions = WINDOWS_IMAGE_FILE_EXTENSIONS.map(psSingleQuote).join(",");
    const sharedHost = psSingleQuote(sharedHostDir);
    const sharedContainer = psSingleQuote(sharedContainerDir);
    return [
        "$previousErrorActionPreference = $ErrorActionPreference",
        "$ErrorActionPreference = 'Stop'",
        "try {",
        `if (-not (${psSingleQuote(WINDOWS_CLIPBOARD_SEQUENCE_TYPE)} -as [type])) {`,
        "  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CCCClipboardSequence { [DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber(); }'",
        "}",
        "$r = @{ marker = $null; targets = @(); text = $null; imagePng = $null }",
        "try { $r.marker = [CCCClipboardSequence]::GetClipboardSequenceNumber() } catch { }",
        `$imageExts = @(${extensions})`,
        `$sharedHost = ${sharedHost}`,
        `$sharedContainer = ${sharedContainer}`,
        "$dataObj = [System.Windows.Forms.Clipboard]::GetDataObject()",
        "if ($dataObj) {",
        "  foreach ($fmt in @('PNG', 'image/png')) {",
        "    try {",
        "      if ($dataObj.GetDataPresent($fmt)) {",
        "        $data = $dataObj.GetData($fmt)",
        "        $bytes = $null",
        "        if ($data -is [byte[]]) { $bytes = $data }",
        "        elseif ($data -is [System.IO.Stream]) {",
        "          $msRaw = New-Object System.IO.MemoryStream",
        "          if ($data.CanSeek) { $data.Position = 0 }",
        "          $data.CopyTo($msRaw)",
        "          $bytes = $msRaw.ToArray()",
        "          $msRaw.Dispose()",
        "        }",
        "        if ($bytes -and $bytes.Length -gt 0) {",
        "          $r.targets += 'image/png'",
        "          $r.imagePng = [Convert]::ToBase64String($bytes)",
        "          break",
        "        }",
        "      }",
        "    } catch { }",
        "  }",
        "}",
        "$img = [System.Windows.Forms.Clipboard]::GetImage()",
        "if (!$r.imagePng -and !$img -and [System.Windows.Forms.Clipboard]::ContainsFileDropList()) {",
        "  $files = [System.Windows.Forms.Clipboard]::GetFileDropList()",
        "  foreach ($file in $files) {",
        "    $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()",
        "    if ($imageExts -contains $ext -and [System.IO.File]::Exists($file)) {",
        "      try {",
        "        $img = [System.Drawing.Image]::FromFile($file)",
        "        $r.targets += 'application/x-ccc-image-file'",
        "        break",
        "      } catch {",
        "        try {",
        "          $bytes = [System.IO.File]::ReadAllBytes($file)",
        "          if ($bytes.Length -gt 0) {",
        "            $r.targets += 'image/png'",
        "            $r.targets += 'application/x-ccc-image-file'",
        "            $r.imagePng = [Convert]::ToBase64String($bytes)",
        "            break",
        "          }",
        "        } catch {",
        "          try {",
        "          [System.IO.Directory]::CreateDirectory($sharedHost) | Out-Null",
        "          $destName = ([System.Guid]::NewGuid().ToString() + '-' + [System.IO.Path]::GetFileName($file))",
        "          $dest = [System.IO.Path]::Combine($sharedHost, $destName)",
        "          Copy-Item -LiteralPath $file -Destination $dest -Force",
        "          $r.targets += 'text/plain'",
        "          $r.targets += 'application/x-ccc-copied-image-file'",
        "          $r.text = ($sharedContainer.TrimEnd('/') + '/' + $destName)",
        "          break",
        "          } catch { }",
        "        }",
        "      }",
        "    }",
        "  }",
        "}",
        "if (!$r.imagePng -and $img) {",
        "  try {",
        "    $ms = New-Object System.IO.MemoryStream",
        "    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
        "    $bytes = $ms.ToArray()",
        "    if ($bytes.Length -gt 0) {",
        "      $r.targets += 'image/png'",
        "      $r.imagePng = [Convert]::ToBase64String($bytes)",
        "    }",
        "    $ms.Dispose()",
        "  } catch { }",
        "  try { $img.Dispose() } catch { }",
        "}",
        "$text = [System.Windows.Forms.Clipboard]::GetText()",
        "if ($text -and !$r.imagePng -and !$r.text) {",
        "  $file = $text.Trim().Trim([char]34).Trim([char]39)",
        "  $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()",
        "  if ($imageExts -contains $ext -and [System.IO.File]::Exists($file)) {",
        "    try {",
        "      $img = [System.Drawing.Image]::FromFile($file)",
        "      $r.targets += 'application/x-ccc-image-file'",
        "    } catch {",
        "      try {",
        "        $bytes = [System.IO.File]::ReadAllBytes($file)",
        "        if ($bytes.Length -gt 0) {",
        "          $r.targets += 'image/png'",
        "          $r.targets += 'application/x-ccc-image-file'",
        "          $r.imagePng = [Convert]::ToBase64String($bytes)",
        "        }",
        "      } catch {",
        "        try {",
        "          [System.IO.Directory]::CreateDirectory($sharedHost) | Out-Null",
        "          $destName = ([System.Guid]::NewGuid().ToString() + '-' + [System.IO.Path]::GetFileName($file))",
        "          $dest = [System.IO.Path]::Combine($sharedHost, $destName)",
        "          Copy-Item -LiteralPath $file -Destination $dest -Force",
        "          $r.targets += 'text/plain'",
        "          $r.targets += 'application/x-ccc-copied-image-file'",
        "          $r.text = ($sharedContainer.TrimEnd('/') + '/' + $destName)",
        "        } catch { }",
        "      }",
        "    }",
        "  }",
        "}",
        "if ($img -and !$r.imagePng) {",
        "  try {",
        "    $ms = New-Object System.IO.MemoryStream",
        "    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
        "    $bytes = $ms.ToArray()",
        "    if ($bytes.Length -gt 0) {",
        "      $r.targets += 'image/png'",
        "      $r.imagePng = [Convert]::ToBase64String($bytes)",
        "    }",
        "    $ms.Dispose()",
        "  } catch { }",
        "  try { $img.Dispose() } catch { }",
        "}",
        "if ($text -and !$r.imagePng -and !$r.text) { $r.targets += 'text/plain'; $r.text = $text }",
        "$r | ConvertTo-Json -Compress",
        "} catch { '{\"error\":\"clipboard-read-failed\"}' } finally { $ErrorActionPreference = $previousErrorActionPreference }",
    ].join("; ");
}

/**
 * macOS: Read all clipboard data with parallel process spawns.
 * Skips 'clipboard info' — infers targets from actual data availability.
 * Runs osascript (image) and pbpaste (text) concurrently for ~2x speedup.
 */


/**
 * Windows/WSL: Read all clipboard data via the persistent PowerShell process.
 * Single command returns targets + text + image as JSON.
 */
async function readAllClipboardWindows(): Promise<Omit<ClipboardSnapshot, "timestamp">> {
    // Single-line command: PS interactive stdin (-Command -) without a console
    // cannot handle multi-line continuation blocks (if { ... } across lines).
    mkdirSync(clipboardFilesDir(), { recursive: true });
    const command = buildWindowsClipboardReadCommand();

    const output = await runPSCommand(command);
    const snapshot = parseWindowsClipboardSnapshot(output);
    if (!snapshot) throw new ClipboardReadError();
    return snapshot;
}

async function readWindowsClipboardChangeMarker(): Promise<string | null> {
    const output = await runPSCommand(buildWindowsClipboardChangeMarkerCommand(), 2000);
    const marker = output.trim();
    if (!/^\d+$/.test(marker) || Number(marker) <= 0) throw new ClipboardReadError();
    return marker;
}

async function readDarwinClipboardChangeMarker(): Promise<string | null> {
    const output = await runDarwinCommand("MARK", 1000);
    if (output === null) return null;
    try {
        const json = JSON.parse(output);
        if ((typeof json.changeCount === "number" || typeof json.changeCount === "string") && /^\d+$/.test(String(json.changeCount))) {
            return String(json.changeCount);
        }
    } catch { /* helper without MARK support or invalid output */ }
    throw new ClipboardReadError();
}

async function readClipboardChangeMarker(plat: ClipboardPlatform): Promise<string | null> {
    if (plat === "windows" || plat === "wsl") return readWindowsClipboardChangeMarker();
    if (plat === "darwin") return readDarwinClipboardChangeMarker();
    return null;
}

function readDarwinClipboardFileReferenceData(): { stdout: Buffer; status: number } {
    return execCommand("osascript", ["-e", [
        "try",
        "set f to the clipboard as «class furl»",
        "return POSIX path of f",
        "end try",
    ].join("\n")]);
}

function readLinuxClipboardUriData(plat: ClipboardPlatform, target: string): { stdout: Buffer; status: number } {
    return plat === "linux-x11"
        ? execCommand("xclip", ["-selection", "clipboard", "-t", target, "-o"])
        : execCommand("wl-paste", ["--type", target]);
}



async function observeClipboardChangeMarker(plat: ClipboardPlatform): Promise<ClipboardMarkerObservation> {
    try {
        return { kind: "observed", marker: await readClipboardChangeMarker(plat) };
    } catch (error) {
        if (error instanceof ClipboardReadError) return { kind: "unavailable" };
        throw error;
    }
}

function readClipboardFileReferences(plat: ClipboardPlatform, targets: string[]): string[] {
    if (plat === "darwin") {
        const result = readDarwinClipboardFileReferenceData();
        return result.status === 0 ? result.stdout.toString("utf8").split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
    }
    if (plat !== "linux-x11" && plat !== "linux-wayland") return [];
    const candidates = [...new Set([
        ...targets.filter(target => target === "text/uri-list" || target === "x-special/gnome-copied-files"),
        "text/uri-list", "x-special/gnome-copied-files",
    ])];
    for (const target of candidates) {
        const result = readLinuxClipboardUriData(plat, target);
        if (result.status !== 0 || result.stdout.length === 0) continue;
        const paths = parseClipboardFileUriList(result.stdout.toString("utf8"));
        if (paths.length > 0) return paths;
    }
    return [];
}

async function captureDarwinClipboard(): Promise<Omit<ClipboardSnapshot, "timestamp">> {
    const output = await runDarwinCommand();
    let snapshot: Omit<ClipboardSnapshot, "timestamp">;
    if (output !== null) {
        const parsed = parseDarwinHelperOutput(output);
        if (!parsed) throw new ClipboardReadError();
        snapshot = parsed;
    } else {
        const [image, text] = await Promise.all([
            execCommandAsync("osascript", ["-e", 'try\nset d to the clipboard as «class PNGf»\nreturn d\nend try']),
            execCommandAsync("pbpaste", []),
        ]);
        if (image.status !== 0 || text.status !== 0) throw new ClipboardReadError();
        const imagePng = image.stdout.length > 0 ? parseAppleScriptImageData(image.stdout) : null;
        const textBytes = text.stdout.length > 0 ? text.stdout : null;
        snapshot = { targets: [...(imagePng ? ["image/png"] : []), ...(textBytes ? ["text/plain"] : [])], text: textBytes, imagePng, imageBmp: null };
    }
    if (!snapshot.imagePng) {
        const converted = execCommand("pngpaste", ["-"]);
        if (converted.status === 0 && converted.stdout.length > 0) {
            const targets = output === null ? ["image/png", ...snapshot.targets.filter(target => target !== "image/png")]
                : [...new Set([...snapshot.targets, "image/png"])];
            snapshot = { ...snapshot, targets, imagePng: converted.stdout };
        }
    }
    return snapshot;
}

async function captureNativeClipboard(plat: ClipboardPlatform): Promise<ClipboardCaptureObservation<Buffer>> {
    try {
        if (plat === "windows" || plat === "wsl") {
            return { kind: "captured", snapshot: await readAllClipboardWindows(), fileReferences: [], textImagePaths: [] };
        }
        let snapshot: Omit<ClipboardSnapshot, "timestamp">;
        if (plat === "darwin") {
            snapshot = await captureDarwinClipboard();
        } else {
            const targets = readClipboardTargets(plat);
            const hasImage = targets.some(isSupportedImageTarget);
            const hasText = targets.some(target => target.includes("text/plain") || target === "STRING" || target === "UTF8_STRING");
            const text = hasText ? readClipboardText(plat) : null;
            const imagePng = hasImage ? readClipboardImage(plat, "png", targets) : null;
            const imageBmp = hasImage ? readClipboardImage(plat, "bmp", targets) : null;
            snapshot = {
                marker: null,
                targets: targets.filter(target => isSupportedImageTarget(target) ? imagePng !== null || imageBmp !== null
                    : target.includes("text/plain") || target === "STRING" || target === "UTF8_STRING" ? text !== null : true),
                text, imagePng, imageBmp,
            };
        }
        const needsFallback = !snapshot.imagePng && !snapshot.imageBmp;
        return {
            kind: "captured", snapshot,
            fileReferences: needsFallback ? readClipboardFileReferences(plat, snapshot.targets) : [],
            textImagePaths: needsFallback && snapshot.text ? parseClipboardImagePathText(snapshot.text.toString("utf8")) : [],
        };
    } catch (error) {
        if (error instanceof ClipboardReadError) return { kind: "unavailable" };
        throw error;
    }
}

const getCachedClipboard = createClipboardSnapshotReader<Buffer>({
    now: () => Date.now(),
    readChangeMarker: observeClipboardChangeMarker,
    capture: captureNativeClipboard,
    readImageFile: (filePath) => {
        if (!isImageFilePath(filePath)) return null;
        try {
            const body = readFileSync(filePath);
            return body.length > 0 ? body : null;
        } catch { return null; }
    },
    copyImageFile: copyImageFileToClipboardShare,
    createReadError: () => new ClipboardReadError(),
}, clipboardState);

const writeClipboardText = createClipboardTextWriter<Buffer>({
    encodeText: (text) => Buffer.from(text, "utf8"),
    decodeText: (bytes) => bytes.toString("utf8"),
    prepareWriter: prepareNativeClipboardTextWrite,
}, clipboardState);
export { writeClipboardText };





function readClipboardTargets(plat: ClipboardPlatform): string[] {
    switch (plat) {
        case "darwin": {
            const r = execCommand("osascript", ["-e", "clipboard info"]);
            if (r.status !== 0) return [];
            const out = r.stdout.toString("utf-8");
            const types: string[] = [];
            if (/PNGf|png/i.test(out)) types.push("image/png");
            if (/TIFF|tiff/i.test(out)) types.push("image/tiff");
            if (/BMP|BMPf/i.test(out)) types.push("image/bmp");
            if (/utf|text|«class ut16»|«class utf8»/i.test(out)) types.push("text/plain");
            return types.length > 0 ? types : ["text/plain"];
        }
        case "linux-x11": {
            const r = execCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]);
            if (r.status !== 0) return [];
            return r.stdout.toString("utf-8").split("\n").filter(Boolean);
        }
        case "linux-wayland": {
            const r = execCommand("wl-paste", ["-l"]);
            if (r.status !== 0) return [];
            return r.stdout.toString("utf-8").split("\n").filter(Boolean);
        }
        default:
            return [];
    }
}

function readClipboardText(plat: ClipboardPlatform): Buffer | null {
    let r: { stdout: Buffer; status: number };
    switch (plat) {
        case "darwin":
            r = execCommand("pbpaste", []);
            break;
        case "linux-x11":
            r = execCommand("xclip", ["-selection", "clipboard", "-o"]);
            break;
        case "linux-wayland":
            r = execCommand("wl-paste", []);
            break;
        default:
            return null;
    }
    return r.status === 0 && r.stdout.length > 0 ? r.stdout : null;
}

function readClipboardImage(plat: ClipboardPlatform, format: "png" | "bmp", targets: string[] = []): Buffer | null {
    let r: { stdout: Buffer; status: number };
    switch (plat) {
        case "darwin": {
            if (format === "png") {
                r = execCommand("osascript", ["-e",
                    'try\nset d to the clipboard as «class PNGf»\nreturn d\nend try']);
                if (r.status === 0 && r.stdout.length > 0) {
                    // osascript returns «data PNGf<hex>» format, not raw binary
                    const parsed = parseAppleScriptImageData(r.stdout);
                    if (parsed) return parsed;
                }
                // Fallback: pngpaste outputs raw PNG binary
                r = execCommand("pngpaste", ["-"]);
            } else {
                return null;
            }
            break;
        }
        case "linux-x11":
        case "linux-wayland": {
            for (const candidateMimeType of buildImageMimeReadOrder(targets, format)) {
                r = plat === "linux-x11"
                    ? execCommand("xclip", ["-selection", "clipboard", "-t", candidateMimeType, "-o"])
                    : execCommand("wl-paste", ["--type", candidateMimeType]);
                if (r.status === 0 && r.stdout.length > 0) {
                    return r.stdout;
                }
            }
            return null;
        }
        default:
            return null;
    }
    return r.status === 0 && r.stdout.length > 0 ? r.stdout : null;
}

// === HTTP Server ===

export function createClipboardServer(token: string, plat: ClipboardPlatform, options: {
    disablePublication?: () => void;
    publicationCommitted?: () => boolean;
    retirePublication?: (guard?: RuntimeBindGuard) => void;
    runtimeInvocation?: NativeRuntimeInvocation;
    publicationPath?: string;
} = {}): { server: Server; start: (bindAddr: string) => Promise<number>; shutdown: () => void } {
    let noActiveSessionsSince: number | null = null;
    let idleTimer: ReturnType<typeof setInterval>;
    let retiring = false;
    let exitAfterClose = false;
    let closed = false;
    let orphanCheckPending = false;
    const relinquish = () => {
        if (!retiring) {
            retiring = true;
            options.disablePublication?.();
            clearInterval(idleTimer);
            killPersistentPS();
            killPersistentDarwin();
            server.close(() => {
                closed = true;
                if (exitAfterClose) process.exit(0);
            });
        }
        return !server.listening;
    };
    const finishShutdown = () => {
        if (exitAfterClose) return;
        exitAfterClose = true;
        if (closed) process.exit(0);
        setTimeout(() => process.exit(0), 3000).unref();
    };
    const shutdown = () => {
        relinquish();
        try { options.retirePublication?.(); } finally { finishShutdown(); }
    };

    // Pre-warm persistent PowerShell on Windows/WSL
    if (plat === "windows" || plat === "wsl") {
        ensurePersistentPS();
    }

    const server = createServer(async (req, res) => {
        const url = req.url ?? "";
        const method = req.method ?? "GET";

        try {
            if (method === "GET" && url === "/health") {
                // Unauthenticated liveness probe - no token info exposed
                const authH = req.headers.authorization;
                const expected = `Bearer ${token}`;
                const isValid = authH !== undefined && safeCompare(authH, expected);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ service: "ccc-clipboard", ...(isValid ? { version: SERVER_VERSION, valid: true,
                    ...(options.publicationCommitted?.() === false ? {} : { retirement: WRITER_SETTLEMENT }) } : {}) }));
                return;
            }

            // Authenticate all other endpoints
            const authHeader = req.headers.authorization;
            const expectedAuth = `Bearer ${token}`;
            if (!authHeader || !safeCompare(authHeader, expectedAuth)) {
                res.writeHead(401, { "Content-Type": "text/plain" });
                res.end("Unauthorized");
                return;
            }

            if (method === "POST" && url === "/shutdown") {
                if (options.publicationCommitted?.() === false) {
                    res.writeHead(503);
                    res.end("Clipboard publication is not committed");
                    return;
                }
                // server.close() stops new listeners synchronously. Its close event
                // waits for this response, so never await it before acknowledging.
                if (!relinquish()) {
                    res.writeHead(503);
                    res.end();
                    return;
                }
                options.retirePublication?.(); // Parent owns any final marker; this child can never write again.
                res.once("finish", finishShutdown);
                res.once("close", finishShutdown);
                res.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
                res.end(JSON.stringify({ service: "ccc-clipboard", retirement: WRITER_SETTLEMENT, settled: true }));
                return;
            }

            if (method === "POST" && url === "/clipboard/text") {
                // Close rejected uploads rather than draining unbounded bodies.
                const rejectUpload = (status: number) => {
                    res.writeHead(status, { "Content-Type": "text/plain", "Connection": "close" });
                    res.end("Clipboard upload failed");
                    res.once("finish", () => req.destroy());
                };
                const contentType = req.headers["content-type"] ?? "";
                if (!/^text\/plain(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
                    rejectUpload(415);
                    return;
                }
                const length = req.headers["content-length"];
                if (length !== undefined && Number(length) > MAX_CLIPBOARD_TEXT_BYTES) {
                    rejectUpload(413);
                    return;
                }
                try {
                    const text = await readClipboardUpload(req);
                    await writeClipboardText(text, plat);
                    res.writeHead(204);
                    res.end();
                } catch (error) {
                    rejectUpload(error instanceof ClipboardUploadError ? error.status : 500);
                }
                return;
            }

            if (method === "POST" && url === "/host/open-url") {
                const rejectOpen = (status: number) => {
                    res.writeHead(status, { "Content-Type": "text/plain", "Connection": "close" });
                    res.end("Host browser request failed");
                    res.once("finish", () => req.destroy());
                };
                const contentType = req.headers["content-type"] ?? "";
                if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
                    rejectOpen(415);
                    return;
                }
                const length = req.headers["content-length"];
                if (length !== undefined && Number(length) > MAX_HOST_OPEN_URL_BYTES) {
                    rejectOpen(413);
                    return;
                }
                try {
                    const target = parseHostOpenUrl(await readClipboardUpload(req, MAX_HOST_OPEN_URL_BYTES));
                    if (!target) { rejectOpen(400); return; }
                    const opening = openHostUrl(target, plat);
                    if (!opening) { rejectOpen(501); return; }
                    if (!await opening) { rejectOpen(502); return; }
                    res.writeHead(204);
                    res.end();
                } catch (error) {
                    rejectOpen(error instanceof ClipboardUploadError ? error.status : 502);
                }
                return;
            }

            if (method === "GET" && url === "/clipboard/targets") {
                const cache = await getCachedClipboard(plat);
                if (cache.targets.length === 0) {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end(cache.targets.join("\n") + "\n");
                return;
            }

            if (method === "GET" && url === "/clipboard/text") {
                const cache = await getCachedClipboard(plat);
                if (!cache.text) {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end(cache.text);
                return;
            }

            if (method === "GET" && (url === "/clipboard/image/png" || url === "/clipboard/image/bmp")) {
                const forceFreshImageRead = plat === "linux-x11" || plat === "linux-wayland";
                let cache = await getCachedClipboard(plat, forceFreshImageRead);
                let image = url.endsWith("/bmp") ? cache.imageBmp : cache.imagePng;
                if (!image) {
                    cache = await getCachedClipboard(plat, true);
                    image = url.endsWith("/bmp") ? cache.imageBmp : cache.imagePng;
                }
                if (!image) {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                res.writeHead(200, { "Content-Type": url.endsWith("/bmp") ? "image/bmp" : "image/png" });
                res.end(image);
                return;
            }

            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
        } catch (error) {
            if (!res.headersSent) {
                res.writeHead(error instanceof ClipboardReadError ? 503 : 500);
                res.end(error instanceof ClipboardReadError ? "Clipboard read unavailable" : "Internal error");
            }
        }
    });

    // A detached server may outlive a crashed CLI. Active session locks keep it
    // alive; an empty/stale lock set starts a short grace period before exit.
    idleTimer = setInterval(() => {
        if (retiring || orphanCheckPending) return;
        const state = clipboardServerOrphanWatchdogState(Date.now(), noActiveSessionsSince, hasAnyActiveSessionsExcept(null));
        noActiveSessionsSince = state.noActiveSessionsSince;
        if (!state.shouldShutdown || !options.runtimeInvocation) return;
        orphanCheckPending = true;
        void runWithNativeRuntimeInvocation(options.runtimeInvocation, () => withRuntimeBindGuardAsync(cccHome(), async guard => {
            if (retiring || hasAnyActiveSessionsExcept(null)) return;
            const portFile = options.publicationPath ?? clipboardPortFile();
            const selected = readPortFile(portFile);
            const address = server.address();
            if (!selected || !address || typeof address === "string" || selected.token !== token || selected.port !== address.port) return;
            if (clipboardPortMayHaveBindUsers(portFile, guard) || hasAnyActiveSessionsExcept(null) || !portRecordMatches(selected, portFile)) return;
            if (!relinquish()) return;
            try { options.retirePublication?.(guard); }
            finally { finishShutdown(); }
        }, { waitMs: 0 })).catch(() => undefined).finally(() => { orphanCheckPending = false; });
    }, CLIPBOARD_SERVER_ORPHAN_CHECK_INTERVAL_MS);
    server.once("close", () => clearInterval(idleTimer));

    const start = (bindAddr: string): Promise<number> => {
        return new Promise((resolve, reject) => {
            if (retiring) { reject(new Error("Clipboard writer has retired")); return; }
            server.listen(0, bindAddr, () => {
                const addr = server.address();
                if (addr && typeof addr !== "string") {
                    resolve(addr.port);
                } else {
                    reject(new Error("Failed to get server port"));
                }
            });
            server.on("error", reject);
        });
    };

    return { server, start, shutdown };
}

// === Port File Management ===

interface ClipboardPortReceipt { readonly stat: BigIntStats; readonly bytes: string }
const portReceipts = new WeakMap<ClipboardPortRecord, ClipboardPortReceipt>();

function samePortReceipt(left: ClipboardPortReceipt, right: ClipboardPortReceipt): boolean {
    return left.bytes === right.bytes && left.stat.dev === right.stat.dev && left.stat.ino === right.stat.ino
        && left.stat.birthtimeNs === right.stat.birthtimeNs && left.stat.mtimeNs === right.stat.mtimeNs
        && left.stat.ctimeNs === right.stat.ctimeNs;
}

function portPathMatches(opened: BigIntStats, named: BigIntStats): boolean {
    const unnamedWindowsDevice = process.platform === "win32" && named.dev === 0n;
    return named.isFile() && !named.isSymbolicLink() && named.nlink === 1n
        && named.ino === opened.ino && named.birthtimeNs === opened.birthtimeNs
        && (unnamedWindowsDevice ? opened.dev > 0n && opened.ino > 0n : named.dev === opened.dev);
}

function capturePortFile(path: string): ClipboardPortReceipt | null {
    let fd: number | undefined;
    try {
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const before = fstatSync(fd, { bigint: true });
        const uid = process.getuid?.();
        if (!before.isFile() || before.nlink !== 1n || before.size > 1024n
            || (uid !== undefined && (before.uid !== BigInt(uid) || (before.mode & 0o077n) !== 0n))) return null;
        const bytes = Buffer.alloc(1025);
        let length = 0;
        while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, length);
            if (!count) break;
            length += count;
        }
        const after = fstatSync(fd, { bigint: true });
        const named = lstatSync(path, { bigint: true });
        if (BigInt(length) !== before.size || !portPathMatches(before, named)
            || !after.isFile() || after.nlink !== 1n || after.dev !== before.dev || after.ino !== before.ino
            || after.birthtimeNs !== before.birthtimeNs || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return null;
        return { stat: before, bytes: bytes.subarray(0, length).toString("utf8") };
    } catch { return null; }
    finally { if (fd !== undefined) closeSync(fd); }
}

function decodePortFile(receipt: ClipboardPortReceipt | null): ClipboardPortRecord | null {
    const retired = receipt?.bytes.match(/^retired-v1:([1-9][0-9]{0,4}):([a-f0-9]{32})$/);
    const active = receipt?.bytes.trim().match(/^([0-9]{1,5}):([^\s\x00-\x1f]{1,256})$/);
    const match = retired ?? active;
    if (!match) return null;
    const port = Number(match[1]);
    return port > 0 && port <= 65535 ? { port, token: match[2], ...(retired ? { retired: true as const } : {}) } : null;
}

function readPortFile(portFile = clipboardPortFile()): ClipboardPortRecord | null {
    const receipt = capturePortFile(portFile);
    const record = decodePortFile(receipt);
    if (receipt && record) portReceipts.set(record, receipt);
    return record;
}

function portRecordMatches(record: ClipboardPortRecord, path: string): boolean {
    const before = portReceipts.get(record);
    const current = capturePortFile(path);
    return !!before && !!current && samePortReceipt(before, current);
}

/** A paused caller cannot bind one record and later use a different daemon token. */
export async function validateClipboardSelection(selected: ClipboardSelection | null, guard: RuntimeBindGuard): Promise<ClipboardSelection | null> {
    if (!selected) return null;
    try {
        const snapshot = readRuntimeBindAuthority(guard);
        const suffix = relative(resolve(guard.root), selected.portFile);
        if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return null;
        for (let path = dirname(selected.portFile); ; path = dirname(path)) {
            const parent = lstatSync(path);
            if (!parent.isDirectory() || parent.isSymbolicLink()) return null;
            if (path === resolve(guard.root)) break;
            if (dirname(path) === path) return null;
        }
        const current = capturePortFile(selected.portFile);
        const record = decodePortFile(current);
        if (!current || !record || record.retired || selected.retired || record.port !== selected.port || record.token !== selected.token) return null;
        const health = await checkServerHealth(selected.port, selected.token, "127.0.0.1");
        const after = capturePortFile(selected.portFile);
        assertRuntimeBindAuthorityCurrent(guard, snapshot);
        if (!health.alive || !after || !samePortReceipt(current, after)
            || (selected.generation !== undefined && (selected.generation !== SERVER_VERSION
                || !/^[a-f0-9]{12}$/.test(selected.generation) || selected.portFile !== currentClipboardPortFile()
                || health.version !== selected.generation))) return null;
        return selected;
    } catch { return null; }
}

function preparePortPublication(portFile: string, guard: RuntimeBindGuard): ClipboardPublication | null {
    try {
        const snapshot = readRuntimeBindAuthority(guard);
        const root = resolve(guard.root);
        const suffix = relative(root, portFile);
        if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return null;
        const ancestors: Array<{ path: string; stat: BigIntStats; canonical: string }> = [];
        const missing: string[] = [];
        for (let path = dirname(portFile); ; path = dirname(path)) {
            try {
                const stat = lstatSync(path, { bigint: true });
                if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o022n) !== 0n))) return null;
                ancestors.push({ path, stat, canonical: realpathSync(path) });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
                missing.push(path);
            }
            if (path === root) break;
            if (dirname(path) === path) return null;
        }
        const expected = capturePortFile(portFile);
        if (!expected) {
            try { lstatSync(portFile); return null; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; }
        } else if (!decodePortFile(expected)) return null;
        const assertParents = () => {
            assertRuntimeBindAuthorityCurrent(guard, snapshot);
            for (const before of ancestors) {
                const stat = lstatSync(before.path, { bigint: true });
                if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== before.stat.dev
                    || stat.ino !== before.stat.ino || stat.birthtimeNs !== before.stat.birthtimeNs
                    || realpathSync(before.path) !== before.canonical) throw new Error("Clipboard publication parent changed");
            }
            for (const path of missing) {
                try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
                throw new Error("Clipboard publication parent changed");
            }
        };
        const assertCurrent = () => {
            assertParents();
            const current = capturePortFile(portFile);
            if (expected ? !current || !samePortReceipt(expected, current) : current !== null) throw new Error("Clipboard publication target changed");
            if (!expected) {
                try { lstatSync(portFile); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
                throw new Error("Clipboard publication target changed");
            }
        };
        if (!expected && /^[a-f0-9]{12}$/.test(SERVER_VERSION) && portFile === currentClipboardPortFile()) {
            // An exclusively created sibling is distinct from an older mounted
            // port inode. Scan that existing inode so ancestor mounts and unknown
            // runtime history still veto creation without treating every sibling
            // file bind as an overlapping mount.
            if (snapshot.coverage !== "complete" || snapshot.pending || missing.length !== 0) return null;
            assertCurrent();
            const stage = join(dirname(portFile), `.${basename(portFile)}.${randomBytes(16).toString("hex")}.pending`);
            const fd = openSync(stage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL
                | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
            const owned = fstatSync(fd, { bigint: true });
            let receipt = capturePortFile(stage);
            let closed = false;
            let settled = false;
            const sameOwned = (stat: BigIntStats) => stat.isFile() && stat.dev === owned.dev && stat.ino === owned.ino
                && stat.birthtimeNs === owned.birthtimeNs && (!process.getuid
                    || (stat.uid === BigInt(process.getuid()) && (stat.mode & 0o777n) === 0o600n));
            const stageMatches = () => {
                if (!receipt || !sameOwned(receipt.stat)) return false;
                const opened = fstatSync(fd, { bigint: true });
                const named = lstatSync(stage, { bigint: true });
                return sameOwned(opened) && named.isFile() && !named.isSymbolicLink()
                    && named.ino === opened.ino && named.birthtimeNs === opened.birthtimeNs
                    && (named.dev === opened.dev || (process.platform === "win32" && named.dev === 0n))
                    && opened.nlink === receipt.stat.nlink && named.nlink === opened.nlink
                    && opened.size === receipt.stat.size && named.size === opened.size
                    && opened.mtimeNs === receipt.stat.mtimeNs && named.mtimeNs === opened.mtimeNs
                    && opened.ctimeNs === receipt.stat.ctimeNs && named.ctimeNs === opened.ctimeNs;
            };
            const dispose = () => {
                if (closed) return;
                try { assertParents(); if (stageMatches()) unlinkSync(stage); }
                catch { /* Never unlink a changed stage or a successor parent. */ }
                finally { closed = true; closeSync(fd); }
            };
            try {
                if (!receipt || !sameOwned(owned) || owned.nlink !== 1n || !stageMatches()
                    || clipboardPortMayHaveBindUsers(stage, guard)) { dispose(); return null; }
                assertCurrent();
                const publish: ClipboardPublication = record => {
                    if (closed || settled) throw new Error("Clipboard publication has already settled");
                    settled = true;
                    assertCurrent();
                    if (!stageMatches()) throw new Error("Clipboard publication stage changed");
                    try {
                        ftruncateSync(fd, 0);
                        writeFileSync(fd, `${record.port}:${record.token}`);
                    } finally {
                        const written = capturePortFile(stage);
                        if (written && sameOwned(written.stat)) receipt = written;
                    }
                    fsyncSync(fd);
                    assertCurrent();
                    if (!stageMatches()) throw new Error("Clipboard publication stage changed");
                    // Atomic no-replace publication. An intervening final path
                    // wins; it is never truncated, renamed over or removed.
                    linkSync(stage, portFile);
                    const linked = fstatSync(fd, { bigint: true });
                    if (sameOwned(linked)) receipt = { stat: linked, bytes: `${record.port}:${record.token}` };
                    const target = lstatSync(portFile, { bigint: true });
                    if (!sameOwned(linked) || linked.nlink !== 2n || !stageMatches() || !target.isFile()
                        || target.isSymbolicLink() || target.nlink !== 2n || target.ino !== linked.ino
                        || target.birthtimeNs !== linked.birthtimeNs
                        || (target.dev !== linked.dev && !(process.platform === "win32" && target.dev === 0n))) {
                        throw new Error("Clipboard publication link changed");
                    }
                    dispose();
                    const committed = capturePortFile(portFile);
                    if (!committed || !sameOwned(committed.stat) || committed.stat.nlink !== 1n
                        || committed.bytes !== `${record.port}:${record.token}`) throw new Error("Clipboard publication could not be captured");
                    return publicationReceipt(portFile, committed);
                };
                publish.dispose = dispose;
                return publish;
            } catch { dispose(); return null; }
        }
        const scope = expected ? portFile : ancestors[0]?.path;
        if (!scope || clipboardPortMayHaveBindUsers(scope, guard)) return null;
        assertCurrent();
        let published = false;
        return record => {
            if (published) throw new Error("Clipboard publication has already settled");
            published = true;
            assertCurrent();
            for (const path of [...missing].reverse()) mkdirSync(path, { mode: 0o700 });
            const flags = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
            const fd = openSync(portFile, expected ? flags : flags | constants.O_CREAT | constants.O_EXCL, 0o600);
            try {
                const stat = fstatSync(fd, { bigint: true });
                const named = lstatSync(portFile, { bigint: true });
                if (!stat.isFile() || stat.nlink !== 1n || !portPathMatches(stat, named)
                    || (process.getuid && stat.uid !== BigInt(process.getuid()))
                    || (expected && (stat.dev !== expected.stat.dev || stat.ino !== expected.stat.ino
                        || stat.birthtimeNs !== expected.stat.birthtimeNs || stat.size !== expected.stat.size
                        || stat.mtimeNs !== expected.stat.mtimeNs || stat.ctimeNs !== expected.stat.ctimeNs))) {
                    throw new Error("Unsafe clipboard port file");
                }
                if (process.getuid && (stat.mode & 0o777n) !== 0o600n) fchmodSync(fd, 0o600);
                ftruncateSync(fd, 0);
                writeFileSync(fd, `${record.port}:${record.token}`);
                fsyncSync(fd);
                const committed = capturePortFile(portFile);
                if (!committed) throw new Error("Clipboard publication could not be captured");
                return publicationReceipt(portFile, committed);
            } finally { closeSync(fd); }
        };
    } catch { return null; }
}

interface PublishedClipboardReceipt {
    readonly path: string;
    readonly bytes: string;
    readonly device: string;
    readonly inode: string;
    readonly birthtime: string;
    readonly mtime: string;
    readonly ctime: string;
}

function publicationReceipt(path: string, receipt: ClipboardPortReceipt): PublishedClipboardReceipt {
    return Object.freeze({ path, bytes: receipt.bytes, device: String(receipt.stat.dev), inode: String(receipt.stat.ino),
        birthtime: String(receipt.stat.birthtimeNs), mtime: String(receipt.stat.mtimeNs), ctime: String(receipt.stat.ctimeNs) });
}

function publicationMatches(before: PublishedClipboardReceipt, current: ClipboardPortReceipt): boolean {
    const after = publicationReceipt(before.path, current);
    return Object.keys(after).every(key => after[key as keyof PublishedClipboardReceipt] === before[key as keyof PublishedClipboardReceipt]);
}

function decodePublicationReceipt(value: unknown, port: number, token: string, expectedPath: string): PublishedClipboardReceipt {
    if (!value || typeof value !== "object") throw new Error("Clipboard commit receipt is unavailable");
    const record = value as Record<string, unknown>;
    const keys = ["path", "bytes", "device", "inode", "birthtime", "mtime", "ctime"];
    if (Object.keys(record).length !== keys.length || keys.some(key => typeof record[key] !== "string")
        || record.path !== expectedPath || record.bytes !== `${port}:${token}`
        || keys.slice(2).some(key => !/^[0-9]+$/.test(record[key] as string))) throw new Error("Invalid clipboard commit receipt");
    return Object.freeze({ path: record.path as string, bytes: record.bytes as string, device: record.device as string,
        inode: record.inode as string, birthtime: record.birthtime as string, mtime: record.mtime as string, ctime: record.ctime as string });
}

function writeRetiredPublication(receipt: PublishedClipboardReceipt, guard: RuntimeBindGuard): void {
    const snapshot = readRuntimeBindAuthority(guard);
    const relativePath = relative(resolve(guard.root), receipt.path);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
        || !/^[1-9][0-9]{0,4}:[a-f0-9]{32}$/.test(receipt.bytes)) throw new Error("Invalid clipboard retirement authority");
    for (let path = dirname(receipt.path); ; path = dirname(path)) {
        const parent = lstatSync(path);
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Clipboard retirement parent changed");
        if (path === resolve(guard.root)) break;
        if (dirname(path) === path) throw new Error("Clipboard retirement is outside its guard");
    }
    const current = capturePortFile(receipt.path);
    if (!current || !publicationMatches(receipt, current)) throw new Error("Clipboard publication was replaced");
    assertRuntimeBindAuthorityCurrent(guard, snapshot);
    const fd = openSync(receipt.path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const stat = fstatSync(fd, { bigint: true });
        const named = lstatSync(receipt.path, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || !portPathMatches(stat, named)
            || String(stat.dev) !== receipt.device || String(stat.ino) !== receipt.inode
            || String(stat.birthtimeNs) !== receipt.birthtime || String(stat.mtimeNs) !== receipt.mtime || String(stat.ctimeNs) !== receipt.ctime) {
            throw new Error("Clipboard publication changed before retirement");
        }
        ftruncateSync(fd, 0);
        writeFileSync(fd, `retired-v1:${receipt.bytes}`);
        fsyncSync(fd);
    } finally { closeSync(fd); }
}

function markPortRetired(record: ClipboardPortRecord, path: string, guard: RuntimeBindGuard): void {
    const receipt = portReceipts.get(record);
    // Consume even a failed terminal writer; never retry against a successor.
    try {
        if (!receipt) throw new Error("Clipboard retirement lacks its captured publication");
        writeRetiredPublication(publicationReceipt(path, receipt), guard);
    } finally { portReceipts.delete(record); }
}

// === Server Shutdown (used for version upgrade restart) ===

function shutdownServer(port: number, token?: string): Promise<boolean> {
    return new Promise((resolve) => {
        let req: ReturnType<typeof httpRequest> | undefined;
        const timeout = setTimeout(() => { req?.destroy(); resolve(false); }, SHUTDOWN_TIMEOUT_MS);
        const finish = (acknowledged: boolean) => { clearTimeout(timeout); resolve(acknowledged); };
        try {
            const headers: Record<string, string> = {};
            if (token) headers["Authorization"] = `Bearer ${token}`;
            req = httpRequest(
                { hostname: "127.0.0.1", port, path: "/shutdown", method: "POST", headers },
                (res) => {
                    res.on("error", () => finish(false));
                    let body = "";
                    res.on("data", chunk => {
                        body += chunk;
                        if (Buffer.byteLength(body) > 1024) { req?.destroy(); finish(false); }
                    });
                    res.on("end", () => {
                        try {
                            const value = JSON.parse(body);
                            finish(res.statusCode === 200 && value.service === "ccc-clipboard"
                                && value.retirement === WRITER_SETTLEMENT && value.settled === true);
                        } catch { finish(false); }
                    });
                },
            );
            req.on("error", () => finish(false));
            req.end();
        } catch {
            finish(false);
        }
    });
}

// === Health Check ===

interface HealthResult {
    alive: boolean;
    version?: string;
    retirement?: "writer-settlement-v1";
}

function checkServerHealth(port: number, expectedToken: string, bindAddr: string): Promise<HealthResult> {
    return new Promise((resolve, reject) => {
        let req: ReturnType<typeof httpRequest> | undefined;
        let settled = false;
        const timeout = setTimeout(() => finish({ alive: false }, true), HEALTH_CHECK_TIMEOUT_MS);
        const finish = (health: HealthResult, destroyUnfinished = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (destroyUnfinished) {
                try { req?.destroy(); } catch { /* Keep the health result when cleanup fails. */ }
            }
            resolve(health);
        };
        try {
            req = httpRequest(
                { hostname: bindAddr, port, path: "/health", method: "GET", headers: { "Authorization": `Bearer ${expectedToken}` }, timeout: HEALTH_CHECK_TIMEOUT_MS },
                (res) => {
                    let data = "";
                    res.on("data", (chunk) => {
                        if (settled) return;
                        data += chunk;
                        if (Buffer.byteLength(data) > 4096) finish({ alive: false }, true);
                    });
                    res.on("error", () => finish({ alive: false }, true));
                    res.on("aborted", () => finish({ alive: false }, true));
                    res.on("end", () => {
                        if (settled) return;
                        try {
                            const json = JSON.parse(data);
                            const alive = json.service === "ccc-clipboard" && json.valid === true;  // valid only present when auth header sent
                            finish({ alive, version: json.version, ...(alive && json.retirement === WRITER_SETTLEMENT ? { retirement: WRITER_SETTLEMENT } : {}) });
                        } catch {
                            finish({ alive: false });
                        }
                    });
                },
            );
            req.on("error", () => finish({ alive: false }, true));
            req.end();
        } catch (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            try { req?.destroy(); } catch { /* Preserve the synchronous request failure. */ }
            reject(error);
        }
    });
}

// === Exported Functions (used by index.ts) ===

/**
 * Ensure a clipboard server is running. Returns the port number.
 * If a server is already running (verified via health check + token), reuses it.
 * Otherwise starts a new detached server process.
 */
function launchClipboardDaemon(serverScript: string, publish: (record: ClipboardPortRecord) => unknown, publicationPath: string): Promise<ChildProcess> {
    const runtimeInvocation = peekRuntimeInvocation();
    if (!runtimeInvocation) return Promise.reject(new Error("Clipboard runtime authority is unavailable"));
    return new Promise((resolve, reject) => {
        const deadline = performance.now() + DAEMON_START_TIMEOUT_MS;
        const child = spawn(process.execPath, [serverScript, "--serve", "--parent-publisher"], {
            detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
        });
        let active = true;
        let ready = false;
        const finish = (error?: Error) => {
            if (!active) return;
            active = false;
            clearTimeout(timer);
            child.removeListener("message", onMessage);
            child.removeListener("error", onError);
            child.removeListener("exit", onExit);
            child.removeListener("disconnect", onDisconnect);
            if (error) {
                try { child.disconnect(); } catch { /* The private channel may already be closed. */ }
                reject(error);
            } else {
                try { child.disconnect(); } catch { /* The committed child can disconnect first. */ }
                resolve(child);
            }
        };
        const onError = () => finish(new Error("Clipboard daemon startup failed"));
        const onExit = () => finish(new Error("Clipboard daemon exited before publication committed"));
        const onDisconnect = () => finish(new Error("Clipboard daemon disconnected before publication committed"));
        const onMessage = (message: unknown) => {
            if (!active) return;
            if (performance.now() >= deadline) {
                finish(new Error("Clipboard daemon publication timed out"));
                return;
            }
            if (!message || typeof message !== "object" || !("type" in message)) return;
            if (message.type === "ready" && !ready && "port" in message && "token" in message
                && typeof message.port === "number" && Number.isInteger(message.port) && Number(message.port) > 0 && Number(message.port) <= 65535
                && typeof message.token === "string" && /^[a-f0-9]{32}$/.test(message.token)) {
                ready = true;
                try {
                    if (performance.now() >= deadline) {
                        finish(new Error("Clipboard daemon publication timed out"));
                        return;
                    }
                    const receipt = publish({ port: Number(message.port), token: message.token });
                    // A synchronous write begun in budget cannot be cancelled. Do
                    // not commit a late result or give its child a terminal writer.
                    if (performance.now() >= deadline) {
                        finish(new Error("Clipboard daemon publication timed out"));
                        return;
                    }
                    child.send({ type: "published", receipt }, error => { if (error) onError(); });
                } catch { finish(new Error("Clipboard publication authority changed")); }
            } else if (message.type === "committed" && ready) finish();
        };
        const timer = setTimeout(() => finish(new Error("Clipboard daemon publication timed out")), Math.max(0, deadline - performance.now()));
        child.on("message", onMessage);
        child.once("error", onError);
        child.once("exit", onExit);
        child.once("disconnect", onDisconnect);
        if (performance.now() >= deadline) { finish(new Error("Clipboard daemon publication timed out")); return; }
        try { child.send({ type: "initialize", runtimeInvocation, publicationPath }, error => { if (error) onError(); }); }
        catch { onError(); }
    });
}

function createNativeClipboardLifecycle(publicationPath = currentClipboardPortFile()) {
    let homePreparation: RuntimeBindHomePreparation | undefined;
    const generation = /^[a-f0-9]{12}$/.test(SERVER_VERSION) && publicationPath === currentClipboardPortFile() ? SERVER_VERSION : undefined;
    return createClipboardServerLifecycle({
        generation,
        readPortFile: (path = publicationPath) => readPortFile(path),
        portRecordMatches,
        portFilePath: () => publicationPath,
        startupLockPath: () => {
            // The startup slot can create the root: capture exclusive genesis first.
            homePreparation ??= prepareRuntimeBindHome(cccHome());
            return clipboardStartupPath(publicationPath);
        },
        tryAcquireStartupLock: tryAcquireClipboardStartupLock,
        recoverDeadStartupLock: recoverDeadClipboardStartupLock,
        releaseStartupLock: (lock) => { releaseClipboardStartupLock(lock); return undefined; },
        checkHealth: checkServerHealth,
        requestShutdown: shutdownServer,
        withGlobalGuard: <T>(operation: (guard: RuntimeBindGuard) => Promise<T>) => {
            const invocation = getRuntimeInvocation(); // Capture outside the guarded inventory budget.
            return runWithNativeRuntimeInvocation(invocation, () => withRuntimeBindGuardAsync(homePreparation ?? cccHome(), operation));
        },
        hasOtherSessions: (requester?: SessionOwnershipReceipt) => hasAnyActiveSessionsExcept(requester ?? null),
        portMayHaveBindUsers: clipboardPortMayHaveBindUsers,
        preparePublication: preparePortPublication,
        markRetired: markPortRetired,
        warnUpgradeDeferred: () => {
            console.warn("[ccc] Clipboard update deferred: shared session, bind, or writer ownership could not be excluded. Keeping the authenticated existing bridge.");
            return undefined;
        },
        now: () => performance.now(),
        sleep: (milliseconds) => new Promise((r) => setTimeout(r, milliseconds)),
        daemonScriptPath: () => fileURLToPath(import.meta.url).replace(/\.ts$/, ".js"),
        launchDaemon: (script, publish) => launchClipboardDaemon(script, publish, publicationPath),
        unrefDaemon: (child) => { child.unref(); return undefined; },
    }, SERVER_VERSION);
}

export function ensureClipboardSelection(requester?: SessionOwnershipReceipt): Promise<ClipboardSelection | null> {
    return createNativeClipboardLifecycle().ensureClipboardSelection(requester);
}
export function ensureClipboardServer(requester?: SessionOwnershipReceipt): Promise<number> {
    return createNativeClipboardLifecycle().ensureClipboardServer(requester);
}
export function stopClipboardServerIfLast(hasOtherActiveSessions: boolean): Promise<void> {
    return createNativeClipboardLifecycle().stopClipboardServerIfLast(hasOtherActiveSessions);
}
export function retireClipboardServerFromPortFile(portFile: string): Promise<void> {
    return createNativeClipboardLifecycle(portFile).retireClipboardServerFromPortFile(portFile);
}

/**
 * Check if there are any active CCC sessions besides the given lock file.
 */
export function hasAnyActiveSessionsExcept(currentLockFile: string | SessionOwnershipReceipt | null, directory: string = locksDir()): boolean {
    const requester = typeof currentLockFile === "object" && currentLockFile !== null ? currentLockFile : null;
    let locks: string[];
    try {
        locks = readdirSync(directory).filter((f) => f.endsWith(".lock"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        // Failure to enumerate locks is not proof that no sessions exist.
        return true;
    }
    return locks.some((f) => {
        const lockPath = join(directory, f);
        if (requester && requester.ownerPid === process.pid && requester.path === lockPath && nativeSessionOwnershipMatches(requester)) return false;
        // Unknown, replaced and nonregular claims veto a shared mutation.
        try {
            const receipt = captureNativeSessionOwnership(lockPath);
            const liveness = sessionLockLiveness(Buffer.from(receipt.bytes, "base64").toString("utf8"));
            return liveness !== "stale";
        } catch {
            // A read failure is not proof that the owning session exited.
            return true;
        }
    });
}

// === Standalone Entry Point ===
// When run with --serve flag, start the HTTP server directly

const isMainModule = process.argv[1] &&
    (process.argv[1].endsWith("clipboard-server.js") || process.argv[1].endsWith("clipboard-server.ts"));

if (isMainModule && process.argv.includes("--serve")) {
    if (!process.argv.includes("--parent-publisher")) {
        // A direct entrance owns the ordinary startup/global admission itself.
        // It never races the parent-owned child publisher by reacquiring its guard.
        void ensureClipboardSelection().then(selected => {
            if (!selected) process.exitCode = 1;
        }).catch(() => { console.error("Clipboard startup admission failed; existing state was preserved."); process.exitCode = 1; });
    } else {
        const publicationDeadline = performance.now() + DAEMON_START_TIMEOUT_MS;
        let initialized = false;
        let committed = false;
        let publicationEnabled = true;
        let daemon: ReturnType<typeof createClipboardServer> | undefined;
        let publishedReceipt: PublishedClipboardReceipt | undefined;
        let daemonPort: number | undefined;
        let daemonToken: string | undefined;
        let publicationPath: string | undefined;
        const stop = () => {
            publicationEnabled = false;
            publishedReceipt = undefined;
            clearTimeout(timer);
            if (daemon) daemon.shutdown();
            else process.exit(1);
        };
        const timer = setTimeout(stop, Math.max(0, publicationDeadline - performance.now()));
        process.once("disconnect", () => { if (!committed) stop(); });
        process.on("message", (message: unknown) => {
            if (!publicationEnabled) return;
            if (!committed && performance.now() >= publicationDeadline) { stop(); return; }
            if (!message || typeof message !== "object" || !("type" in message)) return;
            if (message.type === "published" && initialized && daemon?.server.listening && publicationEnabled && !committed) {
                try {
                    if (!("receipt" in message) || daemonPort === undefined || !daemonToken || !publicationPath) { stop(); return; }
                    if (performance.now() >= publicationDeadline) { stop(); return; }
                    const receipt = decodePublicationReceipt(message.receipt, daemonPort, daemonToken, publicationPath);
                    const current = capturePortFile(receipt.path);
                    if (!current || !publicationMatches(receipt, current)) { stop(); return; }
                    // Descriptor reads can outlast the budget even when their
                    // message preceded the timer. Never adopt a late writer.
                    if (performance.now() >= publicationDeadline) { stop(); return; }
                    publishedReceipt = receipt;
                } catch { stop(); return; }
                committed = true;
                clearTimeout(timer);
                process.send?.({ type: "committed" }, error => { if (error) stop(); });
                return;
            }
            if (message.type !== "initialize" || initialized || !publicationEnabled || !("runtimeInvocation" in message)) return;
            if (performance.now() >= publicationDeadline) { stop(); return; }
            initialized = true;
            try {
                const invocation = validateNativeRuntimeInvocation(message.runtimeInvocation);
                const path = "publicationPath" in message ? message.publicationPath : clipboardPortFile();
                if (typeof path !== "string" || (path !== clipboardPortFile() && path !== currentClipboardPortFile())) { stop(); return; }
                publicationPath = path;
                const token = randomBytes(16).toString("hex");
                daemonToken = token;
                const plat = detectPlatform();
                if (plat === "darwin") compileDarwinHelperAsync();
                daemon = createClipboardServer(token, plat, {
                    disablePublication: () => { publicationEnabled = false; },
                    publicationCommitted: () => committed,
                    retirePublication: guard => {
                        const receipt = publishedReceipt;
                        publishedReceipt = undefined;
                        if (guard && receipt) writeRetiredPublication(receipt, guard);
                    },
                    runtimeInvocation: invocation,
                    publicationPath,
                });
                void daemon.start("127.0.0.1").then(port => {
                    if (!publicationEnabled || !process.connected || performance.now() >= publicationDeadline) { stop(); return; }
                    daemonPort = port;
                    process.send?.({ type: "ready", port, token }, error => { if (error) stop(); });
                }).catch(stop);
            } catch { stop(); }
        });
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
        process.on("uncaughtException", stop);
        process.on("unhandledRejection", stop);
    }
}
