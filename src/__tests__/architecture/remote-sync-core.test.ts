import { describe, expect, it } from "vitest";
import { createRemoteSync } from "../../application/remote-sync.js";
import type { RemoteSyncPorts } from "../../ports/remote-services.js";
import type { RemoteObservedSync } from "../../domain/remote-services.js";

const evidence = Symbol("opaque sync diagnostic");
const config = { host: "host", user: "user", remotePath: "remote-root" };
function observed(facts: Partial<Omit<RemoteObservedSync<symbol>, "kind" | "evidence">> = {}): RemoteObservedSync<symbol> {
    return { kind: "observed", endpointMatches: true, paused: false, watching: true, failed: false, evidence, ...facts };
}
function fixture() {
    const trace: unknown[][] = []; let clock = 0;
    const ports: RemoteSyncPorts<symbol> = {
        resolveProjectPath: path => { trace.push(["resolve", path]); return "/resolved/project"; },
        getProjectId: path => { trace.push(["project", path]); return "project-id"; },
        getMutagenSessionName: path => { trace.push(["session", path]); return "sync"; },
        startSyncDaemon: () => { trace.push(["daemon"]); },
        observeSync: (name, id, remainingMs) => { trace.push(["observe", name, id, ...(remainingMs === undefined ? [] : [remainingMs])]); return observed(); },
        terminateStaleSync: name => { trace.push(["terminate-stale", name]); return { ok: true }; },
        resumeSync: name => { trace.push(["resume", name]); return { ok: true }; },
        createSync: request => { trace.push(["create", request]); return { ok: true }; },
        report: event => { trace.push(["report", event]); },
        fail: (kind, original) => { trace.push(["fail", kind, original]); throw Error(kind); },
        now: () => clock,
        sleep: async milliseconds => { trace.push(["sleep", milliseconds]); clock += milliseconds; },
    };
    return { ports, trace, setClock: (milliseconds: number) => { clock = milliseconds; }, sync: () => createRemoteSync(ports) };
}

