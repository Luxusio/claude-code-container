import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

const native = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), read: vi.fn(), exists: vi.fn(), mkdir: vi.fn(), trusted: vi.fn(), platform: "linux", handlers: [] as unknown[], states: [] as unknown[] }));
vi.mock("child_process", () => ({ spawn: native.spawn, spawnSync: native.spawnSync }));
vi.mock("os", async actual => ({ ...await actual<typeof import("node:os")>(), platform: () => native.platform }));
vi.mock("./../../utils.js", () => ({ CLIPBOARD_FILES_CONTAINER_DIR: "/clipboard-files" }));
vi.mock("./../../home-layout.js", () => ({ clipboardFilesDir: () => "/private/files", clipboardPortFile: () => "/private/port", clipboardStartingLock: () => "/private/lock", helperBinDir: () => "/private/bin", locksDir: () => "/private/locks" }));
vi.mock("./../../clipboard-startup-lock.js", () => ({ tryAcquireClipboardStartupLock: () => { throw new Error("No native lock"); }, recoverDeadClipboardStartupLock: () => false, releaseClipboardStartupLock: () => { throw new Error("No native release"); } }));
vi.mock("./../../clipboard-bind-users.js", () => ({ clipboardPortMayHaveBindUsers: () => true }));
vi.mock("./../../session-lock-liveness.js", () => ({ sessionLockLiveness: () => { throw new Error("No native session probe"); } }));
vi.mock("@ccc/device-lab/windows-system-powershell.js", () => ({ canonicalWindowsPowerShellPath: native.trusted, hiddenWindowsPowerShellArgs: () => [] }));
vi.mock("http", () => ({ request: () => { throw new Error("No actual network"); }, createServer: (handler: unknown) => { native.handlers.push(handler); return new EventEmitter(); } }));
vi.mock("fs", async actual => ({ ...await actual<typeof import("node:fs")>(), readFileSync: native.read, existsSync: native.exists,
    mkdirSync: native.mkdir, copyFileSync: () => { throw new Error("No native copy"); },
    readdirSync: () => { throw new Error("No native directory scan"); }, openSync: () => { throw new Error("No native open"); }, writeFileSync: () => { throw new Error("No native write"); } }));
vi.mock("./../../application/clipboard/snapshot.js", async actual => {
    const mod = await actual<typeof import("../../application/clipboard/snapshot.js")>();
    return { ...mod, createClipboardSnapshotReader: (...args: Parameters<typeof mod.createClipboardSnapshotReader>) => { native.states.push(args[1]); return mod.createClipboardSnapshotReader(...args); } };
});

