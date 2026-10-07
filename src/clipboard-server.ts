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
    existsSync,
    readFileSync,
    writeFileSync,
    copyFileSync,
    readdirSync,
    openSync,
    closeSync,
    mkdirSync,
} from "fs";
import { join, dirname, basename } from "path";
import { platform } from "os";
import { fileURLToPath } from "url";
import { CLIPBOARD_FILES_CONTAINER_DIR } from "./utils.js";
import { clipboardFilesDir, clipboardPortFile, clipboardStartingLock, helperBinDir, locksDir } from "./home-layout.js";
import { tryAcquireClipboardStartupLock, recoverDeadClipboardStartupLock, releaseClipboardStartupLock } from "./clipboard-startup-lock.js";
import { clipboardPortMayHaveBindUsers } from "./clipboard-bind-users.js";
import { sessionLockLiveness } from "./session-lock-liveness.js";
import { canonicalWindowsPowerShellPath, hiddenWindowsPowerShellArgs } from "@ccc/device-lab/windows-system-powershell.js";

// === Version (for auto-restart on upgrade) ===
// Uses content hash of the compiled server file so ANY code change triggers restart
function getServerHash(): string {
    try {
        const __fn = fileURLToPath(import.meta.url);
        const content = readFileSync(__fn, "utf-8");
        return createHash("sha256").update(content).digest("hex").slice(0, 12);
    } catch { return "unknown"; }
}
const SERVER_VERSION = getServerHash();

// === Constants ===
// Paths resolve on every use: the ~/.ccc layout can migrate after this module loads
// (doc/common/REQ__ccc-home-layout.md).
export const CLIPBOARD_SERVER_ORPHAN_GRACE_MS = 15000;
const CLIPBOARD_SERVER_ORPHAN_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const STARTUP_POLL_INTERVAL_MS = 100;
const STARTUP_POLL_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 2000;
const UPGRADE_SHUTDOWN_GRACE_MS = 3500;
const STARTUP_LOCK_TIMEOUT_MS = HEALTH_CHECK_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS
    + UPGRADE_SHUTDOWN_GRACE_MS + STARTUP_POLL_TIMEOUT_MS + 1000;
const PS_MARKER = "<<<CCC_CB_DONE>>>";
export const MAX_CLIPBOARD_TEXT_BYTES = 1048576;
const CLIPBOARD_WRITE_TIMEOUT_MS = 5000;

// === Security Helpers ===
function safeCompare(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

// === Platform Detection ===
export type ClipboardPlatform = "darwin" | "linux-x11" | "linux-wayland" | "wsl" | "windows" | "unsupported";

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
export async function writeClipboardText(text: string, plat: ClipboardPlatform): Promise<void> {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_CLIPBOARD_TEXT_BYTES || text.includes("\0") || bytes.toString("utf8") !== text) {
        throw new Error("Invalid clipboard text");
    }
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
            if (!powershell) throw new Error("Clipboard writer unavailable");
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
            throw new Error("Clipboard writer unavailable");
    }

    invalidateClipboardCache();
    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(command, args, {
                stdio: ["pipe", "ignore", "ignore"],
                windowsHide: true,
                ...(plat === "darwin" ? { env: { ...process.env, LC_CTYPE: "UTF-8" } } : {}),
            });
            let settled = false;
            const finish = (success: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (success) resolve();
                else reject(new Error("Clipboard write failed"));
            };
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                finish(false);
            }, CLIPBOARD_WRITE_TIMEOUT_MS);
            child.once("error", () => finish(false));
            // Clipboard tools fork a selection owner; inherited pipes must not
            // keep a completed upload waiting for that owner to exit.
            child.once("exit", (code) => finish(code === 0));
            child.stdin!.on("error", () => {
                child.kill("SIGKILL");
                finish(false);
            });
            child.stdin!.end(input);
        });
    } finally {
        // Also discard reads started while the native command was running.
        invalidateClipboardCache();
    }
}

