import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
    spawn: vi.fn(), sync: vi.fn(), exists: vi.fn(), read: vi.fn(),
    legacy: vi.fn(() => "/legacy"), containerName: vi.fn(),
}));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: native.spawn, spawnSync: native.sync }));
vi.mock("fs", async original => {
    const actual = await original<typeof import("node:fs")>();
    return {
        ...actual, existsSync: native.exists,
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) => String(args[0]).endsWith("package.json") ? actual.readFileSync(...args) : native.read(...args),
    };
});
vi.mock("../../home-layout.js", async original => ({ ...await original<typeof import("../../home-layout.js")>(), legacyRemoteConfigDir: native.legacy }));
vi.mock("../../docker.js", async original => ({ ...await original<typeof import("../../docker.js")>(), getContainerName: native.containerName }));

import { createNativeRemoteServicesPorts } from "../../adapters/remote-services.js";
import { checkTailscale, checkMutagen, getMutagenSyncStatus, isHostReachable, shellEscapeArg } from "../../remote.js";

const config = { host: "host", user: "user", remotePath: "" };
const containerId = "a".repeat(64);
const token = "b".repeat(32);
const reservation = { config, projectPath: "/work/project", profile: "named", token, leaseSeconds: 300 };
const retained = { config, name: "ccc-returned", containerId, token };
const syncRequest = { config, name: "ccc-sync", localPath: "/work/雪 project", containerId, projectId: "project-id" };
function execution(status: number | null, stdout = "", error?: Error, stderr = "") {
    return { status, stdout, stderr, error, pid: 123, output: [], signal: null };
}

beforeEach(() => {
    vi.resetAllMocks();
    native.legacy.mockReturnValue("/legacy");
    native.containerName.mockReturnValue("ccc-returned");
});
afterEach(() => { vi.restoreAllMocks(); });

