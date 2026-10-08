import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

const native = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), read: vi.fn(), exists: vi.fn(), handlers: [] as unknown[], states: [] as unknown[] }));
vi.mock("child_process", () => ({ spawn: native.spawn, spawnSync: native.spawnSync }));
vi.mock("./../../utils.js", () => ({ CLIPBOARD_FILES_CONTAINER_DIR: "/clipboard-files" }));
vi.mock("./../../home-layout.js", () => ({ clipboardFilesDir: () => "/private/files", clipboardPortFile: () => "/private/port", clipboardStartingLock: () => "/private/lock", helperBinDir: () => "/private/bin", locksDir: () => "/private/locks" }));
vi.mock("./../../clipboard-startup-lock.js", () => ({ tryAcquireClipboardStartupLock: () => { throw new Error("No native lock"); }, recoverDeadClipboardStartupLock: () => false, releaseClipboardStartupLock: () => { throw new Error("No native release"); } }));
vi.mock("./../../clipboard-bind-users.js", () => ({ clipboardPortMayHaveBindUsers: () => true }));
vi.mock("./../../session-lock-liveness.js", () => ({ sessionLockLiveness: () => { throw new Error("No native session probe"); } }));
vi.mock("@ccc/device-lab/windows-system-powershell.js", () => ({ canonicalWindowsPowerShellPath: () => null, hiddenWindowsPowerShellArgs: () => [] }));
vi.mock("http", () => ({ request: () => { throw new Error("No actual network"); }, createServer: (handler: unknown) => { native.handlers.push(handler); return new EventEmitter(); } }));
vi.mock("fs", async actual => ({ ...await actual<typeof import("node:fs")>(), readFileSync: native.read, existsSync: native.exists,
    mkdirSync: () => { throw new Error("No native mkdir"); }, copyFileSync: () => { throw new Error("No native copy"); },
    readdirSync: () => { throw new Error("No native directory scan"); }, openSync: () => { throw new Error("No native open"); }, writeFileSync: () => { throw new Error("No native write"); } }));
vi.mock("./../../application/clipboard/snapshot.js", async actual => {
    const mod = await actual<typeof import("../../application/clipboard/snapshot.js")>();
    return { ...mod, createClipboardSnapshotReader: (...args: Parameters<typeof mod.createClipboardSnapshotReader>) => { native.states.push(args[1]); return mod.createClipboardSnapshotReader(...args); } };
});

let mod: typeof import("../../clipboard-server.js"); let image: Buffer | null; let text: Buffer; let targetReads: number;
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); native.handlers.length = 0; native.states.length = 0;
    image = Buffer.from("native-image"); text = Buffer.from("한글 text"); targetReads = 0;
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
    it("preserves optional getter order, bare custom callbacks, raw byte identity and two-pass fallback", () => {
        const calls: string[] = []; const bytes = Buffer.alloc(0); const copied = Buffer.from("copied");
        const options = {
            get readImageFile() { calls.push("get-read"); return function (this: unknown, path: string) { expect(this).toBeUndefined(); calls.push(`read:${path}`); return null; }; },
            get copyImageFile() { calls.push("get-copy"); return function (this: unknown, path: string) { expect(this).toBeUndefined(); calls.push(`copy:${path}`); return copied; }; },
        };
        expect(mod.buildImageFileClipboardFallbackFromPaths(["a", "b"], options).text).toBe(copied);
        expect(calls).toEqual(["get-read", "get-copy", "read:a", "read:b", "copy:a"]);
        expect(mod.buildImageFileClipboardFallbackFromPaths(["a"], { readImageFile: () => bytes, copyImageFile: () => { throw new Error("No copy"); } }).imagePng).toBe(bytes);
        const raw = { raw: "getter" }; let received: unknown;
        try { mod.buildImageFileClipboardFallbackFromPaths([], { get readImageFile(): (path: string) => Buffer | null { throw raw; } }); } catch (error) { received = error; }
        expect(received).toBe(raw);
    });
});
