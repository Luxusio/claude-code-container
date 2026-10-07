import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter, once } from "events";
import { PassThrough, Writable } from "stream";
import { createServer, request, type Server } from "http";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";

const native = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), platform: "win32" }));
vi.mock("child_process", async () => ({ ...await vi.importActual<typeof import("child_process")>("child_process"), spawn: native.spawn, spawnSync: native.spawnSync }));
vi.mock("os", async () => ({ ...await vi.importActual<typeof import("os")>("os"), platform: () => native.platform }));
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    return { ...actual, existsSync: (path: string) => String(path).endsWith("clipboard-helper-darwin") || actual.existsSync(path) };
});
vi.mock("@ccc/device-lab/windows-system-powershell.js", async () => ({
    ...await vi.importActual<typeof import("@ccc/device-lab/windows-system-powershell.js")>("@ccc/device-lab/windows-system-powershell.js"),
    canonicalWindowsPowerShellPath: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
}));

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64");
const marker = "<<<CCC_CB_DONE>>>";
type State = { sequence: number; text: string | null; image: Buffer | null };
type Fault = "json" | "partial" | "eof" | "process" | "stdin" | "schema" | null;
let state: State;
let fault: Fault;
let unstable: boolean;
let splitFrames: boolean;
let snapshotReads: number;
let afterSnapshot: (() => void) | undefined;
let server: Server | undefined;
let port: number;
let mod: typeof import("../clipboard-server.js");
let children: ReturnType<typeof fakeProcess>[];
let token: string;

function fakeProcess() {
    const proc = Object.assign(new EventEmitter(), {
        stdin: null as unknown as Writable, stdout: new PassThrough(), stderr: new PassThrough(),
        killed: false, exitCode: null as number | null, kill: vi.fn(),
    });
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const commands: string[] = [];
    let busy = false;
    proc.kill.mockImplementation(() => { proc.killed = true; if (scheduled) clearTimeout(scheduled); return true; });
    function next() {
        if (busy || !commands.length || proc.killed) return;
        busy = true;
        const wireCommand = commands.shift()!;
        const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(wireCommand);
        const command = encoded ? Buffer.from(encoded[1], "base64").toString("utf16le") : wireCommand;
        // Model an actual helper: commands execute serially, independent of how many
        // JavaScript listeners have been attached by concurrent HTTP requests.
        scheduled = setTimeout(() => {
            const reading = command.includes("ConvertTo-Json") || command.trim() === "READ";
            let value: unknown;
            if (reading) {
                snapshotReads++;
                value = { marker: state.sequence, changeCount: state.sequence,
                    targets: state.image ? ["image/png"] : state.text ? ["text/plain"] : [],
                    text: state.text, imagePng: state.image?.toString("base64") ?? null };
                afterSnapshot?.();
                if (unstable) state.sequence++;
                if (fault === "schema") value = { marker: state.sequence, changeCount: state.sequence };
                if (fault === "eof") { proc.stdout.emit("end"); proc.exitCode = 1; proc.emit("exit", 1); return; }
                if (fault === "process") { proc.emit("error", new Error("native unavailable")); return; }
                if (fault === "stdin") { proc.stdin.emit("error", new Error("EPIPE")); return; }
            } else value = native.platform === "darwin" ? { changeCount: state.sequence } : state.sequence;
            const body = reading && fault === "json" ? "{broken-json" : JSON.stringify(value);
            const frame = Buffer.from(body + (reading && fault === "partial" ? "" : `\r\n${marker}\r\n`));
            if (splitFrames) {
                // Deliberately split within UTF-8 characters and within the delimiter.
                for (let offset = 0; offset < frame.length; offset += 2) proc.stdout.emit("data", frame.subarray(offset, offset + 2));
            } else proc.stdout.emit("data", frame);
            busy = false;
            next();
        }, 8);
    }
    proc.stdin = new Writable({ write(chunk, _encoding, done) { commands.push(chunk.toString()); done(); next(); } });
    return proc;
}

