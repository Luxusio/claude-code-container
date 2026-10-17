import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:http";
import { performance } from "node:perf_hooks";

const native = vi.hoisted(() => ({ read: vi.fn(), exists: vi.fn(), spawn: vi.fn(), request: vi.fn(), acquire: vi.fn(), recover: vi.fn(), release: vi.fn(), bindUsers: vi.fn() }));
vi.mock("child_process", () => ({ spawn: native.spawn, spawnSync: () => { throw new Error("No native command"); } }));
vi.mock("./../../utils.js", () => ({ CLIPBOARD_FILES_CONTAINER_DIR: "/clipboard-files" }));
vi.mock("./../../home-layout.js", () => ({ clipboardFilesDir: () => "/private/files", clipboardPortFile: () => "/private/port", clipboardStartingLock: () => "/private/lock", helperBinDir: () => "/private/bin", locksDir: () => "/private/locks" }));
vi.mock("./../../clipboard-startup-lock.js", () => ({ tryAcquireClipboardStartupLock: native.acquire, recoverDeadClipboardStartupLock: native.recover, releaseClipboardStartupLock: native.release }));
vi.mock("./../../clipboard-bind-users.js", () => ({ clipboardPortMayHaveBindUsers: native.bindUsers }));
vi.mock("./../../session-lock-liveness.js", () => ({ sessionLockLiveness: () => { throw new Error("No native session probe"); } }));
vi.mock("@ccc/device-lab/windows-system-powershell.js", () => ({ canonicalWindowsPowerShellPath: () => null, hiddenWindowsPowerShellArgs: () => [] }));
vi.mock("http", () => ({ request: native.request, createServer: () => { throw new Error("No actual server"); } }));
vi.mock("crypto", async actual => ({ ...await actual<typeof import("node:crypto")>(), createHash: () => {
    const hash = { update: (_value: unknown) => hash, digest: () => "aaaaaaaaaaaa0000000000000000000000000000000000000000000000000000" }; return hash;
} }));
vi.mock("fs", async actual => ({ ...await actual<typeof import("node:fs")>(), readFileSync: native.read, existsSync: native.exists,
    mkdirSync: () => { throw new Error("No native mkdir"); }, openSync: () => { throw new Error("No native open"); }, writeFileSync: () => { throw new Error("No native write"); } }));

let mod: typeof import("../../clipboard-server.js"); let record: string | null; let version: string;
const lock = { opaque: "native-lock" }; let child: { unref: ReturnType<typeof vi.fn> };
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); record = "1234:secret:with:colon"; version = "aaaaaaaaaaaa";
    child = { unref: vi.fn().mockReturnValue({ ignored: true }) };
    native.exists.mockImplementation((path: string) => path.endsWith("port") && record !== null);
    native.read.mockImplementation((path: string) => path.endsWith(".js") ? "fixture-policy" : record);
    native.acquire.mockReturnValue(lock); native.recover.mockReturnValue(false); native.release.mockReturnValue({ ignored: true }); native.bindUsers.mockReturnValue(false);
    native.spawn.mockImplementation(() => { record = "4321:new-token"; version = "aaaaaaaaaaaa"; return child; });
    native.request.mockImplementation((options: RequestOptions, callback: (response: unknown) => void) => {
        const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
        req.end.mockImplementation(() => { void Promise.resolve().then(() => {
            const res = Object.assign(new EventEmitter(), { statusCode: 200, resume: () => { void Promise.resolve().then(() => res.emit("end")); } });
            callback(res);
            if (options.path === "/health") { res.emit("data", JSON.stringify({ service: "ccc-clipboard", valid: true, version })); res.emit("end"); }
        }); }); return req;
    });
    mod = await import("../../clipboard-server.js");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function pendingHealthResponse() {
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    native.request.mockImplementation((_options: RequestOptions, callback: (response: unknown) => void) => {
        req.end.mockImplementation(() => { callback(res); });
        return req;
    });
    return { req, res };
}

