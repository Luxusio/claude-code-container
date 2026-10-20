import { describe, expect, it } from "vitest";
import { createRemoteServices } from "../../application/remote-services.js";
import type { RemoteServicesPorts } from "../../ports/remote-services.js";
import type { RemoteConfig, RemoteEvent, RemoteSignal, RemoteSyncInventory, RemoteExecutionOutcome } from "../../domain/remote-services.js";

const config: RemoteConfig = { host: "host", user: "user", remotePath: "" };
const evidence = Symbol("opaque native diagnostic");
function fixture() {
    const held = new Set<string>();
    const trace: unknown[][] = []; const id = "a".repeat(64); const token = "b".repeat(32);
    const syncId = "sync_" + "s".repeat(43);
    let savedConfig = config;
    const state = {
        stop: false, busy: false, userAnswer: "newuser",
        closeCode: 0 as number | null, childError: null as unknown, closeFirst: false,
        signal: null as RemoteSignal | null, launchHook: null as (() => void) | null,
        heartbeat: null as (() => void) | null, releaseFault: null as Error | null,
        cancelFault: null as Error | null, removalFault: null as Error | null,
        inventory: null as RemoteSyncInventory<symbol> | null,
    };
    const handlers = new Map<RemoteSignal, () => void>();
    const ports: RemoteServicesPorts<symbol> = {
        resolveProjectPath: path => { trace.push(["resolve", path]); return "/resolved/project"; },
        getProjectId: () => "project-id", getProjectHash: () => "hash", getMutagenSessionName: () => "legacy-sync", getScopedMutagenSessionName: () => "sync",
        getContainerName: () => "expected-name", hashRemoteIdentity: value => { trace.push(["identity", value]); return "owner"; },
        newReservationToken: () => token,
        observeTool: tool => { trace.push(["tool", tool]); return { installed: true, version: "1.0" }; },
        isHostReachable: host => { trace.push(["ping", host]); return true; },
        remoteImagePresent: remote => { trace.push(["image", remote]); return true; },
        reserveContainer: request => { trace.push(["reserve", request]); return { kind: "reserved", container: { name: "returned-name", id } }; },
        refreshReservation: request => { trace.push(["refresh", request]); return false; },
        releaseReservation: request => { trace.push(["release", request]); if (state.releaseFault) throw state.releaseFault; return { ok: true }; },
        stopReservedContainer: request => { trace.push(["stop", request]); return { kind: state.busy ? "busy" : "stopped" }; },
        prepareRemoteProject: request => { trace.push(["prepare", request]); return { ok: true }; },
        observeSyncInventory: remaining => {
            trace.push(["observe-sync", remaining]);
            return state.inventory ?? { kind: "known", evidence, sessions: [{ kind: "observed", identifier: syncId, name: "sync", binding: { localPath: "/resolved/project", user: savedConfig.user, host: savedConfig.host, projectId: "project-id", containerId: id }, paused: false, watching: true, failed: false, evidence }] };
        },
        createSync: request => { trace.push(["create-sync", request]); return { ok: true }; },
        resumeSync: name => { trace.push(["resume", name]); return { ok: true }; },
        terminateSync: identifier => { trace.push(["terminate", identifier]); return { ok: true }; },
        pauseSync: identifier => { trace.push(["pause", identifier]); return { ok: true }; },
        startSyncDaemon: () => { trace.push(["daemon"]); },
        readRemoteConfigs: () => { trace.push(["read-config"]); return { hash: config }; },
        prepareLegacyConfigReader: hash => { trace.push(["legacy", hash]); return { exists: () => { trace.push(["legacy-exists"]); return false; }, readConfig: () => { trace.push(["legacy-read"]); return config; } }; },
        saveRemoteConfig: (hash, remote) => { trace.push(["save", hash, remote]); savedConfig = remote; }, readUser: () => "localuser",
        prompt: request => { trace.push(["prompt", request]); return { result: Promise.resolve(request.kind === "user" ? state.userAnswer : state.stop ? "yes" : "n"), cancel: () => { trace.push(["cancel-prompt", request.kind]); return undefined; } }; },
        report: event => { trace.push(["report", event]); },
        createSessionLock: prefix => { trace.push(["claim", prefix]); return "claim"; },
        removeSessionLock: file => { expect([...held].some(key => key.startsWith("remote--"))).toBe(false); trace.push(["remove", file]); if (state.removalFault) throw state.removalFault; return undefined; },
        removeSessionLockInHeldLifecycleLock: file => { expect([...held].some(key => key.startsWith("remote--"))).toBe(true); trace.push(["remove", file]); if (state.removalFault) throw state.removalFault; return undefined; },
        withLifecycleLock: (prefix, operation) => {
            expect(held.has(prefix)).toBe(false);
            trace.push(["sync-lock", prefix]); held.add(prefix);
            try { return operation(); } finally { held.delete(prefix); trace.push(["unlock", prefix]); }
        },
        withLifecycleLockAsync: async <Value>(prefix: string, operation: () => Promise<Value>): Promise<Value> => {
            expect(held.has(prefix)).toBe(false); trace.push(["async-lock", prefix]); held.add(prefix);
            try { return await operation(); } finally { held.delete(prefix); trace.push(["unlock", prefix]); }
        },
        startHeartbeat: (callback, milliseconds) => {
            state.heartbeat = callback; trace.push(["heartbeat", milliseconds]);
            return {
                unref: () => { trace.push(["unref"]); return undefined; },
                cancel: () => { trace.push(["cancel"]); if (state.cancelFault) throw state.cancelFault; state.heartbeat = null; return undefined; },
            };
        },
        onSignal: (signal, callback) => { trace.push(["listen", signal]); handlers.set(signal, callback); return undefined; },
        removeSignalListener: (signal, callback) => { trace.push(["unlisten", signal]); if (handlers.get(signal) === callback) handlers.delete(signal); return undefined; },
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
        now: () => 1, sleep: () => ({ completion: Promise.resolve(), cancel: () => undefined }),
    };
    return { trace, state, ports, handlers, id, token, syncId, services: () => {
        const service = createRemoteServices(ports);
        return { ...service, remoteExec: async (...args: Parameters<typeof service.remoteExec>) => { const outcome = await service.remoteExec(...args); trace.push(["outcome", outcome]); return outcome; }, remoteTerminate: async (...args: Parameters<typeof service.remoteTerminate>) => { const outcome = await service.remoteTerminate(...args); trace.push(["outcome", outcome]); return outcome; } };
    } };
}
function completed(exitCode: number): RemoteExecutionOutcome<symbol> { return { kind: "completed", exitCode, cleanupFailures: [] }; }
function deferred<Value>() { let resolve!: (value: Value | PromiseLike<Value>) => void; const promise = new Promise<Value>(settle => { resolve = settle; }); return { promise, resolve }; }
function outcome(trace: unknown[][]) { return trace.filter(row => row[0] === "outcome").at(-1)?.[1]; }
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

    it("check qualifies saved configuration and distinguishes active, missing, unknown and conflicting sync", async () => {
        const { state, services, trace } = fixture();
        await services().remoteCheck("relative"); expect(trace).toContainEqual(["ping", "host"]);
        expect(events(trace)).toContainEqual({ kind: "status-config-saved", config, containerName: "expected-name" });
        expect(events(trace).some(event => event.kind === "status-sync-active")).toBe(true); expectNoClaim(trace);
        trace.length = 0; state.inventory = { kind: "known", sessions: [], evidence };
        await services().remoteCheck("relative"); expect(events(trace)).toContainEqual({ kind: "status-sync-missing", sessionName: "sync" });
        trace.length = 0; state.inventory = { kind: "unknown", evidence };
        await services().remoteCheck("relative"); expect(events(trace)).toContainEqual({ kind: "status-sync-unknown" });
        trace.length = 0; state.inventory = { kind: "known", evidence, sessions: [{ kind: "observed", identifier: "sync_" + "x".repeat(43), name: "sync", binding: null, paused: false, watching: true, failed: false, evidence }] };
        await services().remoteCheck("relative"); expect(events(trace)).toContainEqual({ kind: "status-sync-conflict" });
    });

    it("public terminate requires qualified inventory and checked identifier completion", async () => {
        const { ports, state, syncId, services, trace } = fixture(); state.inventory = { kind: "known", sessions: [], evidence };
        await expect(services().remoteTerminate("relative")).resolves.toEqual({ kind: "completed", state: "inactive" }); expect(events(trace)).toContainEqual({ kind: "sync-inactive" });
        expect(trace.some(row => row[0] === "terminate")).toBe(false);
        trace.length = 0; state.inventory = null;
        await expect(services().remoteTerminate("relative")).resolves.toEqual({ kind: "completed", state: "terminated" }); expect(trace).toContainEqual(["terminate", syncId]);
        expect(events(trace)).toContainEqual({ kind: "sync-terminated" }); expectNoClaim(trace);
        trace.length = 0; ports.terminateSync = () => ({ ok: false, evidence });
        await expect(services().remoteTerminate("relative")).resolves.toEqual({ kind: "failed", reason: "sync-terminate-failed", evidence });
        expect(events(trace)).not.toContainEqual({ kind: "sync-terminated" });
        const fault = Error("terminate"); ports.terminateSync = () => { throw fault; };
        await expect(services().remoteTerminate("relative")).resolves.toEqual({ kind: "fault", error: fault });
    });

    it("public termination rejects missing/invalid config, unknown and conflicting authority with no effects", async () => {
        for (const saved of [null, { ...config, host: "bad;host" }]) {
            const f = fixture(); f.ports.readRemoteConfigs = () => saved ? { hash: saved } : null;
            await expect(f.services().remoteTerminate("relative")).resolves.toMatchObject({ kind: "failed", reason: saved ? "config-invalid" : "config-unresolved" });
            expect(f.trace.some(row => ["terminate", "observe-sync", "pause", "create-sync"].includes(String(row[0])))).toBe(false);
        }
        for (const inventory of [{ kind: "unknown", evidence }, { kind: "known", evidence, sessions: [{ kind: "observed", identifier: "sync_" + "x".repeat(43), name: "legacy-sync", binding: null, paused: false, watching: true, failed: false, evidence }] }] as RemoteSyncInventory<symbol>[]) {
            const f = fixture(); f.state.inventory = inventory;
            await expect(f.services().remoteTerminate("relative")).resolves.toEqual({ kind: "failed", reason: inventory.kind === "unknown" ? "sync-unknown" : "sync-conflict", evidence });
            expect(f.trace.some(row => ["terminate", "pause", "create-sync"].includes(String(row[0])))).toBe(false);
        }
        const f = fixture(); f.ports.readRemoteConfigs = () => ({ hash: { ...config, host: "bad;host" } });
        await f.services().remoteCheck("relative"); expect(events(f.trace)).toContainEqual({ kind: "status-sync-unknown" }); expect(f.trace.some(row => row[0] === "ping")).toBe(false);
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
        await expect(missingTool.services().remoteExec("relative")).resolves.toEqual({ kind: "refused", reason: "mutagen-required", cleanupFailures: [] });
        expect(events(missingTool.trace)).toContainEqual({ kind: "mutagen-required" }); expectNoClaim(missingTool.trace);
        const absent = fixture(); absent.ports.readRemoteConfigs = () => null;
        await expect(absent.services().remoteExec("relative")).resolves.toEqual({ kind: "refused", reason: "config-required", cleanupFailures: [] });
        expect(events(absent.trace)).toContainEqual({ kind: "config-required" }); expectNoClaim(absent.trace);
        for (const invalid of [{ ...config, host: "host;bad" }, { ...config, user: "user;bad" }]) {
            const f = fixture(); f.ports.readRemoteConfigs = () => ({ hash: invalid });
            await expect(f.services().remoteExec("relative")).resolves.toEqual({ kind: "refused", reason: "config-invalid", cleanupFailures: [] });
            expect(events(f.trace)).toContainEqual({ kind: "config-invalid" }); expectNoClaim(f.trace);
        }
    });

    it("invalid explicit host/user and unreachable host refuse execution before save or claim", async () => {
        const invalidHost = fixture();
        await expect(invalidHost.services().remoteExec("relative", "bad;host")).resolves.toEqual({ kind: "refused", reason: "host-invalid", cleanupFailures: [] });
        expect(events(invalidHost.trace)).toContainEqual({ kind: "host-invalid", host: "bad;host" }); expectNoClaim(invalidHost.trace);
        const unreachable = fixture(); unreachable.ports.isHostReachable = () => false;
        await expect(unreachable.services().remoteExec("relative", "new-host")).resolves.toEqual({ kind: "refused", reason: "host-unreachable", cleanupFailures: [] });
        expect(events(unreachable.trace)).toContainEqual({ kind: "host-unreachable", host: "new-host" }); expectNoClaim(unreachable.trace);
        const invalidUser = fixture(); invalidUser.state.userAnswer = "bad;user";
        await expect(invalidUser.services().remoteExec("relative", "new-host")).resolves.toEqual({ kind: "refused", reason: "user-invalid", cleanupFailures: [] });
        expect(events(invalidUser.trace)).toContainEqual({ kind: "user-invalid", user: "bad;user" }); expectNoClaim(invalidUser.trace);
        for (const f of [invalidHost, unreachable, invalidUser]) expect(f.trace.some(row => row[0] === "save")).toBe(false);
    });

    it("explicit host saves the chosen user or local default before claim, and forwards literal arguments", async () => {
        for (const answer of ["newuser", ""]) {
            const f = fixture(); f.state.userAnswer = answer;
            await expect(f.services().remoteExec("relative", "new-host", ["a'b", "日本語", "$(literal)"])).resolves.toEqual(completed(0));
            const remote = { host: "new-host", user: answer || "localuser", remotePath: "" };
            expect(f.trace).toContainEqual(["prompt", { kind: "user", defaultUser: "localuser" }]);
            expect(f.trace).toContainEqual(["save", "hash", remote]); expect(index(f.trace, "save")).toBeLessThan(index(f.trace, "claim"));
            expect(f.trace).toContainEqual(["ssh", { config: remote, containerId: f.id, projectId: "project-id", arguments: ["a'b", "日本語", "$(literal)"], environment: [["SECOND", "v2"], ["FIRST", "v1"]] }]);
        }
    });

    it("claim and both signal listeners precede locked start, with 300-second lease and 30-second unref heartbeat", async () => {
        const { services, trace, id, token } = fixture(); await expect(services().remoteExec("relative")).resolves.toEqual(completed(0));
        expect(trace).toContainEqual(["reserve", { config, projectPath: "/resolved/project", profile: undefined, token, leaseSeconds: 300 }]);
        expect(trace).toContainEqual(["heartbeat", 30_000]); expect(trace).toContainEqual(["unref"]);
        expect(index(trace, "claim")).toBeLessThan(index(trace, "async-lock"));
        for (const signal of ["SIGINT", "SIGTERM"]) {
            const listen = trace.findIndex(row => row[0] === "listen" && row[1] === signal);
            expect(listen).toBeLessThan(index(trace, "async-lock"));
        }
        expect(index(trace, "async-lock")).toBeLessThan(index(trace, "reserve"));
        expect(trace).toContainEqual(["prepare", { config, containerId: id, projectId: "project-id" }]);
        expect(trace.some(row => row[0] === "observe-sync")).toBe(true);
        expect(trace).toContainEqual(["ssh", { config, containerId: id, projectId: "project-id", arguments: [], environment: [["SECOND", "v2"], ["FIRST", "v1"]] }]);
    });

    it("refresh uses returned name and exact ID, warns without aborting, while release retains expected name", async () => {
        const { services, trace, id, token } = fixture(); await expect(services().remoteExec("relative")).resolves.toEqual(completed(0));
        expect(trace).toContainEqual(["refresh", { config, name: "returned-name", containerId: id, token, leaseSeconds: 300 }]);
        expect(events(trace)).toContainEqual({ kind: "refresh-failed" }); expect(events(trace)).toContainEqual({ kind: "env-skipped", count: 1 });
        expect(trace).toContainEqual(["release", { config, name: "expected-name", token }]);
        expect(index(trace, "cancel")).toBeLessThan(index(trace, "release")); expect(index(trace, "release")).toBeLessThan(index(trace, "remove"));
        expect(index(trace, "remove")).toBeLessThan(index(trace, "outcome"));
    });

    it("finite reservation failures preserve diagnostics and release expected-name protection before removing the claim", async () => {
        for (const reason of ["start-failed", "missing-container-id"] as const) {
            const f = fixture(); f.ports.reserveContainer = request => { f.trace.push(["reserve", request]); return { kind: "failed", reason, evidence }; };
            await expect(f.services().remoteExec("relative")).resolves.toEqual({ kind: "failed", reason, evidence, cleanupFailures: [] });
            expect(outcome(f.trace)).toMatchObject({ kind: "failed", reason: reason, evidence: evidence }); expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", "claim"]]);
            expect(f.trace).toContainEqual(["release", { config, name: "expected-name", token: f.token }]);
            expect(index(f.trace, "release")).toBeLessThan(index(f.trace, "remove"));
            expect(f.trace.some(row => ["heartbeat", "cancel", "prepare", "daemon", "observe-sync", "ssh"].includes(String(row[0])))).toBe(false);
        }
    });

    it("image failure cleans the existing claim and prevents reservation; preparation failure prevents sync and SSH", async () => {
        const missingImage = fixture(); missingImage.ports.remoteImagePresent = () => false;
        await expect(missingImage.services().remoteExec("relative")).resolves.toEqual({ kind: "failed", reason: "image-missing", cleanupFailures: [] });
        expect(outcome(missingImage.trace)).toMatchObject({ kind: "failed", reason: "image-missing" });
        expect(missingImage.trace.some(row => row[0] === "reserve" || row[0] === "release")).toBe(false);
        expect(missingImage.trace).toContainEqual(["remove", "claim"]);
        const unprepared = fixture(); unprepared.ports.prepareRemoteProject = () => ({ ok: false, evidence });
        await expect(unprepared.services().remoteExec("relative")).resolves.toEqual({ kind: "failed", reason: "project-prepare-failed", evidence, cleanupFailures: [] });
        expect(outcome(unprepared.trace)).toMatchObject({ kind: "failed", reason: "project-prepare-failed", evidence: evidence });
        expect(unprepared.trace.some(row => ["daemon", "observe-sync", "ssh"].includes(String(row[0])))).toBe(false);
        expect(unprepared.trace).toContainEqual(["release", { config, name: "expected-name", token: unprepared.token }]);
        expect(unprepared.trace).toContainEqual(["remove", "claim"]);
    });

    it("close zero and null prompt; nonzero settles without cleanup prompt", async () => {
        for (const code of [0, 7, null]) {
            const f = fixture(); f.state.closeCode = code;
            await expect(f.services().remoteExec("relative")).resolves.toEqual(completed(code ?? 0));
            expect(f.trace.filter(row => row[0] === "prompt")).toEqual((code ?? 0) === 0 ? [["prompt", { kind: "cleanup" }]] : []);
            expect(f.trace).toContainEqual(["remove", "claim"]);
        }
    });

    it("the first SSH settlement wins for error before close and close before error", async () => {
        const errorFirst = fixture(); const childError = { message: "opaque child detail" }; errorFirst.state.childError = childError;
        await expect(errorFirst.services().remoteExec("relative")).resolves.toEqual(completed(1));
        expect(events(errorFirst.trace)).toContainEqual({ kind: "ssh-error", error: childError });
        expect(errorFirst.trace.some(row => row[0] === "prompt")).toBe(false);
        const closeFirst = fixture(); closeFirst.state.childError = childError; closeFirst.state.closeFirst = true;
        await expect(closeFirst.services().remoteExec("relative")).resolves.toEqual(completed(0));
        expect(closeFirst.trace).toContainEqual(["prompt", { kind: "cleanup" }]);
    });

    it("successful unsignalled yes stops the exact returned container under lock before pausing", async () => {
        const { state, services, trace, id, token, syncId } = fixture(); state.stop = true;
        await expect(services().remoteExec("relative")).resolves.toEqual(completed(0));
        expect(trace).toContainEqual(["stop", { config, name: "returned-name", containerId: id, token }]);
        expect(index(trace, "sync-lock")).toBeLessThan(index(trace, "stop")); expect(index(trace, "stop")).toBeLessThan(index(trace, "pause"));
        expect(trace).toContainEqual(["pause", syncId]); expect(trace.filter(row => row[0] === "remove")).toHaveLength(1);
        expect(trace.some(row => row[0] === "release")).toBe(false);
    });

    it("busy stop cancels protection, skips pause and release, and removes its local claim once", async () => {
        const { state, services, trace } = fixture(); state.stop = true; state.busy = true;
        await expect(services().remoteExec("relative")).resolves.toEqual(completed(0));
        expect(events(trace)).toContainEqual({ kind: "peer-active" }); expect(trace).toContainEqual(["cancel"]);
        expect(trace.filter(row => row[0] === "remove")).toHaveLength(1);
        expect(trace.some(row => row[0] === "pause" || row[0] === "release")).toBe(false);
    });

    it("holds project sync before container guards across reservation and stop/pause", async () => {
        const f = fixture(); f.state.stop = true;
        await expect(f.services().remoteExec("relative")).resolves.toEqual(completed(0));
        const admission = f.trace.filter(row => row[0] === "async-lock");
        expect(admission.slice(0, 2)).toEqual([["async-lock", "remote-sync--hash"], ["async-lock", "remote--owner--project-id"]]);
        const cleanup = f.trace.filter(row => row[0] === "sync-lock");
        expect(cleanup).toEqual([["sync-lock", "remote--owner--project-id"]]);
        const stopAt = index(f.trace, "stop"), pauseAt = index(f.trace, "pause");
        expect(f.trace.slice(0, stopAt).filter(row => row[0] === "async-lock").at(-1)).toEqual(["async-lock", "remote-sync--hash"]);
        expect(f.trace.slice(stopAt + 1, pauseAt).some(row => row[0] === "observe-sync")).toBe(true);
        expect(f.trace.slice(stopAt + 1, pauseAt).some(row => row[0] === "unlock")).toBe(false);
        expect(f.trace.filter(row => row[0] === "resolve")).toEqual([["resolve", "relative"]]);
        expect(f.trace.filter(row => row[0] === "read-config")).toHaveLength(1);
    });

    it.each(["missing", "successor", "unknown", "conflict"] as const)("cleanup stops its container but preserves %s sync authority", async mode => {
        const f = fixture(); f.state.stop = true;
        f.state.launchHook = () => {
            const inventory = f.ports.observeSyncInventory();
            if (inventory.kind !== "known") throw Error("fixture initial inventory");
            f.state.inventory = mode === "unknown" ? { kind: "unknown", evidence } : { kind: "known", evidence,
                sessions: mode === "missing" ? [] : inventory.sessions.map(row => mode === "successor" ? { ...row, identifier: "sync_" + "z".repeat(43) } : { ...row, binding: null }) };
        };
        await expect(f.services().remoteExec("relative")).resolves.toMatchObject(mode === "unknown" || mode === "conflict" ? { kind: "failed", reason: "sync-" + mode } : completed(0));
        expect(f.trace.filter(row => row[0] === "stop")).toHaveLength(1);
        expect(f.trace.some(row => row[0] === "pause" || row[0] === "terminate")).toBe(false);
        if (mode === "unknown" || mode === "conflict") expect(outcome(f.trace)).toMatchObject({ kind: "failed", reason: "sync-" + mode, evidence: evidence });
    });

    it("checked pause failure cannot become a successful cleanup", async () => {
        const f = fixture(); f.state.stop = true; f.ports.pauseSync = identifier => { f.trace.push(["pause", identifier]); return { ok: false, evidence }; };
        await expect(f.services().remoteExec("relative")).resolves.toEqual({ kind: "failed", reason: "sync-pause-failed", evidence, cleanupFailures: [] });
        expect(f.trace).toContainEqual(["pause", f.syncId]); expect(outcome(f.trace)).toMatchObject({ kind: "failed", reason: "sync-pause-failed", evidence: evidence });
        expect(index(f.trace, "stop")).toBeLessThan(index(f.trace, "pause"));
    });

    it("failed stop and thrown pause preserve failure exit without reopening a retired local claim", async () => {
        const failedStop = fixture(); failedStop.state.stop = true; failedStop.ports.stopReservedContainer = () => ({ kind: "failed", evidence });
        await expect(failedStop.services().remoteExec("relative")).resolves.toEqual({ kind: "failed", reason: "stop-failed", evidence, cleanupFailures: [] });
        expect(outcome(failedStop.trace)).toMatchObject({ kind: "failed", reason: "stop-failed", evidence: evidence });
        expect(failedStop.trace.filter(row => row[0] === "remove")).toHaveLength(1);
        expect(failedStop.trace).toContainEqual(["release", { config, name: "expected-name", token: failedStop.token }]);
        expect(index(failedStop.trace, "cancel")).toBeLessThan(index(failedStop.trace, "release"));
        expect(index(failedStop.trace, "remove")).toBeLessThan(index(failedStop.trace, "release"));
        expect(failedStop.trace.some(row => row[0] === "pause")).toBe(false);
        const thrownPause = fixture(); thrownPause.state.stop = true; const fault = Error("pause");
        thrownPause.ports.pauseSync = name => { thrownPause.trace.push(["pause", name]); throw fault; };
        await expect(thrownPause.services().remoteExec("relative")).resolves.toEqual({ kind: "fault", error: fault, cleanupFailures: [] });
        expect(outcome(thrownPause.trace)).toMatchObject({ kind: "fault", error: fault });
        expect(thrownPause.trace.filter(row => row[0] === "remove")).toHaveLength(1);
        expect(thrownPause.trace.some(row => row[0] === "release")).toBe(false);
    });

    it.each(["SIGINT", "SIGTERM"] as const)("joins active SSH after forwarding the first %s signal and returns cancellation", async signal => {
        const f = fixture(); const joined = deferred<void>(); let close!: (code: number) => void;
        f.ports.startInteractiveSession = () => ({ onClose: callback => { close = callback; joined.resolve(); return undefined; }, onError: () => undefined, kill: actual => { f.trace.push(["child-kill", actual]); return true; } });
        const execution = f.services().remoteExec("relative"); await joined.promise;
        const first = f.handlers.get(signal)!; const second = f.handlers.get(signal === "SIGINT" ? "SIGTERM" : "SIGINT")!;
        expect(() => { first(); second(); first(); }).not.toThrow();
        expect(f.trace.filter(row => row[0] === "child-kill")).toEqual([["child-kill", signal]]);
        expect(f.trace.some(row => row[0] === "release" || row[0] === "remove")).toBe(false);
        f.trace.push(["child-close"]); close(0);
        await expect(execution).resolves.toEqual({ kind: "cancelled", signal, cleanupFailures: [] });
        expect(index(f.trace, "child-kill")).toBeLessThan(index(f.trace, "child-close"));
        expect(index(f.trace, "child-close")).toBeLessThan(index(f.trace, "release"));
        expect(index(f.trace, "release")).toBeLessThan(index(f.trace, "remove"));
        expect(f.trace.some(row => ["prompt", "stop", "self-signal", "exit"].includes(String(row[0])))).toBe(false);
    });

    it("retains the first SSH error while awaiting close before releasing owned resources", async () => {
        const f = fixture(), connected = deferred<void>(); const error = { native: "SSH error" }; let close!: (code: number) => void;
        f.ports.startInteractiveSession = () => ({ onClose: callback => { close = callback; return undefined; }, onError: callback => { callback(error); connected.resolve(); return undefined; }, kill: () => true });
        const execution = f.services().remoteExec("relative"); await connected.promise;
        expect(f.trace.some(row => row[0] === "release" || row[0] === "remove")).toBe(false);
        close(0); await expect(execution).resolves.toEqual(completed(1));
        expect(events(f.trace)).toContainEqual({ kind: "ssh-error", error }); expect(f.trace.some(row => row[0] === "prompt")).toBe(false);
    });

    it.each(["outer", "inner"] as const)("cancellation inside the queued %s reservation guard prevents reservation dispatch", async guard => {
        const f = fixture(), entered = deferred<void>(), release = deferred<void>(); const ordinary = f.ports.withLifecycleLockAsync;
        f.ports.withLifecycleLockAsync = async (prefix, operation) => {
            if ((guard === "outer" && prefix.startsWith("remote-sync--")) || (guard === "inner" && prefix.startsWith("remote--"))) { entered.resolve(); await release.promise; }
            return ordinary(prefix, operation);
        };
        const execution = f.services().remoteExec("relative"); await entered.promise; f.handlers.get("SIGTERM")!(); release.resolve();
        await expect(execution).resolves.toEqual({ kind: "cancelled", signal: "SIGTERM", cleanupFailures: [] });
        expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", "claim"]]);
        expect(f.trace.some(row => ["reserve", "release", "heartbeat", "prepare", "observe-sync", "ssh"].includes(String(row[0])))).toBe(false);
    });

    it("accounts for a dispatched reservation cancelled before its surrounding await settles", async () => {
        const f = fixture(), reserved = deferred<void>(), settle = deferred<void>(); const ordinary = f.ports.withLifecycleLockAsync;
        f.ports.withLifecycleLockAsync = async (prefix, operation) => { const result = await ordinary(prefix, operation); if (prefix.startsWith("remote-sync--")) { reserved.resolve(); await settle.promise; } return result; };
        const execution = f.services().remoteExec("relative"); await reserved.promise; f.handlers.get("SIGINT")!();
        expect(f.trace.some(row => row[0] === "release")).toBe(false); settle.resolve();
        await expect(execution).resolves.toEqual({ kind: "cancelled", signal: "SIGINT", cleanupFailures: [] });
        expect(f.trace.filter(row => row[0] === "release")).toEqual([["release", { config, name: "expected-name", token: f.token }]]);
        expect(f.trace.some(row => ["heartbeat", "prepare", "observe-sync", "ssh"].includes(String(row[0])))).toBe(false);
    });

    it.each(["outer", "inner"] as const)("accepted cleanup cancelled in its queued %s guard does not stop or pause", async guard => {
        const f = fixture(), entered = deferred<void>(), release = deferred<void>(); f.state.stop = true; const ordinaryAsync = f.ports.withLifecycleLockAsync; const ordinarySync = f.ports.withLifecycleLock;
        let syncAcquisitions = 0;
        if (guard === "outer") f.ports.withLifecycleLockAsync = async (prefix, operation) => { if (prefix.startsWith("remote-sync--") && ++syncAcquisitions === 3) { entered.resolve(); await release.promise; } return ordinaryAsync(prefix, operation); };
        else f.ports.withLifecycleLock = (prefix, operation) => { entered.resolve(); f.handlers.get("SIGTERM")!(); return ordinarySync(prefix, operation); };
        const execution = f.services().remoteExec("relative"); await entered.promise;
        if (guard === "outer") { f.handlers.get("SIGTERM")!(); release.resolve(); }
        await expect(execution).resolves.toEqual({ kind: "cancelled", signal: "SIGTERM", cleanupFailures: [] });
        expect(f.trace.some(row => row[0] === "stop" || row[0] === "pause")).toBe(false);
        expect(f.trace.filter(row => row[0] === "remove")).toHaveLength(1); expect(f.trace.filter(row => row[0] === "release")).toHaveLength(1);
    });

    it.each(["user", "cleanup"] as const)("cancels and settles its held %s prompt without forward admission", async kind => {
        const f = fixture(), entered = deferred<void>(), answered = deferred<string>(); let cancelled = 0;
        f.ports.prompt = request => { f.trace.push(["prompt", request]); entered.resolve(); return { result: answered.promise, cancel: () => { cancelled++; answered.resolve(""); return undefined; } }; };
        const execution = f.services().remoteExec("relative", kind === "user" ? "new-host" : undefined); await entered.promise; f.handlers.get("SIGINT")!();
        await expect(execution).resolves.toEqual({ kind: "cancelled", signal: "SIGINT", cleanupFailures: [] }); expect(cancelled).toBe(1);
        expect(f.trace.some(row => row[0] === "save" || row[0] === "stop" || row[0] === "pause")).toBe(false);
        if (kind === "user") expectNoClaim(f.trace); else expect(f.trace.filter(row => row[0] === "remove")).toHaveLength(1);
    });

    it.each(["user", "cleanup"] as const)("the owning %s prompt interrupt cancels its invocation without accepting blank input", async kind => {
        const f = fixture(), interrupted = deferred<(signal: RemoteSignal) => void>(), answer = deferred<string>(); let cancellations = 0;
        f.ports.prompt = (_request, onInterrupt) => {
            interrupted.resolve(onInterrupt);
            return { result: answer.promise, cancel: () => { cancellations++; answer.resolve(""); return undefined; } };
        };
        const execution = f.services().remoteExec("relative", kind === "user" ? "new-host" : undefined);
        (await interrupted.promise)("SIGINT");
        await expect(execution).resolves.toEqual({ kind: "cancelled", signal: "SIGINT", cleanupFailures: [] });
        expect(cancellations).toBe(1); expect(f.trace.some(row => ["save", "stop", "pause"].includes(String(row[0])))).toBe(false);
        if (kind === "user") expectNoClaim(f.trace);
    });

    it("cancellation settles the current polling sleep without later observation or SSH", async () => {
        const f = fixture(), sleeping = deferred<void>(), entered = deferred<void>(); let observations = 0, cancelled = 0;
        const ordinary = f.ports.observeSyncInventory; f.ports.observeSyncInventory = budget => { observations++; const inventory = ordinary(budget); return inventory.kind === "known" ? { ...inventory, sessions: inventory.sessions.map(row => ({ ...row, watching: false })) } : inventory; };
        f.ports.sleep = () => { entered.resolve(); return { completion: sleeping.promise, cancel: () => { cancelled++; sleeping.resolve(); return undefined; } }; };
        const execution = f.services().remoteExec("relative"); await entered.promise; const before = observations; f.handlers.get("SIGTERM")!();
        await expect(execution).resolves.toEqual({ kind: "cancelled", signal: "SIGTERM", cleanupFailures: [] }); expect(cancelled).toBe(1); expect(observations).toBe(before);
        expect(f.trace.some(row => row[0] === "ssh")).toBe(false);
    });

    it.each(["prompt", "sleep"] as const)("overlapping invocations retain their own %s handles and signal listeners", async heldKind => {
        const f = fixture(), registered: Array<() => void> = [], held: Array<{ settle: () => void; cancelled: number }> = [], ready = deferred<void>();
        const tokens = ["1".repeat(32), "2".repeat(32)]; let claims = 0, reservations = 0;
        f.ports.newReservationToken = () => tokens[reservations++];
        f.ports.createSessionLock = prefix => { const claim = "claim-" + ++claims; f.trace.push(["claim", prefix, claim]); return claim; };
        const ordinarySignal = f.ports.onSignal; f.ports.onSignal = (signal, callback) => { if (signal === "SIGINT") registered.push(callback); return ordinarySignal(signal, callback); };
        if (heldKind === "prompt") f.ports.prompt = () => { const answer = deferred<string>(); const record = { settle: () => answer.resolve("n"), cancelled: 0 }; held.push(record); if (held.length === 2) ready.resolve(); return { result: answer.promise, cancel: () => { record.cancelled++; record.settle(); return undefined; } }; };
        else {
            let polls = 0; const ordinaryInventory = f.ports.observeSyncInventory;
            f.ports.observeSyncInventory = budget => { const inventory = ordinaryInventory(budget); return inventory.kind === "known" ? { ...inventory, sessions: inventory.sessions.map(row => ({ ...row, watching: ++polls > 4 })) } : inventory; };
            f.ports.sleep = () => { const sleep = deferred<void>(); const record = { settle: () => sleep.resolve(), cancelled: 0 }; held.push(record); if (held.length === 2) ready.resolve(); return { completion: sleep.promise, cancel: () => { record.cancelled++; record.settle(); return undefined; } }; };
        }
        f.ports.withLifecycleLockAsync = async (_prefix, operation) => operation();
        const service = f.services(); const first = service.remoteExec("first"), second = service.remoteExec("second"); await ready.promise;
        registered[0](); await expect(first).resolves.toEqual({ kind: "cancelled", signal: "SIGINT", cleanupFailures: [] });
        expect(held.map(record => record.cancelled)).toEqual([1, 0]); expect(f.handlers.get("SIGINT")).toBe(registered[1]);
        expect(f.trace.filter(row => row[0] === "release")).toEqual([["release", { config, name: "expected-name", token: tokens[0] }]]);
        expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", "claim-1"]]);
        held[1].settle(); await expect(second).resolves.toEqual(completed(0));
        expect(f.trace.filter(row => row[0] === "release")).toEqual(tokens.map(token => ["release", { config, name: "expected-name", token }]));
        expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", "claim-1"], ["remove", "claim-2"]]);
    });

    it("records checked release failure while preserving the primary semantic failure", async () => {
        const f = fixture(); f.ports.prepareRemoteProject = () => ({ ok: false, evidence }); const releaseEvidence = Symbol("release refused");
        f.ports.releaseReservation = request => { f.trace.push(["release", request]); return { ok: false, evidence: releaseEvidence }; };
        await expect(f.services().remoteExec("relative")).resolves.toEqual({ kind: "failed", reason: "project-prepare-failed", evidence, cleanupFailures: [{ kind: "release-failed", evidence: releaseEvidence }] });
        expect(f.trace.filter(row => row[0] === "release")).toHaveLength(1); expect(f.trace.filter(row => row[0] === "remove")).toHaveLength(1);
    });

    it("contains signal kill and heartbeat callback exceptions, joins SSH and continues independent cleanup", async () => {
        const f = fixture(), connected = deferred<void>(); const primary = { opaque: "heartbeat" }, killFault = Error("kill"), cancelFault = Error("cancel"), releaseFault = Error("release"), removalFault = Error("remove"); const forwarded: RemoteSignal[] = []; let close!: (code: number) => void;
        f.ports.refreshReservation = () => { throw primary; }; f.state.cancelFault = cancelFault; f.state.releaseFault = releaseFault; f.state.removalFault = removalFault;
        f.ports.startInteractiveSession = () => ({ onClose: callback => { close = callback; connected.resolve(); return undefined; }, onError: () => undefined, kill: signal => { forwarded.push(signal); throw killFault; } });
        const execution = f.services().remoteExec("relative"); await connected.promise;
        expect(() => f.state.heartbeat!()).not.toThrow(); const signal = f.handlers.get("SIGTERM")!; expect(() => { signal(); f.handlers.get("SIGINT")!(); signal(); }).not.toThrow(); expect(forwarded).toEqual(["SIGTERM"]);
        expect(f.trace.some(row => row[0] === "release" || row[0] === "remove")).toBe(false); close(0);
        const result = await execution; expect(result).toMatchObject({ kind: "fault", error: primary });
        expect(result.cleanupFailures).toEqual(expect.arrayContaining([
            { kind: "cleanup-fault", phase: "signal-child", error: killFault }, { kind: "cleanup-fault", phase: "cancel-heartbeat", error: cancelFault },
            { kind: "cleanup-fault", phase: "release-reservation", error: releaseFault }, { kind: "cleanup-fault", phase: "remove-session-lock", error: removalFault },
        ]));
        expect(new Set(result.cleanupFailures.map(failure => failure.kind === "cleanup-fault" ? failure.phase : failure.kind)).size).toBe(result.cleanupFailures.length);
        expect(f.trace.filter(row => row[0] === "cancel")).toHaveLength(1); expect(f.trace.filter(row => row[0] === "release")).toHaveLength(1); expect(f.trace.filter(row => row[0] === "remove")).toHaveLength(1);
    });

    it("retains a semantic failure if a later signal and cleanup failure also occur", async () => {
        const f = fixture(), releaseFault = Error("release"); f.state.releaseFault = releaseFault;
        f.ports.prepareRemoteProject = () => { queueMicrotask(() => f.handlers.get("SIGINT")!()); return { ok: false, evidence }; };
        await expect(f.services().remoteExec("relative")).resolves.toEqual({ kind: "failed", reason: "project-prepare-failed", evidence, cleanupFailures: [{ kind: "cleanup-fault", phase: "release-reservation", error: releaseFault }] });
        expect(f.trace.filter(row => row[0] === "remove")).toHaveLength(1);
    });

    it("captures faults before claim and releases only a reservation whose dispatch began", async () => {
        const beforeClaim = fixture(), fault = Error("claim"); beforeClaim.ports.createSessionLock = () => { throw fault; };
        await expect(beforeClaim.services().remoteExec("relative")).resolves.toEqual({ kind: "fault", error: fault, cleanupFailures: [] }); expectNoClaim(beforeClaim.trace);
        const save = fixture(); save.ports.saveRemoteConfig = () => { throw fault; };
        await expect(save.services().remoteExec("relative", "new-host")).resolves.toEqual({ kind: "fault", error: fault, cleanupFailures: [] }); expectNoClaim(save.trace);
        const lock = fixture(); lock.ports.withLifecycleLockAsync = async () => { throw fault; };
        await expect(lock.services().remoteExec("relative")).resolves.toEqual({ kind: "fault", error: fault, cleanupFailures: [] });
        expect(lock.trace.filter(row => row[0] === "remove")).toEqual([["remove", "claim"]]); expect(lock.trace.some(row => row[0] === "reserve" || row[0] === "release")).toBe(false);
    });
    it.each(["refresh", "report"] as const)("contains a heartbeat %s fault before queued sync admission", async failingStage => {
        const f = fixture(), entered = deferred<void>(), release = deferred<void>(), fault = { opaque: failingStage }; const ordinary = f.ports.withLifecycleLockAsync;
        let acquisitions = 0;
        f.ports.withLifecycleLockAsync = async (prefix, operation) => { if (prefix.startsWith("remote-sync--") && ++acquisitions === 2) { entered.resolve(); await release.promise; } return ordinary(prefix, operation); };
        if (failingStage === "refresh") f.ports.refreshReservation = () => { throw fault; };
        else { const report = f.ports.report; f.ports.report = event => { report(event); if (event.kind === "refresh-failed") throw fault; }; }
        const execution = f.services().remoteExec("relative"); await entered.promise;
        expect(() => f.state.heartbeat!()).not.toThrow(); release.resolve();
        await expect(execution).resolves.toEqual({ kind: "fault", error: fault, cleanupFailures: [] });
        expect(f.trace.some(row => ["observe-sync", "create-sync", "resume", "terminate", "ssh"].includes(String(row[0])))).toBe(false);
    });

    it.each(["prompt", "sleep"] as const)("contains a throwing %s cancellation and still settles its invocation", async heldKind => {
        const f = fixture(), entered = deferred<void>(), finished = deferred<void>(), fault = { opaque: heldKind }; let attempts = 0;
        if (heldKind === "prompt") f.ports.prompt = () => ({ result: finished.promise.then(() => ""), cancel: () => { attempts++; finished.resolve(); throw fault; } });
        else {
            const ordinary = f.ports.observeSyncInventory;
            f.ports.observeSyncInventory = budget => { const inventory = ordinary(budget); return inventory.kind === "known" ? { ...inventory, sessions: inventory.sessions.map(row => ({ ...row, watching: false })) } : inventory; };
            f.ports.sleep = () => { entered.resolve(); return { completion: finished.promise, cancel: () => { attempts++; finished.resolve(); throw fault; } }; };
        }
        if (heldKind === "prompt") { const ordinary = f.ports.prompt; f.ports.prompt = (request, onInterrupt) => { entered.resolve(); return ordinary(request, onInterrupt); }; }
        const execution = f.services().remoteExec("relative"); await entered.promise;
        expect(() => f.handlers.get("SIGINT")!()).not.toThrow();
        await expect(execution).resolves.toEqual({ kind: "cancelled", signal: "SIGINT", cleanupFailures: [{ kind: "cleanup-fault", phase: heldKind === "prompt" ? "dispose-prompt" : "cancel-sleep", error: fault }] });
        expect(attempts).toBe(1); expect(f.trace.filter(row => row[0] === "remove")).toHaveLength(1);
    });

});