const originalProcessPlatform = process.platform;

beforeEach(async () => {
    Object.defineProperty(process, "platform", { configurable: true, get: () => native.platform });
    vi.resetModules();
    vi.clearAllMocks();
    native.platform = "win32";
    state = { sequence: 1, text: null, image: png };
    fault = null;
    unstable = false;
    splitFrames = false;
    snapshotReads = 0;
    afterSnapshot = undefined;
    children = [];
    server = undefined;
    token = "image-test-token";
    native.spawn.mockImplementation(() => { const proc = fakeProcess(); children.push(proc); return proc; });
    native.spawnSync.mockReturnValue({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    mod = await import("../clipboard-server.js");
});

afterEach(async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalProcessPlatform });
    for (const child of children) child.kill();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
});

async function start(platform: "windows" | "darwin" = "windows") {
    native.platform = platform === "darwin" ? "darwin" : "win32";
    const instance = mod.createClipboardServer(token, platform);
    server = instance.server;
    port = await instance.start("127.0.0.1");
}

function get(path: string) {
    return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: `/clipboard/${path}`, headers: { Authorization: `Bearer ${token}` } }, res => {
            const chunks: Buffer[] = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.end();
    });
}

describe.each(["windows", "darwin"] as const)("real HTTP %s native image reads", platform => {
    it("isolates concurrent target checks and image consumers on one persistent helper", async () => {
        await start(platform);
        const { readClipboardImagePng } = await import("../codex-clipboard-image.js");
        const [targets, image, codex] = await Promise.all([get("targets"), get("image/png"), readClipboardImagePng(`http://127.0.0.1:${port}`, token)]);
        expect(targets.status).toBe(200);
        expect(targets.body.toString()).toContain("image/png");
        expect(image.body).toEqual(png);
        expect(codex).toEqual(png);
        expect(children).toHaveLength(1);
        if (platform === "windows") expect(native.spawn.mock.calls[0][1]).toContain("-STA");
    });

    it("treats literal delimiter text as data and reconstructs split UTF-8 frames", async () => {
        state = { sequence: 2, image: null, text: `한글 😀 ${marker}\ntrailing\n` };
        splitFrames = true;
        await start(platform);
        const result = await get("text");
        expect(result.status).toBe(200);
        expect(result.body.toString()).toBe(state.text);
    });

    it.each(["json", "schema", "eof", "process", "stdin"] as const)("returns 503 for %s failure and recovers under the same marker", async problem => {
        await start(platform);
        fault = problem;
        const failed = await get("targets");
        expect(failed.status).toBe(503);
        expect(failed.body.length).toBeLessThan(256);
        expect(failed.body.toString()).not.toContain("native unavailable");
        fault = null;
        const recovered = await get("targets");
        expect(recovered.status).toBe(200);
        expect(recovered.body.toString()).toContain("image/png");
    });

    it("does not return or cache complete-looking JSON without the response terminator", async () => {
        await start(platform);
        fault = "partial";
        expect((await get("targets")).status).toBe(503);
        fault = null;
        expect((await get("image/png")).body).toEqual(png);
    }, 15000);

    it("bounds retry when clipboard sequence changes during every snapshot", async () => {
        await start(platform);
        unstable = true;
        expect((await get("targets")).status).toBe(503);
        expect(snapshotReads).toBeGreaterThan(0);
        expect(snapshotReads).toBeLessThanOrEqual(3);
        unstable = false;
        expect((await get("image/png")).body).toEqual(png);
    });

    it("retries a snapshot changed during capture before exposing its old image", async () => {
        await start(platform);
        afterSnapshot = () => {
            afterSnapshot = undefined;
            state = { sequence: 2, image: null, text: "new coherent text" };
        };
        const text = await get("text");
        expect(text.status).toBe(200);
        expect(text.body.toString()).toBe("new coherent text");
        expect(snapshotReads).toBeGreaterThanOrEqual(2);
        expect((await get("targets")).body.toString()).not.toContain("image/png");
    });

    it("exposes image, text, empty, then identical image transitions", async () => {
        await start(platform);
        for (const next of [
            { sequence: 1, image: png, text: null },
            { sequence: 2, image: null, text: "plain text" },
            { sequence: 3, image: null, text: null },
            { sequence: 4, image: png, text: null },
        ]) {
            state = next;
            const targets = await get("targets");
            const image = await get("image/png");
            const text = await get("text");
            expect(targets.body.toString().includes("image/png")).toBe(Boolean(next.image));
            expect(image.status).toBe(next.image ? 200 : 204);
            expect(image.body).toEqual(next.image ?? Buffer.alloc(0));
            expect(text.status).toBe(next.text ? 200 : 204);
            expect(text.body.toString()).toBe(next.text ?? "");
        }
    });

    it("expires negative cache even when delayed image rendering does not change the marker", async () => {
        state.image = null;
        await start(platform);
        expect((await get("targets")).status).toBe(204);
        state.image = png;
        await new Promise(resolve => setTimeout(resolve, mod.CACHE_TTL_MS + 40));
        expect((await get("targets")).body.toString()).toContain("image/png");
    });
});

