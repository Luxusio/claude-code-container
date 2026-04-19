// src/clipboard-server.ts - Singleton HTTP clipboard server for host-container clipboard bridge
//
// This file serves dual purpose:
// 1. Standalone entry point: when spawned as detached process, starts HTTP server
// 2. Library: exports ensureClipboardServer() and stopClipboardServerIfLast() for index.ts

import { createServer, request as httpRequest, type Server } from "http";
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "child_process";
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import {
    existsSync,
    readFileSync,
    writeFileSync,
    unlinkSync,
    readdirSync,
    openSync,
    closeSync,
    mkdirSync,
} from "fs";
import { join, dirname, basename } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";

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
const DATA_DIR = join(homedir(), ".ccc");
const LOCKS_DIR = join(DATA_DIR, "locks");
const PORT_FILE = join(DATA_DIR, "clipboard.port");
const STARTING_LOCK = join(DATA_DIR, "clipboard.starting");
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const STARTUP_POLL_INTERVAL_MS = 100;
const STARTUP_POLL_TIMEOUT_MS = 5000;
const PS_MARKER = "<<<CCC_CB_DONE>>>";

// === Security Helpers ===
function safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// === Platform Detection ===
type ClipboardPlatform = "darwin" | "linux-x11" | "linux-wayland" | "wsl" | "windows" | "unsupported";

