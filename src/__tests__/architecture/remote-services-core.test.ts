import { describe, expect, it } from "vitest";
import { createRemoteServices } from "../../application/remote-services.js";
import type { RemoteServicesPorts } from "../../ports/remote-services.js";
import type { RemoteSignal } from "../../domain/remote-services.js";

function fixture() {
    const trace: unknown[][] = []; const id = "a".repeat(64);
    const state = { stop: false, busy: false, releaseFault: null as Error | null, signal: false, childError: false, nameReads: 0, heartbeat: null as (() => void) | null };
    const handlers = new Map<RemoteSignal, () => void>();
    const ports: RemoteServicesPorts = {
        resolveProjectPath: path => { trace.push(["resolve", path]); return path; }, getProjectId: () => "project", getProjectHash: () => "hash", getMutagenSessionName: () => "sync",
        getContainerName: () => ++state.nameReads === 1 ? "expected-name" : "captured-name", captureHashPath: () => value => { trace.push(["hash", value]); return "owner"; }, newReservationToken: () => "b".repeat(32),
        observeTool: tool => { trace.push(["tool", tool]); return { status: 0, stdout: tool+" 1.0" }; }, observeHostReachability: host => { trace.push(["ping", host]); return { status: 0 }; },
        observeSync: () => ({ status: 0, stdout: `docker://${id}/\nStatus: Watching for changes` }), startSyncDaemon: () => ({ status: 1 }), terminateSync: () => { trace.push(["terminate"]); return { status: 1 }; }, resumeSync: () => ({ status: 0 }), createSync: () => ({ status: 0 }), pauseSync: () => { trace.push(["pause"]); return { status: 1 }; }, readCommonIgnoreDirs: () => [],
        readSettings: () => ({ remote: { hash: { host: "host", user: "user", remotePath: "" } } }), captureLegacyConfigReader: () => ({ exists: () => false, readText: () => "" }), updateSettings: callback => { const settings = {}; callback(settings); trace.push(["settings", settings]); return undefined; }, readUser: () => "localuser",
        prompt: async question => { trace.push(["prompt", question]); return question.startsWith("Remote user") ? "newuser" : state.stop ? "yes" : "n"; },
        captureLog: () => message => { trace.push(["log", message]); return undefined; }, captureError: () => message => { trace.push(["error", message]); return undefined; }, captureProgress: () => message => { trace.push(["progress", message]); return undefined; },
        observeRemoteImage: () => ({ status: 1, stdout: "image" }), buildContainerStartShell: () => "start-body", buildReservationShell: (...args) => { trace.push(["reserve-body", ...args]); return "reserve"; },
        buildRefreshShell: (...args) => { trace.push(["refresh-body", ...args]); return "refresh"; }, buildReleaseShell: (...args) => { trace.push(["release-body", ...args]); return "release"; }, buildStopShell: (...args) => { trace.push(["stop-body", ...args]); return "stop"; },
        runReservation: (_config, body) => { body(); return { status: 0, stdout: `ccc-container-id=${id}\n` }; }, prepareRemoteProject: (_config, target, projectId) => { trace.push(["mkdir", target, projectId]); return { status: 0 }; }, runRefresh: (_config, body) => { body(); return { status: 1 }; }, runRelease: (_config, body) => { body(); trace.push(["release"]); if (state.releaseFault) throw state.releaseFault; return { status: 1 }; }, runStop: (_config, body) => { body(); trace.push(["stop"]); return { status: state.busy ? 42 : 0 }; },
        createSessionLock: prefix => { trace.push(["claim", prefix]); return "claim"; }, removeSessionLock: claim => { trace.push(["remove", claim]); return undefined; }, withLifecycleLock: (prefix, operation) => { trace.push(["sync-lock", prefix]); return operation(); }, withLifecycleLockAsync: <Value>(prefix: string, operation: () => Promise<Value>): Promise<Value> => { trace.push(["async-lock", prefix]); return operation(); },
        startHeartbeat: (callback, interval) => { state.heartbeat = callback; trace.push(["heartbeat", interval]); return { unref: () => { trace.push(["unref"]); return undefined; }, cancel: () => { trace.push(["cancel"]); return undefined; } }; }, onceSignal: (signal, callback) => { handlers.set(signal, callback); return undefined; }, removeSignalListener: signal => { handlers.delete(signal); return undefined; }, resignalSelf: signal => { trace.push(["self-signal", signal]); return true; }, exit: code => { trace.push(["exit", code]); throw Error(`exit:${code}`); },
        collectCurrentForwardedEnv: () => ({ forwarded: [["SAFE", "value"]], skippedDueToLimit: ["LARGE"], totalBytes: 10 }), readContainerEnvKey: () => "CCC_CONTAINER", readContainerEnvValue: () => "1", encodeProgram: program => { trace.push(["program", program]); return "encoded"; },
        startInteractiveSsh: (_config, command) => { trace.push(["ssh", command]); return { onClose: callback => { trace.push(["on-close"]); state.heartbeat?.(); if (state.signal) handlers.get("SIGTERM")?.(); queueMicrotask(() => callback(0)); return undefined; }, onError: callback => { trace.push(["on-error"]); if (state.childError) callback({ message: "child" }); return undefined; }, kill: signal => { trace.push(["child-kill", signal]); return true; } }; },
        now: () => 1, sleep: async () => {},
    };
    return { trace, state, ports, id, services: () => createRemoteServices(ports) };
}