describe("remote native observations and effects", () => {
    it("projects tool, ping and image facts with their distinct error/status rules", () => {
        const ports = createNativeRemoteServicesPorts();
        for (const result of [execution(0, " version 1\nsecond line"), execution(0, "version 1", Error("returned")), execution(1, "version 1"), execution(null, "version 1")]) {
            native.sync.mockReturnValue(result);
            const installed = result.status === 0 && !result.error;
            const observation = installed ? { installed: true, version: "version 1" } : { installed: false };
            expect(ports.observeTool("tailscale")).toEqual(observation);
            expect(native.sync).toHaveBeenLastCalledWith("tailscale", ["version"], { encoding: "utf-8" });
            expect(checkTailscale()).toEqual(observation);
            expect(checkMutagen()).toEqual(observation);
            expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["version"], { encoding: "utf-8" });
            expect(ports.isHostReachable("host")).toBe(result.status === 0);
            expect(isHostReachable("host")).toBe(result.status === 0);
            expect(native.sync).toHaveBeenLastCalledWith("ping", ["-c", "1", "-W", "1", "host"], { encoding: "utf-8" });
            expect(ports.remoteImagePresent(config)).toBe(true);
            expect(native.sync).toHaveBeenLastCalledWith("ssh", ["user@host", expect.stringContaining("docker images -q")], { encoding: "utf-8", timeout: 10000 });
        }
        native.sync.mockReturnValue(execution(0, " \n\t"));
        expect(ports.remoteImagePresent(config)).toBe(false);
    });

    it("requires an exact stable-ID marker and returns the reservation's name and ID", () => {
        const ports = createNativeRemoteServicesPorts();
        native.containerName.mockReturnValueOnce("ccc-returned").mockReturnValueOnce("ccc-start-command");
        native.sync.mockReturnValue(execution(0, `other output\nccc-container-id=${containerId}\n`, Error("ignored returned error")));
        expect(ports.reserveContainer(reservation)).toEqual({ kind: "reserved", container: { name: "ccc-returned", id: containerId } });
        expect(native.containerName.mock.calls).toEqual([["/work/project", "named"], ["/work/project", "named"]]);
        expect(native.sync).toHaveBeenLastCalledWith("ssh", ["user@host", expect.stringContaining("ccc-start-command")], { encoding: "utf-8", timeout: 60000 });
        for (const stdout of ["", "ccc-container-id=abc\n", `ccc-container-id=${"g".repeat(64)}\n`, `ccc-container-id=${"a".repeat(65)}\n`, `prefix ccc-container-id=${containerId}\n`, `ccc-container-id=${containerId} trailing\n`]) {
            native.sync.mockReturnValue(execution(0, stdout));
            const result = ports.reserveContainer(reservation);
            expect(result.kind).toBe("failed");
            if (result.kind !== "failed") throw Error("reservation unexpectedly succeeded");
            expect(result.reason).toBe("missing-container-id");
            expect(() => ports.fail(result.reason, result.evidence)).toThrow("stable container ID was not returned");
        }
        native.sync.mockReturnValue(execution(1, `ccc-container-id=${containerId}\n`, undefined, "start denied"));
        const failure = ports.reserveContainer(reservation);
        expect(failure.kind).toBe("failed");
        if (failure.kind !== "failed") throw Error("reservation unexpectedly succeeded");
        expect(failure.reason).toBe("start-failed");
        expect(() => ports.fail(failure.reason, failure.evidence)).toThrow("Failed to start remote container: start denied");
    });

    it("refreshes by status and gives busy stop markers precedence over failure", () => {
        const ports = createNativeRemoteServicesPorts();
        native.sync.mockReturnValue(execution(0, "", Error("returned")));
        expect(ports.refreshReservation({ ...retained, leaseSeconds: 300 })).toBe(true);
        expect(native.sync).toHaveBeenLastCalledWith("ssh", ["user@host", expect.stringContaining(containerId)], { encoding: "utf-8", timeout: 10000 });
        expect(ports.stopReservedContainer(retained)).toEqual({ kind: "stopped" });
        expect(native.sync).toHaveBeenLastCalledWith("ssh", ["user@host", expect.stringContaining(containerId)], { encoding: "utf-8", timeout: 60000 });
        for (const result of [execution(42), execution(1, "ccc-remote-sessions-active\n", Error("returned")), execution(0, "ccc-remote-sessions-active")]) {
            native.sync.mockReturnValue(result);
            expect(ports.stopReservedContainer(retained)).toEqual({ kind: "busy" });
        }
        native.sync.mockReturnValue(execution(1, "", undefined, "stop denied"));
        expect(ports.refreshReservation({ ...retained, leaseSeconds: 300 })).toBe(false);
        const failure = ports.stopReservedContainer(retained);
        expect(failure.kind).toBe("failed");
        if (failure.kind !== "failed") throw Error("stop unexpectedly succeeded");
        expect(() => ports.fail("stop-failed", failure.evidence)).toThrow("Failed to stop remote container: stop denied");
        expect(ports.releaseReservation(retained)).toBeUndefined();
        expect(native.sync).toHaveBeenLastCalledWith("ssh", ["user@host", expect.any(String)], { encoding: "utf-8", timeout: 10000 });
    });

    it("rejects project preparation errors and retains diagnostic precedence", () => {
        const ports = createNativeRemoteServicesPorts();
        const request = { config, containerId, projectId: "project-id" };
        native.sync.mockReturnValue(execution(0));
        expect(ports.prepareRemoteProject(request)).toEqual({ ok: true });
        expect(native.sync).toHaveBeenLastCalledWith("ssh", ["user@host", `docker exec ${containerId} mkdir -p /project/project-id`], { encoding: "utf-8" });
        for (const [result, diagnostic] of [
            [execution(0, "", Error("returned"), "stderr wins"), "stderr wins"],
            [execution(0, "", Error("returned")), "returned"],
            [execution(1), "unknown error"],
        ] as const) {
            native.sync.mockReturnValue(result);
            const failure = ports.prepareRemoteProject(request);
            expect(failure.ok).toBe(false);
            if (failure.ok) throw Error("preparation unexpectedly succeeded");
            expect(() => ports.fail("project-prepare-failed", failure.evidence)).toThrow(`Failed to prepare remote container project directory: ${diagnostic}`);
        }
    });

    it("projects independent sync flags for the exact endpoint and preserves public display status", () => {
        const ports = createNativeRemoteServicesPorts();
        native.sync.mockReturnValue(execution(0, `Beta:\n  URL: user@host:docker://${containerId}/project/id\nStatus: Paused Watching ERROR halted\n`));
        const mixed = ports.observeSync("ccc-sync", containerId);
        expect(mixed.kind).toBe("observed");
        if (mixed.kind !== "observed") throw Error("sync unexpectedly unavailable");
        expect([mixed.endpointMatches, mixed.paused, mixed.watching, mixed.failed]).toEqual([true, true, true, true]);
        expect(getMutagenSyncStatus("ccc-sync")).toBe("Paused Watching ERROR halted");
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", "list", "ccc-sync"], { encoding: "utf-8" });
        for (const output of [`URL: docker://${containerId}f/project/id\nStatus: Saving custom state\n`, "Name: ccc-sync\n", ""]) {
            native.sync.mockReturnValue(execution(0, output));
            const observation = ports.observeSync("ccc-sync", containerId);
            expect(observation.kind).toBe("observed");
            if (observation.kind !== "observed") throw Error("sync unexpectedly unavailable");
            expect([observation.endpointMatches, observation.paused, observation.watching, observation.failed]).toEqual([false, false, false, false]);
            expect(getMutagenSyncStatus("ccc-sync")).toBe(output.includes("Status:") ? "Saving custom state" : "Unknown");
        }
        for (const result of [execution(0, "Status: Watching\n", Error("returned")), execution(1, "Status: Watching\n"), execution(null)]) {
            native.sync.mockReturnValue(result);
            expect(ports.observeSync("ccc-sync", containerId)).toEqual({ kind: "unavailable" });
            expect(getMutagenSyncStatus("ccc-sync")).toBeNull();
        }
    });

    it.each([0, -1, 0.999])("does not dispatch Mutagen when the remaining %s ms cannot fund a process", remainingMs => {
        const ports = createNativeRemoteServicesPorts();
        native.sync.mockReturnValue(execution(0, "Status: Watching\n"));
        expect(ports.observeSync("ccc-sync", containerId, remainingMs)).toEqual({ kind: "unavailable" });
        expect(native.sync).not.toHaveBeenCalled();
    });

    it("bounds the native query to usable whole milliseconds without changing its endpoint facts", () => {
        const ports = createNativeRemoteServicesPorts();
        native.sync.mockReturnValue(execution(0, `URL: docker://${containerId}/project/id\nStatus: Watching for changes\n`));
        const observation = ports.observeSync("ccc-sync", containerId, 4321.9);
        expect(observation).toMatchObject({ kind: "observed", endpointMatches: true, watching: true, failed: false });
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", "list", "ccc-sync"], { encoding: "utf-8", timeout: 4321, killSignal: "SIGKILL" });
        expect(ports.observeSync("ccc-sync", undefined, 1)).toMatchObject({ kind: "observed", endpointMatches: false, watching: true });
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", "list", "ccc-sync"], { encoding: "utf-8", timeout: 1, killSignal: "SIGKILL" });
        ports.observeSync("ccc-sync", containerId);
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", "list", "ccc-sync"], { encoding: "utf-8" });
    });

    it("retains unavailable and raw-fault outcomes from a bounded native query", () => {
        const ports = createNativeRemoteServicesPorts();
        for (const result of [execution(0, "Status: Watching\n", Error("timed out")), execution(7, "Status: Watching\n"), execution(null)]) {
            native.sync.mockReturnValue(result);
            expect(ports.observeSync("ccc-sync", containerId, 321)).toEqual({ kind: "unavailable" });
            expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", "list", "ccc-sync"], { encoding: "utf-8", timeout: 321, killSignal: "SIGKILL" });
        }
        const fault = Error("native query threw");
        native.sync.mockImplementation(() => { throw fault; });
        expect(() => ports.observeSync("ccc-sync", containerId, 321)).toThrow(fault);
    });

    it("forcibly terminates a SIGTERM-handling native query within its remaining budget", async () => {
        const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
        const budgetMs = 1500;
        const allowanceMs = 1000;
        const naturalExitMs = 5000;
        const queryLeaf = [
            'process.on("SIGTERM", () => {});',
            'process.stdout.write("query ready\\n");',
            `setTimeout(() => { process.stdout.write("natural exit\\n"); }, ${naturalExitMs});`,
        ].join("\n");
        const joined: Array<import("node:child_process").SpawnSyncReturns<string>> = [];
        native.sync.mockImplementation((command: string, args: string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => {
            expect(command).toBe("mutagen");
            expect(args).toEqual(["sync", "list", "ccc-sync"]);
            // Redirect only the query executable and argv. The adapter's timeout
            // and termination options reach the actual joined native process.
            const result = spawnSync(process.execPath, ["-e", queryLeaf], options);
            joined.push(result);
            return result;
        });
        const ports = createNativeRemoteServicesPorts();
        const started = performance.now();
        const observation = ports.observeSync("ccc-sync", containerId, budgetMs);
        const elapsedMs = performance.now() - started;

        expect(observation).toEqual({ kind: "unavailable" });
        expect(native.sync).toHaveBeenCalledOnce();
        expect(joined).toHaveLength(1);
        expect(joined[0]?.pid).toBeGreaterThan(0);
        expect(joined[0]?.stdout).toContain("query ready\n");
        expect(elapsedMs).toBeLessThan(budgetMs + allowanceMs);
        expect(joined[0]?.error).toMatchObject({ code: "ETIMEDOUT" });
        expect(joined[0]?.stdout).not.toContain("natural exit\n");
    });

    it("reads its monotonic clock independently of changes to the calendar clock", () => {
        let monotonic = 123.25; let calendar = 10_000;
        vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        vi.spyOn(Date, "now").mockImplementation(() => calendar);
        const ports = createNativeRemoteServicesPorts();
        expect(Date.now()).toBe(10_000);
        expect(ports.now()).toBe(123.25);
        monotonic = 124.5; calendar = -50_000;
        expect(Date.now()).toBe(-50_000);
        expect(ports.now()).toBe(124.5);
        expect(native.sync).not.toHaveBeenCalled();
    });

    it("creates the exact-ID sync by status while checking resume and stale termination errors", () => {
        const ports = createNativeRemoteServicesPorts();
        for (const result of [execution(0), execution(0, "", Error("returned")), execution(1), execution(null)]) {
            native.sync.mockReturnValue(result);
            expect(ports.createSync(syncRequest).ok).toBe(result.status === 0);
            expect(native.sync).toHaveBeenLastCalledWith("mutagen", expect.arrayContaining(["--ignore-vcs"]), { stdio: "inherit" });
            expect(native.sync.mock.calls.at(-1)?.[1].slice(0, 7)).toEqual(["sync", "create", syncRequest.localPath, `user@host:docker://${containerId}/project/project-id`, "--name", "ccc-sync", "--ignore-vcs"]);
            expect(ports.resumeSync("ccc-sync").ok).toBe(result.status === 0 && !result.error);
            expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", "resume", "ccc-sync"], { stdio: "inherit" });
            expect(ports.terminateStaleSync("ccc-sync").ok).toBe(result.status === 0 && !result.error);
            expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", "terminate", "ccc-sync"], { stdio: "inherit" });
        }
    });

    it("ignores returned failures from daemon, pause, public termination and release but propagates throws", () => {
        const ports = createNativeRemoteServicesPorts();
        native.sync.mockReturnValue(execution(1, "", Error("returned")));
        expect(ports.startSyncDaemon()).toBeUndefined();
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["daemon", "start"], { stdio: "ignore" });
        expect(ports.pauseSync("ccc-sync")).toBeUndefined();
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", "pause", "ccc-sync"], { stdio: "inherit" });
        expect(ports.terminateSync("ccc-sync")).toBeUndefined();
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", "terminate", "ccc-sync"], { stdio: "inherit" });
        expect(ports.releaseReservation(retained)).toBeUndefined();
        native.sync.mockImplementation(() => { throw Error("native throw"); });
        expect(() => ports.startSyncDaemon()).toThrow("native throw");
        expect(() => ports.pauseSync("ccc-sync")).toThrow("native throw");
        expect(() => ports.terminateSync("ccc-sync")).toThrow("native throw");
        expect(() => ports.releaseReservation(retained)).toThrow("native throw");
    });

    it("decodes legacy configuration at the bound native reader and leaves failures observable", () => {
        const reader = createNativeRemoteServicesPorts().prepareLegacyConfigReader("project-hash");
        native.exists.mockReturnValue(true);
        native.read.mockReturnValue(JSON.stringify(config));
        expect(reader.exists()).toBe(true);
        expect(reader.readConfig()).toEqual(config);
        expect(native.exists).toHaveBeenCalledWith("/legacy/project-hash.json");
        expect(native.read).toHaveBeenCalledWith("/legacy/project-hash.json", "utf-8");
        native.read.mockReturnValue("not json");
        expect(() => reader.readConfig()).toThrow();
        native.read.mockImplementation(() => { throw Error("read denied"); });
        expect(() => reader.readConfig()).toThrow("read denied");
        native.exists.mockImplementation(() => { throw Error("stat denied"); });
        expect(() => reader.exists()).toThrow("stat denied");
    });

    it("encodes literal UTF-8 arguments and ordered environment with the container marker first", () => {
        const ports = createNativeRemoteServicesPorts();
        const child = { on: vi.fn(), kill: vi.fn(() => true) };
        native.spawn.mockReturnValue(child);
        const arguments_ = ["--continue", "", "雪 café ' $(touch /tmp/ccc-never-run) `whoami`", "line\nbreak"];
        const environment: Array<[string, string]> = [["FIRST", "雪 ' $(never)"], ["SECOND", "line\nvalue"]];
        const channel = ports.startInteractiveSession({ config, containerId, projectId: "project-id", arguments: arguments_, environment });
        const program = `cd '/project/project-id' && mise trust . 2>/dev/null; mise install -y || true; exec claude ${arguments_.map(shellEscapeArg).join(" ")}`;
        const encoded = Buffer.from(program, "utf8").toString("base64");
        const command = `docker exec -e 'container=docker' -e ${shellEscapeArg("FIRST=雪 ' $(never)")} -e ${shellEscapeArg("SECOND=line\nvalue")} -it ${containerId} sh -c ${shellEscapeArg(`printf %s '${encoded}' | base64 -d | sh`)}`;
        expect(native.spawn).toHaveBeenLastCalledWith("ssh", ["-t", "user@host", command], { stdio: "inherit" });
        expect(command).not.toContain("touch /tmp/ccc-never-run");
        const close = vi.fn(); const error = vi.fn();
        expect(channel.onClose(close)).toBeUndefined();
        expect(channel.onError(error)).toBeUndefined();
        expect(child.on.mock.calls).toEqual([["close", close], ["error", error]]);
        expect(channel.kill("SIGTERM")).toBe(true);
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        ports.startInteractiveSession({ config, containerId, projectId: "project-id", arguments: [], environment: [] });
        const defaultProgram = "cd '/project/project-id' && mise trust . 2>/dev/null; mise install -y || true; exec claude --dangerously-skip-permissions";
        const defaultDecoder = `printf %s '${Buffer.from(defaultProgram, "utf8").toString("base64")}' | base64 -d | sh`;
        expect(native.spawn).toHaveBeenLastCalledWith("ssh", ["-t", "user@host", `docker exec -e 'container=docker' -it ${containerId} sh -c ${shellEscapeArg(defaultDecoder)}`], { stdio: "inherit" });
    });
});
