import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
    spawn: vi.fn(), sync: vi.fn(), exists: vi.fn(), read: vi.fn(), writeSync: vi.fn(),
    legacy: vi.fn(() => "/legacy"), containerName: vi.fn(), reader: vi.fn(),
}));
vi.mock("readline", () => ({ createInterface: native.reader }));
vi.mock("child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: native.spawn, spawnSync: native.sync }));
vi.mock("fs", async original => {
    const actual = await original<typeof import("node:fs")>();
    return {
        ...actual, existsSync: native.exists, writeSync: native.writeSync,
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) => String(args[0]).endsWith("package.json") ? actual.readFileSync(...args) : native.read(...args),
    };
});
vi.mock("../../home-layout.js", async original => ({ ...await original<typeof import("../../home-layout.js")>(), legacyRemoteConfigDir: native.legacy }));
vi.mock("../../docker.js", async original => ({ ...await original<typeof import("../../docker.js")>(), getContainerName: native.containerName }));

import { createNativeRemoteServicesPorts, projectRemoteExecutionOutcome, projectRemoteTerminateOutcome } from "../../adapters/remote-services.js";
import { checkTailscale, checkMutagen, getMutagenSyncStatus, isHostReachable, shellEscapeArg } from "../../remote.js";

const config = { host: "host", user: "user", remotePath: "" };
const containerId = "a".repeat(64);
const syncId = "sync_" + "a".repeat(43);
const token = "b".repeat(32);
const reservation = { config, projectPath: "/work/project", profile: "named", token, leaseSeconds: 300 };
const retained = { config, name: "ccc-returned", containerId, token };
const syncRequest = { config, name: "ccc-sync", localPath: resolve("/work/雪 project"), containerId, projectId: "project-id" };
const interactiveRequest = { config, containerId, projectId: "project-id", arguments: [], environment: [] };
const lifecycleEvents = ["SIGINT", "SIGTERM", "SIGHUP", "exit"] as const;
type LifecycleListener = NodeJS.ExitListener | NodeJS.SignalsListener;
let baseline: Map<string, LifecycleListener[]>;
const ttyDescriptors = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
function lifecycleListeners(event: typeof lifecycleEvents[number]): LifecycleListener[] {
    return event === "exit" ? process.listeners("exit") : process.listeners(event);
}
function setTty(input: boolean, output: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: input });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: output });
}
function terminalFixture(input = true, output = true) {
    setTty(input, output);
    native.sync.mockReturnValue(execution(0, "500:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0\n"));
    native.writeSync.mockImplementation((_fd: number, data: string | NodeJS.ArrayBufferView) => typeof data === "string" ? Buffer.byteLength(data) : data.byteLength);
    return { write: native.writeSync, output: () => native.writeSync.mock.calls.map(call => String(call[1])).join("") };
}
function expectTerminalRestored(output: string): void {
    const modes = new Map<number, boolean>();
    for (const match of output.matchAll(/\u001b\[\?([\d;]+)([hl])/g)) {
        for (const mode of match[1].split(";")) modes.set(Number(mode), match[2] === "h");
    }
    for (const mode of [1000, 1002, 1003, 1006, 1004, 2004, 1049]) expect(modes.get(mode)).toBe(false);
    expect(modes.get(25)).toBe(true);
    expect(output).not.toContain("\u001bc");
    expect(output).not.toMatch(/\u001b\[[23]J/);
}
function execution(status: number | null, stdout = "", error?: Error, stderr = "") {
    return { status, stdout, stderr, error, pid: 123, output: [], signal: null };
}
function nativeSession(overrides: Record<string, unknown> = {}) {
    return { identifier: syncId, name: "ccc-sync", alpha: { protocol: "local", path: syncRequest.localPath },
        beta: { protocol: "ssh", user: "user", host: "host", path: `docker://${containerId}/project/project-id` },
        paused: false, status: "watching", ...overrides };
}
const queryArgs = ["sync", "list", "--template", "{{json .}}"];
const capturedOptions = (extra: Record<string, unknown> = {}) => expect.objectContaining({ env: expect.any(Object), cwd: process.cwd(), ...extra });

beforeEach(() => {
    vi.resetAllMocks();
    setTty(false, false);
    baseline = new Map(lifecycleEvents.map(event => [event, lifecycleListeners(event)]));
    native.legacy.mockReturnValue("/legacy");
    native.containerName.mockReturnValue("ccc-returned");
});
afterEach(() => {
    for (const event of lifecycleEvents) {
        for (const listener of lifecycleListeners(event)) {
            if (!baseline.get(event)!.includes(listener)) process.removeListener(event, listener);
        }
    }
    vi.restoreAllMocks();
    [process.stdin, process.stdout].forEach((stream, index) => {
        const descriptor = ttyDescriptors[index];
        if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
        else Reflect.deleteProperty(stream, "isTTY");
    });
});

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
            expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["version"], capturedOptions({ encoding: "utf-8" }));
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
            expect(() => projectRemoteTerminateOutcome({ kind: "failed", reason: result.reason, evidence: result.evidence })).toThrow("stable container ID was not returned");
        }
        native.sync.mockReturnValue(execution(1, `ccc-container-id=${containerId}\n`, undefined, "start denied"));
        const failure = ports.reserveContainer(reservation);
        expect(failure.kind).toBe("failed");
        if (failure.kind !== "failed") throw Error("reservation unexpectedly succeeded");
        expect(failure.reason).toBe("start-failed");
        expect(() => projectRemoteTerminateOutcome({ kind: "failed", reason: failure.reason, evidence: failure.evidence })).toThrow("Failed to start remote container: start denied");
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
        expect(() => projectRemoteTerminateOutcome({ kind: "failed", reason: "stop-failed", evidence: failure.evidence })).toThrow("Failed to stop remote container: stop denied");
        native.sync.mockReturnValue(execution(0));
        expect(ports.releaseReservation(retained)).toEqual({ ok: true });
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
            expect(() => projectRemoteTerminateOutcome({ kind: "failed", reason: "project-prepare-failed", evidence: failure.evidence })).toThrow(`Failed to prepare remote container project directory: ${diagnostic}`);
        }
    });

    it("projects official complete JSON inventory into exact semantic binding and independent flags", () => {
        const ports = createNativeRemoteServicesPorts();
        native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession({ paused: true, lastError: "permission denied" })])));
        const inventory = ports.observeSyncInventory();
        expect(inventory.kind).toBe("known"); if (inventory.kind !== "known") throw Error("unknown inventory");
        expect(inventory.sessions).toHaveLength(1);
        expect(inventory.sessions[0]).toMatchObject({ kind: "observed", identifier: syncId, name: "ccc-sync", paused: true, watching: true, failed: true,
            binding: { localPath: syncRequest.localPath, user: "user", host: "host", projectId: "project-id", containerId } });
        expect(getMutagenSyncStatus("ccc-sync")).toBe("Paused");
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", queryArgs, capturedOptions({ encoding: "utf-8", timeout: 30000, killSignal: "SIGKILL" }));
        native.sync.mockReturnValue(execution(0, "[]")); expect(ports.observeSyncInventory()).toMatchObject({ kind: "known", sessions: [] });
        expect(getMutagenSyncStatus("ccc-sync")).toBeNull();
    });

    it.each([
        "", "not json", "{}", "null", "[null]", JSON.stringify([nativeSession(), {}]),
        JSON.stringify([nativeSession({ identifier: "name-is-not-id" })]), JSON.stringify([nativeSession({ paused: "false" })]),
        JSON.stringify([nativeSession({ name: 7 })]), JSON.stringify([nativeSession({ status: null })]),
        JSON.stringify([nativeSession({ alpha: { protocol: "local" } })]),
        JSON.stringify([nativeSession(), nativeSession({ name: "unrelated" })]),
    ])("treats every malformed or incompatible inventory as unknown: %s", output => {
        native.sync.mockReturnValue(execution(0, output));
        expect(createNativeRemoteServicesPorts().observeSyncInventory()).toMatchObject({ kind: "unknown" });
        expect(getMutagenSyncStatus("ccc-sync")).toBeNull();
    });

    it.each([
        ["unknown protocol", "beta", { protocol: "unknown", host: "other", path: "/project" }],
        ["relative local path", "alpha", { protocol: "local", path: "relative/project" }],
        ["local username", "alpha", { protocol: "local", path: "/project", user: "other" }],
        ["local hostname", "alpha", { protocol: "local", path: "/project", host: "other" }],
        ["local port", "alpha", { protocol: "local", path: "/project", port: 22 }],
        ["local environment", "alpha", { protocol: "local", path: "/project", environment: { HOME: "/other" } }],
        ["local parameters", "alpha", { protocol: "local", path: "/project", parameters: { compression: "true" } }],
        ["empty SSH hostname", "beta", { protocol: "ssh", host: "", path: "/project" }],
        ["SSH environment", "beta", { protocol: "ssh", host: "other", path: "/project", environment: { HOME: "/other" } }],
        ["empty Docker container", "beta", { protocol: "docker", host: "", path: "/project" }],
        ["Docker port", "beta", { protocol: "docker", host: "container", port: 22, path: "/project" }],
        ["invalid Docker path prefix", "beta", { protocol: "docker", host: "container", path: "relative/project" }],
    ] as const)("refuses inventory containing an unrelated endpoint with %s", (_label, field, endpoint) => {
        const unrelated = nativeSession({ identifier: "sync_" + "b".repeat(43), name: "unrelated", [field]: endpoint });
        native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession(), unrelated])));
        expect(createNativeRemoteServicesPorts().observeSyncInventory()).toMatchObject({ kind: "unknown" });
        expect(getMutagenSyncStatus("ccc-sync")).toBeNull();
    });

    it.each(["defaults", "1leading-digit", "name_with-underscore", "name with space", "name!", "abcdefab-cdef-abcd-abcd-abcdefabcdef", "ABCDEFAB-CDEF-ABCD-ABCD-ABCDEFABCDEF", syncId])(
        "rejects an invalid unrelated native name %s before any identifier can become authority", name => {
            native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession(), nativeSession({ identifier: "sync_" + "b".repeat(43), name })])));
            expect(createNativeRemoteServicesPorts().observeSyncInventory()).toMatchObject({ kind: "unknown" });
        });

    it("retains legal Unicode names and valid unrelated SSH and Docker endpoints", () => {
        const ports = createNativeRemoteServicesPorts();
        for (const name of ["", "雪-project٢", "𐐀name-²", "Defaults"]) {
            native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession({ name })])));
            expect(ports.observeSyncInventory()).toMatchObject({ kind: "known", sessions: [{ name }] });
        }
        for (const beta of [
            { protocol: "ssh", host: "other", path: "relative/project" },
            { protocol: "ssh", user: "other", host: "other", port: 2222, path: "/project", parameters: { compression: "true" } },
            { protocol: "docker", user: "other", host: "container", path: "/project", environment: { DOCKER_HOST: "tcp://other:2376" }, parameters: { extra: "value" } },
            { protocol: "docker", host: "container", path: "~/project" },
        ]) {
            native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession({ beta })])));
            expect(ports.observeSyncInventory()).toMatchObject({ kind: "known", sessions: [{ binding: null }] });
        }
    });

    it("admits native absolute local paths and preserves the official Docker path forms", () => {
        const ports = createNativeRemoteServicesPorts();
        const localPaths = process.platform === "win32" ? ["C:\\project", "\\\\server\\share\\project"] : ["/project", "/work/雪 project"];
        const relativePaths = process.platform === "win32" ? ["relative/project", "C:relative", "\\project", "/project", "\\\\server"] : ["relative/project", "C:relative", "C:\\project", "\\\\server\\share\\project"];
        for (const path of localPaths) {
            native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession({ alpha: { protocol: "local", path, user: "", host: "", port: 0, environment: {}, parameters: {} } })])));
            expect(ports.observeSyncInventory()).toMatchObject({ kind: "known" });
        }
        for (const path of relativePaths) {
            native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession({ alpha: { protocol: "local", path } })])));
            expect(ports.observeSyncInventory()).toMatchObject({ kind: "unknown" });
        }
        for (const path of ["/project", "~/project", "C:\\project", "d:/project"]) {
            native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession({ beta: { protocol: "docker", host: "container", path } })])));
            expect(ports.observeSyncInventory()).toMatchObject({ kind: "known", sessions: [{ binding: null }] });
        }
        for (const path of ["relative/project", "C:relative", "1:/project", "\\\\server\\share\\project"]) {
            native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession({ beta: { protocol: "docker", host: "container", path } })])));
            expect(ports.observeSyncInventory()).toMatchObject({ kind: "unknown" });
        }
    });

    it("accounts for anonymous sessions and retains unsupported endpoints as unqualified records", () => {
        const ports = createNativeRemoteServicesPorts();
        const anonymous = nativeSession(); Reflect.deleteProperty(anonymous, "name");
        native.sync.mockReturnValue(execution(0, JSON.stringify([anonymous])));
        expect(ports.observeSyncInventory()).toMatchObject({ kind: "known", sessions: [{ name: "", identifier: syncId }] });
        for (const beta of [
            { protocol: "docker", host: containerId, path: "/project/project-id" },
            { protocol: "ssh", user: "user", host: "host", path: `docker://${containerId}/project/project-id`, port: 2200 },
            { protocol: "ssh", user: "user", host: "host", path: `/unqualified/${containerId}` },
            { protocol: "ssh", user: "user", host: "host", path: `docker://${containerId}f/project/project-id/trailing` },
        ]) {
            native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession({ beta })])));
            expect(ports.observeSyncInventory()).toMatchObject({ kind: "known", sessions: [{ binding: null }] });
        }
    });

    it("never borrows an ID from alpha or diagnostics to qualify the remote endpoint", () => {
        native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession({ alpha: { protocol: "local", path: `${process.platform === "win32" ? "C:" : ""}/local/docker://${containerId}/` },
            beta: { protocol: "ssh", user: "foreign", host: "other-host", path: `docker://${"b".repeat(64)}/project/project-id` }, lastError: `docker://${containerId}/` })])));
        expect(createNativeRemoteServicesPorts().observeSyncInventory()).toMatchObject({ kind: "known", sessions: [{ binding: { user: "foreign", host: "other-host", containerId: "b".repeat(64) } }] });
    });

    it.each([0, -1, 0.999])("does not dispatch Mutagen when the remaining %s ms cannot fund a process", remainingMs => {
        const ports = createNativeRemoteServicesPorts();
        expect(ports.observeSyncInventory(remainingMs)).toMatchObject({ kind: "unknown" });
        expect(native.sync).not.toHaveBeenCalled();
    });

    it("bounds the native query to usable whole milliseconds without changing its endpoint facts", () => {
        const ports = createNativeRemoteServicesPorts();
        native.sync.mockReturnValue(execution(0, JSON.stringify([nativeSession()])));
        expect(ports.observeSyncInventory(4321.9)).toMatchObject({ kind: "known", sessions: [{ watching: true, failed: false }] });
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", queryArgs, capturedOptions({ encoding: "utf-8", timeout: 4321, killSignal: "SIGKILL" }));
        ports.observeSyncInventory(1);
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", queryArgs, capturedOptions({ timeout: 1, killSignal: "SIGKILL" }));
        ports.observeSyncInventory(60000);
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", queryArgs, capturedOptions({ timeout: 30000, killSignal: "SIGKILL" }));
    });

    it("retains unavailable and raw-fault outcomes from a bounded native query", () => {
        const ports = createNativeRemoteServicesPorts();
        for (const result of [execution(0, "Status: Watching\n", Error("timed out")), execution(7, "Status: Watching\n"), execution(null)]) {
            native.sync.mockReturnValue(result);
            expect(ports.observeSyncInventory(321)).toMatchObject({ kind: "unknown" });
            expect(native.sync).toHaveBeenLastCalledWith("mutagen", queryArgs, capturedOptions({ encoding: "utf-8", timeout: 321, killSignal: "SIGKILL" }));
        }
        const fault = Error("native query threw");
        native.sync.mockImplementation(() => { throw fault; });
        expect(() => ports.observeSyncInventory(321)).toThrow(fault);
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
            expect(args).toEqual(queryArgs);
            // Redirect only the query executable and argv. The adapter's timeout
            // and termination options reach the actual joined native process.
            const result = spawnSync(process.execPath, ["-e", queryLeaf], options);
            joined.push(result);
            return result;
        });
        const ports = createNativeRemoteServicesPorts();
        const started = performance.now();
        const observation = ports.observeSyncInventory(budgetMs);
        const elapsedMs = performance.now() - started;

        expect(observation).toMatchObject({ kind: "unknown" });
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

    it("checks create and every identifier effect, including returned errors with status zero", () => {
        const ports = createNativeRemoteServicesPorts();
        for (const result of [execution(0), execution(0, "", Error("returned")), execution(1), execution(null)]) {
            native.sync.mockReturnValue(result);
            expect(ports.createSync(syncRequest).ok).toBe(result.status === 0 && !result.error);
            expect(native.sync).toHaveBeenLastCalledWith("mutagen", expect.arrayContaining(["--ignore-vcs"]), capturedOptions({ stdio: "inherit" }));
            expect(native.sync.mock.calls.at(-1)?.[1].slice(0, 7)).toEqual(["sync", "create", syncRequest.localPath, `user@host:docker://${containerId}/project/project-id`, "--name", "ccc-sync", "--ignore-vcs"]);
            for (const [action, effect] of [["resume", ports.resumeSync], ["terminate", ports.terminateSync], ["pause", ports.pauseSync]] as const) {
                expect(effect(syncId).ok).toBe(result.status === 0 && !result.error);
                expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["sync", action, syncId], capturedOptions({ stdio: "inherit" }));
            }
        }
    });

    it("rejects name selectors and malformed identifiers without dispatch", () => {
        const ports = createNativeRemoteServicesPorts();
        for (const selector of ["ccc-sync", "", "sync_short", "sync_" + "a".repeat(42), "sync_" + "a".repeat(44), "SYNC_" + "a".repeat(43)]) {
            expect(ports.resumeSync(selector).ok).toBe(false); expect(ports.pauseSync(selector).ok).toBe(false); expect(ports.terminateSync(selector).ok).toBe(false);
        }
        expect(native.sync).not.toHaveBeenCalled();
        native.sync.mockReturnValue(execution(0));
        expect(ports.terminateSync("12345678-1234-4234-9234-1234567890ab").ok).toBe(true);
    });

    it("captures Mutagen environment when ports are created", () => {
        const previous = process.env.CCC_SYNC_CAPTURE_TEST;
        try {
            process.env.CCC_SYNC_CAPTURE_TEST = "captured"; const ports = createNativeRemoteServicesPorts();
            process.env.CCC_SYNC_CAPTURE_TEST = "changed"; native.sync.mockReturnValue(execution(0, "[]"));
            ports.observeSyncInventory(); ports.resumeSync(syncId);
            for (const call of native.sync.mock.calls) expect(call[2]).toMatchObject({ cwd: process.cwd(), env: { CCC_SYNC_CAPTURE_TEST: "captured" } });
        } finally {
            if (previous === undefined) delete process.env.CCC_SYNC_CAPTURE_TEST; else process.env.CCC_SYNC_CAPTURE_TEST = previous;
        }
    });

    it("checks release status and returned errors while retaining void daemon startup and exact thrown faults", () => {
        const ports = createNativeRemoteServicesPorts();
        native.sync.mockReturnValue(execution(1, "", Error("returned")));
        expect(ports.startSyncDaemon()).toBeUndefined();
        expect(native.sync).toHaveBeenLastCalledWith("mutagen", ["daemon", "start"], capturedOptions({ stdio: "ignore" }));
        for (const result of [execution(1, "", Error("returned")), execution(null), execution(0, "", Error("returned with zero status"))]) {
            native.sync.mockReturnValue(result);
            expect(ports.releaseReservation(retained)).toEqual({ ok: false, evidence: { execution: result } });
        }
        native.sync.mockReturnValue(execution(0)); expect(ports.releaseReservation(retained)).toEqual({ ok: true });
        native.sync.mockImplementation(() => { throw Error("native throw"); });
        expect(() => ports.startSyncDaemon()).toThrow("native throw");
        expect(() => ports.pauseSync(syncId)).toThrow("native throw");
        expect(() => ports.terminateSync(syncId)).toThrow("native throw");
        expect(() => ports.releaseReservation(retained)).toThrow("native throw");
    });

    it("decodes legacy configuration at the bound native reader and leaves failures observable", () => {
        const reader = createNativeRemoteServicesPorts().prepareLegacyConfigReader("project-hash");
        native.exists.mockReturnValue(true);
        native.read.mockReturnValue(JSON.stringify(config));
        expect(reader.exists()).toBe(true);
        expect(reader.readConfig()).toEqual(config);
        expect(native.exists).toHaveBeenCalledWith(join("/legacy", "project-hash.json"));
        expect(native.read).toHaveBeenCalledWith(join("/legacy", "project-hash.json"), "utf-8");
        native.read.mockReturnValue("not json");
        expect(() => reader.readConfig()).toThrow();
        native.read.mockImplementation(() => { throw Error("read denied"); });
        expect(() => reader.readConfig()).toThrow("read denied");
        native.exists.mockImplementation(() => { throw Error("stat denied"); });
        expect(() => reader.exists()).toThrow("stat denied");
    });

    it.each(["user", "cleanup"] as const)("cancels only its owned %s reader, settles blank and ignores a late answer", async kind => {
        const readers: Array<EventEmitter & { question: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
        const answers: Array<(answer: string) => void> = [];
        native.reader.mockImplementation(() => {
            const events = new EventEmitter();
            const reader = Object.assign(events, { question: vi.fn((_question: string, answer: (value: string) => void) => answers.push(answer)), close: vi.fn(() => { events.emit("close"); }) });
            readers.push(reader); return reader;
        });
        const ports = createNativeRemoteServicesPorts();
        const request = kind === "user" ? { kind, defaultUser: "local" } as const : { kind } as const;
        const firstInterrupt = vi.fn(), secondInterrupt = vi.fn();
        const first = ports.prompt(request, firstInterrupt), second = createNativeRemoteServicesPorts().prompt(request, secondInterrupt);
        expect(readers).toHaveLength(1);
        expect(first.cancel()).toBeUndefined(); expect(first.cancel()).toBeUndefined();
        await expect(first.result).resolves.toBe(""); await Promise.resolve();
        expect(readers).toHaveLength(2); expect(readers[0].close).toHaveBeenCalledTimes(1); expect(readers[1].close).not.toHaveBeenCalled();
        expect(firstInterrupt).not.toHaveBeenCalled(); expect(secondInterrupt).not.toHaveBeenCalled();
        answers[0]("late answer"); answers[1](kind === "cleanup" ? "  YeS  " : "  NewUser  ");
        await expect(second.result).resolves.toBe(kind === "cleanup" ? "yes" : "NewUser"); expect(readers[1].close).toHaveBeenCalledTimes(1);
    });
    it.each(["blank", "EOF"] as const)("preserves %s as ordinary empty input rather than cancellation", async input => {
        let answer!: (value: string) => void;
        const events = new EventEmitter();
        const reader = Object.assign(events, { question: vi.fn((_question: string, callback: (value: string) => void) => { answer = callback; }), close: vi.fn(() => { events.emit("close"); }) });
        native.reader.mockReturnValue(reader); const ports = createNativeRemoteServicesPorts();
        const interrupted = vi.fn();
        const prompt = ports.prompt({ kind: "user", defaultUser: "local" }, interrupted);
        if (input === "blank") answer("   "); else reader.emit("close");
        await expect(prompt.result).resolves.toBe(""); expect(interrupted).not.toHaveBeenCalled();
    });
    it("delivers a reader interrupt only to its owning invocation and then admits the queued reader", async () => {
        const readers: EventEmitter[] = [];
        native.reader.mockImplementation(() => {
            const events = new EventEmitter();
            const reader = Object.assign(events, { question: vi.fn(), close: vi.fn(() => { events.emit("close"); }) });
            readers.push(reader); return reader;
        });
        const firstInterrupt = vi.fn(), secondInterrupt = vi.fn();
        const first = createNativeRemoteServicesPorts().prompt({ kind: "cleanup" }, firstInterrupt);
        const second = createNativeRemoteServicesPorts().prompt({ kind: "cleanup" }, secondInterrupt);
        expect(readers).toHaveLength(1); readers[0].emit("SIGINT");
        await expect(first.result).resolves.toBe(""); await Promise.resolve();
        expect(firstInterrupt).toHaveBeenCalledExactlyOnceWith("SIGINT"); expect(secondInterrupt).not.toHaveBeenCalled();
        expect(readers).toHaveLength(2); second.cancel(); await second.result;
    });
    it("cancels and settles one native sleep without disposing another invocation's timer", async () => {
        vi.useFakeTimers();
        try {
            const ports = createNativeRemoteServicesPorts(), first = ports.sleep(1000), second = ports.sleep(2000);
            let secondDone = false; void second.completion.then(() => { secondDone = true; });
            first.cancel(); first.cancel(); await first.completion; expect(secondDone).toBe(false); expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(2000); await second.completion; expect(secondDone).toBe(true); expect(vi.getTimerCount()).toBe(0);
        } finally { vi.useRealTimers(); }
    });
    it("projects a latched signal exactly once after cleanup facts are reported", () => {
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true), exit = vi.spyOn(process, "exit").mockImplementation(() => { throw Error("unexpected exit"); });
        projectRemoteExecutionOutcome({ kind: "cancelled", signal: "SIGINT", cleanupFailures: [] });
        expect(signal).toHaveBeenCalledExactlyOnceWith(process.pid, "SIGINT"); expect(exit).not.toHaveBeenCalled();
    });
    it("reports a guard cleanup fault while preserving the primary native termination failure", () => {
        const secondary = Error("termination guard release denied"), error = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(() => projectRemoteTerminateOutcome({ kind: "failed", reason: "sync-terminate-failed", evidence: { execution: execution(1) }, cleanupFailures: [{ kind: "cleanup-fault", phase: "release-sync-guard", error: secondary }] })).toThrow("Failed to terminate sync session");
        expect(error.mock.calls.flat().join(" ")).toContain(secondary.message);
        const primary = { native: "termination dispatch" }; let observed: unknown;
        try { projectRemoteTerminateOutcome({ kind: "fault", error: primary, cleanupFailures: [{ kind: "cleanup-fault", phase: "release-sync-guard", error: secondary }] }); }
        catch (failure) { observed = failure; }
        expect(observed).toBe(primary);
    });

    it("does not report successful process completion when checked reservation release failed", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {}), sentinel = Error("projected");
        const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw sentinel; });
        expect(() => projectRemoteExecutionOutcome({ kind: "completed", exitCode: 0, cleanupFailures: [{ kind: "release-failed", evidence: { execution: execution(1, "", undefined, "release denied") } }] })).toThrow(sentinel);
        expect(exit).toHaveBeenCalledExactlyOnceWith(1); expect(error.mock.calls.flat().join(" ")).toMatch(/release/i);
    });

    it("encodes literal UTF-8 arguments and ordered environment with the container marker first", () => {
        const ports = createNativeRemoteServicesPorts();
        const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
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
        child.emit("close", 17, null);
        const fault = Error("ssh failed");
        child.emit("error", fault);
        expect(close).toHaveBeenCalledExactlyOnceWith(17);
        expect(error).toHaveBeenCalledExactlyOnceWith(fault);
        expect(channel.kill("SIGTERM")).toBe(true);
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        ports.startInteractiveSession({ config, containerId, projectId: "project-id", arguments: [], environment: [] });
        const defaultProgram = "cd '/project/project-id' && mise trust . 2>/dev/null; mise install -y || true; exec claude --dangerously-skip-permissions";
        const defaultDecoder = `printf %s '${Buffer.from(defaultProgram, "utf8").toString("base64")}' | base64 -d | sh`;
        expect(native.spawn).toHaveBeenLastCalledWith("ssh", ["-t", "user@host", `docker exec -e 'container=docker' -it ${containerId} sh -c ${shellEscapeArg(defaultDecoder)}`], { stdio: "inherit" });
    });
});

