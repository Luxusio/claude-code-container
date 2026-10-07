import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "http";
import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";

const adapter = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), trusted: vi.fn() }));
vi.mock("child_process", () => ({ spawn: adapter.spawn, spawnSync: adapter.spawnSync }));
vi.mock("os", async () => ({ ...await vi.importActual<typeof import("os")>("os"), platform: () => "win32" }));
vi.mock("@ccc/device-lab/windows-system-powershell.js", async () => ({
    ...await vi.importActual<typeof import("@ccc/device-lab/windows-system-powershell.js")>("@ccc/device-lab/windows-system-powershell.js"),
    canonicalWindowsPowerShellPath: adapter.trusted,
}));

type ClipboardModule = typeof import("../clipboard-server.js");
let mod: ClipboardModule;
let servers: Server[] = [];
const children: ReturnType<typeof child>[] = [];
let writeStatus = 0;
let holdWrites = false;
let nativeText = Buffer.from("old text");
let nativeImage: Buffer | null = null;
let persistentInput: ((proc: ReturnType<typeof child>, command: string) => void) | undefined;
const token = "copy-test-token";
const trustedPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function child() {
    const proc = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        killed: false, exitCode: null as number | null, kill: vi.fn(),
        input: [] as Buffer[],
    });
    proc.kill.mockImplementation(() => { proc.killed = true; return true; });
    return proc;
}

const originalProcessPlatform = process.platform;

beforeEach(async () => {
    Object.defineProperty(process, "platform", { configurable: true, get: () => "win32" });
    vi.resetModules();
    vi.clearAllMocks();
    servers = [];
    children.length = 0;
    holdWrites = false;
    writeStatus = 0;
    nativeText = Buffer.from("old text");
    nativeImage = null;
    persistentInput = undefined;
    adapter.trusted.mockReturnValue(trustedPath);
    adapter.spawn.mockImplementation((_cmd: string, args: string[]) => {
        const proc = child();
        children.push(proc);
        const persistent = args.at(-1) === "-";
        proc.stdin = new Writable({
            write(chunk, _encoding, done) {
                proc.input.push(Buffer.from(chunk));
                if (persistent) {
                    const wire = chunk.toString();
                    const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(wire);
                    persistentInput?.(proc, encoded ? Buffer.from(encoded[1], "base64").toString("utf16le") : wire);
                }
                done();
            },
            final(done) {
                done();
                if (!persistent && !holdWrites) queueMicrotask(() => {
                    if (writeStatus === 0) { nativeText = Buffer.concat(proc.input); nativeImage = null; }
                    proc.exitCode = writeStatus;
                    proc.emit("exit", writeStatus, null);
                    proc.emit("close", writeStatus, null);
                });
            },
        }) as typeof proc.stdin;
        return proc;
    });
    adapter.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
        let stdout = Buffer.alloc(0);
        if (args.includes("TARGETS")) stdout = Buffer.from(nativeImage ? "image/png\n" : "UTF8_STRING\n");
        else if (args.includes("-t")) stdout = nativeImage ?? Buffer.alloc(0);
        else if (args.includes("-o")) stdout = nativeText;
        return { status: 0, stdout, stderr: Buffer.alloc(0) };
    });
    mod = await import("../clipboard-server.js");
});

afterEach(async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalProcessPlatform });
    vi.useRealTimers();
    for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const proc of children) { proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); }
});

async function start(plat: Parameters<ClipboardModule["createClipboardServer"]>[1] = "linux-x11") {
    const instance = mod.createClipboardServer(token, plat);
    servers.push(instance.server);
    return instance.start("127.0.0.1");
}

function http(port: number, body: Buffer | string = "", options: {
    method?: string; path?: string; headers?: Record<string, string>; unfinished?: boolean;
} = {}) {
    let req: ReturnType<typeof request>;
    const response = new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        req = request({ host: "127.0.0.1", port, method: options.method ?? "POST",
            path: options.path ?? "/clipboard/text", headers: {
                Authorization: `Bearer ${token}`, "Content-Type": "text/plain; charset=utf-8", ...options.headers,
            } }, res => {
            const chunks: Buffer[] = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
            res.on("error", reject);
        });
        req.on("error", reject);
        if (options.unfinished) { req.flushHeaders(); req.write(body); } else req.end(body);
    });
    return { response, abort: () => req.destroy() };
}

