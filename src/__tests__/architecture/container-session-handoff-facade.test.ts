import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncReturns } from "child_process";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { normalizeNativeRuntimeCall, preloadNativeRuntimeFixture } from "../helpers/native-runtime-fixture.js";

const native = vi.hoisted(() => ({
    bindGuard: Object.freeze({ get root() { return resolve("/fixture/home/.ccc"); } }) as import("../../ports/runtime-bind-authority.js").RuntimeBindGuard,
    creationTicket: Object.freeze({}) as import("../../ports/runtime-bind-authority.js").RuntimeBindCreationTicket,
    authorityEvents: [] as string[],
    authorityHeld: false,
    retainedAuthority: undefined as import("../../ports/runtime-bind-authority.js").RuntimeBindAuthorityFacts | undefined,
    spawn: vi.fn(), runtime: vi.fn(), remote: vi.fn(), family: vi.fn(),
    handoffBoundary: vi.fn<(operation: () => string) => string>(),
    exists: vi.fn(), stat: vi.fn(), lstat: vi.fn(), read: vi.fn(), write: vi.fn(),
    realpath: vi.fn(), mkdir: vi.fn(), open: vi.fn(), fstat: vi.fn(), close: vi.fn(), rm: vi.fn(),
}));
// These facade owners fabricate host metadata. Keep authority at an explicit
// typed native boundary; real private-file guard qualification has native owners.
vi.mock("../../adapters/runtime-bind-authority.js", async original => {
    const actual = await original<typeof import("../../adapters/runtime-bind-authority.js")>();
    const { validateNativeRuntimeInvocation } = await import("../../adapters/container-runtime-invocation.js");
    const snapshot = (guard: import("../../ports/runtime-bind-authority.js").RuntimeBindGuard, invocation: import("../../ports/container-runtime-invocation.js").NativeRuntimeInvocation) => {
        expect(native.authorityHeld).toBe(true);
        expect(guard).toBe(native.bindGuard);
        expect(validateNativeRuntimeInvocation(invocation).executable).toBe("/fixture/runtime/docker");
        native.retainedAuthority = Object.freeze({ coverage: "incomplete", pending: false, authorities: [invocation] });
        return native.retainedAuthority;
    };
    return {
        ...actual,
        withRuntimeBindGuard: <T>(root: string | import("../../ports/runtime-bind-authority.js").RuntimeBindHomePreparation, operation: (guard: import("../../ports/runtime-bind-authority.js").RuntimeBindGuard) => T) => {
            expect(typeof root === "string" ? root : root.root).toBe(native.bindGuard.root);
            expect(native.authorityHeld).toBe(false);
            native.authorityHeld = true;
            try { return operation(native.bindGuard); } finally { native.authorityHeld = false; }
        },
        recordRuntimeBindAuthority: (guard: import("../../ports/runtime-bind-authority.js").RuntimeBindGuard, invocation: import("../../ports/container-runtime-invocation.js").NativeRuntimeInvocation) => {
            const recorded = snapshot(guard, invocation);
            native.authorityEvents.push("record");
            return recorded;
        },
        beginRuntimeBindCreation: (guard: import("../../ports/runtime-bind-authority.js").RuntimeBindGuard, invocation: import("../../ports/container-runtime-invocation.js").NativeRuntimeInvocation) => {
            snapshot(guard, invocation);
            native.authorityEvents.push("begin");
            return native.creationTicket;
        },
        settleRuntimeBindCreation: (guard: import("../../ports/runtime-bind-authority.js").RuntimeBindGuard, ticket: import("../../ports/runtime-bind-authority.js").RuntimeBindCreationTicket) => {
            expect(native.authorityHeld).toBe(true);
            expect(guard).toBe(native.bindGuard);
            expect(ticket).toBe(native.creationTicket);
            native.authorityEvents.push("settle");
            if (!native.retainedAuthority) throw new Error("Fixture creation has no recorded authority");
            return native.retainedAuthority;
        },
    };
});
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn,
}));
vi.mock("fs", async original => ({
    ...await original<typeof import("node:fs")>(),
    existsSync: native.exists, statSync: native.stat, lstatSync: native.lstat,
    readFileSync: native.read, writeFileSync: native.write, realpathSync: native.realpath,
    mkdirSync: native.mkdir, openSync: native.open, fstatSync: native.fstat,
    closeSync: native.close, rmSync: native.rm,
}));
vi.mock("os", async original => ({
    ...await original<typeof import("node:os")>(), homedir: () => resolve("/fixture/home"),
}));
vi.mock("../../container-runtime.js", async original => ({
    ...await original<typeof import("../../container-runtime.js")>(),
    runtimeCli: native.runtime, isContainerHostRemote: native.remote,
    getRuntimeInfo: () => ({ runtime: "docker", dockerDesktop: false, socketPath: "/var/run/docker.sock" }),
    containerManagerSocketPath: () => "/var/run/docker.sock",
    containerManagerSocketMountArgs: () => ["-v", "/var/run/docker.sock:/var/run/docker.sock"],
    runtimeExtraRunArgs: () => [],
    bindMountArgs: (host: string, container: string, options?: { readonly?: boolean }) => ["-v", `${host}:${container}${options?.readonly ? ":ro" : ""}`],
}));
// Arm native failure observations at the handoff boundary while retaining every
// real application port assertion, identity check and callback invocation.
vi.mock("../../application/container-session-handoff.js", async original => {
    const actual = await original<typeof import("../../application/container-session-handoff.js")>();
    return {
        ...actual,
        createContainerSessionHandoff: (ports: Parameters<typeof actual.createContainerSessionHandoff>[0]) => {
            const handoff = actual.createContainerSessionHandoff(ports);
            return { run: (...args: Parameters<typeof handoff.run>) => native.handoffBoundary(() => handoff.run(...args)) };
        },
    };
});
vi.mock("../../tool-registry.js", () => ({ getAllCredentialMounts: () => [] }));
vi.mock("../../device-lab-admin.js", () => ({ cleanupOwnerDevices: vi.fn() }));
vi.mock("../../session.js", () => ({
    getSessionLockClaimsForContainer: () => [],
    withContainerLifecycleLock: (_prefix: string, operation: () => unknown) => operation(),
    withProjectFamilyLifecycleLock: native.family,
}));
// Native lock safety/contended ownership is tested in shared-mutation-lock.test.ts.
// No other shared state export or native path is replaced by this lock boundary.
vi.mock("@ccc/device-lab/device-lab-shared-state.js", async original => ({
    ...await original<typeof import("@ccc/device-lab/device-lab-shared-state.js")>(),
    withSharedMutationLock: (path: string, operation: () => unknown, options: { waitMs: number; reclaimStale?: boolean }) => {
        const codexState = path === join(native.bindGuard.root, "codex-state.lock");
        const identity = dirname(path) === join(native.bindGuard.root, "run", "locks")
            && /^identity-[a-f0-9]{64}\.lock$/.test(basename(path));
        if (!codexState && !identity) throw new Error("unexpected fixture lock IO");
        expect(operation).toBeTypeOf("function");
        expect(options).toEqual({ waitMs: codexState ? 600_000 : 1_260_000, reclaimStale: false });
        return operation();
    },
}));

