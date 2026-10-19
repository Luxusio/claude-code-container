import {describe, expect, it} from "vitest";
import {createClipboardServerLifecycle} from "../../application/clipboard/server-lifecycle.js";
import type {ClipboardHealthResult, ClipboardPortRecord} from "../../domain/clipboard/server-lifecycle.js";
import type {ClipboardServerLifecyclePorts} from "../../ports/clipboard/server-lifecycle.js";

function fixture() {
    const calls: unknown[] = [], lock = {owner: "startup"}, child = {owner: "daemon"}, guard = {owner: "global"};
    const requester = {claim: "this requester"};
    let held = false, now = 0, record: ClipboardPortRecord | null = null;
    let health: ClipboardHealthResult = {alive: false};
    let otherSessions = false, bindUsers = false, publicationAllowed = true;
    const assertHeld = () => { if (!held) throw new Error("effect escaped global guard"); };
    const ports: ClipboardServerLifecyclePorts<typeof lock, typeof child, typeof guard, typeof requester> = {
        readPortFile: path => { calls.push(["read", path]); return record; },
        portRecordMatches: observed => observed === record,
        portFilePath: () => "/private/port", startupLockPath: () => "/private/starting",
        tryAcquireStartupLock: path => { calls.push(["startup", path]); return lock; },
        recoverDeadStartupLock: path => { calls.push(["recover", path]); return false; },
        releaseStartupLock: value => { calls.push(["release", value]); return undefined; },
        async withGlobalGuard(operation) {
            calls.push("global-enter"); held = true;
            try { return await operation(guard); }
            finally { held = false; calls.push("global-exit"); }
        },
        hasOtherSessions: value => { assertHeld(); calls.push(["sessions", value]); return otherSessions; },
        checkHealth: async (port, token, address) => { calls.push(["health", port, token, address]); return health; },
        requestShutdown: async (port, token) => { assertHeld(); calls.push(["shutdown", port, token]); return true; },
        markRetired: (value, path) => { assertHeld(); calls.push(["retired", value, path]); record = {...value, retired: true}; },
        portMayHaveBindUsers: (path, value) => { assertHeld(); calls.push(["bind-users", path, value]); return bindUsers; },
        preparePublication: (path, value) => {
            assertHeld(); calls.push(["prepare-publication", path, value]);
            return publicationAllowed && !bindUsers ? next => { assertHeld(); calls.push(["publish", next]); record = next; } : null;
        },
        warnUpgradeDeferred: () => { calls.push("deferred"); return undefined; },
        now: () => now, sleep: async milliseconds => { calls.push(["sleep", milliseconds]); now += milliseconds; },
        daemonScriptPath: () => "/private/clipboard-server.js",
        launchDaemon: async (script, publish) => {
            assertHeld(); calls.push(["launch", script]);
            publish({port: 4321, token: "new-token"}); health = {alive: true, version: "current", retirement: "writer-settlement-v1"};
            return child;
        },
        unrefDaemon: value => { calls.push(["unref", value]); return undefined; },
    };
    return {calls, ports, guard, lock, child, requester, app: createClipboardServerLifecycle(ports, "current"),
        setRecord: (value: ClipboardPortRecord | null) => { record = value; },
        setHealth: (value: ClipboardHealthResult) => { health = value; },
        setOtherSessions: (value: boolean) => { otherSessions = value; },
        setBindUsers: (value: boolean) => { bindUsers = value; },
        setPublicationAllowed: (value: boolean) => { publicationAllowed = value; },
        advance: (value: number) => { now += value; }};
}

function effects(calls: readonly unknown[]): string[] {
    return calls.filter((call): call is unknown[] => Array.isArray(call))
        .map(call => String(call[0])).filter(name => ["shutdown", "launch", "publish"].includes(name));
}

