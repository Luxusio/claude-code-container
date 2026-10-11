import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

const native = vi.hoisted(() => ({ spawn: vi.fn(), trusted: vi.fn(), snapshotState: undefined as unknown, writeState: undefined as unknown, handlers: [] as unknown[] }));
vi.mock("child_process", () => ({ spawn: native.spawn, spawnSync: () => { throw new Error("No native command"); } }));
vi.mock("./../../utils.js", () => ({ CLIPBOARD_FILES_CONTAINER_DIR: "/clipboard-files" }));
vi.mock("./../../home-layout.js", () => ({ clipboardFilesDir: () => "/private/files", clipboardPortFile: () => "/private/port", clipboardStartingLock: () => "/private/lock", helperBinDir: () => "/private/bin", locksDir: () => "/private/locks" }));
vi.mock("./../../clipboard-startup-lock.js", () => ({ tryAcquireClipboardStartupLock: () => null, recoverDeadClipboardStartupLock: () => false, releaseClipboardStartupLock: () => {} }));
vi.mock("./../../clipboard-bind-users.js", () => ({ clipboardPortMayHaveBindUsers: () => true }));
vi.mock("./../../session-lock-liveness.js", () => ({ sessionLockLiveness: () => { throw new Error("No native session probe"); } }));
vi.mock("@ccc/device-lab/windows-system-powershell.js", () => ({ canonicalWindowsPowerShellPath: native.trusted,
    hiddenWindowsPowerShellArgs: (args: string[]) => ["-WindowStyle", "Hidden", ...args] }));
vi.mock("http", () => ({ request: () => { throw new Error("No actual network"); }, createServer: (handler: unknown) => { native.handlers.push(handler); return new EventEmitter(); } }));
vi.mock("fs", async actual => ({ ...await actual<typeof import("node:fs")>(), readFileSync: (path: string) => {
    if (path.endsWith(".js")) return "fixture-policy"; if (path === "/proc/version") return "fixture linux"; throw new Error("No native read");
}, existsSync: () => false, mkdirSync: () => { throw new Error("No native mkdir"); }, copyFileSync: () => { throw new Error("No native copy"); } }));
vi.mock("./../../application/clipboard/snapshot.js", async actual => {
    const mod = await actual<typeof import("../../application/clipboard/snapshot.js")>();
    return { ...mod, createClipboardSnapshotReader: (...args: Parameters<typeof mod.createClipboardSnapshotReader>) => { native.snapshotState = args[1]; return mod.createClipboardSnapshotReader(...args); } };
});
vi.mock("./../../application/clipboard/text-write.js", async actual => {
    const mod = await actual<typeof import("../../application/clipboard/text-write.js")>();
    return { ...mod, createClipboardTextWriter: (...args: Parameters<typeof mod.createClipboardTextWriter>) => { native.writeState = args[1]; return mod.createClipboardTextWriter(...args); } };
});

