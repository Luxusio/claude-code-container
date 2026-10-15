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
        ];
        const hash = createHash("sha256").update("ccc-clipboard-policy-v1\0");
        for (const file of files) {
            const content = readFileSync(join(directory, file), "utf-8");
            hash.update(file).update("\0").update(String(Buffer.byteLength(content, "utf8")))
                .update("\0").update(content).update("\0");
        }
        return hash.digest("hex").slice(0, 12);
    } catch { return "unknown"; }
}
const SERVER_VERSION = getServerHash();

// === Constants ===
// Paths resolve on every use: the ~/.ccc layout can migrate after this module loads
// (doc/common/REQ__ccc-home-layout.md).
const CLIPBOARD_SERVER_ORPHAN_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;


const SHUTDOWN_TIMEOUT_MS = 2000;


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
interface PreparedClipboardTextWriter { command: string; args: string[]; input: Buffer }
function prepareClipboardTextWriter(bytes: Buffer, plat: ClipboardPlatform): PreparedClipboardTextWriter | null {
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
    return { kind: "ready", write: (timeoutMs) => executeClipboardTextWrite(prepared, plat, timeoutMs) };
}

function executeClipboardTextWrite(
    prepared: PreparedClipboardTextWriter,
    plat: ClipboardPlatform,
    timeoutMs: number,
): Promise<ClipboardTextWriteResult> {
    return new Promise((resolve) => {
        let child: ChildProcess;
        try {
            child = spawn(prepared.command, prepared.args, {
                stdio: ["pipe", "ignore", "ignore"],
                windowsHide: true,
                ...(plat === "darwin" ? { env: { ...process.env, LC_CTYPE: "UTF-8" } } : {}),
            });
        } catch {
            resolve({ kind: "failed" });
            return;
        }
        let settled = false;
        const finish = (success: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ kind: success ? "written" : "failed" });
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
const clipboardLifecycle = createClipboardServerLifecycle({
    readPortFile,
    portFilePath: () => clipboardPortFile(),
    startupLockPath: () => clipboardStartingLock(),
    tryAcquireStartupLock: tryAcquireClipboardStartupLock,
    recoverDeadStartupLock: recoverDeadClipboardStartupLock,
    releaseStartupLock: (lock) => { releaseClipboardStartupLock(lock); return undefined; },
    checkHealth: checkServerHealth,
    requestShutdown: shutdownServer,
    portMayHaveBindUsers: clipboardPortMayHaveBindUsers,
    warnUpgradeDeferred: () => {
        console.warn("[ccc] Clipboard update deferred: running container bind users could not be excluded. Keeping the authenticated existing bridge; retry after its container users stop.");
        return undefined;
    },
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((r) => setTimeout(r, milliseconds)),
    daemonScriptPath: () => fileURLToPath(import.meta.url).replace(/\.ts$/, ".js"),
    launchDaemon: (serverScript) => spawn(process.execPath, [serverScript, "--serve"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    }),
    unrefDaemon: (child) => { child.unref(); return undefined; },
}, SERVER_VERSION);
const { ensureClipboardServer, stopClipboardServerIfLast, retireClipboardServerFromPortFile } = clipboardLifecycle;
export { ensureClipboardServer, stopClipboardServerIfLast, retireClipboardServerFromPortFile };

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


/** Ask the server recorded in a pre-layout port file to shut down. */


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