function detectPlatform(): ClipboardPlatform {
    const plat = platform();

    if (plat === "darwin") return "darwin";

    if (plat === "win32") return "windows";

    if (plat === "linux") {
        // Check for WSL
        try {
            const release = readFileSync("/proc/version", "utf-8");
            if (/microsoft|wsl/i.test(release)) return "wsl";
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

const DARWIN_HELPER_SOURCE_HASH_FILE = join(DATA_DIR, "bin", "clipboard-helper-darwin.hash");
const DARWIN_HELPER_BINARY = join(DATA_DIR, "bin", "clipboard-helper-darwin");
const DARWIN_MARKER = PS_MARKER; // Same protocol as Windows

let persistentDarwin: ChildProcess | null = null;

/**
 * Parse JSON output from the native macOS clipboard helper.
 * Format matches Windows PowerShell output for consistency.
 */
export function parseDarwinHelperOutput(output: string): Omit<ClipboardSnapshot, "timestamp"> | null {
    if (!output) return null;
    try {
        const json = JSON.parse(output);
        const rawTargets = json.targets;
        const targets = Array.isArray(rawTargets) ? rawTargets
            : typeof rawTargets === "string" ? [rawTargets]
            : [];
        return {
            targets,
            text: json.text ? Buffer.from(json.text, "utf-8") : null,
            imagePng: json.imagePng ? Buffer.from(json.imagePng, "base64") : null,
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
    if (!existsSync(DARWIN_HELPER_BINARY)) return null;
    return DARWIN_HELPER_BINARY;
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
        if (existsSync(DARWIN_HELPER_BINARY)) {
            try {
                const existingHash = readFileSync(DARWIN_HELPER_SOURCE_HASH_FILE, "utf-8").trim();
                if (existingHash === sourceHash) return;
            } catch { /* recompile */ }
        }

        const binDir = join(DATA_DIR, "bin");
        mkdirSync(binDir, { recursive: true });

        const child = spawn("cc", [
            "-framework", "AppKit", "-framework", "Foundation",
            "-O2", "-o", DARWIN_HELPER_BINARY, sourcePath,
        ], { stdio: "ignore" });

        child.on("close", (code) => {
            if (code === 0) {
                try { writeFileSync(DARWIN_HELPER_SOURCE_HASH_FILE, sourceHash); } catch { /* ignore */ }
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
    child.on("exit", () => { if (persistentDarwin === child) persistentDarwin = null; });

    persistentDarwin = child;
    return persistentDarwin;
}

function runDarwinCommand(timeout = 5000): Promise<string> {
    return new Promise((resolve) => {
        let helper: ChildProcess | null;
        try {
            helper = ensurePersistentDarwin();
        } catch {
            resolve("");
            return;
        }
        if (!helper || !helper.stdin?.writable) {
            resolve("");
            return;
        }

        let output = "";

        const timer = setTimeout(() => {
            helper!.stdout!.removeListener("data", onData);
            try { helper!.kill(); } catch { /* ignore */ }
            persistentDarwin = null;
            resolve("");
        }, timeout);

        const onData = (chunk: Buffer) => {
            output += chunk.toString("utf-8");
            const idx = output.indexOf(DARWIN_MARKER);
            if (idx !== -1) {
                clearTimeout(timer);
                helper!.stdout!.removeListener("data", onData);
                resolve(output.substring(0, idx).trim());
            }
        };

        helper.stdout!.on("data", onData);

        try {
            helper.stdin!.write("READ\n");
        } catch {
            clearTimeout(timer);
            helper.stdout!.removeListener("data", onData);
            resolve("");
        }
    });
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

    const ps = spawn("powershell.exe", [
        "-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-",
    ], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });

    ps.stderr?.on("data", () => { /* drain stderr */ });
    // Guard: only null the reference if this is still the active process (avoids race with replacement)
    ps.on("exit", () => { if (persistentPS === ps) { persistentPS = null; psAssemblyLoaded = false; } });

    persistentPS = ps;

    return persistentPS;
}

function runPSCommand(command: string, timeout = 8000): Promise<string> {
    return new Promise((resolve) => {
        function attempt(isRetry: boolean): void {
            let ps: ChildProcess;
            try {
                ps = ensurePersistentPS();
            } catch {
                resolve("");
                return;
            }

            // Check if process is healthy before using it
            if (ps.killed || ps.exitCode !== null || !ps.stdin?.writable) {
                if (!isRetry) {
                    // Kill and recreate, then retry once
                    try { ps.kill(); } catch { /* ignore */ }
                    persistentPS = null;
                    psAssemblyLoaded = false;
                    attempt(true);
                } else {
                    resolve("");
                }
                return;
            }

            let output = "";

            const timer = setTimeout(() => {
                ps.stdout!.removeListener("data", onData);
                // Kill the PS process to prevent leftover output from
                // contaminating the next command's stdout
                try { ps.kill(); } catch { /* ignore */ }
                persistentPS = null;
                psAssemblyLoaded = false;
                resolve(output.trim());
            }, timeout);

            const onData = (chunk: Buffer) => {
                output += chunk.toString("utf-8");
                const idx = output.indexOf(PS_MARKER);
                if (idx !== -1) {
                    clearTimeout(timer);
                    ps.stdout!.removeListener("data", onData);
                    resolve(output.substring(0, idx).trim());
                }
            };

            ps.stdout!.on("data", onData);

            // First call: load System.Windows.Forms assembly (only once)
            const prefix = psAssemblyLoaded ? "" : "Add-Type -AssemblyName System.Windows.Forms\n";
            psAssemblyLoaded = true;

            try {
                ps.stdin!.write(`${prefix}${command}\n'${PS_MARKER}'\n`);
            } catch {
                clearTimeout(timer);
                ps.stdout!.removeListener("data", onData);
                if (!isRetry) {
                    // stdin write failed - process may have died; kill and retry once
                    try { ps.kill(); } catch { /* ignore */ }
                    persistentPS = null;
                    psAssemblyLoaded = false;
                    attempt(true);
                } else {
                    resolve("");
                }
            }
        }

        attempt(false);
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
const CACHE_TTL_MS = 2000; // 2 seconds
interface ClipboardSnapshot {
    timestamp: number;
    targets: string[];
    text: Buffer | null;
    imagePng: Buffer | null;
    imageBmp: Buffer | null;
}
let clipboardCache: ClipboardSnapshot | null = null;

/**
 * macOS: Read all clipboard data with parallel process spawns.
 * Skips 'clipboard info' — infers targets from actual data availability.
 * Runs osascript (image) and pbpaste (text) concurrently for ~2x speedup.
 */
async function readAllClipboardDarwin(): Promise<Omit<ClipboardSnapshot, "timestamp">> {
    // Try native helper first (persistent process, ~5ms per read)
    const nativeOutput = await runDarwinCommand();
    if (nativeOutput) {
        const parsed = parseDarwinHelperOutput(nativeOutput);
        if (parsed) return parsed;
    }

    // Fallback: parallel osascript + pbpaste (~250ms)
    const [imgResult, textResult] = await Promise.all([
        execCommandAsync("osascript", ["-e",
            'try\nset d to the clipboard as «class PNGf»\nreturn d\nend try']),
        execCommandAsync("pbpaste", []),
    ]);

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

    if (textResult.status === 0 && textResult.stdout.length > 0) {
        text = textResult.stdout;
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
    const command = "$r = @{ targets = @(); text = $null; imagePng = $null }; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $r.targets += 'image/png'; $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $r.imagePng = [Convert]::ToBase64String($ms.ToArray()); $ms.Dispose(); $img.Dispose() }; $text = [System.Windows.Forms.Clipboard]::GetText(); if ($text) { $r.targets += 'text/plain'; $r.text = $text }; $r | ConvertTo-Json -Compress";

    const output = await runPSCommand(command);
    if (!output) return { targets: [], text: null, imagePng: null, imageBmp: null };

    try {
        const json = JSON.parse(output);
        // PowerShell's ConvertTo-Json may serialize single-element arrays as scalars
        const rawTargets = json.targets;
        const targets = Array.isArray(rawTargets) ? rawTargets
            : typeof rawTargets === "string" ? [rawTargets]
            : [];
        return {
            targets,
            text: json.text ? Buffer.from(json.text, "utf-8") : null,
            imagePng: json.imagePng ? Buffer.from(json.imagePng, "base64") : null,
            imageBmp: null,
        };
    } catch {
        return { targets: [], text: null, imagePng: null, imageBmp: null };
    }
}

async function getCachedClipboard(plat: ClipboardPlatform): Promise<ClipboardSnapshot> {
    const now = Date.now();
    if (clipboardCache && now - clipboardCache.timestamp < CACHE_TTL_MS) {
        return clipboardCache;
    }

    // Windows/WSL: persistent PowerShell process
    if (plat === "windows" || plat === "wsl") {
        clipboardCache = { timestamp: now, ...await readAllClipboardWindows() };
        return clipboardCache;
    }

    // macOS: parallel reads (skip clipboard info, infer targets from actual data)
    if (plat === "darwin") {
        clipboardCache = { timestamp: now, ...await readAllClipboardDarwin() };
        return clipboardCache;
    }

    // Linux: individual calls
    const targets = readClipboardTargets(plat);
    const hasImage = targets.some(t => /image\/(png|jpeg|jpg|gif|webp|bmp)/.test(t));
    const hasText = targets.some(t => t.includes("text/plain") || t === "STRING" || t === "UTF8_STRING");
    const text = hasText ? readClipboardText(plat) : null;
    const imagePng = hasImage ? readClipboardImage(plat, "png") : null;
    const imageBmp = hasImage ? readClipboardImage(plat, "bmp") : null;

    // Filter targets: remove image types if actual image data is null/empty,
    // and remove text/plain if actual text data is null/empty
    const filteredTargets = targets.filter(t => {
        if (/image\/(png|jpeg|jpg|gif|webp|bmp)/.test(t)) return imagePng !== null || imageBmp !== null;
        if (t.includes("text/plain") || t === "STRING" || t === "UTF8_STRING") return text !== null;
        return true;
    });

    clipboardCache = {
        timestamp: now,
        targets: filteredTargets,
        text,
        imagePng,
        imageBmp,
    };
    return clipboardCache;
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

function readClipboardImage(plat: ClipboardPlatform, format: "png" | "bmp"): Buffer | null {
    let r: { stdout: Buffer; status: number };
    const mimeType = format === "png" ? "image/png" : "image/bmp";

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
            r = execCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
            break;
        case "linux-wayland":
            r = execCommand("wl-paste", ["--type", mimeType]);
            break;
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
        cleanupStateFiles();
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
}

// === HTTP Server ===

function createClipboardServer(token: string, plat: ClipboardPlatform): { server: Server; start: (bindAddr: string) => Promise<number> } {
    let lastRequestTime = Date.now();
    let idleTimer: ReturnType<typeof setInterval>;

    // Pre-warm persistent PowerShell on Windows/WSL
    if (plat === "windows" || plat === "wsl") {
        ensurePersistentPS();
    }

    const server = createServer(async (req, res) => {
        lastRequestTime = Date.now();

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
                const cache = await getCachedClipboard(plat);
                const image = url.endsWith("/bmp") ? cache.imageBmp : cache.imagePng;
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
        } catch {
            if (!res.headersSent) {
                res.writeHead(500);
                res.end("Internal error");
            }
        }
    });

    // Idle timeout: self-terminate after 30 minutes of no requests,
    // but ONLY if no active CCC sessions (lock files) exist.
    idleTimer = setInterval(() => {
        if (Date.now() - lastRequestTime > IDLE_TIMEOUT_MS) {
            // Check for active sessions — don't die while someone is using CCC
            if (hasAnyActiveSessionsExcept(null)) return;
            gracefulShutdown(server, idleTimer);
        }
    }, 60000);

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

function cleanupStateFiles(): void {
    try { if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE); } catch { /* ignore */ }
    try { if (existsSync(STARTING_LOCK)) unlinkSync(STARTING_LOCK); } catch { /* ignore */ }
}

// === Port File Management ===

function readPortFile(): { port: number; token: string } | null {
    try {
        if (!existsSync(PORT_FILE)) return null;
        const content = readFileSync(PORT_FILE, "utf-8").trim();
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
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(PORT_FILE, `${port}:${token}`, { mode: 0o600 });
}

// === Server Shutdown (used for version upgrade restart) ===

function shutdownServer(port: number, token?: string): void {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = httpRequest(
        { hostname: "127.0.0.1", port, path: "/shutdown", method: "POST", timeout: 2000, headers },
        () => { /* response doesn't matter */ },
    );
    req.on("error", () => { /* server may already be gone */ });
    req.end();
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
    const existing = readPortFile();
    if (existing) {
        const health = await checkServerHealth(existing.port, existing.token, bindAddr);
        if (health.alive) {
            // Version match → reuse existing server
            if (health.version === SERVER_VERSION) return existing.port;
            // Version mismatch → shutdown old server, start new one
            shutdownServer(existing.port, existing.token);
            // Brief wait for old server to release the port
            await new Promise((r) => setTimeout(r, 500));
        }
        cleanupStateFiles();
    }

    // Atomic startup lock to prevent race condition
    let lockFd: number | null = null;
    try {
        mkdirSync(DATA_DIR, { recursive: true });
        lockFd = openSync(STARTING_LOCK, "wx");
        closeSync(lockFd);
    } catch {
        // Another process is starting the server - wait for port file
        const deadline = Date.now() + STARTUP_POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, STARTUP_POLL_INTERVAL_MS));
            const info = readPortFile();
            if (info) {
                const health = await checkServerHealth(info.port, info.token, bindAddr);
                if (health.alive) return info.port;
            }
        }
        // Timeout - try to start ourselves (delete stale lock)
        cleanupStateFiles();
        try {
            mkdirSync(DATA_DIR, { recursive: true });
            lockFd = openSync(STARTING_LOCK, "wx");
            closeSync(lockFd);
        } catch {
            throw new Error("Failed to acquire clipboard server startup lock");
        }
    }

    // We hold the startup lock - fork the server
    try {
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
            if (info) {
                const health = await checkServerHealth(info.port, info.token, bindAddr);
                if (health.alive) {
                    try { unlinkSync(STARTING_LOCK); } catch { /* ignore */ }
                    return info.port;
                }
            }
        }

        throw new Error("Clipboard server failed to start within timeout");
    } catch (err) {
        try { unlinkSync(STARTING_LOCK); } catch { /* ignore */ }
        throw err;
    }
}

/**
 * Check if there are any active CCC sessions besides the given lock file.
 */
export function hasAnyActiveSessionsExcept(currentLockFile: string | null): boolean {
    if (!existsSync(LOCKS_DIR)) return false;
    const currentLockName = currentLockFile ? basename(currentLockFile) : "";
    const locks = readdirSync(LOCKS_DIR).filter((f) => f.endsWith(".lock"));
    return locks.some((f) => {
        if (f === currentLockName) return false;
        // Validate PID liveness — delete stale lock files from crashed sessions
        const lockPath = join(LOCKS_DIR, f);
        try {
            const content = readFileSync(lockPath, "utf-8").trim();
            const pid = parseInt(content, 10);
            if (isNaN(pid)) {
                try { unlinkSync(lockPath); } catch { /* ignore */ }
                return false;
            }
            try {
                process.kill(pid, 0);
                return true; // PID is alive
            } catch {
                try { unlinkSync(lockPath); } catch { /* ignore */ }
                return false; // PID is dead — stale lock
            }
        } catch {
            try { unlinkSync(lockPath); } catch { /* ignore */ }
            return false;
        }
    });
}

/**
 * Stop the clipboard server if this is the last active CCC session.
 * Call BEFORE removing the current session's lock file.
 */
export function stopClipboardServerIfLast(currentLockFile: string | null): void {
    if (hasAnyActiveSessionsExcept(currentLockFile)) return;

    const info = readPortFile();
    if (!info) return;

    shutdownServer(info.port, info.token);

    // Clean up port file
    try { unlinkSync(PORT_FILE); } catch { /* ignore */ }
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
            try { unlinkSync(STARTING_LOCK); } catch { /* ignore */ }
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