let mod: typeof import("../../clipboard-server.js");
let child: ReturnType<typeof writer>;
function writer() {
    const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
    return Object.assign(new EventEmitter(), { stdin, kill: vi.fn(), unref: vi.fn() });
}
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); native.handlers.length = 0; child = writer();
    native.spawn.mockReturnValue(child); native.trusted.mockReturnValue("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    mod = await import("../../clipboard-server.js");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); Object.defineProperty(process, "platform", originalPlatform); });

describe("Clipboard text-write actual public native facade", () => {
    it("shares cache generation with the snapshot binding", () => {
        expect(native.writeState).toBe(native.snapshotState);
    });
    it.each(["linux-x11", "linux-wayland", "darwin"] as const)("preserves fixed command, UTF8 bytes, hidden spawn and native listeners on %s", async platform => {
        const text = "\uFEFF한국 😀\r\n"; const promise = mod.writeClipboardText(text, platform);
        const expected = platform === "linux-x11" ? ["xclip", ["-selection", "clipboard", "-in", "-target", "UTF8_STRING"]]
            : platform === "linux-wayland" ? ["wl-copy", ["--type", "text/plain;charset=utf-8"]] : ["pbcopy", []];
        expect(native.spawn.mock.calls[0].slice(0, 2)).toEqual(expected);
        const options = native.spawn.mock.calls[0][2]; expect(options).toMatchObject({ stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        if (platform === "darwin") expect(options.env).toEqual({ ...process.env, LC_CTYPE: "UTF-8" }); else expect(options).not.toHaveProperty("env");
        expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from(text, "utf8"));
        child.emit("exit", 0); await expect(promise).resolves.toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    });
    it("uses the trusted Windows path and ASCII PowerShell with exact UTF8 base64 data", async () => {
        const text = "한국 😀"; const promise = mod.writeClipboardText(text, "windows");
        const [command, args, options] = native.spawn.mock.calls[0];
        expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        const script = "$ErrorActionPreference = 'Stop'; try { Add-Type -AssemblyName System.Windows.Forms; $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); if ($text.Length -eq 0) { [Windows.Forms.Clipboard]::Clear() } else { [Windows.Forms.Clipboard]::SetText($text) }; exit 0 } catch { exit 1 }";
        expect(args).toEqual(["-WindowStyle", "Hidden", "-STA", "-NoProfile", "-NonInteractive", "-Command", script]);
        expect(options).toEqual({ stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        expect(child.stdin.end.mock.calls[0][0]).toEqual(Buffer.from(Buffer.from(text).toString("base64"), "ascii")); expect(script).toMatch(/^[\x00-\x7f]*$/);
        child.emit("exit", 0); await promise;
    });
    it("rejects invalid text and missing trusted Windows writer before spawn or cache invalidation", async () => {
        const state = native.writeState as { generation: number };
        await expect(mod.writeClipboardText("bad\0text", "windows")).rejects.toThrow("Invalid clipboard text");
        native.trusted.mockReturnValue(null); await expect(mod.writeClipboardText("valid", "windows")).rejects.toThrow();
        expect(native.spawn).not.toHaveBeenCalled(); expect(state.generation).toBe(0);
    });
    it("terminates the native writer with SIGKILL when stdin fails, without adopting kill's boolean return", async () => {
        child.kill.mockReturnValue(true); const promise = mod.writeClipboardText("text", "linux-x11"); const caught = promise.catch(e => e);
        child.stdin.emit("error", new Error("pipe")); expect((await caught).message).toBe("Clipboard write failed");
        expect(child.kill).toHaveBeenCalledWith("SIGKILL"); expect(vi.getTimerCount()).toBe(0);
        expect((native.writeState as { generation: number }).generation).toBe(2);
    });
    it("bounds timeout at 5000ms and reports synchronous spawn failure without exposing its carrier", async () => {
        const promise = mod.writeClipboardText("text", "linux-wayland"); const caught = promise.catch(e => e);
        await vi.advanceTimersByTimeAsync(4999); expect(child.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1); expect((await caught).message).toBe("Clipboard write failed"); expect(child.kill).toHaveBeenCalledWith("SIGKILL");
        const raw = { raw: "spawn" }; native.spawn.mockImplementation(() => { throw raw; });
        await expect(mod.writeClipboardText("text", "linux-x11")).rejects.toThrow("Clipboard write failed");
        expect((native.writeState as { generation: number }).generation).toBe(4);
    });
    it.each(["error", "nonzero", "unknown"] as const)("finishes a failed native %s observation and clears its timer", async failure => {
        const promise = mod.writeClipboardText("text", "linux-x11");
        const observed = promise.catch(error => error);
        if (failure === "error") child.emit("error", new Error("native detail"));
        else child.emit("exit", failure === "nonzero" ? 1 : null);
        expect((await observed).message).toBe("Clipboard write failed");
        expect(vi.getTimerCount()).toBe(0);
        expect((native.writeState as { generation: number }).generation).toBe(2);
    });
    it.each(["timeout", "input"] as const)("settles %s failure even when owned writer termination throws", async failure => {
        child.kill.mockImplementation(() => { throw new Error("signal unavailable"); });
        const promise = mod.writeClipboardText("text", "linux-x11");
        const observed = promise.catch(error => error);
        if (failure === "timeout") await vi.advanceTimersByTimeAsync(5000);
        else child.stdin.emit("error", new Error("input failed"));
        expect((await observed).message).toBe("Clipboard write failed");
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
        expect(vi.getTimerCount()).toBe(0);
        expect((native.writeState as { generation: number }).generation).toBe(2);
    });
    it.each([0, 1])("waits for native exit %i before acknowledging the HTTP write", async exitCode => {
        mod.createClipboardServer("secret", "linux-x11");
        const req = Object.assign(new EventEmitter(), { url: "/clipboard/text", method: "POST", destroy: vi.fn(),
            headers: { authorization: "Bearer secret", "content-type": "text/plain;charset=utf-8" } });
        const res = Object.assign(new EventEmitter(), { status: 0, body: undefined as unknown, headersSent: false,
            writeHead(status: number) { this.status = status; this.headersSent = true; }, end(body?: unknown) { this.body = body; } });
        const done = (native.handlers[0] as (req: IncomingMessage, res: ServerResponse) => Promise<void>)(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req.emit("data", Buffer.from("private clipboard text")); req.emit("end");
        await Promise.resolve();
        expect(res.status).toBe(0);
        child.emit("exit", exitCode);
        await done;
        expect(res.status).toBe(exitCode === 0 ? 204 : 500);
        expect(res.body).toBe(exitCode === 0 ? undefined : "Clipboard upload failed");
        expect((native.writeState as { generation: number }).generation).toBe(2);
    });
});
