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
        observeSync: (name, id) => { trace.push(["observe", name, id]); return observed(); },
        terminateStaleSync: name => { trace.push(["terminate-stale", name]); return { ok: true }; },
        resumeSync: name => { trace.push(["resume", name]); return { ok: true }; },
        createSync: request => { trace.push(["create", request]); return { ok: true }; },
        report: event => { trace.push(["report", event]); },
        fail: (kind, original) => { trace.push(["fail", kind, original]); throw Error(kind); },
        now: () => clock,
        sleep: async milliseconds => { trace.push(["sleep", milliseconds]); clock += milliseconds; },
    };
    return { ports, trace, sync: () => createRemoteSync(ports) };
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

    it("sleeps one second for progress, then completes; default timeout uses elapsed wall clock", async () => {
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
});