let mod: typeof import("../../clipboard-server.js"); let image: Buffer | null; let text: Buffer; let targetReads: number;
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); native.handlers.length = 0; native.states.length = 0;
    image = Buffer.from("native-image"); text = Buffer.from("한글 text"); targetReads = 0; native.platform = "linux";
    native.trusted.mockReturnValue(null); native.mkdir.mockImplementation(() => { throw new Error("No native mkdir"); });
    native.exists.mockReturnValue(false); native.read.mockImplementation((path: string) => { if (path.endsWith(".js")) return "fixture-policy"; throw new Error("No native file read"); });
    native.spawn.mockImplementation(() => { throw new Error("No native spawn"); });
    native.spawnSync.mockImplementation((_command: string, args: string[]) => {
        let stdout: Buffer = Buffer.alloc(0);
        if (args.includes("TARGETS") || args.includes("-l")) { ++targetReads; stdout = Buffer.from("image/png\nUTF8_STRING\n"); }
        else if (args.includes("-t") || args.includes("--type")) { if (args.includes("image/png")) stdout = image ?? Buffer.alloc(0); }
        else stdout = text;
        return { status: 0, stdout, stderr: Buffer.alloc(0) };
    });
    mod = await import("../../clipboard-server.js");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function request(index: number, path: string, token = "secret") {
    const req = Object.assign(new EventEmitter(), { url: path, method: "GET", headers: { authorization: `Bearer ${token}` } });
    const res = Object.assign(new EventEmitter(), { status: 0, body: undefined as unknown, headersSent: false,
        writeHead(status: number) { this.status = status; this.headersSent = true; }, end(body?: unknown) { this.body = body; } });
    await (native.handlers[index] as (req: IncomingMessage, res: ServerResponse) => Promise<void>)(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return res;
}

describe("Clipboard snapshot actual public facade composition", () => {
    it("composes one state and shares its text cache across two server/platform contexts", async () => {
        mod.createClipboardServer("secret", "linux-x11"); mod.createClipboardServer("secret", "linux-wayland");
        const first = await request(0, "/clipboard/text"); const second = await request(1, "/clipboard/text");
        expect(first.status).toBe(200); expect(first.body).toBe(text); expect(second.body).toBe(text);
        expect(native.states).toHaveLength(1); expect(targetReads).toBe(1);
        expect(native.spawnSync.mock.calls[0]).toEqual(["xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], { stdio: ["pipe", "pipe", "pipe"], timeout: 5000, windowsHide: true }]);
    });
    it("forces native image freshness on Linux even when another server warmed the cache", async () => {
        mod.createClipboardServer("secret", "linux-x11"); mod.createClipboardServer("secret", "linux-wayland");
        await request(0, "/clipboard/text"); const fresh = Buffer.from("new-image"); image = fresh;
        const result = await request(1, "/clipboard/image/png"); expect(result.status).toBe(200); expect(result.body).toBe(fresh);
        expect(targetReads).toBe(2); expect(native.spawnSync.mock.calls.some(([command]) => command === "wl-paste")).toBe(true);
    });
    it("performs the existing fresh-empty image retry and returns 204 without caching an error", async () => {
        mod.createClipboardServer("secret", "linux-x11"); image = null;
        const result = await request(0, "/clipboard/image/png"); expect(result.status).toBe(204); expect(targetReads).toBe(2);
    });
    it("rejects unauthorized snapshot requests before executing native commands", async () => {
        mod.createClipboardServer("secret", "linux-x11"); const result = await request(0, "/clipboard/text", "wrong");
        expect(result.status).toBe(401); expect(native.spawnSync).not.toHaveBeenCalled();
    });
    it("treats failed Linux target queries as empty clipboard data", async () => {
        native.spawnSync.mockReturnValue({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
        mod.createClipboardServer("secret", "linux-x11");
        expect((await request(0, "/clipboard/image/png")).status).toBe(204);
    });
    it("selects the first nonempty URI group before falling back to a text image path", async () => {
        const file = Buffer.from("text-path-image");
        native.read.mockImplementation((path: string) => {
            if (path.endsWith(".js")) return "fixture-policy";
            if (path === "/text.png" || path === "/later-uri.png") return file;
            throw new Error("unreadable file");
        });
        native.spawnSync.mockImplementation((_command: string, args: string[]) => {
            const target = args.includes("-t") ? args[args.indexOf("-t") + 1] : null;
            const stdout = target === "TARGETS" ? Buffer.from("text/uri-list\nx-special/gnome-copied-files\nUTF8_STRING\nimage/png\n")
                : target === "text/uri-list" ? Buffer.from("file:///missing.png")
                : target === "x-special/gnome-copied-files" ? Buffer.from("copy\nfile:///later-uri.png")
                : target === null ? Buffer.from("/text.png") : Buffer.alloc(0);
            return { status: 0, stdout, stderr: Buffer.alloc(0) };
        });
        mod.createClipboardServer("secret", "linux-x11");
        const result = await request(0, "/clipboard/image/png");
        expect(result.status).toBe(200); expect(result.body).toEqual(file);
        expect(native.read).toHaveBeenCalledWith("/missing.png"); expect(native.read).toHaveBeenCalledWith("/text.png");
        expect(native.read).not.toHaveBeenCalledWith("/later-uri.png");
        expect(native.spawnSync.mock.calls.some(([, args]) => args.includes("x-special/gnome-copied-files"))).toBe(false);
    });
    it("captures legacy Darwin data and places converted image targets ahead of text", async () => {
        native.platform = "darwin";
        native.spawn.mockImplementation((command: string) => {
            const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
            queueMicrotask(() => { if (command === "pbpaste") child.stdout.emit("data", Buffer.from("caption")); child.emit("close", 0); });
            return child;
        });
        native.spawnSync.mockImplementation((command: string) => ({ status: command === "pngpaste" ? 0 : 1,
            stdout: command === "pngpaste" ? Buffer.from("converted-image") : Buffer.alloc(0), stderr: Buffer.alloc(0) }));
        mod.createClipboardServer("secret", "darwin");
        const result = await request(0, "/clipboard/targets");
        expect(result.status).toBe(200); expect(result.body).toBe("image/png\ntext/plain\n");
        expect(native.spawn.mock.calls.map(([command]) => command)).toEqual(["osascript", "pbpaste"]);
        expect(native.spawnSync).toHaveBeenCalledWith("pngpaste", ["-"], expect.any(Object));
    });
    it("returns 503 for failed Darwin legacy capture and recovers without caching empty data", async () => {
        native.platform = "darwin"; let failed = true;
        native.spawn.mockImplementation((command: string) => {
            const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
            queueMicrotask(() => { if (command === "pbpaste") child.stdout.emit("data", Buffer.from("recovered text")); child.emit("close", command === "pbpaste" && failed ? 1 : 0); });
            return child;
        });
        native.spawnSync.mockReturnValue({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
        mod.createClipboardServer("secret", "darwin");
        const unavailable = await request(0, "/clipboard/text"); expect(unavailable.status).toBe(503); expect(unavailable.body).toBe("Clipboard read unavailable");
        failed = false;
        const recovered = await request(0, "/clipboard/text"); expect(recovered.status).toBe(200); expect(recovered.body).toEqual(Buffer.from("recovered text"));
        expect(native.spawn).toHaveBeenCalledTimes(4);
    });
    it("returns 500 for an unexpected Windows capture exception and recovers the read queue", async () => {
        native.trusted.mockReturnValue("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        native.spawn.mockImplementation(() => {
            const stdout = new EventEmitter();
            const stdin = Object.assign(new EventEmitter(), { writable: true, write: (wire: string) => {
                const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(wire);
                const command = encoded ? Buffer.from(encoded[1], "base64").toString("utf16le") : wire;
                const output = command.includes("ConvertTo-Json") ? JSON.stringify({ marker: 1, targets: ["text/plain"], text: "recovered", imagePng: null }) : "1";
                queueMicrotask(() => stdout.emit("data", Buffer.from(`${output}\n<<<CCC_CB_DONE>>>\n`)));
            } });
            return Object.assign(new EventEmitter(), { stdin, stdout, stderr: new EventEmitter(), killed: false, exitCode: null, kill: vi.fn() });
        });
        mod.createClipboardServer("secret", "windows");
        const failed = await request(0, "/clipboard/text"); expect(failed.status).toBe(500); expect(failed.body).toBe("Internal error");
        native.mkdir.mockReturnValue(undefined);
        const recovered = await request(0, "/clipboard/text"); expect(recovered.status).toBe(200); expect(recovered.body).toEqual(Buffer.from("recovered"));
    });
});