it.each(["1", "null", "[]", '{"marker":1}', '{"changeCount":1}'])("rejects non-READ schema %s", json => {
    expect(mod.parseWindowsClipboardSnapshot(json)).toBeNull();
    expect(mod.parseDarwinHelperOutput(json)).toBeNull();
});

it("never advertises an image target without captured bytes", () => {
    const json = JSON.stringify({ marker: 1, changeCount: 1, targets: ["image/png", "text/plain"], imagePng: null, text: "plain" });
    for (const parse of [mod.parseWindowsClipboardSnapshot, mod.parseDarwinHelperOutput]) {
        const result = parse(json);
        expect(result).not.toBeNull();
        expect(result!.targets).not.toContain("image/png");
        expect(result!.text?.toString()).toBe("plain");
    }
});

it("preserves multi-megabyte image payloads in both native snapshot parsers", () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0xab);
    png.copy(bytes);
    const json = JSON.stringify({ marker: 1, changeCount: 1, targets: ["image/png"], imagePng: bytes.toString("base64"), text: null });
    for (const parse of [mod.parseWindowsClipboardSnapshot, mod.parseDarwinHelperOutput]) {
        const result = parse(json);
        expect(result).not.toBeNull();
        expect(result!.imagePng?.equals(bytes)).toBe(true);
        expect(result!.targets).toContain("image/png");
    }
});

it.each(["iVBOR", "%%%="])("rejects malformed image base64 %s instead of reporting an image", imagePng => {
    const json = JSON.stringify({ marker: 1, changeCount: 1, targets: ["image/png"], text: null, imagePng });
    expect(mod.parseWindowsClipboardSnapshot(json)).toBeNull();
    expect(mod.parseDarwinHelperOutput(json)).toBeNull();
});