// Docker, lifecycle composition and the extracted application remain real.
const runtime = await import("../../container-runtime.js");
const docker = await import("../../docker.js");
const containerIdentity = await import("../../container-identity.js");
const sharedState = await import("@ccc/device-lab/device-lab-shared-state.js");
const baseImageId = `sha256:${"b".repeat(64)}`;
const identityImageId = `sha256:${"c".repeat(64)}`;
const { getClaudeJsonFile, IMAGE_NAME } = await import("../../utils.js");
const id = "a".repeat(64);
const project = resolve("/fixture/project");
const refusal = "Container identity changed before session handoff; refusing to join.";
type Path = "fresh" | "existing" | "restart" | "deferred";

function result(status = 0, stdout = ""): SpawnSyncReturns<string> {
    return { status, stdout, stderr: "", pid: 1, output: [], signal: null };
}

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected exception");
}

function calls() {
    return native.spawn.mock.calls.map(call => normalizeNativeRuntimeCall(call, "fixture-runtime") as [string, string[], Record<string, unknown>]);
}

function fixture(path: Path) {
    native.authorityEvents = [];
    preloadNativeRuntimeFixture(runtime);
    const identity = containerIdentity.resolveContainerIdentity();
    const identityLabels = { ...containerIdentity.getIdentityLabels(identity), "ccc.identity.base": baseImageId };
    const trace: string[] = [];
    const state = {
        existing: false, running: true, deferred: false, late: false,
        finalIdentity: `${id}|true`, identityFailure: undefined as unknown,
        sourceFailure: undefined as unknown, sourcePath: "",
        runArgs: [] as string[],
    };
    native.handoffBoundary.mockImplementation(operation => {
        trace.push("handoff");
        state.late = true;
        const value = operation();
        state.late = false;
        return value;
    });
    native.runtime.mockReturnValue("fixture-runtime");
    native.remote.mockReturnValue(false);
    native.exists.mockReturnValue(false);
    native.realpath.mockImplementation((target: string) => target);
    const stat = (target: string) => {
        if (state.late) {
            trace.push(`source:${target}`);
            if (target === state.sourcePath) throw state.sourceFailure;
        }
        return {
            isSymbolicLink: () => false, isDirectory: () => !target.endsWith(".json"),
            isFile: () => target.endsWith(".json"), dev: 1, ino: 1, size: 16, gid: 100,
        };
    };
    native.lstat.mockImplementation(stat);
    native.stat.mockImplementation(stat);
    native.fstat.mockImplementation(() => stat("owner.json"));
    native.read.mockReturnValue(Buffer.from("fixture"));
    const markers = new Map<string, string>();
    native.write.mockImplementation((target: string, content: string) => { markers.set(basename(target), content); });
    native.open.mockReturnValue(1);
    native.family.mockImplementation((_prefix, operation) => operation());
    native.spawn.mockImplementation((...rawCall) => {
        const [, args, options] = normalizeNativeRuntimeCall(rawCall, "fixture-runtime") as [string, string[], { encoding?: string | null }];
        if (args[0] === "info" && args.includes("{{.ID}}")) {
            expect(rawCall[0]).toBe("/fixture/runtime/docker");
            expect(args).toEqual(["info", "--format", "{{.ID}}"]);
            expect(options).toEqual({ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL", windowsHide: true });
            return result(0, "fixture-daemon-id\n");
        }
        if (args[0] === "exec" && args.includes("/usr/bin/docker")) {
            expect(rawCall[0]).toBe("/fixture/runtime/docker");
            // The outer exec retains captured authority. The Docker command
            // inside the container addresses its mounted socket directly.
            expect(args).toEqual(["exec", "--user", "root", id, "/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "info", "--format", "{{.ID}}"]);
            expect(options).toEqual({ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL", windowsHide: true });
            return result(0, "fixture-daemon-id\n");
        }
        if (args[0] === "images") return result(0, "image-id");
        if (args[0] === "image" && args[1] === "inspect") {
            expect(args[2]).toMatch(/^ccc-identity:[a-f0-9]{64}$/);
            return result(0, JSON.stringify([{ Id: identityImageId, Config: { User: "ccc", Labels: identityLabels } }]));
        }
        if (args[0] === "inspect" && args[1] === IMAGE_NAME && args.includes("{{.Id}}")) return result(0, baseImageId);
        if (args[0] === "run" && args[1] === "--rm") {
            if (args.at(-1) === 'set -eu; printf "%s:%s" "$(id -u ccc)" "$(id -g ccc)"') {
                expect(args.slice(0, 9)).toEqual(["run", "--rm", "--network", "none", "--user", "root", "--entrypoint", "/bin/sh", identityImageId]);
                return result(0, `${identity.uid}:${identity.gid}`);
            }
            expect(args.slice(0, 9)).toEqual(["run", "--rm", "--network", "none", "--user", "ccc", "--entrypoint", "/bin/sh", identityImageId]);
            return result(0, `${identity.uid}:${identity.gid}:/home/ccc:ccc`);
        }
        if (args[0] === "run") {
            expect(native.authorityHeld).toBe(true);
            expect(native.authorityEvents.at(-1)).toBe("begin");
            native.authorityEvents.push("run");
            state.runArgs = [...args]; return result(0, id);
        }
        if (args[0] === "start") { state.running = true; return result(); }
        if (args[0] === "ps" && args[1] === "-aq") return result(0, state.existing ? id : "");
        if (args[0] === "ps" && args[1] === "-q") return result(0, state.existing && state.running ? id : "");
        if (args[0] === "inspect" && args.includes("{{.State.Running}}")) return result(0, String(state.existing && state.running));
        if (args[0] === "inspect" && args.includes("{{.Id}}|{{.State.Running}}|{{.Image}}")) return result(0, `${id}|${state.running}|${identityImageId}`);
        if (args[0] === "inspect" && args.includes("{{.Id}}|{{.State.Running}}")) {
            if (state.late) {
                trace.push(`identity:${args[1]}`);
                if (state.identityFailure !== undefined) throw state.identityFailure;
                return result(0, state.finalIdentity);
            }
            return result(0, `${id}|${state.running}`);
        }
        if (args[0] === "inspect" && args.includes("{{json .}}")) {
            const mounts: Array<{ Source: string; Destination: string; Type: string; RW: boolean }> = [];
            const labels: Record<string, string> = {};
            const env: string[] = [];
            for (let index = 0; index < state.runArgs.length; index++) {
                const argument = state.runArgs[index];
                const value = state.runArgs[index + 1];
                if (argument === "-v") {
                    const match = value.match(/^(.*):(\/[^:]+)(?::ro)?$/)!;
                    mounts.push({ Source: match[1], Destination: match[2], Type: isAbsolute(match[1]) ? "bind" : "volume", RW: !value.endsWith(":ro") });
                }
                if (argument === "--tmpfs") mounts.push({ Source: "", Destination: value.split(":")[0], Type: "tmpfs", RW: true });
                if (argument === "--label") labels[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
                if (argument === "-e") env.push(value);
            }
            return result(0, JSON.stringify({ Id: id, Image: identityImageId, State: { Running: state.running }, Mounts: mounts, Config: { Labels: labels, Env: env, User: "ccc" }, HostConfig: { Init: !state.deferred, Devices: [], DeviceRequests: [], GroupAdd: [], Privileged: false } }));
        }
        if (args[0] === "exec" && args[1] === id && args[2] === "sh" && args[4]?.includes('$(id -un)')) return result(0, `${identity.uid}:${identity.gid}:ccc:/home/ccc`);
        if (args[0] === "exec" && args[2] === "cat") {
            if (options?.encoding === null) return { ...result(), stdout: Buffer.from("fixture") };
            return result(0, markers.get(basename(args[3])) ?? "");
        }
        if (args[0] === "exec" && args.includes("ccc-ssh-copy")) {
            trace.push("sync-finished");
        }
        return result();
    });
    if (path !== "fresh") {
        docker.startProjectContainer(project, () => {});
        state.existing = true;
        state.running = path !== "restart";
        state.deferred = path === "deferred";
        state.late = false;
        native.spawn.mockClear(); native.family.mockClear(); trace.length = 0;
        native.authorityEvents = [];
    }
    const start = (ready?: (target: string, handoff: { startedByInvocation: boolean }) => void, started?: (target: string) => void) => docker.startProjectContainer(
        project, () => {}, undefined, undefined, undefined, undefined,
        path === "deferred" ? () => false : undefined, ready, undefined, started,
    );
    const startPrepared = () => docker.prepareProjectContainerStartup().start(
        project, () => {}, undefined, undefined, undefined, undefined,
        path === "deferred" ? () => false : undefined,
    );
    return { state, trace, start, startPrepared };
}

function assertPreserved() {
    expect(calls().filter(call => ["stop", "rm"].includes(call[1][0]))).toEqual([]);
}

beforeEach(() => {
    vi.resetAllMocks();
    native.authorityEvents = []; native.authorityHeld = false;
    runtime._resetRuntimeCacheForTest();
    native.handoffBoundary.mockImplementation(operation => operation());
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { runtime._resetRuntimeCacheForTest(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("public Docker session handoff through the real application", () => {
    it("refuses an unknown fixture lock without executing its callback", () => {
        const callback = vi.fn();
        expect(() => sharedState.withSharedMutationLock("/outside/start.lock", callback)).toThrow("unexpected fixture lock IO");
        expect(callback).not.toHaveBeenCalled();
    });
    it.each(["fresh", "existing", "restart", "deferred"] as const)("hands off the pinned ID after source checks with a readiness callback on %s", path => {
        const f = fixture(path);
        const returned = Promise.resolve("ignored");
        Object.defineProperty(returned, "then", { get() { throw new Error("must not observe callback return"); } });
        expect(f.start(function (this: unknown, target, handoff) {
            expect(target).toBe(id);
            expect(handoff).toEqual({ startedByInvocation: path === "fresh" || path === "restart" });
            f.trace.push(`ready:${target}`);
            return returned;
        })).toBe(docker.getContainerName(project));
        const readyIndex = f.trace.indexOf(`ready:${id}`);
        expect(f.trace.slice(readyIndex - 1, readyIndex + 1)).toEqual([`identity:${id}`, `ready:${id}`]);
        expect(readyIndex).toBeLessThan(f.trace.indexOf("sync-finished"));
        const finalIdentity = f.trace.indexOf(`identity:${id}`);
        const sourceTrace = f.trace.slice(f.trace.indexOf("handoff") + 1, finalIdentity);
        // The synchronous wrapper publishes the exact target before running
        // queued helpers; source and identity assertions belong to that handoff.
        const projectCheck = sourceTrace.indexOf(`source:${project}`);
        const filesystemCheck = sourceTrace.findIndex(entry => entry.endsWith("claude.json"));
        expect(projectCheck).toBeGreaterThanOrEqual(0);
        expect(filesystemCheck).toBeGreaterThan(projectCheck);
        expect(calls().filter(call => call[1][0] === "run" && call[1][1] !== "--rm")).toHaveLength(path === "fresh" ? 1 : 0);
        expect(calls().filter(call => call[1][0] === "start").map(call => call[1])).toEqual(path === "restart" ? [["start", id]] : []);
        expect(native.family).toHaveBeenCalledTimes(path === "fresh" ? 1 : 0);
        expect(native.authorityEvents).toEqual(path === "fresh" ? ["record", "begin", "run", "settle"] : ["record"]);
        if (path === "deferred") expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Container update deferred"));
        assertPreserved();
    });

    it.each(["fresh", "existing", "restart", "deferred"] as const)("publishes start authority before helper synchronization, once on %s", path => {
        const f = fixture(path);
        const ready = vi.fn();
        const started = vi.fn(function (this: unknown, target: string) {
            expect(target).toBe(id);
            expect(f.trace).not.toContain("sync-finished");
            expect(ready).not.toHaveBeenCalled();
            f.trace.push("started");
        });
        expect(f.start(ready, started)).toBe(docker.getContainerName(project));
        expect(started).toHaveBeenCalledTimes(path === "fresh" || path === "restart" ? 1 : 0);
        expect(ready).toHaveBeenCalledExactlyOnceWith(id, { startedByInvocation: path === "fresh" || path === "restart" });
        if (started.mock.calls.length) expect(f.trace.indexOf("started")).toBeLessThan(f.trace.indexOf("sync-finished"));
        assertPreserved();
    });

    it.each(["fresh", "existing", "restart", "deferred"] as const)("prepared startup makes no handoff identity inspection without a callback on %s", path => {
        const f = fixture(path);
        expect(f.startPrepared()).toBe(docker.getContainerName(project));
        expect(f.trace.some(entry => entry.startsWith("identity:"))).toBe(false);
        const allCalls = calls();
        const inspections = allCalls.filter(call => call[1].includes("{{.Id}}|{{.State.Running}}"));
        expect(inspections).toHaveLength(path === "existing" ? 0 : path === "deferred" ? 2 : 1);
        if (path === "fresh") expect(inspections[0][1]).toEqual(["inspect", id, "--format", "{{.Id}}|{{.State.Running}}"]);
        if (path === "deferred") {
            expect(inspections.map(call => call[1])).toEqual([
                ["inspect", docker.getContainerName(project), "--format", "{{.Id}}|{{.State.Running}}"],
                ["inspect", id, "--format", "{{.Id}}|{{.State.Running}}"],
            ]);
        }
        if (path === "restart") {
            // Restart rechecks its captured stopped ID before start. This early
            // fence must not become a callback-dependent final identity probe.
            expect(inspections[0]).toEqual(["fixture-runtime", ["inspect", id, "--format", "{{.Id}}|{{.State.Running}}"],
                { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" }]);
            const startCall = allCalls.find(call => call[1][0] === "start");
            expect(startCall?.[1]).toEqual(["start", id]);
            expect(allCalls.indexOf(inspections[0])).toBeLessThan(allCalls.indexOf(startCall!));
        }
        expect(f.trace.some(entry => entry.endsWith("claude.json"))).toBe(true);
        assertPreserved();
    });

    it.each(["fresh", "existing", "restart", "deferred"] as const)("synchronous startup retains its internal handoff before helper initialization without an external callback on %s", path => {
        const f = fixture(path);
        expect(f.start()).toBe(docker.getContainerName(project));
        expect(f.trace.filter(entry => entry.startsWith("identity:"))).toEqual([`identity:${id}`]);
        expect(f.trace.filter(entry => entry === "sync-finished")).toHaveLength(1);
        expect(f.trace.indexOf(`identity:${id}`)).toBeLessThan(f.trace.indexOf("sync-finished"));
        assertPreserved();
    });

    it.each(["fresh", "existing"] as const)("refuses stopped, missing and successor identities without late compensation on %s", path => {
        for (const identity of [`${id}|false`, "", `${"b".repeat(64)}|true`]) {
            const f = fixture(path); f.state.finalIdentity = identity;
            const ready = vi.fn();
            expect(() => f.start(ready)).toThrow(refusal);
            expect(ready).not.toHaveBeenCalled();
            expect(f.trace.at(-1)).toBe(`identity:${id}`);
            assertPreserved();
        }
    });

    it.each(["fresh", "existing"] as const)("propagates identity and callback exceptions unchanged without late compensation on %s", path => {
        for (const stage of ["identity", "callback"] as const) {
            for (const failure of [new Error(stage), { stage }]) {
                const f = fixture(path);
                if (stage === "identity") f.state.identityFailure = failure;
                const ready = vi.fn(() => { throw failure; });
                expect(thrown(() => f.start(ready))).toBe(failure);
                expect(ready).toHaveBeenCalledTimes(stage === "callback" ? 1 : 0);
                assertPreserved();
            }
        }
    });

    it.each(["fresh", "existing"] as const)("propagates late project and filesystem assertion failures before identity on %s", path => {
        for (const kind of ["project", "filesystem"]) {
            const f = fixture(path);
            const source = kind === "project" ? project : getClaudeJsonFile();
            const failure = { source };
            f.state.sourcePath = source; f.state.sourceFailure = failure;
            const ready = vi.fn();
            expect(thrown(() => f.start(ready))).toBe(failure);
            expect(ready).not.toHaveBeenCalled();
            expect(f.trace.some(entry => entry.startsWith("identity:"))).toBe(false);
            expect(f.trace.at(-1)).toBe(`source:${source}`);
            assertPreserved();
        }
    });
});