describe("remote inherited terminal lifetime", () => {
    it.each(["close", "error"] as const)("restores before the caller's %s callback without adding parent signal policy", event => {
        const terminal = terminalFixture();
        const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
        native.spawn.mockReturnValue(child);
        const channel = createNativeRemoteServicesPorts().startInteractiveSession(interactiveRequest);
        const callback = vi.fn(() => {
            expectTerminalRestored(terminal.output());
            for (const lifecycle of lifecycleEvents) expect(lifecycleListeners(lifecycle)).toEqual(baseline.get(lifecycle));
        });
        const fault = Error("disconnected ssh");
        if (event === "close") channel.onClose(callback);
        else channel.onError(callback);
        for (const signal of lifecycleEvents.filter(value => value !== "exit")) expect(process.listeners(signal)).toEqual(baseline.get(signal));
        expect(process.listeners("exit").filter(listener => !baseline.get("exit")!.includes(listener))).toHaveLength(1);
        if (event === "close") child.emit("close", 23, null);
        else child.emit("error", fault);
        expect(callback).toHaveBeenCalledExactlyOnceWith(event === "close" ? 23 : fault);
        const writes = terminal.write.mock.calls.length;
        channel.kill("SIGTERM");
        expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
        expect(terminal.write).toHaveBeenCalledTimes(writes);
    });

    it("restores before propagating the exact synchronous SSH launch failure", () => {
        const terminal = terminalFixture();
        const fault = { native: "ssh launch" };
        native.spawn.mockImplementation(() => { throw fault; });
        let observed: unknown;
        try { createNativeRemoteServicesPorts().startInteractiveSession(interactiveRequest); }
        catch (error) { observed = error; }
        expect(observed).toBe(fault);
        expectTerminalRestored(terminal.output());
        for (const event of lifecycleEvents) expect(lifecycleListeners(event)).toEqual(baseline.get(event));
    });

    it.each([false, true, "throw"] as const)("preserves the SSH child's kill outcome %s while restoring synchronously", result => {
        const terminal = terminalFixture();
        const fault = Error("owned SSH client already exited");
        const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => {
            if (result === "throw") throw fault;
            return result;
        }) });
        native.spawn.mockReturnValue(child);
        const channel = createNativeRemoteServicesPorts().startInteractiveSession(interactiveRequest);
        if (result === "throw") expect(() => channel.kill("SIGINT")).toThrow(fault);
        else expect(channel.kill("SIGINT")).toBe(result);
        expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGINT");
        expectTerminalRestored(terminal.output());
        for (const event of lifecycleEvents) expect(lifecycleListeners(event)).toEqual(baseline.get(event));
    });

    it.each([[false, false], [true, false], [false, true]])("preserves redirected SSH stream bytes %s/%s and original callbacks", (input, output) => {
        const terminal = terminalFixture(input, output);
        const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
        native.spawn.mockReturnValue(child);
        const channel = createNativeRemoteServicesPorts().startInteractiveSession(interactiveRequest);
        const callback = vi.fn();
        channel.onClose(callback);
        child.emit("close", 31, null);
        expect(callback).toHaveBeenCalledExactlyOnceWith(31);
        expect(terminal.write).not.toHaveBeenCalled();
        expect(native.sync).not.toHaveBeenCalled();
        for (const event of lifecycleEvents) expect(lifecycleListeners(event)).toEqual(baseline.get(event));
    });
});
