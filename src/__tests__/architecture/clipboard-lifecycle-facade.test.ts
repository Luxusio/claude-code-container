import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:http";
import { performance } from "node:perf_hooks";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NATIVE_RUNTIME_SELECTOR_KEYS} from "../../ports/container-runtime-invocation.js";

type NativeGlobalGuard = typeof import("../../adapters/runtime-bind-authority.js").withRuntimeBindGuardAsync;
const native = vi.hoisted(() => ({root: "", realHash: false, namedDevice: "native" as "native" | "zero" | "other", read: vi.fn(), exists: vi.fn(), spawn: vi.fn(), request: vi.fn(), acquire: vi.fn(), recover: vi.fn(), release: vi.fn(), bindUsers: vi.fn(), global: vi.fn(), originalGlobal: undefined as NativeGlobalGuard | undefined}));
vi.mock("child_process", () => ({ spawn: native.spawn, spawnSync: () => { throw new Error("No native command"); } }));
vi.mock("./../../utils.js", () => ({ CLIPBOARD_FILES_CONTAINER_DIR: "/clipboard-files" }));
vi.mock("./../../home-layout.js", () => ({cccHome: () => native.root, clipboardFilesDir: () => join(native.root, "files"), clipboardPortFile: () => join(native.root, "port"), clipboardStartingLock: () => join(native.root, "lock"), helperBinDir: () => join(native.root, "bin"), locksDir: () => join(native.root, "locks")}));
vi.mock("./../../clipboard-startup-lock.js", () => ({ tryAcquireClipboardStartupLock: native.acquire, recoverDeadClipboardStartupLock: native.recover, releaseClipboardStartupLock: native.release }));
vi.mock("./../../clipboard-bind-users.js", () => ({ clipboardPortMayHaveBindUsers: native.bindUsers }));
vi.mock("./../../adapters/runtime-bind-authority.js", async actual => {
    const authority = await actual<typeof import("../../adapters/runtime-bind-authority.js")>();
    native.originalGlobal = authority.withRuntimeBindGuardAsync;
    return {...authority, withRuntimeBindGuardAsync: native.global};
});
vi.mock("./../../session-lock-liveness.js", () => ({ sessionLockLiveness: () => { throw new Error("No native session probe"); } }));
vi.mock("@ccc/device-lab/windows-system-powershell.js", () => ({ canonicalWindowsPowerShellPath: () => null, hiddenWindowsPowerShellArgs: () => [] }));
vi.mock("http", async actual => ({...await actual<typeof import("node:http")>(), request: native.request}));
vi.mock("crypto", async actual => { const crypto = await actual<typeof import("node:crypto")>(); return {...crypto, createHash: (...args: Parameters<typeof crypto.createHash>) => {
    if (native.realHash) return crypto.createHash(...args);
    const hash = { update: (_value: unknown) => hash, digest: () => "aaaaaaaaaaaa0000000000000000000000000000000000000000000000000000" }; return hash;
}};});
vi.mock("fs", async actual => {
    const fs = await actual<typeof import("node:fs")>();
    return {...fs, readFileSync: native.read, existsSync: native.exists,
        lstatSync: (path: import("node:fs").PathLike, options?: {bigint?: boolean}) => {
            const observed = fs.lstatSync(path, options as {bigint: true});
            if (String(path) !== join(native.root, "port") || native.namedDevice === "native") return observed;
            const dev = native.namedDevice === "zero" ? (options?.bigint ? 0n : 0)
                : typeof observed.dev === "bigint" ? observed.dev + 1n : Number(observed.dev) + 1;
            return Object.create(observed, {dev: {value: dev, enumerable: true}});
        }};
});

