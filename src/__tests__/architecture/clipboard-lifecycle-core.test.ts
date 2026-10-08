import { describe, expect, it } from "vitest";
import { createClipboardServerLifecycle } from "../../application/clipboard/server-lifecycle.js";
import type { ClipboardHealthResult, ClipboardPortRecord } from "../../domain/clipboard/server-lifecycle.js";
import type { ClipboardServerLifecyclePorts } from "../../ports/clipboard/server-lifecycle.js";

function fixture() {
    const calls: unknown[] = []; const lock = { opaque: "lock" }; const child = { opaque: "child" };
    let now = 0; let record: ClipboardPortRecord | null = null; let health: ClipboardHealthResult = { alive: false };
    const ports: ClipboardServerLifecyclePorts<typeof lock, typeof child> = {
        readPortFile: path => { calls.push(["read", path]); return record; }, portFilePath: () => "/private/port", startupLockPath: () => "/private/lock",
        tryAcquireStartupLock: path => { calls.push(["acquire", path]); return lock; },
        recoverDeadStartupLock: path => { calls.push(["recover", path]); return false; },
        releaseStartupLock: value => { calls.push(["release", value]); return undefined; },
        checkHealth: async (port, token, address) => { calls.push(["health", port, token, address]); return health; },
        requestShutdown: async (port, token) => { calls.push(["shutdown", port, token]); return true; },
        portMayHaveBindUsers: path => { calls.push(["bind-users", path]); return false; },
        warnUpgradeDeferred: () => { calls.push("warning"); return undefined; }, now: () => now,
        sleep: async ms => { calls.push(["sleep", ms]); now += ms; }, daemonScriptPath: () => "/private/clipboard-server.js",
        launchDaemon: script => { calls.push(["launch", script]); record = { port: 4321, token: "new-token" }; health = { alive: true, version: "current" }; return child; },
        unrefDaemon: value => { calls.push(["unref", value]); return undefined; },
    };
    return { calls, ports, lock, child, app: createClipboardServerLifecycle(ports, "current"),
        setRecord: (value: ClipboardPortRecord | null) => { record = value; }, setHealth: (value: ClipboardHealthResult) => { health = value; } };
}