describe("authenticated clipboard text copy (actual HTTP handler)", () => {
    it("rejects an unauthorized unfinished request before waiting for its body", async () => {
        const port = await start();
        const upload = http(port, "", { unfinished: true, headers: { Authorization: "Bearer wrong", "Content-Length": "999999" } });
        try { expect((await upload.response).status).toBe(401); }
        finally { upload.abort(); }
        expect(adapter.spawn).not.toHaveBeenCalled();
        expect(adapter.spawnSync).not.toHaveBeenCalled();
    });

    it.each(["", "\uFEFFtext with BOM", "  한글 😀 ' \" $(whoami) `x`\r\nlast\n\n"])("preserves exact stdin bytes: %j", async text => {
        const result = await http(await start(), text).response;
        expect(result.status).toBe(204);
        expect(result.body.length).toBe(0);
        expect(Buffer.concat(children[0].input)).toEqual(Buffer.from(text));
    });

    it.each(["application/octet-stream", "text/html", "text/plain; charset=iso-8859-1"])("rejects unsupported MIME %s", async mime => {
        expect((await http(await start(), "secret", { headers: { "Content-Type": mime } }).response).status).toBe(415);
        expect(adapter.spawn).not.toHaveBeenCalled();
    });

    it.each([Buffer.from([0xc0, 0xaf]), Buffer.from([0xe2, 0x82]), Buffer.from("a\0b")])("rejects malformed UTF-8 or NUL %j", async body => {
        expect((await http(await start(), body).response).status).toBe(400);
        expect(adapter.spawn).not.toHaveBeenCalled();
    });

    it("accepts the exact byte limit and rejects one byte more, including chunked input", async () => {
        expect(mod.MAX_CLIPBOARD_TEXT_BYTES).toBe(1048576);
        const port = await start();
        const exact = Buffer.from("한".repeat(349525) + "x");
        expect(exact.length).toBe(mod.MAX_CLIPBOARD_TEXT_BYTES);
        expect((await http(port, exact).response).status).toBe(204);
        expect(Buffer.concat(children[0].input).equals(exact)).toBe(true);
        adapter.spawn.mockClear();
        expect((await http(port, Buffer.concat([exact, Buffer.from("x")]), { headers: { "Transfer-Encoding": "chunked" } }).response).status).toBe(413);
        expect(adapter.spawn).not.toHaveBeenCalled();
    });

    it("rejects an oversized declared length without waiting for its body", async () => {
        const upload = http(await start(), "", { unfinished: true, headers: { "Content-Length": "1048577" } });
        try { expect((await upload.response).status).toBe(413); } finally { upload.abort(); }
        expect(adapter.spawn).not.toHaveBeenCalled();
    });

    it("does not mutate for an aborted incomplete body", async () => {
        const upload = http(await start(), "partial", { unfinished: true, headers: { "Content-Length": "100" } });
        const rejected = upload.response.catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 30));
        upload.abort();
        await rejected;
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(adapter.spawn).not.toHaveBeenCalled();
    });

    it("bounds an upload that never finishes", async () => {
        const upload = http(await start(), "partial", { unfinished: true, headers: { "Content-Length": "100" } });
        try { expect((await upload.response).status).toBe(408); } finally { upload.abort(); }
        expect(adapter.spawn).not.toHaveBeenCalled();
    }, 10000);

    it("reports native failure generically without clipboard contents", async () => {
        writeStatus = 9;
        const result = await http(await start(), "private clipboard value").response;
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(result.body.length).toBeLessThan(256);
        expect(result.body.toString()).not.toContain("private clipboard value");
    });

    it("does not acknowledge success before native completion", async () => {
        holdWrites = true;
        let completed = false;
        const pending = http(await start(), "pending").response.then(result => { completed = true; return result; });
        await vi.waitFor(() => expect(children.length).toBe(1));
        expect(completed).toBe(false);
        children[0].emit("exit", 0, null);
        children[0].emit("close", 0, null);
        expect((await pending).status).toBe(204);
    });

    it("invalidates cached text and image on successful write", async () => {
        nativeImage = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
        const port = await start();
        const get = (path: string) => http(port, "", { method: "GET", path }).response;
        expect((await get("/clipboard/image/png")).body).toEqual(nativeImage);
        expect((await http(port, "new text").response).status).toBe(204);
        expect((await get("/clipboard/text")).body.toString()).toBe("new text");
        expect((await get("/clipboard/targets")).body.toString()).not.toContain("image/png");
        expect((await get("/clipboard/image/png")).status).toBe(204);
        expect((await http(port, "newer text").response).status).toBe(204);
        expect((await get("/clipboard/text")).body.toString()).toBe("newer text");
    });

    it.each(["text", "image"])("does not restore an in-flight old %s snapshot after a write", async kind => {
        let releaseOld: (() => void) | undefined;
        let snapshotReads = 0;
        const emit = (proc: ReturnType<typeof child>, value: unknown) => queueMicrotask(() => {
            proc.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n<<<CCC_CB_DONE>>>\n`));
        });
        persistentInput = (proc, command) => {
            // Existing PowerShell read protocol returns JSON snapshots and scalar change markers.
            if (!command.includes("ConvertTo-Json")) { emit(proc, snapshotReads ? 2 : 1); return; }
            snapshotReads++;
            if (snapshotReads === 1) {
                releaseOld = () => emit(proc, {
                    marker: 1, targets: [kind === "image" ? "image/png" : "text/plain"],
                    text: kind === "text" ? "stale text" : null,
                    imagePng: kind === "image" ? Buffer.from("old image").toString("base64") : null,
                });
            } else emit(proc, { marker: 2, targets: ["text/plain"], text: "fresh text", imagePng: null });
        };
        const port = await start("windows");
        const pendingRead = http(port, "", { method: "GET" }).response;
        await vi.waitFor(() => expect(releaseOld).toBeTypeOf("function"));
        expect((await http(port, "fresh text").response).status).toBe(204);
        releaseOld!();
        expect((await pendingRead).body.toString()).toBe("fresh text");
        expect((await http(port, "", { method: "GET", path: "/clipboard/targets" }).response).body.toString()).not.toContain("image/png");
        expect((await http(port, "", { method: "GET" }).response).body.toString()).toBe("fresh text");
    });
});

describe("native clipboard write command contract", () => {
    it("clears the server idle timer when the server closes", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const before = vi.getTimerCount();
        const instance = mod.createClipboardServer(token, "linux-x11");
        await instance.start("127.0.0.1");
        expect(vi.getTimerCount()).toBeGreaterThan(before);
        await new Promise<void>(resolve => instance.server.close(() => resolve()));
        expect(vi.getTimerCount()).toBe(before);
    });

    it.each(["darwin", "linux-x11", "linux-wayland", "windows", "wsl"] as const)("uses fixed arguments and stdin data on %s", async plat => {
        const text = "한글 😀 '$HOME'\r\n\n";
        await mod.writeClipboardText(text, plat);
        const [executable, args, options] = adapter.spawn.mock.calls[0];
        expect(options.shell).not.toBe(true);
        expect(args.join(" ")).not.toContain(text);
        const input = Buffer.concat(children[0].input);
        if (plat === "windows" || plat === "wsl") {
            expect(executable).toBe(trustedPath);
            expect(options.windowsHide).toBe(true);
            expect(args.map((a: string) => a.toLowerCase())).toEqual(expect.arrayContaining(["-sta", "-windowstyle", "hidden"]));
            expect(Buffer.from(input.toString().trim(), "base64")).toEqual(Buffer.from(text));
            const command = args.join(" ");
            expect(command).toMatch(/FromBase64String/);
            expect(command).toMatch(/UTF8/i);
        } else {
            expect(executable).toBe({ darwin: "pbcopy", "linux-x11": "xclip", "linux-wayland": "wl-copy" }[plat]);
            expect(input).toEqual(Buffer.from(text));
            if (plat === "linux-x11") expect(args).toEqual(expect.arrayContaining(["-selection", "clipboard", "UTF8_STRING"]));
            if (plat === "linux-wayland") expect(args.join(" ")).toContain("text/plain");
        }
        await mod.writeClipboardText("different data", plat);
        expect(adapter.spawn.mock.calls[1].slice(0, 2)).toEqual([executable, args]);
    });

    it("rejects unsupported hosts and unavailable trusted PowerShell", async () => {
        await expect(mod.writeClipboardText("x", "unsupported")).rejects.toThrow();
        adapter.trusted.mockReturnValue(null);
        await expect(mod.writeClipboardText("x", "windows")).rejects.toThrow();
        expect(adapter.spawn).not.toHaveBeenCalled();
    });

    it("bounds a hung native writer and kills it", async () => {
        vi.useFakeTimers();
        holdWrites = true;
        const pending = expect(mod.writeClipboardText("x", "linux-x11")).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(10000);
        await pending;
        expect(children[0].kill).toHaveBeenCalled();
    });

    it("rejects process launch and stdin errors", async () => {
        holdWrites = true;
        const launch = expect(mod.writeClipboardText("x", "linux-x11")).rejects.toThrow();
        children[0].emit("error", new Error("ENOENT"));
        await launch;
        const pipe = expect(mod.writeClipboardText("x", "linux-x11")).rejects.toThrow();
        children[1].stdin.emit("error", new Error("EPIPE"));
        await pipe;
    });
});