it.skipIf(process.platform === "win32")("serves actual Claude shell target/image requests and the Codex reader concurrently", async () => {
    await start();
    const { spawn } = await vi.importActual<typeof import("child_process")>("child_process");
    const { readClipboardImagePng } = await import("../codex-clipboard-image.js");
    const fixtureRoot = mkdtempSync(join(tmpdir(), "ccc-image-shims-"));
    const metadataRoot = join(fixtureRoot, ".ccc", "clipboard");
    mkdirSync(metadataRoot, { recursive: true });
    const portFile = join(metadataRoot, "clipboard.port");
    writeFileSync(portFile, `${port}:${token}`, { mode: 0o600 });
    let decoyRequests = 0;
    const decoy = createServer((_req, res) => { decoyRequests++; res.writeHead(500); res.end(); });
    await new Promise<void>((resolve) => decoy.listen(0, "127.0.0.1", resolve));
    const decoyAddress = decoy.address();
    if (!decoyAddress || typeof decoyAddress === "string") throw new Error("Decoy failed to bind");
    const decoyPort = decoyAddress.port;
    for (const name of ["xclip", "wl-paste"]) {
        const source = readFileSync(resolve(`scripts/clipboard-shims/${name}`), "utf8");
        expect(source).toContain("/run/ccc/clipboard.port");
        const isolated = source.replaceAll("/run/ccc/clipboard.port", '"$CCC_TEST_PORT_FILE"');
        expect(isolated).not.toContain("/run/ccc/clipboard.port");
        writeFileSync(join(fixtureRoot, name), isolated, { mode: 0o600 });
    }
    async function shell(name: string, args: string[]) {
        const proc = spawn("sh", [join(fixtureRoot, name), ...args], { env: { ...process.env,
            ENV: "", BASH_ENV: "", HOME: fixtureRoot, TMPDIR: fixtureRoot, CCC_TEST_PORT_FILE: portFile,
            CCC_CLIPBOARD_URL: `http://127.0.0.1:${decoyPort}`, CCC_CLIPBOARD_TOKEN: "stale-fixture-token" }, stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [];
        proc.stdout.on("data", chunk => out.push(chunk));
        const [code] = await once(proc, "close");
        expect(code).toBe(0);
        return Buffer.concat(out);
    }
    try {
        const [targets, image, codex] = await Promise.all([
            shell("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]),
            shell("wl-paste", ["--type", "image/png"]),
            readClipboardImagePng(`http://127.0.0.1:${port}`, token),
        ]);
        expect(targets.toString()).toContain("image/png");
        expect(image).toEqual(png);
        expect(codex).toEqual(png);
        expect(decoyRequests).toBe(0);
    } finally {
        decoy.closeAllConnections();
        await new Promise<void>((resolve) => decoy.close(() => resolve()));
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});


describe("macOS native image fallback reaches the Codex reader", () => {
    it("tries pngpaste after a valid native snapshot has no image", async () => {
        state = { sequence: 1, image: null, text: "image caption" };
        native.spawnSync.mockImplementation(command => ({ status: command === "pngpaste" ? 0 : 1,
            stdout: command === "pngpaste" ? png : Buffer.alloc(0), stderr: Buffer.alloc(0) }));
        await start("darwin");
        const { readClipboardImagePng } = await import("../codex-clipboard-image.js");
        expect(await readClipboardImagePng(`http://127.0.0.1:${port}`, token)).toEqual(png);
        expect((await get("text")).body.toString()).toBe("image caption");
    });

    it.each(["file-url", "text-path"])("recovers a local PNG from %s without pngpaste", async source => {
        const root = mkdtempSync(join(tmpdir(), "ccc-darwin-image-"));
        try {
            const path = join(root, "한글 image.png");
            writeFileSync(path, png);
            state = { sequence: 1, image: null, text: source === "text-path" ? path : null };
            native.spawnSync.mockImplementation(command => ({ status: command === "osascript" && source === "file-url" ? 0 : 1,
                stdout: command === "osascript" && source === "file-url" ? Buffer.from(path) : Buffer.alloc(0), stderr: Buffer.alloc(0) }));
            await start("darwin");
            const { readClipboardImagePng } = await import("../codex-clipboard-image.js");
            expect(await readClipboardImagePng(`http://127.0.0.1:${port}`, token)).toEqual(png);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("discards fallback bytes when the pasteboard marker changes", async () => {
        state = { sequence: 1, image: null, text: null };
        native.spawnSync.mockImplementation(command => {
            if (command === "pngpaste" && state.sequence === 1) {
                state = { sequence: 2, image: null, text: "new clipboard" };
                return { status: 0, stdout: png, stderr: Buffer.alloc(0) };
            }
            return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        });
        await start("darwin");
        expect((await get("image/png")).status).toBe(204);
        expect((await get("text")).body.toString()).toBe("new clipboard");
    });

    it("keeps the native image fast path without invoking converters", async () => {
        await start("darwin");
        expect((await get("image/png")).body).toEqual(png);
        expect(native.spawnSync).not.toHaveBeenCalled();
    });
});