class ClipboardUploadError extends Error {
    constructor(readonly status: number) {
        super("Invalid clipboard upload");
    }
}

function readClipboardUpload(req: IncomingMessage): Promise<string> {
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
            if (size > MAX_CLIPBOARD_TEXT_BYTES) finish(new ClipboardUploadError(413));
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

function darwinHelperSourceHashFile(): string {
    return join(helperBinDir(), "clipboard-helper-darwin.hash");
}

function darwinHelperBinary(): string {
    return join(helperBinDir(), "clipboard-helper-darwin");
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

/**
 * Fast check: is the native helper binary ready to use?
 * No compilation — just checks if binary exists. Used at request time.
 */
function isDarwinHelperReady(): string | null {
    if (platform() !== "darwin") return null;
    if (!existsSync(darwinHelperBinary())) return null;
    return darwinHelperBinary();
}

/**
 * Background compile: build the Objective-C helper binary if needed.
 * Non-blocking — uses async spawn so the server can serve requests immediately.
 * First requests fall back to osascript; once compile finishes, native helper is used.
 */
function compileDarwinHelperAsync(): void {
    try {
        const __fn = fileURLToPath(import.meta.url);
        const sourcePath = join(dirname(__fn), "..", "scripts", "clipboard-helper-darwin.m");
        if (!existsSync(sourcePath)) return;

        const sourceContent = readFileSync(sourcePath, "utf-8");
        const sourceHash = createHash("sha256").update(sourceContent).digest("hex").slice(0, 16);

        // Already up-to-date?
        if (existsSync(darwinHelperBinary())) {
            try {
                const existingHash = readFileSync(darwinHelperSourceHashFile(), "utf-8").trim();
                if (existingHash === sourceHash) return;
            } catch { /* recompile */ }
        }

        const binDir = helperBinDir();
        mkdirSync(binDir, { recursive: true });

        const child = spawn("cc", [
            "-framework", "AppKit", "-framework", "Foundation",
            "-O2", "-o", darwinHelperBinary(), sourcePath,
        ], { stdio: "ignore" });

        child.on("close", (code) => {
            if (code === 0) {
                try { writeFileSync(darwinHelperSourceHashFile(), sourceHash); } catch { /* ignore */ }
            }
        });
    } catch { /* compilation unavailable — osascript fallback will be used */ }
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
export const CACHE_TTL_MS = 200; // Short no-marker fallback; marker platforms can reuse longer safely.
interface ClipboardSnapshot {
    timestamp: number;
    marker?: string | null;
    targets: string[];
    text: Buffer | null;
    imagePng: Buffer | null;
    imageBmp: Buffer | null;
}
let clipboardCache: ClipboardSnapshot | null = null;
let clipboardCacheGeneration = 0;
let clipboardReadQueue: Promise<unknown> = Promise.resolve();

function invalidateClipboardCache(): void {
    clipboardCacheGeneration += 1;
    clipboardCache = null;
}

export function shouldReuseClipboardCache(
    cache: Pick<ClipboardSnapshot, "timestamp" | "marker"> | null,
    now: number,
    marker: string | null,
    ttlMs = CACHE_TTL_MS,
): boolean {
    if (!cache) return false;
    if (marker !== null) return cache.marker === marker;
    return now - cache.timestamp < ttlMs;
}

const IMAGE_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/tiff",
    "image/bmp",
];

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

function isSupportedImageTarget(target: string): boolean {
    return IMAGE_MIME_TYPES.includes(target.toLowerCase());
}

export function buildImageMimeReadOrder(targets: string[], preferred: "png" | "bmp" = "png"): string[] {
    const preferredMime = preferred === "bmp" ? "image/bmp" : "image/png";
    const ordered = [
        preferredMime,
        ...targets.map((target) => target.toLowerCase()).filter(isSupportedImageTarget),
        ...IMAGE_MIME_TYPES,
    ];
    return [...new Set(ordered)];
}

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

    for (const filePath of paths) {
        const image = readImageFile(filePath);
        if (image) {
            return {
                targets: ["image/png", "application/x-ccc-image-file"],
                text: null,
                imagePng: image,
                imageBmp: null,
            };
        }
    }

    for (const filePath of paths) {
        const copiedPath = copyImageFile(filePath);
        if (copiedPath) return withCopiedImageFileTextFallback(copiedPath);
    }

    return withCopiedImageFileTextFallback(null);
}

function withCopiedImageFileTextFallback(
    text: Buffer | null,
): Omit<ClipboardSnapshot, "timestamp"> {
    return {
        targets: text ? ["text/plain", "application/x-ccc-copied-image-file"] : [],
        text,
        imagePng: null,
        imageBmp: null,
    };
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
async function readAllClipboardDarwin(): Promise<Omit<ClipboardSnapshot, "timestamp">> {
    // Try native helper first (persistent process, ~5ms per read)
    const nativeOutput = await runDarwinCommand();
    if (nativeOutput !== null) {
        const parsed = parseDarwinHelperOutput(nativeOutput);
        if (!parsed) throw new ClipboardReadError();
        if (parsed.imagePng) return parsed;

        // A successful native read may contain only a file reference or an
        // image representation that NSImage could not decode. Do not bypass
        // the existing fallbacks just because the helper is installed.
        const converted = execCommand("pngpaste", ["-"]);
        if (converted.status === 0 && converted.stdout.length > 0) {
            return { ...parsed, targets: [...new Set([...parsed.targets, "image/png"])], imagePng: converted.stdout };
        }
        const fileFallback = readDarwinClipboardImageFileFallback();
        if (fileFallback.targets.length > 0) return { ...fileFallback, marker: parsed.marker };
        if (parsed.text) {
            const textFallback = buildImageFileClipboardFallbackFromPaths(
                parseClipboardImagePathText(parsed.text.toString("utf8")),
            );
            if (textFallback.targets.length > 0) return { ...textFallback, marker: parsed.marker };
        }
        return parsed;
    }

    // Fallback: parallel osascript + pbpaste (~250ms)
    const [imgResult, textResult] = await Promise.all([
        execCommandAsync("osascript", ["-e",
            'try\nset d to the clipboard as «class PNGf»\nreturn d\nend try']),
        execCommandAsync("pbpaste", []),
    ]);
    if (imgResult.status !== 0 || textResult.status !== 0) throw new ClipboardReadError();

    const targets: string[] = [];
    let imagePng: Buffer | null = null;
    let text: Buffer | null = null;

    if (imgResult.status === 0 && imgResult.stdout.length > 0) {
        imagePng = parseAppleScriptImageData(imgResult.stdout);
    }
    // Fallback: pngpaste outputs raw PNG binary
    if (!imagePng) {
        const r = execCommand("pngpaste", ["-"]);
        if (r.status === 0 && r.stdout.length > 0) {
            imagePng = r.stdout;
        }
    }
    if (imagePng) targets.push("image/png");

    if (!imagePng) {
        const fileFallback = readDarwinClipboardImageFileFallback();
        if (fileFallback.targets.length > 0) return fileFallback;
    }

    if (textResult.status === 0 && textResult.stdout.length > 0) {
        text = textResult.stdout;
        if (!imagePng) {
            const textPathFallback = buildImageFileClipboardFallbackFromPaths(
                parseClipboardImagePathText(text.toString("utf-8")),
            );
            if (textPathFallback.targets.length > 0) return textPathFallback;
        }
        targets.push("text/plain");
    }

    return { targets, text, imagePng, imageBmp: null };
}

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

function readDarwinClipboardImageFileFallback(): Omit<ClipboardSnapshot, "timestamp"> {
    const r = execCommand("osascript", ["-e", [
        "try",
        "set f to the clipboard as «class furl»",
        "return POSIX path of f",
        "end try",
    ].join("\n")]);
    if (r.status !== 0 || r.stdout.length === 0) return withCopiedImageFileTextFallback(null);
    return buildImageFileClipboardFallbackFromPaths(r.stdout.toString("utf-8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

function readLinuxClipboardUriList(plat: ClipboardPlatform, targets: string[]): string[] {
    const candidateTargets = [
        ...targets.filter((target) => target === "text/uri-list" || target === "x-special/gnome-copied-files"),
        "text/uri-list",
        "x-special/gnome-copied-files",
    ];
    for (const target of [...new Set(candidateTargets)]) {
        const r = plat === "linux-x11"
            ? execCommand("xclip", ["-selection", "clipboard", "-t", target, "-o"])
            : execCommand("wl-paste", ["--type", target]);
        if (r.status === 0 && r.stdout.length > 0) {
            const paths = parseClipboardFileUriList(r.stdout.toString("utf-8"));
            if (paths.length > 0) return paths;
        }
    }
    return [];
}

function readLinuxClipboardImageFileFallback(plat: ClipboardPlatform, targets: string[]): Omit<ClipboardSnapshot, "timestamp"> {
    return buildImageFileClipboardFallbackFromPaths(readLinuxClipboardUriList(plat, targets));
}

function getCachedClipboard(plat: ClipboardPlatform, forceRefresh = false): Promise<ClipboardSnapshot> {
    const read = clipboardReadQueue.then(() => readAndCacheClipboard(plat, forceRefresh));
    clipboardReadQueue = read.catch(() => {});
    return read;
}

async function readAndCacheClipboard(plat: ClipboardPlatform, forceRefresh: boolean): Promise<ClipboardSnapshot> {
    // A native read can finish after a successful POST. Never publish its old
    // snapshot into the cache or return it to a waiting HTTP reader.
    while (true) {
        const generation = clipboardCacheGeneration;
        const snapshot = await readClipboardSnapshot(plat, forceRefresh);
        if (generation !== clipboardCacheGeneration) continue;
        clipboardCache = snapshot;
        return snapshot;
    }
}

async function readClipboardSnapshot(plat: ClipboardPlatform, forceRefresh: boolean): Promise<ClipboardSnapshot> {
    const now = Date.now();
    const marker = await readClipboardChangeMarker(plat);
    const cached = clipboardCache;
    const negativeCacheFresh = cached && (cached.imagePng || cached.imageBmp || now - cached.timestamp < CACHE_TTL_MS);
    if (cached && negativeCacheFresh && !forceRefresh && shouldReuseClipboardCache(cached, now, marker)) {
        return cached;
    }

    if (plat === "windows" || plat === "wsl" || plat === "darwin") {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const snapshot = plat === "darwin" ? await readAllClipboardDarwin() : await readAllClipboardWindows();
            const after = await readClipboardChangeMarker(plat);
            // macOS without its optional helper retains the legacy fallback,
            // but never borrows an unrelated marker for those separate reads.
            if (snapshot.marker == null) {
                if (plat !== "darwin" || marker !== null || after !== null) throw new ClipboardReadError();
                return { timestamp: Date.now(), ...snapshot, marker: null };
            }
            if (snapshot.marker === after) return { timestamp: Date.now(), ...snapshot };
        }
        throw new ClipboardReadError();
    }

    // Linux: individual calls
    const targets = readClipboardTargets(plat);
    const hasImage = targets.some(isSupportedImageTarget);
    const hasText = targets.some(t => t.includes("text/plain") || t === "STRING" || t === "UTF8_STRING");
    const text = hasText ? readClipboardText(plat) : null;
    const imagePng = hasImage ? readClipboardImage(plat, "png", targets) : null;
    const imageBmp = hasImage ? readClipboardImage(plat, "bmp", targets) : null;

    if (!imagePng && !imageBmp) {
        const fileFallback = readLinuxClipboardImageFileFallback(plat, targets);
        if (fileFallback.targets.length > 0) {
            return {
                timestamp: now,
                marker: null,
                ...fileFallback,
            };
        }

        if (text) {
            const textPathFallback = buildImageFileClipboardFallbackFromPaths(
                parseClipboardImagePathText(text.toString("utf-8")),
            );
            if (textPathFallback.targets.length > 0) {
                return {
                    timestamp: now,
                    marker: null,
                    ...textPathFallback,
                };
            }
        }
    }

    // Filter targets: remove image types if actual image data is null/empty,
    // and remove text/plain if actual text data is null/empty
    const filteredTargets = targets.filter(t => {
        if (isSupportedImageTarget(t)) return imagePng !== null || imageBmp !== null;
        if (t.includes("text/plain") || t === "STRING" || t === "UTF8_STRING") return text !== null;
        return true;
    });

    return {
        timestamp: now,
        marker: null,
        targets: filteredTargets,
        text,
        imagePng,
        imageBmp,
    };
}

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

// === Graceful Shutdown ===

function gracefulShutdown(server: Server, idleTimer?: ReturnType<typeof setInterval>): void {
    if (idleTimer) clearInterval(idleTimer);
    killPersistentPS();
    killPersistentDarwin();
    server.close(() => {
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
}

export function clipboardServerOrphanWatchdogState(
    now: number,
    noActiveSessionsSince: number | null,
    hasActiveSessions: boolean,
): { noActiveSessionsSince: number | null; shouldShutdown: boolean } {
    if (hasActiveSessions) return { noActiveSessionsSince: null, shouldShutdown: false };
    const since = noActiveSessionsSince ?? now;
    return {
        noActiveSessionsSince: since,
        shouldShutdown: now - since >= CLIPBOARD_SERVER_ORPHAN_GRACE_MS,
    };
}

// === HTTP Server ===

export function createClipboardServer(token: string, plat: ClipboardPlatform): { server: Server; start: (bindAddr: string) => Promise<number> } {
    let noActiveSessionsSince: number | null = null;
    let idleTimer: ReturnType<typeof setInterval>;

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
                res.end(JSON.stringify({ service: "ccc-clipboard", ...(isValid ? { version: SERVER_VERSION, valid: true } : {}) }));
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
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("shutting down");
                gracefulShutdown(server, idleTimer);
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
        const state = clipboardServerOrphanWatchdogState(
            Date.now(),
            noActiveSessionsSince,
            hasAnyActiveSessionsExcept(null),
        );
        noActiveSessionsSince = state.noActiveSessionsSince;
        if (state.shouldShutdown) gracefulShutdown(server, idleTimer);
    }, CLIPBOARD_SERVER_ORPHAN_CHECK_INTERVAL_MS);
    server.once("close", () => clearInterval(idleTimer));

    const start = (bindAddr: string): Promise<number> => {
        return new Promise((resolve, reject) => {
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

    return { server, start };
}

// === Port File Management ===

function readPortFile(portFile = clipboardPortFile()): { port: number; token: string } | null {
    try {
        if (!existsSync(portFile)) return null;
        const content = readFileSync(portFile, "utf-8").trim();
        const colonIdx = content.indexOf(":");
        if (colonIdx === -1) return null;
        const portStr = content.substring(0, colonIdx);
        const token = content.substring(colonIdx + 1);
        const port = parseInt(portStr, 10);
        if (isNaN(port) || !token) return null;
        return { port, token };
    } catch {
        return null;
    }
}

function writePortFile(port: number, token: string): void {
    const portFile = clipboardPortFile();
    mkdirSync(dirname(portFile), { recursive: true, mode: 0o700 });
    // Containers bind this file's inode. Publish through a pinned descriptor;
    // stale bytes remain harmless because readers require authenticated health.
    const flags = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    let fd: number;
    try {
        fd = openSync(portFile, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        fd = openSync(portFile, flags);
    }
    try {
        const file = fstatSync(fd);
        const path = lstatSync(portFile);
        const uid = process.getuid?.();
        if (!file.isFile() || file.nlink !== 1 || (uid !== undefined && file.uid !== uid)
            || !path.isFile() || path.dev !== file.dev || path.ino !== file.ino) {
            throw new Error("Unsafe clipboard port file");
        }
        if (uid !== undefined && (file.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
        ftruncateSync(fd, 0);
        writeFileSync(fd, `${port}:${token}`);
    } finally {
        closeSync(fd);
    }
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
                    res.on("end", () => finish(res.statusCode === 200));
                    res.resume();
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
}

function checkServerHealth(port: number, expectedToken: string, bindAddr: string): Promise<HealthResult> {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ alive: false }), HEALTH_CHECK_TIMEOUT_MS);
        const req = httpRequest(
            { hostname: bindAddr, port, path: "/health", method: "GET", headers: { "Authorization": `Bearer ${expectedToken}` }, timeout: HEALTH_CHECK_TIMEOUT_MS },
            (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    clearTimeout(timeout);
                    try {
                        const json = JSON.parse(data);
                        const alive = json.service === "ccc-clipboard" && json.valid === true;  // valid only present when auth header sent
                        resolve({ alive, version: json.version });
                    } catch {
                        resolve({ alive: false });
                    }
                });
            },
        );
        req.on("error", () => { clearTimeout(timeout); resolve({ alive: false }); });
        req.end();
    });
}

// === Exported Functions (used by index.ts) ===

/**
 * Ensure a clipboard server is running. Returns the port number.
 * If a server is already running (verified via health check + token), reuses it.
 * Otherwise starts a new detached server process.
 */
export async function ensureClipboardServer(): Promise<number> {
    const bindAddr = "127.0.0.1";

    // Check if server already running
    let existing = readPortFile();
    if (existing) {
        const health = await checkServerHealth(existing.port, existing.token, bindAddr);
        if (health.alive && health.version === SERVER_VERSION) return existing.port;
    }

    const lockPath = clipboardStartingLock();
    let lock = tryAcquireClipboardStartupLock(lockPath);
    if (!lock) {
        const deadline = Date.now() + STARTUP_LOCK_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, STARTUP_POLL_INTERVAL_MS));
            const info = readPortFile();
            if (info && info.token !== existing?.token) {
                const health = await checkServerHealth(info.port, info.token, bindAddr);
                if (health.alive && health.version === SERVER_VERSION) return info.port;
            }
            lock = tryAcquireClipboardStartupLock(lockPath);
            if (lock) break;
            if (recoverDeadClipboardStartupLock(lockPath)) {
                lock = tryAcquireClipboardStartupLock(lockPath);
                if (lock) {
                    // A killed owner may already have sent legacy shutdown.
                    // Wait for delayed cleanup before successor publication.
                    await new Promise((r) => setTimeout(r, UPGRADE_SHUTDOWN_GRACE_MS));
                    break;
                }
            }
        }
        if (!lock) throw new Error(`Clipboard startup is still owned or its owner cannot be verified: ${lockPath}. Retry after the owner finishes; inspect empty or malformed legacy locks before removing them.`);
    }

    // Keep upgrade shutdown, legacy grace and publication under the v2 lock.
    // Legacy cleanup only knows the old lock pathname and cannot release this one.
    try {
        const current = readPortFile();
        if (current) {
            const health = await checkServerHealth(current.port, current.token, bindAddr);
            if (health.alive) {
                if (health.version === SERVER_VERSION) return current.port;
                if (health.version !== SERVER_VERSION) {
                    if (clipboardPortMayHaveBindUsers(clipboardPortFile())) {
                        console.warn("[ccc] Clipboard update deferred: running container bind users could not be excluded. Keeping the authenticated existing bridge; retry after its container users stop.");
                        return current.port;
                    }
                    if (!await shutdownServer(current.port, current.token)) {
                        throw new Error("Failed to acknowledge clipboard server shutdown for upgrade");
                    }
                    // Wait beyond the legacy daemon's 3-second forced exit before publication.
                    await new Promise((r) => setTimeout(r, UPGRADE_SHUTDOWN_GRACE_MS));
                }
            }
        }
        existing = current;

        const __filename = fileURLToPath(import.meta.url);
        const serverScript = __filename.replace(/\.ts$/, ".js");

        const child = spawn(process.execPath, [serverScript, "--serve"], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        });
        child.unref();

        // Wait for the server to write its port file
        const deadline = Date.now() + STARTUP_POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, STARTUP_POLL_INTERVAL_MS));
            const info = readPortFile();
            if (info && info.token !== existing?.token) {
                const health = await checkServerHealth(info.port, info.token, bindAddr);
                if (health.alive && health.version === SERVER_VERSION) return info.port;
            }
        }

        throw new Error("Clipboard server failed to start within timeout");
    } finally {
        releaseClipboardStartupLock(lock);
    }
}