describe("remote sync semantic policy", () => {
    it("creates an unavailable session with resolved path, config, project and exact container ID", async () => {
        const { ports, trace, sync } = fixture(); ports.observeSync = () => ({ kind: "unavailable" });
        expect(await sync().ensureSync("relative", config, "exact-id", "display-name")).toBe("sync");
        expect(trace).toContainEqual(["create", { name: "sync", localPath: "/resolved/project", config, containerId: "exact-id", projectId: "project-id" }]);
        expect(trace).toContainEqual(["report", { kind: "sync-creating", localPath: "/resolved/project", containerDisplayName: "display-name", projectId: "project-id", host: "host" }]);
        expect(trace.findIndex(row => row[0] === "daemon")).toBeLessThan(trace.findIndex(row => row[0] === "create"));
    });

    it("reuses an exact-ID session and gives paused priority over watching and failed", async () => {
        const { ports, trace, sync } = fixture();
        expect(await sync().ensureSync("relative", config, "exact-id")).toBe("sync");
        expect(trace).toContainEqual(["observe", "sync", "exact-id"]);
        expect(trace.some(row => row[0] === "create" || row[0] === "resume" || row[0] === "terminate-stale")).toBe(false);
        trace.length = 0; const mixed = observed({ paused: true, failed: true }); ports.observeSync = () => mixed;
        expect(await sync().ensureSync("relative", config, "exact-id")).toBe("sync");
        expect(trace).toContainEqual(["resume", "sync"]);
        expect(trace.some(row => row[0] === "create" || row[0] === "terminate-stale")).toBe(false);
        trace.length = 0; const failed = observed({ watching: false, failed: true }); ports.observeSync = () => failed;
        expect(await sync().ensureSync("relative", config, "exact-id")).toBe("sync");
        expect(trace).toContainEqual(["report", { kind: "sync-existing", observation: failed }]);
        expect(trace.some(row => row[0] === "fail" || row[0] === "create")).toBe(false);
    });

    it("checks stale termination before creating; termination failure blocks create with opaque evidence", async () => {
        const { ports, trace, sync } = fixture(); ports.observeSync = () => observed({ endpointMatches: false, paused: true, failed: true });
        expect(await sync().ensureSync("relative", config, "exact-id")).toBe("sync");
        expect(trace.findIndex(row => row[0] === "terminate-stale")).toBeLessThan(trace.findIndex(row => row[0] === "create"));
        expect(trace.some(row => row[0] === "resume")).toBe(false);
        trace.length = 0; ports.terminateStaleSync = name => { trace.push(["terminate-stale", name]); return { ok: false, evidence }; };
        await expect(sync().ensureSync("relative", config, "exact-id")).rejects.toThrow("sync-terminate-failed");
        expect(trace).toContainEqual(["fail", "sync-terminate-failed", evidence]);
        expect(trace.some(row => row[0] === "create")).toBe(false);
    });

    it("forwards checked resume and create failures without interpreting evidence", async () => {
        const { ports, trace, sync } = fixture(); ports.observeSync = () => observed({ paused: true });
        ports.resumeSync = () => ({ ok: false, evidence });
        await expect(sync().ensureSync("relative", config, "exact-id")).rejects.toThrow("sync-resume-failed");
        expect(trace).toContainEqual(["fail", "sync-resume-failed", evidence]);
        expect(trace.some(row => row[0] === "create")).toBe(false);
        trace.length = 0; ports.observeSync = () => ({ kind: "unavailable" }); ports.createSync = () => ({ ok: false, evidence });
        await expect(sync().ensureSync("relative", config, "exact-id")).rejects.toThrow("sync-create-failed");
        expect(trace).toContainEqual(["fail", "sync-create-failed", evidence]);
    });

    it("does not require success proof from void daemon startup, while thrown failure remains observable", async () => {
        const { ports, trace, sync } = fixture(); ports.observeSync = () => ({ kind: "unavailable" });
        expect(await sync().ensureSync("relative", config, "exact-id")).toBe("sync");
        expect(trace.some(row => row[0] === "create")).toBe(true);
        trace.length = 0; const fault = Error("daemon"); ports.startSyncDaemon = () => { throw fault; };
        await expect(sync().ensureSync("relative", config, "exact-id")).rejects.toBe(fault);
        expect(trace.some(row => row[0] === "create")).toBe(false);
    });

    it("wait prioritizes watching even for mixed failed/paused facts, otherwise forwards failure evidence", async () => {
        const { ports, trace, sync } = fixture(); ports.observeSync = () => observed({ paused: true, failed: true });
        await sync().waitForSync("sync"); expect(trace).toContainEqual(["report", { kind: "sync-completed" }]);
        expect(trace.some(row => row[0] === "fail" || row[0] === "sleep")).toBe(false);
        trace.length = 0; const failed = observed({ watching: false, failed: true }); ports.observeSync = () => failed;
        await expect(sync().waitForSync("sync")).rejects.toThrow("sync-failed");
        expect(trace).toContainEqual(["report", { kind: "sync-failed", observation: failed }]);
        expect(trace).toContainEqual(["fail", "sync-failed", evidence]);
        trace.length = 0; ports.observeSync = () => ({ kind: "unavailable" });
        await expect(sync().waitForSync("sync")).rejects.toThrow("sync-missing");
        expect(trace).toContainEqual(["fail", "sync-missing", undefined]);
    });

    it("sleeps one second for progress, then completes; default timeout uses the supplied monotonic clock", async () => {
        const { ports, trace, sync } = fixture(); let count = 0;
        ports.observeSync = () => observed({ watching: ++count > 1 });
        await sync().waitForSync("sync"); expect(trace.filter(row => row[0] === "sleep")).toEqual([["sleep", 1000]]);
        trace.length = 0; ports.observeSync = () => observed({ watching: false }); let clock = 0;
        ports.now = () => clock; ports.sleep = async milliseconds => { trace.push(["sleep", milliseconds]); clock += 60_001; };
        await expect(sync().waitForSync("sync")).rejects.toThrow("sync-timeout");
        expect(trace.filter(row => row[0] === "sleep")).toEqual([["sleep", 1000], ["sleep", 1000]]);
        expect(trace).toContainEqual(["report", { kind: "sync-timeout" }]);
        expect(trace).toContainEqual(["fail", "sync-timeout", undefined]);
    });

    it.each([0, -1, 0.5])("times out without observing or sleeping when its usable wait budget is %s ms", async timeoutMs => {
        const { trace, sync } = fixture();
        await expect(sync().waitForSync("sync", timeoutMs)).rejects.toThrow("sync-timeout");
        expect(trace).toEqual([
            ["report", { kind: "sync-waiting" }],
            ["report", { kind: "sync-timeout" }],
            ["fail", "sync-timeout", undefined],
        ]);
    });

    it("passes the remaining budget, clips its final sleep, and never observes after expiry", async () => {
        const { ports, trace, setClock, sync } = fixture(); let clock = 100;
        setClock(clock);
        ports.observeSync = (name, id, remainingMs) => {
            trace.push(["observe", name, id, remainingMs]);
            clock += trace.filter(row => row[0] === "observe").length === 3 ? 80 : 200;
            setClock(clock);
            return observed({ watching: false });
        };
        ports.sleep = async milliseconds => { trace.push(["sleep", milliseconds]); clock += milliseconds; setClock(clock); };
        await expect(sync().waitForSync("sync", 2500)).rejects.toThrow("sync-timeout");
        expect(trace.filter(row => row[0] === "observe")).toEqual([
            ["observe", "sync", undefined, 2500],
            ["observe", "sync", undefined, 1300],
            ["observe", "sync", undefined, 100],
        ]);
        expect(trace.filter(row => row[0] === "sleep")).toEqual([["sleep", 1000], ["sleep", 1000], ["sleep", 20]]);
        expect(clock).toBe(2600);
        expect(trace.at(-1)).toEqual(["fail", "sync-timeout", undefined]);
        expect(trace).not.toContainEqual(["report", { kind: "sync-completed" }]);
    });

    it("keeps fractional remaining time for native admission and does not probe a sub-millisecond remainder", async () => {
        const { ports, trace, setClock, sync } = fixture();
        ports.observeSync = (name, id, remainingMs) => {
            trace.push(["observe", name, id, remainingMs]); setClock(1);
            return observed({ watching: false });
        };
        await expect(sync().waitForSync("sync", 1.5)).rejects.toThrow("sync-timeout");
        expect(trace.filter(row => row[0] === "observe")).toEqual([["observe", "sync", undefined, 1.5]]);
        const sleeps = trace.filter(row => row[0] === "sleep");
        expect(sleeps.reduce((total, row) => total + Number(row[1]), 0)).toBeLessThanOrEqual(0.5);
        expect(trace).not.toContainEqual(["fail", "sync-missing", undefined]);
    });

    it("does not sleep on a stale remainder when reporting progress consumes the deadline", async () => {
        const { ports, trace, setClock, sync } = fixture();
        ports.observeSync = (name, id, remainingMs) => {
            trace.push(["observe", name, id, remainingMs]); return observed({ watching: false });
        };
        ports.report = event => { trace.push(["report", event]); if (event.kind === "sync-poll") setClock(200); };
        await expect(sync().waitForSync("sync", 200)).rejects.toThrow("sync-timeout");
        expect(trace.filter(row => row[0] === "observe")).toEqual([["observe", "sync", undefined, 200]]);
        expect(trace.some(row => row[0] === "sleep")).toBe(false);
        expect(trace.at(-1)).toEqual(["fail", "sync-timeout", undefined]);
    });

    it.each([200, 201])("refuses watching that arrives at %s ms against a 200 ms deadline", async finishedAt => {
        const { ports, trace, setClock, sync } = fixture();
        ports.observeSync = (name, id, remainingMs) => {
            trace.push(["observe", name, id, remainingMs]); setClock(finishedAt);
            return observed();
        };
        await expect(sync().waitForSync("sync", 200)).rejects.toThrow("sync-timeout");
        expect(trace.filter(row => row[0] === "observe")).toEqual([["observe", "sync", undefined, 200]]);
        expect(trace.some(row => row[0] === "sleep")).toBe(false);
        expect(trace).not.toContainEqual(["report", { kind: "sync-completed" }]);
        expect(trace.at(-1)).toEqual(["fail", "sync-timeout", undefined]);
    });

    it("accepts watching just before the deadline and retains its priority over mixed failed facts", async () => {
        const { ports, trace, setClock, sync } = fixture();
        ports.observeSync = (name, id, remainingMs) => {
            trace.push(["observe", name, id, remainingMs]); setClock(199);
            return observed({ paused: true, failed: true });
        };
        await sync().waitForSync("sync", 200);
        expect(trace).toContainEqual(["report", { kind: "sync-completed" }]);
        expect(trace.some(row => row[0] === "sleep" || row[0] === "fail")).toBe(false);
    });

    it.each([false, true])("retains late failure evidence even when watching=%s", async watching => {
        const { ports, trace, setClock, sync } = fixture();
        const failed = observed({ watching, failed: true });
        ports.observeSync = () => { setClock(201); return failed; };
        await expect(sync().waitForSync("sync", 200)).rejects.toThrow("sync-failed");
        expect(trace).toContainEqual(["report", { kind: "sync-failed", observation: failed }]);
        expect(trace).toContainEqual(["fail", "sync-failed", evidence]);
        expect(trace).not.toContainEqual(["report", { kind: "sync-timeout" }]);
        expect(trace).not.toContainEqual(["report", { kind: "sync-completed" }]);
        expect(trace.some(row => row[0] === "sleep")).toBe(false);
    });

    it("retains the missing-session error when an unavailable observation arrives after the deadline", async () => {
        const { ports, trace, setClock, sync } = fixture();
        ports.observeSync = () => { setClock(201); return { kind: "unavailable" }; };
        await expect(sync().waitForSync("sync", 200)).rejects.toThrow("sync-missing");
        expect(trace.at(-1)).toEqual(["fail", "sync-missing", undefined]);
        expect(trace).not.toContainEqual(["report", { kind: "sync-timeout" }]);
        expect(trace.some(row => row[0] === "sleep")).toBe(false);
    });

    it("propagates a thrown observation fault without reporting completion or changing its identity", async () => {
        const { ports, trace, sync } = fixture(); const fault = Error("native observation failed");
        ports.observeSync = () => { throw fault; };
        await expect(sync().waitForSync("sync", 200)).rejects.toBe(fault);
        expect(trace).toEqual([["report", { kind: "sync-waiting" }]]);
    });
});
