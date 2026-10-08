import { describe, expect, it } from "vitest";
import { createRemoteSync } from "../../application/remote-sync.js";
import type { RemoteSyncPorts } from "../../ports/remote-services.js";

function fixture() {
    const trace: unknown[][] = []; let clock = 0;
    const ports: RemoteSyncPorts = {
        resolveProjectPath: path => path, getProjectId: () => "project", getMutagenSessionName: () => "sync", startSyncDaemon: () => { trace.push(["daemon"]); return { status: 1 }; }, observeSync: () => ({ status: 0, stdout: "docker://id/\nStatus: Watching for changes" }), terminateSync: name => { trace.push(["terminate", name]); return { status: 0 }; }, resumeSync: name => { trace.push(["resume", name]); return { status: 0 }; }, createSync: args => { trace.push(["create", args]); return { status: 0 }; }, readCommonIgnoreDirs: () => ["node_modules"], captureLog: () => message => { trace.push(["log", message]); return undefined; }, captureProgress: () => message => { trace.push(["progress", message]); return undefined; }, now: () => clock++, sleep: async milliseconds => { trace.push(["sleep", milliseconds]); },
    };
    return { ports, trace, sync: () => createRemoteSync(ports) };
}
const config = { host: "host", user: "user", remotePath: "" };
describe("remote sync complete policy", () => {
    it("requires every explicit dependency of the independent sync factory", () => { const { ports } = fixture(); for (const name of Object.keys(ports)) { const missing = { ...ports }; Reflect.deleteProperty(missing, name); expect(() => createRemoteSync(missing)).toThrow(`callable ${name} port`); } });
    it("returns exact captured-ID endpoint and resumes paused sessions", async () => {
        const { ports, trace, sync } = fixture(); ports.observeSync = () => ({ status: 0, stdout: "docker://id/\nStatus: Paused" }); expect(await sync().ensureSync("project", config, "id")).toBe("sync"); expect(trace).toContainEqual(["resume", "sync"]); expect(trace.some(row => row[0] === "create")).toBe(false);
    });
    it("replaces stale name endpoints before creating exact-ID sync", async () => {
        const { ports, trace, sync } = fixture(); ports.observeSync = () => ({ status: 0, stdout: "docker://old/\nStatus: Watching" }); await sync().ensureSync("project", config, "id", "name");
        expect(trace.findIndex(row => row[0] === "terminate")).toBeLessThan(trace.findIndex(row => row[0] === "create")); expect(trace.find(row => row[0] === "create")?.[1]).toEqual(["sync", "create", "project", "user@host:docker://id/project/project", "--name", "sync", "--ignore-vcs", "--ignore=node_modules"]);
    });
    it("stale terminate error wins and create checks status only", async () => {
        const { ports, trace, sync } = fixture(); ports.observeSync = () => ({ status: 0, stdout: "docker://old/" }); ports.terminateSync = () => ({ status: 0, error: Error("native") }); await expect(sync().ensureSync("project", config, "id")).rejects.toThrow("Failed to terminate stale sync session"); expect(trace.some(row => row[0] === "create")).toBe(false);
        ports.terminateSync = () => ({ status: 0 }); ports.createSync = () => ({ status: 0, error: Error("ignored") }); expect(await sync().ensureSync("project", config, "id")).toBe("sync");
    });
    it("list error short-circuits status/stdout getters", async () => {
        const { ports, sync } = fixture(); ports.observeSync = () => ({ error: Error("list"), get status(): never { throw Error("status"); }, get stdout(): never { throw Error("stdout"); } }); expect(await sync().ensureSync("project", config, "id")).toBe("sync");
    });
    it("watching wins over error/halted and timeout remains wall clock based", async () => {
        const { ports, sync, trace } = fixture(); ports.observeSync = () => ({ status: 0, stdout: "Status: Watching error halted" }); await sync().waitForSync("sync"); expect(trace).toContainEqual(["log", " done"]);
        let clock = 0; ports.now = () => clock += 120001; await expect(sync().waitForSync("sync")).rejects.toThrow("Sync timeout - initial sync did not complete"); expect(trace).toContainEqual(["log", " timeout"]);
    });
    it("polls unfinished status at one-second intervals then watching", async () => {
        const { ports, sync, trace } = fixture(); let count = 0; ports.observeSync = () => ({ status: 0, stdout: ++count === 1 ? "Status: Scanning" : "Status: Watching" }); await sync().waitForSync("sync"); expect(trace).toContainEqual(["sleep", 1000]);
    });
});