/**
 * Check if there are any active CCC sessions besides the given lock file.
 */
export function hasAnyActiveSessionsExcept(currentLockFile: string | null, directory: string = locksDir()): boolean {
    const currentLockName = currentLockFile ? basename(currentLockFile) : "";
    let locks: string[];
    try {
        locks = readdirSync(directory).filter((f) => f.endsWith(".lock"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        // Failure to enumerate locks is not proof that no sessions exist.
        return true;
    }
    return locks.some((f) => {
        if (f === currentLockName) return false;
        // Use the same conservative lock identity rules as container cleanup.
        const lockPath = join(directory, f);
        try {
            const content = readFileSync(lockPath, "utf-8").trim();
            const liveness = sessionLockLiveness(content);
            return liveness !== "stale";
        } catch {
            // A read failure is not proof that the owning session exited.
            return true;
        }
    });
}

/**
 * Stop the clipboard server when the session module has atomically established
 * that no other session owns the shared container.
 */
export function stopClipboardServerIfLast(hasOtherActiveSessions: boolean): void {
    if (hasOtherActiveSessions) return;

    const info = readPortFile();
    if (!info) return;

    if (clipboardPortMayHaveBindUsers(clipboardPortFile())) return;
    shutdownServer(info.port, info.token);

    // Keep the bind-mounted inode; authenticated health rejects stale state.
}

/** Ask the server recorded in a pre-layout port file to shut down. */
export function retireClipboardServerFromPortFile(portFile: string): void {
    const info = readPortFile(portFile);
    if (info && !clipboardPortMayHaveBindUsers(portFile)) shutdownServer(info.port, info.token);
}

// === Standalone Entry Point ===
// When run with --serve flag, start the HTTP server directly

const isMainModule = process.argv[1] &&
    (process.argv[1].endsWith("clipboard-server.js") || process.argv[1].endsWith("clipboard-server.ts"));

if (isMainModule && process.argv.includes("--serve")) {
    const token = randomBytes(16).toString("hex");
    const plat = detectPlatform();
    const bindAddr = "127.0.0.1";

    // Pre-compile native clipboard helper on macOS (non-blocking background)
    if (plat === "darwin") compileDarwinHelperAsync();

    const { server, start } = createClipboardServer(token, plat);

    start(bindAddr)
        .then((port) => {
            writePortFile(port, token);
        })
        .catch((err) => {
            console.error("Failed to start clipboard server:", err);
            process.exit(1);
        });

    // Handle signals for clean shutdown
    process.once("SIGTERM", () => gracefulShutdown(server));
    process.once("SIGINT", () => gracefulShutdown(server));

    // Graceful shutdown on unexpected errors — don't continue in unknown state
    process.on("uncaughtException", (err) => {
        console.error("clipboard-server uncaughtException:", err);
        gracefulShutdown(server);
    });
    process.on("unhandledRejection", (err) => {
        console.error("clipboard-server unhandledRejection:", err);
        gracefulShutdown(server);
    });
}
