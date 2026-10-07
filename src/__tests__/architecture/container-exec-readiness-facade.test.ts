import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const native = vi.hoisted(() => ({
    spawn: vi.fn(), exists: vi.fn(), stat: vi.fn(), lstat: vi.fn(), read: vi.fn(), write: vi.fn(),
    realpath: vi.fn(), mkdir: vi.fn(), open: vi.fn(), fstat: vi.fn(), close: vi.fn(), rm: vi.fn(),
    chmod: vi.fn(), readdir: vi.fn(), unlink: vi.fn(), rename: vi.fn(), readSync: vi.fn(),
    root: process.platform === "win32" ? "C:\\ccc-exec-readiness-fixture" : "/ccc-exec-readiness-fixture",
}));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn,
}));
vi.mock("fs", async original => ({
    ...await original<typeof import("node:fs")>(),
    existsSync: native.exists, statSync: native.stat, lstatSync: native.lstat,
    readFileSync: (selected: unknown, ...args: unknown[]) => {
        // The real device-lab module reads only this owned manifest during import.
        if (selected instanceof URL && selected.href === new URL("../../../packages/device-lab/package.json", import.meta.url).href) {
            return JSON.stringify({ version: "0.0.0-fixture" });
        }
        return native.read(selected, ...args);
    },
    writeFileSync: native.write, realpathSync: native.realpath,
    mkdirSync: native.mkdir, openSync: native.open, fstatSync: native.fstat,
    closeSync: native.close, rmSync: native.rm, chmodSync: native.chmod,
    readdirSync: native.readdir, unlinkSync: native.unlink, renameSync: native.rename,
    readSync: native.readSync,
}));
vi.mock("os", async original => ({
    ...await original<typeof import("node:os")>(),
    homedir: () => `${native.root}${process.platform === "win32" ? "\\" : "/"}home`,
}));

function fixturePaths(host: typeof path, root: string) {
    const contains = (parent: string, selected: string) => {
        const relative = host.relative(parent, selected);
        return host.isAbsolute(selected) && !host.isAbsolute(relative)
            && relative !== ".." && !relative.startsWith(`..${host.sep}`);
    };
    return {
        root, home: host.join(root, "home"), project: host.join(root, "project"), contains,
        hostMarker: (selected: string) => host.basename(selected),
        guestMarker: (selected: string) => path.posix.basename(selected),
        mount(value: string) {
            const match = value.match(/^(.*):(\/[^:]+)(?::ro)?$/)!;
            return { Source: match[1], Destination: match[2], Type: host.isAbsolute(match[1]) ? "bind" : "volume", RW: !value.endsWith(":ro") };
        },
    };
}
const fixtureHost = fixturePaths(path, native.root);
const ownedSource = fileURLToPath(new URL("../../", import.meta.url));
const unavailablePowerShell = path.win32.join("\\\\?\\GLOBALROOT\\SystemRoot\\System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function fakePath(selected: string): string {
    if (selected === unavailablePowerShell) throw Object.assign(new Error("unavailable fixture process identity"), { code: "ENOENT" });
    expect(fixtureHost.contains(native.root, selected) || fixtureHost.contains(ownedSource, selected)
        || /^\/proc\/(?:\d+\/(?:stat|cmdline)|sys\/kernel\/random\/boot_id)$/.test(selected)).toBe(true);
    return selected;
}

// Public Docker, native composition, lifecycle/readiness applications and runtime stay real.
const docker = await import("../../docker.js");
const runtime = await import("../../container-runtime.js");
const containerIdentity = await import("../../container-identity.js");
const id = "a".repeat(64);
const baseImageId = `sha256:${"b".repeat(64)}`;
const identityImageId = `sha256:${"c".repeat(64)}`;
const project = fixtureHost.project;
type Path = "running" | "restart" | "deferred";
const NativeSharedArrayBuffer = globalThis.SharedArrayBuffer;

function result(status = 0, stdout = ""): SpawnSyncReturns<string> {
    return { status, stdout, stderr: "", pid: 1, output: [], signal: null };
}
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected exception");
}