let mod: typeof import("../../clipboard-server.js"), fs: typeof import("node:fs"), version: string, fixtureRoot: string;
const lock = { opaque: "native-lock" };
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); version = "aaaaaaaaaaaa"; native.namedDevice = "native"; native.realHash = false;
    fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    fixtureRoot = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ccc-clipboard-health-"))); native.root = fixtureRoot;
    fs.writeFileSync(join(native.root, "port"), "1234:secret:with:colon", {mode: 0o600});
    native.exists.mockImplementation(fs.existsSync);
    native.read.mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
        if (typeof args[0] === "string" && args[0].endsWith(".js")) return "fixture-policy";
        return fs.readFileSync(...args);
    });
    native.acquire.mockReturnValue(lock); native.recover.mockReturnValue(false); native.release.mockReturnValue({ ignored: true }); native.bindUsers.mockReturnValue(false);
    native.global.mockRejectedValue(new Error("No native global lock in read-only facade fixtures"));
    native.spawn.mockImplementation(() => { throw new Error("No daemon launch in read-only health owner"); });
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
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(fixtureRoot, {recursive: true, force: true}); });

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
    it("exports ensure, selection and awaited retirement bindings", async () => {
        expect(mod.ensureClipboardServer.name).toBe("ensureClipboardServer");
        expect(mod.ensureClipboardSelection.name).toBe("ensureClipboardSelection");
        expect(mod.stopClipboardServerIfLast.name).toBe("stopClipboardServerIfLast"); expect(mod.stopClipboardServerIfLast.length).toBe(1);
        expect(mod.retireClipboardServerFromPortFile.name).toBe("retireClipboardServerFromPortFile"); expect(mod.retireClipboardServerFromPortFile.length).toBe(1);
        const completion = mod.stopClipboardServerIfLast(true); expect(completion).toBeInstanceOf(Promise); await completion;
    });
    it("reuses current authenticated health with the whole token after the first colon", async () => {
        expect(await mod.ensureClipboardServer()).toBe(1234); expect(native.acquire).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
        expect(native.request.mock.calls[0][0]).toEqual({ hostname: "127.0.0.1", port: 1234, path: "/health", method: "GET", headers: { Authorization: "Bearer secret:with:colon" }, timeout: 2000 });
        expect(native.request.mock.results[0].value.destroy).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it("uses the native monotonic clock for contention despite forward and backward wall jumps", async () => {
        fs.rmSync(join(native.root, "port")); const allowance = 13500; native.acquire.mockReturnValue(null);
        let monotonic = 0;
        vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const wall = vi.spyOn(Date, "now").mockReturnValue(0);
        const observed = mod.ensureClipboardServer().catch(error => error);
        monotonic = allowance - 25; wall.mockReturnValue(1_000_000_000);
        await vi.advanceTimersByTimeAsync(100);
        expect(vi.getTimerCount()).toBe(1); expect(native.request).not.toHaveBeenCalled();
        monotonic = allowance; wall.mockReturnValue(-1_000_000_000);
        await vi.advanceTimersByTimeAsync(25);
        expect(await observed).toEqual(expect.objectContaining({ message: expect.stringContaining("Clipboard startup is still owned or its owner cannot be verified") }));
        expect(native.acquire).toHaveBeenCalledTimes(2); expect(native.recover).toHaveBeenCalledTimes(1); expect(native.release).not.toHaveBeenCalled();
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
    it.each([" 12:raw:token \n", "65535:token", "1234:legacy:retired-v1", `1234:${"a".repeat(32)}:retired-v`])("preserves active token bytes without mistaking a colon suffix for a terminal receipt: %s", async raw => {
        fs.writeFileSync(join(native.root, "port"), raw);
        expect(await mod.ensureClipboardServer()).toBe(Number.parseInt(raw.trim().split(":", 1)[0], 10));
        expect(native.request.mock.calls[0][0].headers.Authorization).toBe(`Bearer ${raw.trim().slice(raw.trim().indexOf(":") + 1)}`);
    });
    it("never treats a strict retired record as a live selection even if old health would say alive", async () => {
        fs.writeFileSync(join(native.root, "port"), `retired-v1:1234:${"a".repeat(32)}`);
        const afterRead = new Error("entered guarded admission instead of reusing retired state");
        native.acquire.mockImplementation(() => {throw afterRead;});
        await expect(mod.ensureClipboardSelection()).rejects.toBe(afterRead);
        expect(native.request).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
    });
    it("returns the authenticated port and token as one selection", async () => {
        expect(await mod.ensureClipboardSelection()).toEqual({port: 1234, token: "secret:with:colon", portFile: join(native.root, "port")});
        expect(native.acquire).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
    });
    it.each(["zero", "other"] as const)("Windows named device %s requires an exact positive opened-file identity", async device => {
        const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.defineProperty(process, "platform", {...descriptor, value: "win32"}); native.namedDevice = device;
        try {
            if (device === "zero") {
                expect(await mod.ensureClipboardSelection()).toEqual({port: 1234, token: "secret:with:colon", portFile: join(native.root, "port")});
                expect(native.acquire).not.toHaveBeenCalled(); expect(native.request).toHaveBeenCalledOnce();
            } else {
                const afterRead = new Error("named nonzero device mismatch preserved"); native.acquire.mockImplementation(() => {throw afterRead;});
                await expect(mod.ensureClipboardSelection()).rejects.toBe(afterRead); expect(native.request).not.toHaveBeenCalled();
            }
        } finally {Object.defineProperty(process, "platform", descriptor);}
    });
    it("stop with an explicit other-session veto resolves without reading shared files", async () => {
        native.read.mockClear(); await expect(mod.stopClipboardServerIfLast(true)).resolves.toBeUndefined();
        expect(native.read).not.toHaveBeenCalled(); expect(native.request).not.toHaveBeenCalled(); expect(native.acquire).not.toHaveBeenCalled();
    });
    it("keeps at most one asynchronous orphan admission pending across repeated timer ticks", async () => {
        vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]});
        let settle!: () => void;
        native.global.mockImplementation(() => new Promise<void>(resolve => {settle = resolve;}));
        const invocation = {version: 1 as const, runtime: "docker" as const, executable: join(native.root, "inert-runtime"),
            transport: {kind: "docker" as const, host: "unix:///inert/orphan.sock", configDirectory: native.root,
                tls: {enabled: false, verify: false, caFile: null, certFile: null, keyFile: null}},
            selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])) as Record<typeof NATIVE_RUNTIME_SELECTOR_KEYS[number], null>};
        const {server, start} = mod.createClipboardServer("owned-token", "unsupported", {runtimeInvocation: invocation});
        try {
            await start("127.0.0.1"); await vi.advanceTimersByTimeAsync(40_000);
            expect(native.global).toHaveBeenCalledTimes(1); expect(native.bindUsers).not.toHaveBeenCalled();
        } finally {
            // Do not invoke process-exiting product shutdown inside Vitest.
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            settle?.(); await Promise.resolve();
        }
    });
    it("rejects a queued IPC ready message after the monotonic publication deadline even before its timer runs", async () => {
        native.realHash = true;
        // The opaque preparation and delegated async guard must share the same
        // actual module's WeakMaps, including across Vitest module resets.
        const authority = await import("../../adapters/runtime-bind-authority.js");
        native.root = join(fixtureRoot, "controlled-home");
        const prepared = authority.prepareRuntimeBindHome(native.root); authority.withRuntimeBindGuard(prepared, () => {});
        if (!native.originalGlobal) throw new Error("Original native guard fixture was not initialized");
        native.global.mockImplementation(native.originalGlobal);
        const runtime = await import("../../container-runtime.js");
        runtime._setRuntimeInvocationForTest(runtime.validateNativeRuntimeInvocation({version: 1, runtime: "docker", executable: join(fixtureRoot, "inert-runtime"),
            transport: {kind: "docker", host: "unix:///inert/late-ready.sock", configDirectory: fixtureRoot,
                tls: {enabled: false, verify: false, caFile: null, certFile: null, keyFile: null}},
            selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null]))}));
        let monotonic = 100;
        vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const child = Object.assign(new EventEmitter(), {connected: true, unref: vi.fn(), disconnect: vi.fn(), send: vi.fn()});
        child.send.mockImplementation((message: {type: string}) => {
            if (message.type === "initialize") {
                // Deliver the already-queued message while the event loop's
                // timeout callback has not run. Wall-time sleeps cannot prove
                // this boundary; the actual IPC parent must check its deadline.
                monotonic += 60_000;
                child.emit("message", {type: "ready", port: 1234, token: "a".repeat(32)});
            }
        });
        native.spawn.mockReturnValue(child);
        let rejected: unknown;
        try {await mod.ensureClipboardSelection();} catch (error) {rejected = error;}
        expect(native.spawn, rejected instanceof Error ? rejected.stack : "IPC setup unexpectedly resolved").toHaveBeenCalledOnce();
        expect(rejected).toMatchObject({message: expect.stringContaining("publication timed out")});
        expect(fs.existsSync(join(native.root, "port"))).toBe(false);
        expect(child.send.mock.calls.some(([message]) => message.type === "published")).toBe(false);
        expect(child.disconnect).toHaveBeenCalledOnce();
    });
});