describe("whole remote host workflows", () => {
    it("requires all explicit ports without invoking native defaults", () => {
        const { ports, trace } = fixture();
        for (const name of Object.keys(ports)) { const missing = { ...ports }; Reflect.deleteProperty(missing, name); expect(() => createRemoteServices(missing)).toThrow(`callable ${name} port`); }
        expect(trace).toEqual([]);
    });
    it("keeps setup observation/output order and missing-tool early return", async () => {
        const { ports, services, trace } = fixture(); ports.observeTool = tool => { trace.push(["tool", tool]); return { status: 1 }; };
        await services().remoteSetup(); expect(trace.filter(row => row[0] === "tool")).toEqual([["tool", "tailscale"], ["tool", "mutagen"]]);
        expect(trace.some(row => String(row[1]).includes("Please install missing tools"))).toBe(true); expect(trace.some(row => String(row[1]).includes("=== Usage"))).toBe(false);
    });
    it("check preserves read-only unvalidated config behavior and terminate ignores returned failure", async () => {
        const { ports, services, trace } = fixture(); ports.readSettings = () => ({ remote: { hash: { host: "host;raw", user: "user", remotePath: "" } } });
        await services().remoteCheck("project"); expect(trace).toContainEqual(["ping", "host;raw"]);
        trace.length = 0; await services().remoteTerminate("project"); expect(trace).toContainEqual(["terminate"]); expect(trace).toContainEqual(["log", "Sync terminated."]); expect(trace.some(row => row[0] === "release")).toBe(false);
    });
    it("keeps expected name for release and captured name/ID for heartbeat/project/SSH", async () => {
        const { services, trace, id } = fixture(); await expect(services().remoteExec("project", undefined, ["a'b"])).rejects.toThrow("exit:0");
        expect(trace).toContainEqual(["heartbeat", 30_000]); expect(trace).toContainEqual(["mkdir", id, "project"]);
        expect(trace).toContainEqual(["refresh-body", "captured-name", "b".repeat(32), 300, true, id]); expect(trace).toContainEqual(["release-body", "expected-name", "b".repeat(32)]);
        const claim = trace.findIndex(row => row[0] === "claim"); const reserve = trace.findIndex(row => row[0] === "reserve-body"); expect(claim).toBeLessThan(reserve);
        expect(trace.some(row => row[0] === "program" && String(row[1]).includes("'a'\\''b'"))).toBe(true);
        expect(trace.findIndex(row => row[0] === "release")).toBeLessThan(trace.findIndex(row => row[0] === "remove"));
    });
    it("busy stop clears protection without pause and removes own local claim only once", async () => {
        const { state, services, trace, id } = fixture(); state.stop = true; state.busy = true;
        await expect(services().remoteExec("project")).rejects.toThrow("exit:0");
        expect(trace).toContainEqual(["stop-body", "captured-name", "b".repeat(32), id]); expect(trace.filter(row => row[0] === "remove")).toHaveLength(1); expect(trace.some(row => row[0] === "pause")).toBe(false); expect(trace.some(row => row[0] === "release")).toBe(false);
    });
    it("forwards active-child signals before cleanup and self-signal after cleanup", async () => {
        const { state, services, trace } = fixture(); state.signal = true; await services().remoteExec("project");
        expect(trace.findIndex(row => row[0] === "child-kill")).toBeLessThan(trace.findIndex(row => row[0] === "remove")); expect(trace.findIndex(row => row[0] === "remove")).toBeLessThan(trace.findIndex(row => row[0] === "self-signal")); expect(trace.some(row => row[0] === "exit")).toBe(false);
    });
    it("release exceptions override exit and skip later local claim removal", async () => {
        const { state, services, trace } = fixture(); const fault = Error("release"); state.releaseFault = fault;
        await expect(services().remoteExec("project")).rejects.toBe(fault); expect(trace.some(row => row[0] === "remove" || row[0] === "exit")).toBe(false);
    });
    it("SSH error settles one before queued close-zero and skips cleanup prompt", async () => {
        const { state, services, trace } = fixture(); state.childError = true;
        await expect(services().remoteExec("project")).rejects.toThrow("exit:1"); expect(trace).toContainEqual(["error", "SSH error: child"]); expect(trace.some(row => row[0] === "prompt")).toBe(false);
    });
});