function fixture(lifecyclePath: Path, outcomes = [false, false, true], guarded = true) {
    const trace: string[] = [];
    const waits: Array<[unknown, number, number | bigint, number]> = [];
    const state = {
        existing: false, running: true, deferred: false, armed: false, active: false,
        now: 0, probes: 0, clocks: 0, sleeps: 0, probeDuration: 10,
        failureStep: "", failure: undefined as unknown,
        afterProbe: undefined as undefined | (() => void),
        runArgs: [] as string[],
    };
    const visit = (step: string, entry: string) => {
        trace.push(entry);
        if (state.failureStep === step) throw state.failure;
    };
    runtime._setRuntimeInfoForTest({ runtime: "docker", flavor: "docker-native", remote: false, dockerDesktop: false });
    const identity = containerIdentity.resolveContainerIdentity();
    const identityLabels = { ...containerIdentity.getIdentityLabels(identity), "ccc.identity.base": baseImageId };
    native.exists.mockImplementation((selected: string) => { if (selected !== "/dev/kvm") fakePath(selected); return false; });
    native.realpath.mockImplementation(fakePath);
    const stat = (selected: string) => { fakePath(selected); return ({
        isSymbolicLink: () => false,
        isDirectory: () => !selected.endsWith(".json") && !selected.includes(".guard"),
        isFile: () => selected.endsWith(".json") || selected.includes(".guard"),
        dev: 1, ino: 1, size: 16, gid: 100, mode: 0o100600, nlink: 1,
    }); };
    native.lstat.mockImplementation(stat);
    native.stat.mockImplementation(stat);
    native.fstat.mockImplementation(() => stat(path.join(native.root, "owner.json")));
    native.read.mockImplementation((selected: string, encoding) => { fakePath(selected); return encoding ? "fixture" : Buffer.from("fixture"); });
    native.readdir.mockReturnValue([]);
    native.readSync.mockReturnValue(0);
    const markers = new Map<string, string>();
    native.write.mockImplementation((selected: string | number, content: string) => {
        if (typeof selected === "string") markers.set(fixtureHost.hostMarker(fakePath(selected)), content);
    });
    native.open.mockReturnValue(1);
    vi.spyOn(Date, "now").mockImplementation(function (this: unknown) {
        expect(this).toBe(Date);
        if (state.active) visit(`clock:${++state.clocks}`, `now:${state.now}`);
        return state.now;
    });
    vi.spyOn(Atomics, "wait").mockImplementation(function (this: unknown, sleeper, index, value, timeout) {
        expect(this).toBe(Atomics);
        if (state.active) {
            waits.push([sleeper, index, value, timeout!]);
            visit(`sleep:${++state.sleeps}`, `sleep:${timeout}`);
            state.now += timeout!;
        }
        return "timed-out";
    });
    vi.stubGlobal("SharedArrayBuffer", new Proxy(NativeSharedArrayBuffer, {
        construct(constructor, args) {
            if (state.active) visit("allocation", `allocate:${args[0]}`);
            return Reflect.construct(constructor, args);
        },
    }));
    native.spawn.mockImplementation((_cli, args: string[], options?: { encoding?: string | null; timeout?: number }) => {
        if (args[0] === "images") return result(0, "image-id");
        if (args[0] === "image" && args[1] === "inspect") {
            expect(args[2]).toMatch(/^ccc-identity:[a-f0-9]{64}$/);
            return result(0, JSON.stringify([{ Id: identityImageId, Config: { User: "ccc", Labels: identityLabels } }]));
        }
        if (args[0] === "inspect" && args.includes("{{.Id}}")) return result(0, baseImageId);
        if (args[0] === "run" && args[1] === "--rm") {
            if (args.at(-1) === 'set -eu; printf "%s:%s" "$(id -u ccc)" "$(id -g ccc)"') {
                expect(args.slice(0, 9)).toEqual(["run", "--rm", "--network", "none", "--user", "root", "--entrypoint", "/bin/sh", identityImageId]);
                return result(0, `${identity.uid}:${identity.gid}`);
            }
            expect(args.slice(0, 9)).toEqual(["run", "--rm", "--network", "none", "--user", "ccc", "--entrypoint", "/bin/sh", identityImageId]);
            return result(0, `${identity.uid}:${identity.gid}:/home/ccc:ccc`);
        }
        if (args[0] === "run") { state.runArgs = [...args]; return result(0, id); }
        if (args[0] === "start") { state.running = true; state.active = state.armed; return result(); }
        if (args[0] === "ps" && args[1] === "-aq") return result(0, state.existing ? id : "");
        if (args[0] === "ps" && args[1] === "-q") {
            state.active = state.armed && state.running;
            return result(0, state.existing && state.running ? id : "");
        }
        if (args[0] === "inspect" && args.includes("{{.State.Running}}")) return result(0, String(state.existing && state.running));
        if (args[0] === "inspect" && args.includes("{{.Id}}|{{.State.Running}}")) return result(0, `${id}|${state.running}`);
        if (args[0] === "inspect" && args.includes("{{.Id}}|{{.State.Running}}|{{.Image}}")) return result(0, `${id}|${state.running}|${identityImageId}`);
        if (args[0] === "inspect" && args.includes("{{json .}}")) {
            const mounts: Array<{ Source: string; Destination: string; Type: string; RW: boolean }> = [];
            const labels: Record<string, string> = {};
            const env: string[] = [];
            for (let index = 0; index < state.runArgs.length; index++) {
                const argument = state.runArgs[index];
                const value = state.runArgs[index + 1];
                if (argument === "-v") {
                    mounts.push(fixtureHost.mount(value));
                }
                if (argument === "--tmpfs") mounts.push({ Source: "", Destination: value.split(":")[0], Type: "tmpfs", RW: true });
                if (argument === "--label") labels[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
                if (argument === "-e") env.push(value);
            }
            return result(0, JSON.stringify({ Id: id, Image: identityImageId, State: { Running: state.running }, Mounts: mounts, Config: { Labels: labels, Env: env, User: "ccc" }, HostConfig: { Init: !state.deferred, Devices: [], DeviceRequests: [], GroupAdd: [], Privileged: false } }));
        }
        if (args[0] === "exec" && args[1] === id && args[2] === "sh" && args[4]?.includes('$(id -un)')) {
            return result(0, `${identity.uid}:${identity.gid}:ccc:/home/ccc`);
        }
        if (args.length === 3 && args[0] === "exec" && args[1] === id && args[2] === "true") {
            if (!guarded) { state.active = false; trace.push(`default-probe:${options?.timeout}`); return result(); }
            const attempt = ++state.probes;
            visit(`probe:${attempt}`, `probe:${args[1]}:${options?.timeout}`);
            state.now += state.probeDuration;
            state.afterProbe?.();
            return result(outcomes[attempt - 1] && state.probeDuration <= options!.timeout! ? 0 : 1);
        }
        // Successful readiness proceeds to synchronization/proofs, outside the retry trace.
        if (state.active && state.probes > 0 && outcomes[state.probes - 1]) state.active = false;
        if (args[0] === "exec" && args[2] === "cat") {
            if (options?.encoding === null) return { ...result(), stdout: Buffer.from("fixture") };
            return result(0, markers.get(fixtureHost.guestMarker(args[3])) ?? "");
        }
        return result();
    });
    // The setup call produces authentic managed mounts, labels and environment.
    docker.startProjectContainer(project, () => {});
    state.existing = true;
    state.running = lifecyclePath !== "restart";
    state.deferred = lifecyclePath === "deferred";
    state.armed = true;
    state.now = 0;
    trace.length = 0;
    native.spawn.mockClear();
    native.rename.mockClear();
    const guard = vi.fn(() => false);
    const ready = vi.fn();
    const start = () => docker.startProjectContainer(project, () => {}, undefined, undefined, undefined, undefined, guarded ? guard : undefined, ready);
    return { state, trace, waits, guard, ready, start };
}

function assertPreserved() {
    expect(native.spawn.mock.calls.filter(call => ["stop", "rm"].includes(call[1][0])
        || (call[1][0] === "run" && call[1][1] !== "--rm"))).toEqual([]);
}
const successTrace = ["allocate:4", "now:0", "now:0", `probe:${id}:5000`, "now:10", "sleep:75", "now:85", `probe:${id}:5000`, "now:95", "sleep:75", "now:170", `probe:${id}:5000`];
// Fresh inspection and live mount proof each allocate their bounded retry
// session only after readiness succeeds; exhaustion retains its original trace.
const liveProofTrace = ["allocate:4", "allocate:4"];
const failureTrace = [...successTrace, "now:180"];

function assertStartupLockFinalized() {
    // The public entrypoint now owns the host-wide startup lock. Its release
    // runs after readiness (including throws) and reads Date.now for the bounded
    // rename. Keep that native cleanup separate from the retry policy trace.
    const releases = native.rename.mock.calls.filter(call => path.basename(call[0]) === "codex-state.lock");
    expect(releases).toHaveLength(1);
    expect(releases[0][1]).toMatch(/codex-state\.lock\.[a-f0-9]{16}\.release$/);
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("DEBUG", ""); vi.stubEnv("SSH_AUTH_SOCK", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); runtime._resetRuntimeCacheForTest(); });

