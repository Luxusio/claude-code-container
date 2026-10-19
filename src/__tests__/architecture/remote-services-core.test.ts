import { describe, expect, it } from "vitest";
import { createRemoteServices } from "../../application/remote-services.js";
import type { RemoteServicesPorts } from "../../ports/remote-services.js";
import type { RemoteConfig, RemoteEvent, RemoteFailureKind, RemoteSignal } from "../../domain/remote-services.js";

const config: RemoteConfig = { host: "host", user: "user", remotePath: "" };
const evidence = Symbol("opaque native diagnostic");
class FixtureFailure extends Error {
    constructor(readonly kind: RemoteFailureKind, readonly evidence?: symbol) { super(kind); }
}
function fixture() {
    let lifecycleHeld = false;
    const trace: unknown[][] = []; const id = "a".repeat(64); const token = "b".repeat(32);
    const state = {
        stop: false, busy: false, userAnswer: "newuser",
        closeCode: 0 as number | null, childError: null as unknown, closeFirst: false,
        signal: null as RemoteSignal | null, launchHook: null as (() => void) | null,
        heartbeat: null as (() => void) | null, releaseFault: null as Error | null,
        cancelFault: null as Error | null, removalFault: null as Error | null,
    };
    const handlers = new Map<RemoteSignal, () => void>();
    const ports: RemoteServicesPorts<symbol> = {
        resolveProjectPath: path => { trace.push(["resolve", path]); return "/resolved/project"; },
        getProjectId: () => "project-id", getProjectHash: () => "hash", getMutagenSessionName: () => "sync",
        getContainerName: () => "expected-name", hashRemoteIdentity: value => { trace.push(["identity", value]); return "owner"; },
        newReservationToken: () => token,
        observeTool: tool => { trace.push(["tool", tool]); return { installed: true, version: "1.0" }; },
        isHostReachable: host => { trace.push(["ping", host]); return true; },
        remoteImagePresent: remote => { trace.push(["image", remote]); return true; },
        reserveContainer: request => { trace.push(["reserve", request]); return { kind: "reserved", container: { name: "returned-name", id } }; },
        refreshReservation: request => { trace.push(["refresh", request]); return false; },
        releaseReservation: request => { trace.push(["release", request]); if (state.releaseFault) throw state.releaseFault; },
        stopReservedContainer: request => { trace.push(["stop", request]); return { kind: state.busy ? "busy" : "stopped" }; },
        prepareRemoteProject: request => { trace.push(["prepare", request]); return { ok: true }; },
        observeSync: (name, expectedId) => { trace.push(["observe-sync", name, expectedId]); return { kind: "observed", endpointMatches: true, paused: false, watching: true, failed: false, evidence }; },
        createSync: request => { trace.push(["create-sync", request]); return { ok: true }; },
        resumeSync: name => { trace.push(["resume", name]); return { ok: true }; },
        terminateStaleSync: name => { trace.push(["terminate-stale", name]); return { ok: true }; },
        terminateSync: name => { trace.push(["terminate", name]); },
        pauseSync: name => { trace.push(["pause", name]); },
        startSyncDaemon: () => { trace.push(["daemon"]); },
        readRemoteConfigs: () => { trace.push(["read-config"]); return { hash: config }; },
        prepareLegacyConfigReader: hash => { trace.push(["legacy", hash]); return { exists: () => { trace.push(["legacy-exists"]); return false; }, readConfig: () => { trace.push(["legacy-read"]); return config; } }; },
        saveRemoteConfig: (hash, remote) => { trace.push(["save", hash, remote]); }, readUser: () => "localuser",
        prompt: async request => { trace.push(["prompt", request]); return request.kind === "user" ? state.userAnswer : state.stop ? "yes" : "n"; },
        report: event => { trace.push(["report", event]); },
        fail: (kind, original) => { trace.push(["fail", kind, original]); throw new FixtureFailure(kind, original); },
        createSessionLock: prefix => { trace.push(["claim", prefix]); return "claim"; },
        removeSessionLock: file => { expect(lifecycleHeld).toBe(false); trace.push(["remove", file]); if (state.removalFault) throw state.removalFault; return undefined; },
        removeSessionLockInHeldLifecycleLock: file => { expect(lifecycleHeld).toBe(true); trace.push(["remove", file]); if (state.removalFault) throw state.removalFault; return undefined; },
        withLifecycleLock: (prefix, operation) => {
            expect(lifecycleHeld).toBe(false);
            trace.push(["sync-lock", prefix]); lifecycleHeld = true;
            try { return operation(); } finally { lifecycleHeld = false; }
        },
        withLifecycleLockAsync: <Value>(prefix: string, operation: () => Promise<Value>): Promise<Value> => { trace.push(["async-lock", prefix]); return operation(); },
        startHeartbeat: (callback, milliseconds) => {
            state.heartbeat = callback; trace.push(["heartbeat", milliseconds]);
            return {
                unref: () => { trace.push(["unref"]); return undefined; },
                cancel: () => { trace.push(["cancel"]); if (state.cancelFault) throw state.cancelFault; state.heartbeat = null; return undefined; },
            };
        },
        onceSignal: (signal, callback) => { trace.push(["listen", signal]); handlers.set(signal, callback); return undefined; },
        removeSignalListener: signal => { trace.push(["unlisten", signal]); handlers.delete(signal); return undefined; },
        resignalSelf: signal => { trace.push(["self-signal", signal]); return true; },
        exit: code => { trace.push(["exit", code]); throw Error("exit:" + code); },
        collectCurrentForwardedEnv: () => ({ forwarded: [["SECOND", "v2"], ["FIRST", "v1"]], skippedDueToLimit: ["LARGE"], totalBytes: 10 }),
        startInteractiveSession: request => {
            trace.push(["ssh", request]); state.launchHook?.();
            return {
                onClose: callback => {
                    trace.push(["on-close"]); state.heartbeat?.();
                    if (state.signal) handlers.get(state.signal)?.();
                    if (state.closeFirst) callback(state.closeCode); else queueMicrotask(() => callback(state.closeCode));
                    return undefined;
                },
                onError: callback => { trace.push(["on-error"]); if (state.childError) callback(state.childError); return undefined; },
                kill: signal => { trace.push(["child-kill", signal]); return true; },
            };
        },
        now: () => 1, sleep: async () => {},
    };
    return { trace, state, ports, handlers, id, token, services: () => createRemoteServices(ports) };
}
function events(trace: unknown[][]): RemoteEvent<symbol>[] {
    return trace.filter(row => row[0] === "report").map(row => row[1] as RemoteEvent<symbol>);
}
function index(trace: unknown[][], kind: string): number {
    const found = trace.findIndex(row => row[0] === kind); expect(found).toBeGreaterThanOrEqual(0); return found;
}
function expectNoClaim(trace: unknown[][]): void {
    expect(trace.some(row => ["claim", "reserve", "release", "remove", "ssh"].includes(String(row[0])))).toBe(false);
}