describe("Clipboard lifecycle actual public native facade", () => {
    it("exports direct named async ensure and synchronous retirement bindings", () => {
        expect(mod.ensureClipboardServer.name).toBe("ensureClipboardServer"); expect(mod.ensureClipboardServer.length).toBe(0);
        expect(mod.ensureClipboardServer.constructor.name).toBe("AsyncFunction");
        expect(mod.stopClipboardServerIfLast.name).toBe("stopClipboardServerIfLast"); expect(mod.stopClipboardServerIfLast.length).toBe(1);
        expect(mod.stopClipboardServerIfLast.constructor.name).toBe("Function");
        expect(mod.retireClipboardServerFromPortFile.name).toBe("retireClipboardServerFromPortFile"); expect(mod.retireClipboardServerFromPortFile.length).toBe(1);
    });
    it("reuses current authenticated health with the whole token after the first colon", async () => {
        expect(await mod.ensureClipboardServer()).toBe(1234); expect(native.acquire).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
        expect(native.request.mock.calls[0][0]).toEqual({ hostname: "127.0.0.1", port: 1234, path: "/health", method: "GET", headers: { Authorization: "Bearer secret:with:colon" }, timeout: 2000 });
        expect(native.request.mock.results[0].value.destroy).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each(["contention", "publication"] as const)("uses the native monotonic clock for %s despite forward and backward wall jumps", async phase => {
        record = null; const allowance = phase === "contention" ? 13500 : 5000;
        if (phase === "contention") native.acquire.mockReturnValue(null);
        else native.spawn.mockReturnValue(child);
        let monotonic = 0;
        vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const wall = vi.spyOn(Date, "now").mockReturnValue(0);
        const observed = mod.ensureClipboardServer().catch(error => error);
        monotonic = allowance - 25; wall.mockReturnValue(1_000_000_000);
        await vi.advanceTimersByTimeAsync(100);
        expect(vi.getTimerCount()).toBe(1); expect(native.request).not.toHaveBeenCalled();
        monotonic = allowance; wall.mockReturnValue(-1_000_000_000);
        await vi.advanceTimersByTimeAsync(25);
        expect(await observed).toEqual(expect.objectContaining({ message: expect.stringContaining(phase === "contention"
            ? "Clipboard startup is still owned or its owner cannot be verified"
            : "Clipboard server failed to start within timeout") }));
        expect(native.acquire).toHaveBeenCalledTimes(phase === "contention" ? 2 : 1);
        expect(native.recover).toHaveBeenCalledTimes(phase === "contention" ? 1 : 0);
        expect(native.release).toHaveBeenCalledTimes(phase === "publication" ? 1 : 0);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("destroys an unfinished authenticated health response once at its separate 2000 ms timeout", async () => {
        const { req, res } = pendingHealthResponse(); const afterHealth = new Error("health failed before lock acquisition");
        native.acquire.mockImplementation(() => { throw afterHealth; });
        req.destroy.mockImplementation(() => {
            req.emit("error", new Error("destroyed request")); res.emit("aborted"); res.emit("error", new Error("destroyed response"));
            return req;
        });
        const observed = mod.ensureClipboardServer().catch(error => error);
        res.emit("data", JSON.stringify({ service: "ccc-clipboard", valid: true, version }));
        expect(native.request.mock.calls[0][0]).toEqual({ hostname: "127.0.0.1", port: 1234, path: "/health", method: "GET", headers: { Authorization: "Bearer secret:with:colon" }, timeout: 2000 });
        await vi.advanceTimersByTimeAsync(1999); expect(req.destroy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await observed).toBe(afterHealth); expect(req.destroy).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
        res.emit("end"); req.emit("timeout");
        expect(req.destroy).toHaveBeenCalledTimes(1); expect(native.acquire).toHaveBeenCalledTimes(1);
        expect(native.spawn).not.toHaveBeenCalled(); expect(native.release).not.toHaveBeenCalled();
    });
    it.each(["request-error", "response-error", "response-aborted"] as const)("settles %s once and consumes destroy/error races without accepting late health", async event => {
        const { req, res } = pendingHealthResponse(); const afterHealth = new Error("failed health reached the existing lock path");
        native.acquire.mockImplementation(() => { throw afterHealth; });
        req.destroy.mockImplementation(() => { req.emit("error", new Error("destroy race")); throw new Error("cleanup failure"); });
        const observed = mod.ensureClipboardServer().catch(error => error);
        if (event === "request-error") req.emit("error", new Error("request failure"));
        else if (event === "response-error") res.emit("error", new Error("response failure"));
        else res.emit("aborted");
        expect(await observed).toBe(afterHealth); expect(req.destroy).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
        res.emit("data", JSON.stringify({ service: "ccc-clipboard", valid: true, version })); res.emit("end");
        expect(req.destroy).toHaveBeenCalledTimes(1); expect(native.acquire).toHaveBeenCalledTimes(1); expect(native.spawn).not.toHaveBeenCalled();
    });
    it.each(["construction", "end"] as const)("preserves the original synchronous request %s rejection and clears owned work even if destruction throws", async operation => {
        const { req } = pendingHealthResponse(); const primary = { raw: `request ${operation}` }; const cleanup = { raw: "destroy" };
        if (operation === "construction") native.request.mockImplementation(() => { throw primary; });
        else {
            req.end.mockImplementation(() => { throw primary; });
            native.request.mockImplementation(() => req);
            req.destroy.mockImplementation(() => { req.emit("error", cleanup); throw cleanup; });
        }
        await expect(mod.ensureClipboardServer()).rejects.toBe(primary);
        expect(req.destroy).toHaveBeenCalledTimes(operation === "end" ? 1 : 0);
        expect(vi.getTimerCount()).toBe(0); expect(native.acquire).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        expect(native.acquire).not.toHaveBeenCalled(); expect(req.destroy).toHaveBeenCalledTimes(operation === "end" ? 1 : 0);
    });
    it.each([" 12junk:raw:token \n", "-12:token"])("retains parseInt behavior and token bytes for port record %s", async raw => {
        record = raw; expect(await mod.ensureClipboardServer()).toBe(Number.parseInt(raw.trim().split(":", 1)[0], 10));
        expect(native.request.mock.calls[0][0].headers.Authorization).toBe(`Bearer ${raw.trim().slice(raw.trim().indexOf(":") + 1)}`);
    });
    it.each([null, "malformed", "x:token", "1234:"])("retirement quietly refuses absent or malformed record %s", raw => {
        record = raw; expect(mod.stopClipboardServerIfLast(false)).toBeUndefined(); expect(native.request).not.toHaveBeenCalled();
        expect(native.bindUsers).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
    });
    it("swallows read failure at the existing record boundary without shutdown or unlink", () => {
        native.read.mockImplementation(() => { throw { raw: "read failure" }; });
        expect(mod.retireClipboardServerFromPortFile("/private/legacy-port")).toBeUndefined(); expect(native.request).not.toHaveBeenCalled();
    });
    it("stop skips all reads for active sessions, then fires authenticated shutdown without adopting the Promise", async () => {
        native.read.mockClear(); expect(mod.stopClipboardServerIfLast(true)).toBeUndefined(); expect(native.read).not.toHaveBeenCalled();
        expect(mod.stopClipboardServerIfLast(false)).toBeUndefined(); await Promise.resolve(); await Promise.resolve();
        expect(native.bindUsers).toHaveBeenCalledWith("/private/port");
        expect(native.request.mock.calls[0][0]).toEqual({ hostname: "127.0.0.1", port: 1234, path: "/shutdown", method: "POST", headers: { Authorization: "Bearer secret:with:colon" } });
        expect(vi.getTimerCount()).toBe(0);
    });
    it("explicit retire reads and checks only the supplied raw path and respects bind-user veto", async () => {
        native.read.mockClear(); native.exists.mockReturnValue(true); native.bindUsers.mockReturnValue(true);
        expect(mod.retireClipboardServerFromPortFile("/private/raw:legacy")).toBeUndefined();
        expect(native.read.mock.calls).toEqual([["/private/raw:legacy", "utf-8"]]); expect(native.bindUsers).toHaveBeenCalledWith("/private/raw:legacy"); expect(native.request).not.toHaveBeenCalled();
        native.bindUsers.mockReturnValue(false); mod.retireClipboardServerFromPortFile("/private/raw:legacy"); await Promise.resolve(); await Promise.resolve();
        expect(native.request.mock.calls[0][0].path).toBe("/shutdown");
    });
    it("launches the unchanged detached node --serve path, ignores native unref/release returns and waits for fresh publication", async () => {
        record = null; const promise = mod.ensureClipboardServer(); await vi.advanceTimersByTimeAsync(100);
        expect(await promise).toBe(4321); const [command, args, options] = native.spawn.mock.calls[0];
        expect(command).toBe(process.execPath); expect(args).toEqual([expect.stringMatching(/[/\\]src[/\\]clipboard-server\.js$/), "--serve"]);
        expect(options).toEqual({ detached: true, stdio: "ignore", windowsHide: true });
        expect(child.unref).toHaveBeenCalledTimes(1); expect(native.release).toHaveBeenCalledWith(lock); expect(vi.getTimerCount()).toBe(0);
    });
    it("preserves raw release exception over a successful launched server", async () => {
        record = null; const raw = { raw: "release" }; native.release.mockImplementation(() => { throw raw; });
        const promise = mod.ensureClipboardServer(); const observed = promise.catch(e => e); await vi.advanceTimersByTimeAsync(100);
        expect(await observed).toBe(raw);
    });
});