describe("public startProjectContainer through real exec readiness", () => {
    it.each([
        { host: path.posix, root: "/fake", project: "/fake/project", marker: "/fake/project/.ccc-marker" },
        { host: path.win32, root: "C:\\fake", project: "C:\\fake\\project", marker: "C:\\fake\\project\\.ccc-marker" },
    ])("uses fixture host transformations for $root and POSIX guest marker lookup", example => {
        const host = fixturePaths(example.host, example.root);
        expect(host.project).toBe(example.project);
        expect(example.host.isAbsolute(host.home)).toBe(true);
        expect(host.contains(host.root, host.project)).toBe(true);
        expect(host.contains(host.root, `${host.root}-outside${example.host.sep}project`)).toBe(false);
        expect(host.mount(`${host.project}:/project/selected:ro`)).toEqual({ Source: host.project, Destination: "/project/selected", Type: "bind", RW: false });
        expect(host.mount("ccc-volume:/home/ccc/data").Type).toBe("volume");
        const stored = new Map([[host.hostMarker(example.marker), "challenge"]]);
        expect(stored.get(host.guestMarker("/project/selected/.ccc-marker"))).toBe("challenge");
    });
    it.each(["running", "restart", "deferred"] as const)("retries and joins the selected ID on guarded %s", path => {
        const f = fixture(path);
        expect(f.start()).toBe(docker.getContainerName(project));
        expect(f.ready).toHaveBeenCalledExactlyOnceWith(id, { startedByInvocation: path === "restart" });
        expect(f.trace).toEqual(path === "deferred" ? successTrace : [...successTrace, ...liveProofTrace]);
        const probes = native.spawn.mock.calls.filter(call => call[1].length === 3 && call[1][0] === "exec" && call[1][2] === "true");
        expect(probes.map(call => call.slice(0, 3))).toEqual(Array.from({ length: 3 }, () => ["docker", ["exec", id, "true"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 }]));
        expect(f.waits).toHaveLength(2);
        expect(f.waits[0][0]).toBeInstanceOf(Int32Array);
        expect((f.waits[0][0] as Int32Array).byteLength).toBe(4);
        expect(f.waits[1][0]).toBe(f.waits[0][0]);
        expect(f.waits.map(wait => wait.slice(1))).toEqual([[0, 0, 75], [0, 0, 75]]);
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "start").map(call => call[1])).toEqual(path === "restart" ? [["start", id]] : []);
        expect(f.guard).toHaveBeenCalledTimes(path === "deferred" ? 1 : 0);
        assertPreserved();
    });

    it.each(["running", "restart", "deferred"] as const)("preserves %s after exhaustion with no join or destructive fallback", path => {
        const f = fixture(path, [false, false, false]);
        expect(() => f.start()).toThrow(path === "restart" ? "Restarted container is unavailable" : "automatic destructive recovery was refused");
        expect(f.trace).toEqual([...failureTrace, "now:180"]);
        assertStartupLockFinalized();
        expect(f.ready).not.toHaveBeenCalled();
        expect(f.guard).toHaveBeenCalledTimes(path === "restart" ? 0 : 1);
        assertPreserved();
    });

    it.each([250, 5000])("joins a healthy guarded container whose exec takes %i ms", duration => {
        const f = fixture("running", [true]);
        f.state.probeDuration = duration;
        expect(f.start()).toBe(docker.getContainerName(project));
        expect(f.trace).toEqual(["allocate:4", "now:0", "now:0", `probe:${id}:5000`, ...liveProofTrace]);
        expect(f.state.now).toBe(duration);
        expect(f.state.probes).toBe(1);
        expect(f.waits).toEqual([]);
        expect(f.ready).toHaveBeenCalledExactlyOnceWith(id, { startedByInvocation: false });
        expect(f.guard).not.toHaveBeenCalled();
        assertPreserved();
    });

    it("uses one default native probe without brief clocks or sleep on an unguarded running container", () => {
        const f = fixture("running", [true], false);
        expect(f.start()).toBe(docker.getContainerName(project));
        expect(f.ready).toHaveBeenCalledExactlyOnceWith(id, { startedByInvocation: false });
        expect(f.trace).toEqual(["default-probe:5000"]);
        expect(f.waits).toEqual([]);
        assertPreserved();
    });
});