describe("whole remote semantic workflows", () => {
    it("observes setup tools in order and returns early with installation notices", async () => {
        const { ports, services, trace } = fixture(); ports.observeTool = tool => { trace.push(["tool", tool]); return { installed: false }; };
        await services().remoteSetup();
        expect(trace.filter(row => row[0] === "tool")).toEqual([["tool", "tailscale"], ["tool", "mutagen"]]);
        expect(events(trace)).toContainEqual({ kind: "tool-install-guide", tool: "tailscale" });
        expect(events(trace)).toContainEqual({ kind: "tool-install-guide", tool: "mutagen" });
        expect(events(trace)).toContainEqual({ kind: "setup-tools-missing" });
        expect(events(trace).some(event => event.kind === "setup-usage")).toBe(false);
        trace.length = 0; ports.observeTool = tool => { trace.push(["tool", tool]); return { installed: true, version: "1.0" }; };
        await services().remoteSetup();
        expect(events(trace).filter(event => ["setup-usage", "setup-architecture", "setup-requirements"].includes(event.kind)).map(event => event.kind)).toEqual(["setup-usage", "setup-architecture", "setup-requirements"]);
    });

    it("check uses saved config without validation and reports finite available/missing sync facts", async () => {
        const { ports, services, trace } = fixture(); const raw = { ...config, host: "host;raw", user: "user;raw" };
        ports.readRemoteConfigs = () => ({ hash: raw });
        await services().remoteCheck("relative"); expect(trace).toContainEqual(["ping", "host;raw"]);
        expect(events(trace)).toContainEqual({ kind: "status-config-saved", config: raw, containerName: "expected-name" });
        expect(events(trace).some(event => event.kind === "status-sync-active")).toBe(true); expectNoClaim(trace);
        trace.length = 0; ports.observeSync = () => ({ kind: "unavailable" });
        await services().remoteCheck("relative"); expect(events(trace)).toContainEqual({ kind: "status-sync-missing", sessionName: "sync" });
    });

    it("public terminate has absent/present branches and consumes a void effect", async () => {
        const { ports, services, trace } = fixture(); ports.observeSync = () => ({ kind: "unavailable" });
        await services().remoteTerminate("relative"); expect(events(trace)).toContainEqual({ kind: "sync-inactive" });
        expect(trace.some(row => row[0] === "terminate")).toBe(false);
        trace.length = 0; ports.observeSync = () => ({ kind: "observed", endpointMatches: false, paused: true, watching: false, failed: true, evidence });
        await services().remoteTerminate("relative"); expect(trace).toContainEqual(["terminate", "sync"]);
        expect(events(trace)).toContainEqual({ kind: "sync-terminated" }); expectNoClaim(trace);
        const fault = Error("terminate"); ports.terminateSync = () => { throw fault; };
        await expect(services().remoteTerminate("relative")).rejects.toBe(fault);
    });

    it("canonical configuration wins without consulting legacy; missing canonical uses decoded legacy", async () => {
        const { ports, services, trace } = fixture();
        ports.prepareLegacyConfigReader = () => { throw Error("legacy must not be consulted"); };
        await services().remoteCheck("relative"); expect(trace).toContainEqual(["ping", "host"]);
        trace.length = 0; ports.readRemoteConfigs = () => ({});
        const legacy = { ...config, host: "legacy-host" };
        ports.prepareLegacyConfigReader = hash => { trace.push(["legacy", hash]); return { exists: () => true, readConfig: () => legacy }; };
        await services().remoteCheck("relative"); expect(trace).toContainEqual(["legacy", "hash"]); expect(trace).toContainEqual(["ping", "legacy-host"]);
    });

    it("legacy absence avoids reading; legacy read/decode errors become missing config", async () => {
        const { ports, services, trace } = fixture(); ports.readRemoteConfigs = () => null;
        ports.prepareLegacyConfigReader = () => ({ exists: () => false, readConfig: () => { throw Error("must not read"); } });
        await services().remoteCheck("relative"); expect(events(trace)).toContainEqual({ kind: "status-config-missing" });
        trace.length = 0; ports.prepareLegacyConfigReader = () => ({ exists: () => true, readConfig: () => { throw Error("decode"); } });
        await services().remoteCheck("relative"); expect(events(trace)).toContainEqual({ kind: "status-config-missing" });
        expect(trace.some(row => row[0] === "ping")).toBe(false);
    });

    it("canonical settings and legacy existence failures propagate before remote mutation", async () => {
        const { ports, services, trace } = fixture(); const mainFault = Error("main settings");
        ports.readRemoteConfigs = () => { throw mainFault; };
        await expect(services().remoteCheck("relative")).rejects.toBe(mainFault); expectNoClaim(trace);
        const existsFault = Error("legacy exists"); ports.readRemoteConfigs = () => null;
        ports.prepareLegacyConfigReader = () => ({ exists: () => { throw existsFault; }, readConfig: () => config });
        await expect(services().remoteCheck("relative")).rejects.toBe(existsFault); expectNoClaim(trace);
    });

    it("tool, absent config and invalid saved config refuse execution before claim", async () => {
        const missingTool = fixture(); missingTool.ports.observeTool = () => ({ installed: false });
        await expect(missingTool.services().remoteExec("relative")).rejects.toThrow("exit:1");
        expect(events(missingTool.trace)).toContainEqual({ kind: "mutagen-required" }); expectNoClaim(missingTool.trace);
        const absent = fixture(); absent.ports.readRemoteConfigs = () => null;
        await expect(absent.services().remoteExec("relative")).rejects.toThrow("exit:1");
        expect(events(absent.trace)).toContainEqual({ kind: "config-required" }); expectNoClaim(absent.trace);
        for (const invalid of [{ ...config, host: "host;bad" }, { ...config, user: "user;bad" }]) {
            const f = fixture(); f.ports.readRemoteConfigs = () => ({ hash: invalid });
            await expect(f.services().remoteExec("relative")).rejects.toThrow("exit:1");
            expect(events(f.trace)).toContainEqual({ kind: "config-invalid" }); expectNoClaim(f.trace);
        }
    });

    it("invalid explicit host/user and unreachable host refuse execution before save or claim", async () => {
        const invalidHost = fixture();
        await expect(invalidHost.services().remoteExec("relative", "bad;host")).rejects.toThrow("exit:1");
        expect(events(invalidHost.trace)).toContainEqual({ kind: "host-invalid", host: "bad;host" }); expectNoClaim(invalidHost.trace);
        const unreachable = fixture(); unreachable.ports.isHostReachable = () => false;
        await expect(unreachable.services().remoteExec("relative", "new-host")).rejects.toThrow("exit:1");
        expect(events(unreachable.trace)).toContainEqual({ kind: "host-unreachable", host: "new-host" }); expectNoClaim(unreachable.trace);
        const invalidUser = fixture(); invalidUser.state.userAnswer = "bad;user";
        await expect(invalidUser.services().remoteExec("relative", "new-host")).rejects.toThrow("exit:1");
        expect(events(invalidUser.trace)).toContainEqual({ kind: "user-invalid", user: "bad;user" }); expectNoClaim(invalidUser.trace);
        for (const f of [invalidHost, unreachable, invalidUser]) expect(f.trace.some(row => row[0] === "save")).toBe(false);
    });

    it("explicit host saves the chosen user or local default before claim, and forwards literal arguments", async () => {
        for (const answer of ["newuser", ""]) {
            const f = fixture(); f.state.userAnswer = answer;
            await expect(f.services().remoteExec("relative", "new-host", ["a'b", "日本語", "$(literal)"])).rejects.toThrow("exit:0");
            const remote = { host: "new-host", user: answer || "localuser", remotePath: "" };
            expect(f.trace).toContainEqual(["prompt", { kind: "user", defaultUser: "localuser" }]);
            expect(f.trace).toContainEqual(["save", "hash", remote]); expect(index(f.trace, "save")).toBeLessThan(index(f.trace, "claim"));
            expect(f.trace).toContainEqual(["ssh", { config: remote, containerId: f.id, projectId: "project-id", arguments: ["a'b", "日本語", "$(literal)"], environment: [["SECOND", "v2"], ["FIRST", "v1"]] }]);
        }
    });

    it("claim and both signal listeners precede locked start, with 300-second lease and 30-second unref heartbeat", async () => {
        const { services, trace, id, token } = fixture(); await expect(services().remoteExec("relative")).rejects.toThrow("exit:0");
        expect(trace).toContainEqual(["reserve", { config, projectPath: "/resolved/project", profile: undefined, token, leaseSeconds: 300 }]);
        expect(trace).toContainEqual(["heartbeat", 30_000]); expect(trace).toContainEqual(["unref"]);
        expect(index(trace, "claim")).toBeLessThan(index(trace, "async-lock"));
        for (const signal of ["SIGINT", "SIGTERM"]) {
            const listen = trace.findIndex(row => row[0] === "listen" && row[1] === signal);
            expect(listen).toBeGreaterThan(index(trace, "claim")); expect(listen).toBeLessThan(index(trace, "async-lock"));
        }
        expect(index(trace, "async-lock")).toBeLessThan(index(trace, "reserve"));
        expect(trace).toContainEqual(["prepare", { config, containerId: id, projectId: "project-id" }]);
        expect(trace).toContainEqual(["observe-sync", "sync", id]);
        expect(trace).toContainEqual(["ssh", { config, containerId: id, projectId: "project-id", arguments: [], environment: [["SECOND", "v2"], ["FIRST", "v1"]] }]);
    });

    it("refresh uses returned name and exact ID, warns without aborting, while release retains expected name", async () => {
        const { services, trace, id, token } = fixture(); await expect(services().remoteExec("relative")).rejects.toThrow("exit:0");
        expect(trace).toContainEqual(["refresh", { config, name: "returned-name", containerId: id, token, leaseSeconds: 300 }]);
        expect(events(trace)).toContainEqual({ kind: "refresh-failed" }); expect(events(trace)).toContainEqual({ kind: "env-skipped", count: 1 });
        expect(trace).toContainEqual(["release", { config, name: "expected-name", token }]);
        expect(index(trace, "cancel")).toBeLessThan(index(trace, "release")); expect(index(trace, "release")).toBeLessThan(index(trace, "remove"));
        expect(index(trace, "remove")).toBeLessThan(index(trace, "exit"));
    });

    it("finite reservation failures preserve diagnostics and release expected-name protection before removing the claim", async () => {
        for (const reason of ["start-failed", "missing-container-id"] as const) {
            const f = fixture(); f.ports.reserveContainer = request => { f.trace.push(["reserve", request]); return { kind: "failed", reason, evidence }; };
            await expect(f.services().remoteExec("relative")).rejects.toThrow("exit:1");
            expect(f.trace).toContainEqual(["fail", reason, evidence]); expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", "claim"]]);
            expect(f.trace).toContainEqual(["release", { config, name: "expected-name", token: f.token }]);
            expect(index(f.trace, "release")).toBeLessThan(index(f.trace, "remove"));
            expect(f.trace.some(row => ["heartbeat", "cancel", "prepare", "daemon", "observe-sync", "ssh"].includes(String(row[0])))).toBe(false);
        }
    });

    it("image failure cleans the existing claim and prevents reservation; preparation failure prevents sync and SSH", async () => {
        const missingImage = fixture(); missingImage.ports.remoteImagePresent = () => false;
        await expect(missingImage.services().remoteExec("relative")).rejects.toThrow("exit:1");
        expect(missingImage.trace).toContainEqual(["fail", "image-missing", undefined]);
        expect(missingImage.trace.some(row => row[0] === "reserve" || row[0] === "release")).toBe(false);
        expect(missingImage.trace).toContainEqual(["remove", "claim"]);
        const unprepared = fixture(); unprepared.ports.prepareRemoteProject = () => ({ ok: false, evidence });
        await expect(unprepared.services().remoteExec("relative")).rejects.toThrow("exit:1");
        expect(unprepared.trace).toContainEqual(["fail", "project-prepare-failed", evidence]);
        expect(unprepared.trace.some(row => ["daemon", "observe-sync", "ssh"].includes(String(row[0])))).toBe(false);
        expect(unprepared.trace).toContainEqual(["release", { config, name: "expected-name", token: unprepared.token }]);
        expect(unprepared.trace).toContainEqual(["remove", "claim"]);
    });

    it("close zero and null prompt; nonzero settles without cleanup prompt", async () => {
        for (const code of [0, 7, null]) {
            const f = fixture(); f.state.closeCode = code;
            await expect(f.services().remoteExec("relative")).rejects.toThrow("exit:" + (code ?? 0));
            expect(f.trace.filter(row => row[0] === "prompt")).toEqual((code ?? 0) === 0 ? [["prompt", { kind: "cleanup" }]] : []);
            expect(f.trace).toContainEqual(["remove", "claim"]);
        }
    });

    it("the first SSH settlement wins for error before close and close before error", async () => {
        const errorFirst = fixture(); const childError = { message: "opaque child detail" }; errorFirst.state.childError = childError;
        await expect(errorFirst.services().remoteExec("relative")).rejects.toThrow("exit:1");
        expect(events(errorFirst.trace)).toContainEqual({ kind: "ssh-error", error: childError });
        expect(errorFirst.trace.some(row => row[0] === "prompt")).toBe(false);
        const closeFirst = fixture(); closeFirst.state.childError = childError; closeFirst.state.closeFirst = true;
        await expect(closeFirst.services().remoteExec("relative")).rejects.toThrow("exit:0");
        expect(closeFirst.trace).toContainEqual(["prompt", { kind: "cleanup" }]);
    });

    it("successful unsignalled yes stops the exact returned container under lock before pausing", async () => {
        const { state, services, trace, id, token } = fixture(); state.stop = true;
        await expect(services().remoteExec("relative")).rejects.toThrow("exit:0");
        expect(trace).toContainEqual(["stop", { config, name: "returned-name", containerId: id, token }]);
        expect(index(trace, "sync-lock")).toBeLessThan(index(trace, "stop")); expect(index(trace, "stop")).toBeLessThan(index(trace, "pause"));
        expect(trace).toContainEqual(["pause", "sync"]); expect(trace.filter(row => row[0] === "remove")).toHaveLength(1);
        expect(trace.some(row => row[0] === "release")).toBe(false);
    });

    it("busy stop cancels protection, skips pause and release, and removes its local claim once", async () => {
        const { state, services, trace } = fixture(); state.stop = true; state.busy = true;
        await expect(services().remoteExec("relative")).rejects.toThrow("exit:0");
        expect(events(trace)).toContainEqual({ kind: "peer-active" }); expect(trace).toContainEqual(["cancel"]);
        expect(trace.filter(row => row[0] === "remove")).toHaveLength(1);
        expect(trace.some(row => row[0] === "pause" || row[0] === "release")).toBe(false);
    });

    it("failed stop and thrown pause preserve failure exit without reopening a retired local claim", async () => {
        const failedStop = fixture(); failedStop.state.stop = true; failedStop.ports.stopReservedContainer = () => ({ kind: "failed", evidence });
        await expect(failedStop.services().remoteExec("relative")).rejects.toThrow("exit:1");
        expect(failedStop.trace).toContainEqual(["fail", "stop-failed", evidence]);
        expect(failedStop.trace.filter(row => row[0] === "remove")).toHaveLength(1);
        expect(failedStop.trace).toContainEqual(["release", { config, name: "expected-name", token: failedStop.token }]);
        expect(index(failedStop.trace, "cancel")).toBeLessThan(index(failedStop.trace, "release"));
        expect(index(failedStop.trace, "remove")).toBeLessThan(index(failedStop.trace, "release"));
        expect(failedStop.trace.some(row => row[0] === "pause")).toBe(false);
        const thrownPause = fixture(); thrownPause.state.stop = true; const fault = Error("pause");
        thrownPause.ports.pauseSync = name => { thrownPause.trace.push(["pause", name]); throw fault; };
        await expect(thrownPause.services().remoteExec("relative")).rejects.toThrow("exit:1");
        expect(events(thrownPause.trace)).toContainEqual({ kind: "unexpected-error", error: fault });
        expect(thrownPause.trace.filter(row => row[0] === "remove")).toHaveLength(1);
        expect(thrownPause.trace.some(row => row[0] === "release")).toBe(false);
    });

    it("active-child signals reach the child before cleanup, then self after cleanup, with no prompt or exit", async () => {
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
            const f = fixture(); f.state.signal = signal; await f.services().remoteExec("relative");
            expect(f.trace).toContainEqual(["child-kill", signal]); expect(f.trace).toContainEqual(["self-signal", signal]);
            expect(index(f.trace, "child-kill")).toBeLessThan(index(f.trace, "release"));
            expect(index(f.trace, "remove")).toBeLessThan(index(f.trace, "self-signal"));
            expect(f.trace.some(row => row[0] === "prompt" || row[0] === "exit" || row[0] === "stop")).toBe(false);
        }
    });

    it("a signal with no active child performs synchronous cleanup immediately before self signalling", async () => {
        const f = fixture(); f.state.launchHook = () => {
            f.trace.push(["signal-without-child"]); f.handlers.get("SIGTERM")?.(); f.trace.push(["signal-returned"]);
        };
        await f.services().remoteExec("relative");
        expect(index(f.trace, "signal-without-child")).toBeLessThan(index(f.trace, "release"));
        expect(index(f.trace, "remove")).toBeLessThan(index(f.trace, "self-signal"));
        expect(index(f.trace, "self-signal")).toBeLessThan(index(f.trace, "signal-returned"));
        expect(f.trace.some(row => row[0] === "child-kill" || row[0] === "prompt" || row[0] === "exit")).toBe(false);
    });

    it("release, heartbeat cancellation and local removal exceptions override exit in cleanup order", async () => {
        const release = fixture(); const releaseFault = Error("release"); release.state.releaseFault = releaseFault;
        await expect(release.services().remoteExec("relative")).rejects.toBe(releaseFault);
        expect(release.trace.some(row => row[0] === "remove" || row[0] === "exit")).toBe(false);
        const cancel = fixture(); const cancelFault = Error("cancel"); cancel.state.cancelFault = cancelFault; cancel.state.releaseFault = releaseFault;
        await expect(cancel.services().remoteExec("relative")).rejects.toBe(cancelFault);
        expect(cancel.trace.some(row => ["release", "remove", "exit"].includes(String(row[0])))).toBe(false);
        const remove = fixture(); const removalFault = Error("remove"); remove.state.removalFault = removalFault;
        await expect(remove.services().remoteExec("relative")).rejects.toBe(removalFault);
        expect(index(remove.trace, "release")).toBeLessThan(index(remove.trace, "remove"));
        expect(remove.trace.some(row => row[0] === "exit")).toBe(false);
    });

    it("failures before claim avoid cleanup and exit; lock failure releases protection before removing the claim", async () => {
        const beforeClaim = fixture(); const fault = Error("claim"); beforeClaim.ports.createSessionLock = () => { throw fault; };
        await expect(beforeClaim.services().remoteExec("relative")).rejects.toBe(fault);
        expectNoClaim(beforeClaim.trace); expect(beforeClaim.trace.some(row => row[0] === "exit" || row[0] === "cancel")).toBe(false);
        const save = fixture(); save.ports.saveRemoteConfig = () => { throw fault; };
        await expect(save.services().remoteExec("relative", "new-host")).rejects.toBe(fault); expectNoClaim(save.trace);
        const lock = fixture(); lock.ports.withLifecycleLockAsync = async () => { throw fault; };
        await expect(lock.services().remoteExec("relative")).rejects.toThrow("exit:1");
        expect(lock.trace.filter(row => row[0] === "remove")).toEqual([["remove", "claim"]]);
        expect(lock.trace).toContainEqual(["release", { config, name: "expected-name", token: lock.token }]);
        expect(index(lock.trace, "release")).toBeLessThan(index(lock.trace, "remove"));
        expect(lock.trace.some(row => ["reserve", "heartbeat", "cancel", "prepare", "daemon", "observe-sync", "ssh"].includes(String(row[0])))).toBe(false);
    });
});
