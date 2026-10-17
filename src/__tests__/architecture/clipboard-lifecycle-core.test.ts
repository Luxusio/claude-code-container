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
        setRecord: (value: ClipboardPortRecord | null) => { record = value; }, setHealth: (value: ClipboardHealthResult) => { health = value; },
        advance: (milliseconds: number) => { now += milliseconds; } };
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
    it.each(["contention", "publication"] as const)("clips the last %s sleep and stops before expired publication polling", async phase => {
        const f = fixture(); const allowance = phase === "contention" ? 13500 : 5000;
        const beforePolling = phase === "contention" ? 1 : 2; let reads = 0;
        if (phase === "contention") f.ports.tryAcquireStartupLock = path => { f.calls.push(["acquire", path]); return null; };
        else f.ports.launchDaemon = script => { f.calls.push(["launch", script]); return f.child; };
        f.ports.readPortFile = path => {
            f.calls.push(["read", path]);
            return ++reads <= beforePolling ? null : { port: 4321, token: "new-token" };
        };
        f.ports.checkHealth = async (port, token, address) => {
            f.calls.push(["health", port, token, address]); f.advance(allowance - 125); return { alive: false };
        };
        await expect(f.app.ensureClipboardServer()).rejects.toThrow(phase === "contention"
            ? "Clipboard startup is still owned or its owner cannot be verified"
            : "Clipboard server failed to start within timeout");
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "sleep")).toEqual([["sleep", 100], ["sleep", 25]]);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "read")).toHaveLength(phase === "contention" ? 2 : 3);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "health")).toEqual([["health", 4321, "new-token", "127.0.0.1"]]);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "acquire")).toHaveLength(phase === "contention" ? 2 : 1);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "recover")).toHaveLength(phase === "contention" ? 1 : 0);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "release")).toEqual(phase === "publication" ? [["release", f.lock]] : []);
    });
    it.each(["contention", "publication"] as const)("refuses health and lock followups when a %s publication read consumes the remainder", async phase => {
        const f = fixture(); const allowance = phase === "contention" ? 13500 : 5000;
        const beforePolling = phase === "contention" ? 1 : 2; let reads = 0;
        f.ports.tryAcquireStartupLock = path => { f.calls.push(["acquire", path]); return phase === "contention" ? null : f.lock; };
        f.ports.launchDaemon = () => f.child;
        f.ports.readPortFile = path => {
            f.calls.push(["read", path]);
            if (++reads <= beforePolling) return null;
            f.advance(allowance - 100);
            return { port: 4321, token: "new-token" };
        };
        f.ports.checkHealth = async () => { f.calls.push("unexpected-health"); return { alive: true, version: "current" }; };
        await expect(f.app.ensureClipboardServer()).rejects.toThrow(phase === "contention"
            ? "Clipboard startup is still owned or its owner cannot be verified"
            : "Clipboard server failed to start within timeout");
        expect(reads).toBe(beforePolling + 1); expect(f.calls).not.toContain("unexpected-health");
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "acquire")).toHaveLength(1);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "recover")).toEqual([]);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "sleep")).toEqual([["sleep", 100]]);
    });
    it.each(["contention", "publication"] as const)("does not accept a late healthy %s publication or dispatch another attempt", async phase => {
        const f = fixture(); const allowance = phase === "contention" ? 13500 : 5000;
        const beforePolling = phase === "contention" ? 1 : 2; let reads = 0; let probes = 0;
        f.ports.tryAcquireStartupLock = path => { f.calls.push(["acquire", path]); return phase === "contention" ? null : f.lock; };
        f.ports.launchDaemon = () => f.child;
        f.ports.readPortFile = () => ++reads <= beforePolling ? null : { port: 4321, token: "new-token" };
        f.ports.checkHealth = async () => { probes++; f.advance(allowance - 100); return { alive: true, version: "current" }; };
        await expect(f.app.ensureClipboardServer()).rejects.toThrow(phase === "contention"
            ? "Clipboard startup is still owned or its owner cannot be verified"
            : "Clipboard server failed to start within timeout");
        expect(probes).toBe(1); expect(reads).toBe(beforePolling + 1);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "acquire")).toHaveLength(1);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "recover")).toEqual([]);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "sleep")).toEqual([["sleep", 100]]);
    });
    it.each(["acquire", "recover"] as const)("does not dispatch another lock operation after an unsuccessful %s exhausts contention", async operation => {
        const f = fixture(); let attempts = 0; let recoveries = 0;
        f.ports.tryAcquireStartupLock = () => { if (++attempts === 2 && operation === "acquire") f.advance(13400); return null; };
        f.ports.recoverDeadStartupLock = () => { recoveries++; f.advance(13400); return true; };
        await expect(f.app.ensureClipboardServer()).rejects.toThrow("Clipboard startup is still owned or its owner cannot be verified");
        expect(attempts).toBe(2); expect(recoveries).toBe(operation === "recover" ? 1 : 0);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "sleep")).toEqual([["sleep", 100]]);
        expect(f.calls.some(call => Array.isArray(call) && ["launch", "release"].includes(String(call[0])))).toBe(false);
    });
    it("keeps a successfully acquired lock even when acquisition itself reaches the contention deadline", async () => {
        const f = fixture(); let attempts = 0;
        f.ports.tryAcquireStartupLock = () => {
            if (++attempts === 1) return null;
            f.advance(13400); f.setRecord({ port: 2345, token: "new-token" }); f.setHealth({ alive: true, version: "current" });
            return f.lock;
        };
        expect(await f.app.ensureClipboardServer()).toBe(2345);
        expect(attempts).toBe(2); expect(f.calls.at(-1)).toEqual(["release", f.lock]);
        expect(f.calls.some(call => Array.isArray(call) && ["recover", "launch"].includes(String(call[0])))).toBe(false);
    });
    it.each(["initial", "held-lock"] as const)("retains independent %s authenticated health outside the publication phase", async phase => {
        const f = fixture(); f.setRecord({ port: 2345, token: "old-token" }); let probes = 0;
        f.ports.checkHealth = async () => { f.advance(50000); return { alive: ++probes === (phase === "initial" ? 1 : 2), version: "current" }; };
        expect(await f.app.ensureClipboardServer()).toBe(2345);
        expect(probes).toBe(phase === "initial" ? 1 : 2);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "release")).toEqual(phase === "initial" ? [] : [["release", f.lock]]);
        expect(f.calls.some(call => Array.isArray(call) && ["launch", "sleep"].includes(String(call[0])))).toBe(false);
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