describe("native retry failure identity and late effects", () => {
    const stages = ["allocation", "clock:1", "clock:2", "probe:1", "clock:3", "sleep:1", "clock:4", "probe:2", "clock:5", "sleep:2", "clock:6", "probe:3", "clock:7"];
    const failureTimes = [0, 0, 0, 0, 10, 10, 85, 85, 95, 95, 170, 170, 180];
    it.each(stages)("preserves Error/non-Error at %s without later retry or destructive effects", stage => {
        for (const failure of [new Error(stage), { stage }]) {
            const f = fixture("running", [false, false, false]);
            f.state.failureStep = stage; f.state.failure = failure;
            expect(thrown(f.start)).toBe(failure);
            const index = stages.indexOf(stage);
            expect(f.trace).toEqual([...failureTrace.slice(0, index + 1), `now:${failureTimes[index]}`]);
            assertStartupLockFinalized();
            expect(f.ready).not.toHaveBeenCalled();
            expect(f.guard).not.toHaveBeenCalled();
            assertPreserved();
        }
    });

    it("looks up Date.now and Atomics.wait late with their native receivers", () => {
        const f = fixture("running", [false, true]);
        const replacements: string[] = [];
        f.state.afterProbe = () => {
            Date.now = function (this: unknown) { expect(this).toBe(Date); replacements.push("now"); f.trace.push(`now:${f.state.now}`); return f.state.now; };
            Atomics.wait = function (this: unknown, _sleeper, index, value, timeout) {
                expect(this).toBe(Atomics); expect([index, value, timeout]).toEqual([0, 0, 75]);
                replacements.push("wait"); f.trace.push(`sleep:${timeout}`); f.state.now += timeout!;
                return "timed-out";
            };
            f.state.afterProbe = undefined;
        };
        expect(f.start()).toBe(docker.getContainerName(project));
        expect(f.trace).toEqual([...successTrace.slice(0, 8), ...liveProofTrace, "now:95"]);
        assertStartupLockFinalized();
        expect(replacements.slice(0, 3)).toEqual(["now", "wait", "now"]);
        assertPreserved();
    });

    it.each(["Promise", "thenable"])("ignores hostile %s Atomics.wait results through the public caller", kind => {
        const f = fixture("running");
        const accesses: string[] = [];
        const ignored = kind === "Promise" ? Promise.resolve("ignored") : {};
        Object.defineProperty(ignored, "then", { get() { accesses.push("then"); throw new Error("must not inspect wait result"); } });
        // Plain replacement keeps Vitest's Promise return tracking outside this assertion.
        Atomics.wait = (function (this: unknown, _sleeper: Int32Array, index: number, value: number, timeout: number) {
            expect(this).toBe(Atomics); expect([index, value]).toEqual([0, 0]);
            f.trace.push(`sleep:${timeout}`); f.state.now += timeout;
            return ignored;
        }) as unknown as typeof Atomics.wait;
        expect(f.start()).toBe(docker.getContainerName(project));
        expect(f.trace).toEqual([...successTrace, ...liveProofTrace]);
        expect(accesses).toEqual([]);
        expect(f.ready).toHaveBeenCalledExactlyOnceWith(id, { startedByInvocation: false });
        assertPreserved();
    });
});