describe("Clipboard lifecycle admission policy", () => {
    it("reuses one authenticated same-version selection without locks, sessions or native inventory", async () => {
        const f = fixture(); f.setRecord({port: 1234, token: "secret:bytes"}); f.setHealth({alive: true, version: "current"});
        expect(await f.app.ensureClipboardSelection(f.requester)).toEqual({port: 1234, token: "secret:bytes", portFile: "/private/port"});
        expect(f.calls).toEqual([["read", undefined], ["health", 1234, "secret:bytes", "127.0.0.1"]]);
        expect(await f.app.ensureClipboardServer()).toBe(1234);
    });
    it("publishes a genuinely missing record only while startup and global ownership are held", async () => {
        const f = fixture();
        expect(await f.app.ensureClipboardSelection(f.requester)).toEqual({port: 4321, token: "new-token", portFile: "/private/port"});
        const enter = f.calls.indexOf("global-enter"), exit = f.calls.indexOf("global-exit");
        expect(enter).toBeGreaterThan(f.calls.findIndex(call => Array.isArray(call) && call[0] === "startup"));
        for (const name of ["sessions", "prepare-publication", "launch", "publish"]) {
            const index = f.calls.findIndex(call => Array.isArray(call) && call[0] === name);
            expect(index, name).toBeGreaterThan(enter); expect(index, name).toBeLessThan(exit);
        }
        expect(f.calls).toContainEqual(["sessions", f.requester]); expect(f.calls.at(-1)).toEqual(["release", f.lock]);
    });
    it.each(["sessions", "bind-users", "publication"] as const)("refuses missing publication when %s is uncertain", async veto => {
        const f = fixture();
        if (veto === "sessions") f.setOtherSessions(true);
        if (veto === "bind-users") f.setBindUsers(true);
        if (veto === "publication") f.setPublicationAllowed(false);
        expect(await f.app.ensureClipboardSelection(f.requester)).toBeNull();
        expect(effects(f.calls)).toEqual([]); expect(f.calls.at(-1)).toEqual(["release", f.lock]);
    });
    it("rechecks the record and authenticated health after entering the global guard", async () => {
        const f = fixture(); f.setRecord({port: 9, token: "stale"});
        const enter = f.ports.withGlobalGuard;
        f.ports.withGlobalGuard = operation => enter(async guard => {
            f.setRecord({port: 10, token: "successor"}); f.setHealth({alive: true, version: "current"});
            return operation(guard);
        });
        expect(await f.app.ensureClipboardSelection()).toEqual({port: 10, token: "successor", portFile: "/private/port"});
        expect(f.calls).toContainEqual(["health", 10, "successor", "127.0.0.1"]); expect(effects(f.calls)).toEqual([]);
    });
    it("does not accept a port/token observed before a publication changed during health", async () => {
        const f = fixture(); f.setRecord({port: 9, token: "old"});
        f.ports.checkHealth = async () => {
            f.setRecord({port: 10, token: "new"}); return {alive: true, version: "current"};
        };
        // Each health response applies to a displaced record. No old or mixed
        // selection may leave this application, even with a valid auth reply.
        expect(await f.app.ensureClipboardSelection()).toBeNull(); expect(effects(f.calls)).toEqual([]);
    });
    it.each(["sessions", "bind-users", "publication"] as const)("keeps an authenticated existing bridge when %s vetoes replacement", async veto => {
        const f = fixture(); f.setRecord({port: 9, token: "old"});
        f.setHealth({alive: true, version: "old", retirement: "writer-settlement-v1"});
        if (veto === "sessions") f.setOtherSessions(true);
        if (veto === "bind-users") f.setBindUsers(true);
        if (veto === "publication") f.setPublicationAllowed(false);
        expect(await f.app.ensureClipboardSelection(f.requester)).toEqual({port: 9, token: "old", portFile: "/private/port"});
        expect(effects(f.calls)).toEqual([]); expect(f.calls).toContain("deferred");
    });
    it("never asks a legacy peer to shut down merely because HTTP200 or a grace interval might follow", async () => {
        const f = fixture(); f.setRecord({port: 9, token: "legacy"}); f.setHealth({alive: true, version: "legacy"});
        expect(await f.app.ensureClipboardServer()).toBe(9); expect(effects(f.calls)).toEqual([]);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "sleep")).toEqual([]);
    });
    it("failed health is not proof of writer retirement", async () => {
        const f = fixture(); f.setRecord({port: 9, token: "old"}); f.setHealth({alive: false});
        expect(await f.app.ensureClipboardSelection()).toBeNull(); expect(effects(f.calls)).toEqual([]);
    });
    it("a settled terminal record is not returned as an active bridge even if its old endpoint answers health", async () => {
        const f = fixture(); f.setRecord({port: 9, token: "a".repeat(32), retired: true}); f.setHealth({alive: true, version: "current"});
        const result = await f.app.ensureClipboardSelection();
        expect(result).toEqual({port: 4321, token: "new-token", portFile: "/private/port"});
        expect(f.calls).toContain("global-enter"); expect(effects(f.calls)).toEqual(["launch", "publish"]);
        expect(f.calls.some(call => Array.isArray(call) && call[0] === "shutdown")).toBe(false);
    });
    it("persists achieved writer settlement before a later session veto blocks new publication", async () => {
        const f = fixture(); f.setRecord({port: 9, token: "old"}); f.setHealth({alive: true, version: "old", retirement: "writer-settlement-v1"});
        let reads = 0; f.ports.hasOtherSessions = () => ++reads > 2;
        expect(await f.app.ensureClipboardSelection()).toBeNull();
        const marker = f.calls.findIndex(call => Array.isArray(call) && call[0] === "retired");
        expect(marker).toBeGreaterThan(f.calls.findIndex(call => Array.isArray(call) && call[0] === "shutdown"));
        expect(effects(f.calls)).toEqual(["shutdown"]);
        // The positive settlement is retained; a later admitted request need
        // not infer death from an unhealthy endpoint or wait a grace interval.
        f.ports.hasOtherSessions = () => false;
        expect(await f.app.ensureClipboardServer()).toBe(4321);
        expect(effects(f.calls)).toEqual(["shutdown", "launch", "publish"]);
    });
    it("waits for exact writer settlement before launching under the same guard, without a fixed grace", async () => {
        const f = fixture(); f.setRecord({port: 9, token: "old"});
        f.setHealth({alive: true, version: "old", retirement: "writer-settlement-v1"});
        let settle: ((value: boolean) => void) | undefined;
        f.ports.requestShutdown = (port, token) => {
            f.calls.push(["shutdown", port, token]); return new Promise(resolve => { settle = resolve; });
        };
        const result = f.app.ensureClipboardSelection();
        while (!settle) await Promise.resolve();
        expect(f.calls).not.toContain("global-exit"); expect(effects(f.calls)).toEqual(["shutdown"]); settle(true);
        expect(await result).toEqual({port: 4321, token: "new-token", portFile: "/private/port"});
        expect(effects(f.calls)).toEqual(["shutdown", "launch", "publish"]); expect(f.calls).not.toContainEqual(["sleep", 3500]);
    });
    it.each([false, "reject"] as const)("does not launch after unsettled shutdown: %s", async outcome => {
        const f = fixture(); f.setRecord({port: 9, token: "old"});
        f.setHealth({alive: true, version: "old", retirement: "writer-settlement-v1"});
        f.ports.requestShutdown = async () => { if (outcome === "reject") throw new Error("retirement unavailable"); return false; };
        await f.app.ensureClipboardSelection().catch(() => null);
        expect(effects(f.calls)).toEqual([]); expect(f.calls).not.toContainEqual(["sleep", 3500]); expect(f.calls.at(-1)).toEqual(["release", f.lock]);
    });
    it("does not publish after the native publication receipt loses its target", async () => {
        const f = fixture(), displaced = new Error("port target changed");
        f.ports.preparePublication = () => () => { throw displaced; };
        await expect(f.app.ensureClipboardSelection()).rejects.toBe(displaced);
        expect(f.calls.some(call => Array.isArray(call) && call[0] === "publish")).toBe(false); expect(f.calls.at(-1)).toEqual(["release", f.lock]);
    });
    it("accepts a contending owner's current authenticated publication without global admission", async () => {
        const f = fixture(); f.ports.tryAcquireStartupLock = () => null;
        f.ports.sleep = async milliseconds => {
            f.advance(milliseconds); f.setRecord({port: 8, token: "winner"}); f.setHealth({alive: true, version: "current"});
        };
        expect(await f.app.ensureClipboardSelection()).toEqual({port: 8, token: "winner", portFile: "/private/port"});
        expect(f.calls).not.toContain("global-enter"); expect(effects(f.calls)).toEqual([]);
    });
    it("bounds startup contention and never enters global state when the startup owner is unknown", async () => {
        const f = fixture(); f.ports.tryAcquireStartupLock = () => null;
        await expect(f.app.ensureClipboardSelection()).rejects.toThrow("Clipboard startup is still owned or its owner cannot be verified");
        expect(f.calls).not.toContain("global-enter"); expect(effects(f.calls)).toEqual([]);
    });
    it("awaits stop settlement and skips all work for the caller's positive other-session veto", async () => {
        const f = fixture(); f.setRecord({port: 9, token: "old"}); f.setHealth({alive: true, version: "current", retirement: "writer-settlement-v1"});
        await f.app.stopClipboardServerIfLast(true); expect(f.calls).toEqual([]);
        let settle: ((value: boolean) => void) | undefined;
        f.ports.requestShutdown = () => new Promise(resolve => { settle = resolve; });
        let finished = false; const stopping = f.app.stopClipboardServerIfLast(false).then(() => { finished = true; });
        while (!settle) await Promise.resolve();
        expect(finished).toBe(false); expect(f.calls).not.toContain("global-exit"); settle(true);
        await stopping; expect(finished).toBe(true); expect(f.calls).toContain("global-exit");
    });
    it.each(["legacy", "sessions", "bind-users"] as const)("explicit retirement preserves a %s veto", async veto => {
        const f = fixture(); f.setRecord({port: 9, token: "old"});
        f.setHealth({alive: true, version: "current", ...(veto === "legacy" ? {} : {retirement: "writer-settlement-v1" as const})});
        if (veto === "sessions") f.setOtherSessions(true);
        if (veto === "bind-users") f.setBindUsers(true);
        await f.app.retireClipboardServerFromPortFile("/private/legacy-port");
        expect(f.calls).toContainEqual(["read", "/private/legacy-port"]); expect(effects(f.calls)).toEqual([]);
    });
});