describe("Clipboard server lifecycle application policy", () => {
    it("reuses an authenticated same-version bridge before looking up a startup lock", async () => {
        const f = fixture(); f.setRecord({ port: 1234, token: "secret" }); f.setHealth({ alive: true, version: "current" });
        expect(f.app.ensureClipboardServer.name).toBe("ensureClipboardServer"); expect(f.app.ensureClipboardServer.length).toBe(0);
        expect(f.app.ensureClipboardServer.constructor.name).toBe("AsyncFunction");
        expect(await f.app.ensureClipboardServer()).toBe(1234);
        expect(f.calls).toEqual([["read", undefined], ["health", 1234, "secret", "127.0.0.1"]]);
    });
    it("launches the fixed daemon under the held lock and waits for fresh token plus current authenticated health", async () => {
        const f = fixture(); expect(await f.app.ensureClipboardServer()).toBe(4321);
        expect(f.calls).toEqual([["read", undefined], ["acquire", "/private/lock"], ["read", undefined],
            ["launch", "/private/clipboard-server.js"], ["unref", f.child], ["sleep", 100], ["read", undefined],
            ["health", 4321, "new-token", "127.0.0.1"], ["release", f.lock]]);
    });
    it("rechecks under lock and can reuse a bridge that became healthy between observations", async () => {
        const f = fixture(); f.setRecord({ port: 9, token: "old" }); let probes = 0;
        f.ports.checkHealth = async () => ({ alive: ++probes === 2, version: "current" });
        expect(await f.app.ensureClipboardServer()).toBe(9); expect(f.calls.at(-1)).toEqual(["release", f.lock]);
        expect(f.calls.some(call => Array.isArray(call) && call[0] === "launch")).toBe(false);
    });
    it("a contended lock accepts only a new publication token and requires the matching version", async () => {
        const f = fixture(); f.setRecord({ port: 9, token: "old" }); f.setHealth({ alive: true, version: "old" });
        f.ports.tryAcquireStartupLock = () => null; let sleeps = 0;
        const sleep = f.ports.sleep;
        f.ports.sleep = async ms => { await sleep(ms); if (++sleeps === 2) f.setRecord({ port: 10, token: "new" }); if (sleeps === 3) f.setHealth({ alive: true, version: "current" }); };
        expect(await f.app.ensureClipboardServer()).toBe(10);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "health")).toEqual([
            ["health", 9, "old", "127.0.0.1"], ["health", 10, "new", "127.0.0.1"], ["health", 10, "new", "127.0.0.1"]]);
        expect(f.calls.some(call => Array.isArray(call) && call[0] === "release")).toBe(false);
    });
    it("fails closed when the live or unknown lock remains unavailable to the deadline", async () => {
        const f = fixture(); f.ports.tryAcquireStartupLock = () => null;
        await expect(f.app.ensureClipboardServer()).rejects.toThrow("Clipboard startup is still owned or its owner cannot be verified: /private/lock");
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "sleep")).toHaveLength(135);
        expect(f.calls.some(call => Array.isArray(call) && ["launch", "release"].includes(String(call[0])))).toBe(false);
    });
    it("recovers then reacquires, sleeps the recovery grace before entering the release boundary", async () => {
        const f = fixture(); let acquired = 0;
        f.ports.tryAcquireStartupLock = path => { f.calls.push(["acquire", path]); return ++acquired === 3 ? f.lock : null; };
        f.ports.recoverDeadStartupLock = path => { f.calls.push(["recover", path]); return true; };
        expect(await f.app.ensureClipboardServer()).toBe(4321);
        expect(f.calls.slice(0, 7)).toEqual([["read", undefined], ["acquire", "/private/lock"], ["sleep", 100], ["read", undefined],
            ["acquire", "/private/lock"], ["recover", "/private/lock"], ["acquire", "/private/lock"]]);
        expect(f.calls[7]).toEqual(["sleep", 3500]); expect(f.calls.at(-1)).toEqual(["release", f.lock]);
    });
    it("propagates rejected recovered-lock grace without releasing the acquired lock", async () => {
        const f = fixture(); const failure = { raw: "grace rejection" }; let acquired = 0;
        f.ports.tryAcquireStartupLock = () => ++acquired === 3 ? f.lock : null; f.ports.recoverDeadStartupLock = () => true;
        const sleep = f.ports.sleep; f.ports.sleep = ms => ms === 3500 ? Promise.reject(failure) : sleep(ms);
        await expect(f.app.ensureClipboardServer()).rejects.toBe(failure);
        expect(f.calls.some(call => Array.isArray(call) && call[0] === "release")).toBe(false);
    });
    it("defers authenticated old-version upgrade when container bind users cannot be excluded", async () => {
        const f = fixture(); f.setRecord({ port: 9, token: "old" }); f.setHealth({ alive: true, version: "old-version" });
        f.ports.portMayHaveBindUsers = path => { f.calls.push(["bind-users", path]); return true; };
        expect(await f.app.ensureClipboardServer()).toBe(9);
        expect(f.calls.slice(-3)).toEqual([["bind-users", "/private/port"], "warning", ["release", f.lock]]);
        expect(f.calls.some(call => Array.isArray(call) && ["shutdown", "launch", "sleep"].includes(String(call[0])))).toBe(false);
    });
    it.each(["false", "reject"])("requires shutdown acknowledgement (%s) before grace or launch", async failure => {
        const f = fixture(); f.setRecord({ port: 9, token: "old" }); f.setHealth({ alive: true, version: "old-version" });
        const raw = { raw: "shutdown" }; f.ports.requestShutdown = () => failure === "false" ? Promise.resolve(false) : Promise.reject(raw);
        const result = f.app.ensureClipboardServer();
        if (failure === "false") await expect(result).rejects.toThrow("Failed to acknowledge clipboard server shutdown for upgrade"); else await expect(result).rejects.toBe(raw);
        expect(f.calls.at(-1)).toEqual(["release", f.lock]);
        expect(f.calls.some(call => Array.isArray(call) && ["launch", "sleep"].includes(String(call[0])))).toBe(false);
    });
    it("keeps acknowledged shutdown grace inside lock ownership and before publication", async () => {
        const f = fixture(); f.setRecord({ port: 9, token: "old" }); f.setHealth({ alive: true, version: "old-version" });
        expect(await f.app.ensureClipboardServer()).toBe(4321);
        const index = f.calls.findIndex(call => Array.isArray(call) && call[0] === "shutdown");
        expect(f.calls.slice(index, index + 3)).toEqual([["shutdown", 9, "old"], ["sleep", 3500], ["launch", "/private/clipboard-server.js"]]);
    });
    it("does not accept an unchanged startup token and releases after bounded publication timeout", async () => {
        const f = fixture(); f.setRecord({ port: 9, token: "old" });
        f.ports.launchDaemon = () => { f.setHealth({ alive: true, version: "current" }); return f.child; };
        await expect(f.app.ensureClipboardServer()).rejects.toThrow("Clipboard server failed to start within timeout");
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "sleep")).toHaveLength(50);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "health")).toHaveLength(2);
        expect(f.calls.at(-1)).toEqual(["release", f.lock]);
    });
    it.each(["success", "launch-error"])("lets locked release override %s with its original thrown value", async outcome => {
        const f = fixture(); const failure = { raw: "release" };
        f.ports.releaseStartupLock = () => { throw failure; };
        if (outcome === "launch-error") f.ports.launchDaemon = () => { throw new Error("primary"); };
        await expect(f.app.ensureClipboardServer()).rejects.toBe(failure);
    });
    it("keeps stop and explicit retire synchronous, observes bind users and ignores the shutdown promise", () => {
        const f = fixture(); const pending = new Promise<boolean>(() => {}); f.setRecord({ port: 9, token: "secret" });
        f.ports.requestShutdown = (port, token) => { f.calls.push(["shutdown", port, token]); return pending; };
        expect(f.app.stopClipboardServerIfLast.name).toBe("stopClipboardServerIfLast"); expect(f.app.stopClipboardServerIfLast.length).toBe(1);
        expect(f.app.retireClipboardServerFromPortFile.name).toBe("retireClipboardServerFromPortFile"); expect(f.app.retireClipboardServerFromPortFile.length).toBe(1);
        expect(f.app.stopClipboardServerIfLast(true)).toBeUndefined(); expect(f.calls).toEqual([]);
        expect(f.app.stopClipboardServerIfLast(false)).toBeUndefined();
        expect(f.calls).toEqual([["read", undefined], ["bind-users", "/private/port"], ["shutdown", 9, "secret"]]);
        f.calls.length = 0; expect(f.app.retireClipboardServerFromPortFile("raw:port")).toBeUndefined();
        expect(f.calls).toEqual([["read", "raw:port"], ["bind-users", "raw:port"], ["shutdown", 9, "secret"]]);
        f.calls.length = 0; f.ports.portMayHaveBindUsers = () => true;
        f.app.stopClipboardServerIfLast(false); f.app.retireClipboardServerFromPortFile("raw:port");
        expect(f.calls).toEqual([["read", undefined], ["read", "raw:port"]]);
    });
});
