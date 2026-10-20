import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeContainerDestructiveLifecycle } from "../../composition/container-destructive-lifecycle.js";
import {
    bindMountSourceIdentityDigest, captureBindMountSourceIdentity,
    getContainerName, removeProjectContainer, stopProjectContainer,
} from "../../docker.js";
import { getProjectId } from "../../utils.js";

const native = vi.hoisted(() => ({
    spawn: vi.fn(), runtime: vi.fn(), cleanup: vi.fn(), claims: vi.fn(), lock: vi.fn(),
    order: [] as string[],
}));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: (...args: unknown[]) => native.spawn(...logicalNativeCall(args)),
}));
vi.mock("../../container-runtime.js", async original => {
    const actual = await original<typeof import("../../container-runtime.js")>();
    const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../../ports/container-runtime-invocation.js");
    const invocation = () => {
        const current = actual.currentNativeRuntimeInvocation();
        if (current) return current;
        const runtime = native.runtime();
        return actual.validateNativeRuntimeInvocation({
            version: 1, runtime, executable: `/fixture/runtime/${runtime}`,
            transport: runtime === "docker"
                ? { kind: "docker", host: "unix:///fixture/engine-a.sock", configDirectory: "/fixture/config",
                    tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } }
                : { kind: "podman-local", graphRoot: "/fixture/storage", runRoot: "/fixture/run",
                    storageDriver: "overlay", storageOptions: [], transientStore: false },
            selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
        });
    };
    return { ...actual, runtimeCli: native.runtime, getRuntimeInvocation: invocation,
        getRuntimeInfo: () => ({runtime: "docker", flavor: "docker-native", rootless: false, remote: false, dockerDesktop: false}),
        runtimeSpawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) =>
            actual.bindNativeRuntimeInvocation(invocation()).spawnSync(args, options) };
});

function logicalNativeCall(call: unknown[]): unknown[] {
    const [program, args, options] = call;
    if (program !== "/fixture/runtime/docker" && program !== "/fixture/runtime/podman") return call;
    const runtime = program.endsWith("/docker") ? "docker" : "podman";
    const prefix = runtime === "docker"
        ? ["--config", "/fixture/config", "--host", "unix:///fixture/engine-a.sock", "--tls=false", "--tlscacert=", "--tlscert=", "--tlskey="]
        : ["--remote=false", "--root", "/fixture/storage", "--runroot", "/fixture/run", "--storage-driver", "overlay", "--transient-store=false"];
    expect((args as string[]).slice(0, prefix.length)).toEqual(prefix);
    const {env, shell, ...logicalOptions} = options as import("child_process").SpawnSyncOptions;
    expect(shell).toBe(false);
    expect(env?.DOCKER_CONTEXT).toBeUndefined();
    return [runtime, (args as string[]).slice(prefix.length), logicalOptions];
}
vi.mock("../../device-lab-admin.js", () => ({ cleanupOwnerDevices: native.cleanup }));
vi.mock("../../session.js", () => ({
    getSessionLockClaimsForContainer: native.claims,
    withContainerLifecycleLock: native.lock,
    withProjectFamilyLifecycleLock: vi.fn(),
}));

const id = "a".repeat(64);
const fixtureStopping = 'log:Stopping container "fixture-container" for workspace "/full/project"...';
const fixtureRemoving = 'log:Removing container "fixture-container" for workspace "/full/project"...';
type SuppliedPorts = Parameters<typeof createNativeContainerDestructiveLifecycle>[0];

function fixture(overrides: Partial<SuppliedPorts> = {}) {
    const order: string[] = [];
    const ports: SuppliedPorts = {
        resolvePath: path => { order.push(`resolve:${path}`); return "/full/project"; },
        projectId: path => { order.push(`project:${path}`); return "project-id"; },
        containerName: (path, profile) => { order.push(`name:${path}:${String(profile)}`); return "fixture-container"; },
        withLifecycleLock: (prefix, callback) => {
            order.push(`lock:${prefix}`);
            try { return callback(); } finally { order.push("unlock"); }
        },
        sessionClaims: prefix => { order.push(`claims:${prefix}`); return []; },
        ensureRuntime: () => { order.push("runtime-ready"); },
        managedIdentity: (name, path) => {
            order.push(`identity:${name}:${path}`); return { containerId: id, running: true };
        },
        cleanupDevices: (path, timeout, profile) => {
            order.push(`cleanup:${path}:${timeout}:${String(profile)}`);
            return { kind: "observed", stopped: 0, skipped: 0, failed: 0 };
        },
        ...overrides,
    };
    return { order, ports, lifecycle: createNativeContainerDestructiveLifecycle(ports) };
}

beforeEach(() => {
    vi.resetAllMocks(); native.order.length = 0;
    native.runtime.mockReturnValue("docker");
    native.spawn.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    native.claims.mockReturnValue([]);
    native.lock.mockImplementation((prefix: string, callback: () => unknown) => {
        native.order.push(`lock:${prefix}`);
        try { return callback(); } finally { native.order.push("unlock"); }
    });
    native.cleanup.mockImplementation(() => { native.order.push("cleanup"); return { ownerId: "fixture-owner", results: [] }; });
    vi.spyOn(console, "log").mockImplementation(message => { native.order.push(`log:${message}`); });
    vi.spyOn(console, "error").mockImplementation(message => { native.order.push(`error:${message}`); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("native destructive lifecycle composition", () => {
    it("constructs without observing or selecting a runtime, executing a process, or reporting", () => {
        const f = fixture();
        expect(f.order).toEqual([]); expect(native.order).toEqual([]);
        expect(native.runtime).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
    });

    it("captures once before identity and retains the same native authority for exact-ID stop and plain rm", () => {
        native.runtime.mockReturnValueOnce("docker").mockReturnValueOnce("podman");
        const f = fixture(); expect(f.lifecycle.remove("input")).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual([
            ["docker", ["stop", id], { stdio: "inherit", timeout: 30000, killSignal: "SIGKILL" }],
            ["docker", ["rm", id], { stdio: "inherit", timeout: 30000, killSignal: "SIGKILL" }],
        ]);
        expect(native.runtime).toHaveBeenCalledTimes(1);
        expect(native.order).toEqual([fixtureStopping, "log:Container stopped", fixtureRemoving, "log:Container removed"]);
        expect(f.order).toEqual([
            "resolve:input", "project:/full/project", "lock:project-id", "claims:project-id", "runtime-ready",
            "name:/full/project:undefined", "identity:fixture-container:/full/project",
            "cleanup:/full/project:5000:undefined", "unlock",
        ]);
    });

    it("escapes the exact selected name and resolved workspace in stop and removal output", () => {
        const name = 'selected "container"\nwith control characters';
        const path = '/full/selected "workspace"\nwith control characters';
        const f = fixture({ resolvePath: () => path, containerName: () => name });
        f.lifecycle.remove("other-workspace", "work");
        expect(native.order).toEqual([
            `log:Stopping container ${JSON.stringify(name)} for workspace ${JSON.stringify(path)}...`,
            "log:Container stopped",
            `log:Removing container ${JSON.stringify(name)} for workspace ${JSON.stringify(path)}...`,
            "log:Container removed",
        ]);
        expect(native.order.every(message => !message.includes("\n"))).toBe(true);
    });

    it.each(["stop", "remove"] as const)("%s never dispatches or cleans without managed identity even forced", operation => {
        const cleanup = vi.fn<SuppliedPorts["cleanupDevices"]>();
        const f = fixture({ sessionClaims: () => ["claim"], managedIdentity: () => null, cleanupDevices: cleanup });
        f.lifecycle[operation]("input", undefined, { force: true });
        expect(cleanup).not.toHaveBeenCalled(); expect(native.runtime).toHaveBeenCalledTimes(1);
        expect(native.spawn).not.toHaveBeenCalled(); expect(console.log).toHaveBeenCalledExactlyOnceWith("Container not found");
    });

    it.each(["stop", "remove"] as const)("%s rejects raw claims with the guard workspace and close/retry guidance before effects", operation => {
        const f = fixture({ sessionClaims: () => ["stale", "live"] });
        let failure: unknown;
        try { f.lifecycle[operation]("input"); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('Container for workspace "/full/project" has 2 session ownership claim(s); close its other CCC sessions and retry.');
        expect(f.order).toEqual(["resolve:input", "project:/full/project", "lock:project-id", "unlock"]);
        expect(native.order).toEqual([]); expect(native.runtime).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
    });

    it.each(["stop", "remove"] as const)("%s bounds thrown cleanup warnings and continues without exposing helper errors", operation => {
        for (const failure of [new Error("device-cleanup"), "device-cleanup", null, undefined]) {
            native.order.length = 0;
            const f = fixture({ cleanupDevices: () => { throw failure; } });
            f.lifecycle[operation]("input");
            expect(native.order[0]).toBe("error:[ccc] device cleanup unavailable before container stop");
            expect(native.order.at(-1)).toBe(operation === "stop" ? "log:Container stopped" : "log:Container removed");
        }
    });

    it.each(["stop", "remove"] as const)("%s never stringifies a thrown cleanup object", operation => {
        const stringify = vi.fn(() => { throw new Error("must not stringify"); });
        const f = fixture({ cleanupDevices: () => { throw { toString: stringify }; } });
        expect(f.lifecycle[operation]("input")).toBeUndefined();
        expect(stringify).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledExactlyOnceWith("[ccc] device cleanup unavailable before container stop");
    });

    const failedResults = [undefined, null, 0, {}, [], { status: "0" }, { status: 1 }, { status: null },
        { status: 0, error: new Error("native-error") }, { status: 0, error: false }, { status: 0, signal: "SIGTERM" }];
    for (const operation of ["stop", "rm"] as const) {
        it.each(failedResults.map(result => ({ result })))(`retains ${operation} result failure and suppresses later dispatch/success: %j`, ({ result }) => {
            native.spawn.mockImplementation((_cli, args) => args[0] === operation ? result : { status: 0 });
            const f = fixture();
            expect(() => f.lifecycle.remove("input")).toThrow(operation === "stop" ? "Failed to stop container." : "Failed to remove container.");
            expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(operation === "stop" ? ["stop"] : ["stop", "rm"]);
            expect(native.order).toEqual(operation === "stop" ? [fixtureStopping] : [fixtureStopping, "log:Container stopped", fixtureRemoving]);
        });
        it(`propagates a thrown ${operation} subprocess error unchanged`, () => {
            const failure = new Error(`spawn-${operation}`);
            native.spawn.mockImplementation((_cli, args) => { if (args[0] === operation) throw failure; return { status: 0 }; });
            const f = fixture(); expect(() => f.lifecycle.remove("input")).toThrow(failure);
            expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(operation === "stop" ? ["stop"] : ["stop", "rm"]);
            expect(console.log).not.toHaveBeenCalledWith("Container removed");
        });
    }

    it.each(["stop", "remove"] as const)("%s propagates current runtime selection failure before subprocess dispatch", operation => {
        const failure = new Error("runtime-selection"); native.runtime.mockImplementation(() => { throw failure; });
        const f = fixture(); expect(() => f.lifecycle[operation]("input")).toThrow(failure);
        expect(native.spawn).not.toHaveBeenCalled(); expect(console.log).not.toHaveBeenCalled();
    });

    it("propagates presentation failure after stop without removal or rollback", () => {
        vi.mocked(console.log).mockImplementation(message => { if (message === "Container stopped") throw new Error("log-failed"); });
        const f = fixture(); expect(() => f.lifecycle.remove("input")).toThrow("log-failed");
        expect(native.spawn.mock.calls).toEqual([["docker", ["stop", id], { stdio: "inherit", timeout: 30000, killSignal: "SIGKILL" }]]);
    });
});

describe("public Docker destructive facade through actual application and composition", () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ccc-destructive-facade-")); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    function identity(running = true, managed = true) {
        return JSON.stringify({
            Id: id, State: { Running: running }, Config: { Labels: {
                "ccc.managed": String(managed), "ccc.project.path": resolve(root),
                "ccc.project.mount-identity": bindMountSourceIdentityDigest(captureBindMountSourceIdentity(root)),
            } },
        });
    }
    function provider(running = true, managed = true) {
        native.spawn.mockImplementation((_cli, args) => {
            native.order.push(`native:${args[0]}`);
            if (args[0] === "inspect") expect(args).toEqual(["inspect", "-f", "{{json .}}", id]);
            return { status: 0, stdout: args[0] === "ps" ? id : args[0] === "inspect" ? identity(running, managed) : "", stderr: "" };
        });
        native.claims.mockImplementation(prefix => { native.order.push(`claims:${prefix}`); return []; });
    }

    it.each(["stop", "remove"] as const)("%s retains public default options, lock scope and void result", operation => {
        provider();
        const execute = operation === "stop" ? stopProjectContainer : removeProjectContainer;
        expect(execute(root)).toBeUndefined();
        const prefix = getProjectId(root);
        const selectedName = getContainerName(resolve(root));
        expect(native.order).toEqual([
            `lock:${prefix}`, `claims:${prefix}`, "native:info", "native:ps", "native:inspect", "cleanup",
            `log:Stopping container ${JSON.stringify(selectedName)} for workspace ${JSON.stringify(resolve(root))}...`, "native:stop", "log:Container stopped",
            ...(operation === "remove" ? [`log:Removing container ${JSON.stringify(selectedName)} for workspace ${JSON.stringify(resolve(root))}...`, "native:rm", "log:Container removed"] : []), "unlock",
        ]);
        expect(native.cleanup).toHaveBeenCalledExactlyOnceWith(resolve(root), 5000, undefined);
        expect(native.spawn.mock.calls.filter(call => ["stop", "rm"].includes(call[1][0]))).toEqual([
            ["docker", ["stop", id], { stdio: "inherit", timeout: 30000, killSignal: "SIGKILL" }],
            ...(operation === "remove" ? [["docker", ["rm", id], { stdio: "inherit", timeout: 30000, killSignal: "SIGKILL" }]] : []),
        ]);
    });

    it.each(["stop", "remove"] as const)("%s preserves raw-claim refusal and explicit force under profile lock", operation => {
        provider(); native.claims.mockReturnValue(["raw-claim"]);
        const execute = operation === "stop" ? stopProjectContainer : removeProjectContainer;
        expect(() => execute(root, "work")).toThrow(`Container for workspace ${JSON.stringify(resolve(root))} has 1 session ownership claim(s); close its other CCC sessions and retry.`);
        expect(native.spawn).not.toHaveBeenCalled(); expect(native.cleanup).not.toHaveBeenCalled();
        expect(native.lock).toHaveBeenCalledWith(`${getProjectId(root)}--p--work`, expect.any(Function));
        expect(execute(root, "work", { force: true })).toBeUndefined();
        expect(native.cleanup).toHaveBeenCalledExactlyOnceWith(resolve(root), 5000, "work");
    });

    it.each(["stop", "remove"] as const)("%s refuses foreign managed proof even under force", operation => {
        provider(true, false);
        const execute = operation === "stop" ? stopProjectContainer : removeProjectContainer;
        expect(() => execute(root, undefined, { force: true })).toThrow("ownership could not be verified");
        expect(native.cleanup).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(["info", "ps", "inspect"]);
        expect(console.log).not.toHaveBeenCalledWith("Container not found");
    });

    it.each(["stop", "remove"] as const)("regression: %s warns for returned failed cleanup rows and still dispatches the authorized action", operation => {
        provider();
        let outcome: unknown;
        native.lock.mockImplementation((_prefix: string, callback: () => unknown) => {
            const result = callback(); outcome = result; return result;
        });
        native.cleanup.mockReturnValue({ ownerId: "fixture-owner", results: [
            { id: "one", backend: "fixture", previousStatus: "running", status: "stopped", commands: [] },
            { id: "two", backend: "fixture", previousStatus: "attached", status: "skipped", commands: [] },
            { id: "three", backend: "fixture", previousStatus: "running", status: "failed", reason: "/private/helper-secret",
                commands: [{ command: "secret command", status: 1, stdout: "private stdout", stderr: "private stderr" }] },
        ] });
        const execute = operation === "stop" ? stopProjectContainer : removeProjectContainer;
        expect(execute(root)).toBeUndefined();
        // The public facade and raw report inputs predate the new outcome ABI.
        expect(console.error).toHaveBeenCalledExactlyOnceWith("[ccc] device cleanup incomplete before container stop: 1 failed");
        const effects = native.spawn.mock.calls.map(call => call[1]).filter(args => ["stop", "rm"].includes(args[0]));
        expect(effects).toEqual(operation === "stop" ? [["stop", id]] : [["stop", id], ["rm", id]]);
        expect(native.order.indexOf("error:[ccc] device cleanup incomplete before container stop: 1 failed"))
            .toBeLessThan(native.order.indexOf("native:stop"));
        expect(native.order.join("\n")).not.toMatch(/helper-secret|secret command|private stdout|private stderr/);
        expect(outcome).toEqual({ kind: "failed", reason: "device-cleanup-incomplete", evidence: {
            target: { containerId: id, running: true }, cleanup: { kind: "observed", stopped: 1, skipped: 1, failed: 1 },
            stop: "completed", removal: operation === "remove" ? "completed" : "not-run",
        } });
    });

    it("preserves bounded unavailable cleanup warning and already stopped remove behavior", () => {
        provider(false); native.cleanup.mockImplementation(() => { throw new Error("cleanup-failed"); });
        expect(removeProjectContainer(root)).toBeUndefined();
        expect(console.error).toHaveBeenCalledExactlyOnceWith("[ccc] device cleanup unavailable before container stop");
        expect(console.log).not.toHaveBeenCalledWith("Container stopped");
        expect(native.spawn.mock.calls.filter(call => ["stop", "rm"].includes(call[1][0]))).toEqual([["docker", ["rm", id], { stdio: "inherit", timeout: 30000, killSignal: "SIGKILL" }]]);
    });
});

describe("emitted native destructive composition", () => {
    it("accepts incomplete cleanup with a bounded warning and refuses uncertain native commands", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-destructive-emitted-"));
        const repository = fileURLToPath(new URL("../../../", import.meta.url));
        try {
            const program = `
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const calls = [], messages = [], outcomes = [];
const id = 'a'.repeat(64), executable = '/fixture/destructive-runtime';
let refusal = null;
// Fence every process leaf before the emitted graph imports child_process.
for (const leaf of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) {
  cp[leaf] = () => { throw new Error('unexpected process leaf: ' + leaf); };
}
cp.spawnSync = (command, argv, options) => {
  assert.equal(command, executable);
  const prefix = ['--config','/fixture/config','--host','unix:///fixture/engine.sock','--tls=false','--tlscacert=','--tlscert=','--tlskey='];
  assert.deepEqual(argv.slice(0,prefix.length), prefix);
  const args = argv.slice(prefix.length);
  assert.ok(args[0] === 'stop' || args[0] === 'rm');
  assert.deepEqual(args, [args[0],id]);
  assert.equal(options.shell,false); assert.equal(options.stdio,'inherit');
  assert.equal(options.timeout,30000); assert.equal(options.killSignal,'SIGKILL');
  calls.push(args);
  return args[0] === refusal ? {status:0,signal:'SIGTERM'} : {status:0,signal:null,error:undefined};
};
syncBuiltinESMExports();
console.log = message => messages.push(['log',message]);
console.error = message => messages.push(['error',message]);
const { _setRuntimeInvocationForTest } = await import(${JSON.stringify(resolve(repository, "dist/container-runtime.js"))});
const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import(${JSON.stringify(resolve(repository, "dist/ports/container-runtime-invocation.js"))});
_setRuntimeInvocationForTest({version:1,runtime:'docker',executable,
  transport:{kind:'docker',host:'unix:///fixture/engine.sock',configDirectory:'/fixture/config',
    tls:{enabled:false,verify:false,caFile:null,certFile:null,keyFile:null}},
  selectors:Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key,null]))});
const {createNativeContainerDestructiveLifecycle} = await import(${JSON.stringify(resolve(repository, "dist/composition/container-destructive-lifecycle.js"))});
const cleanup = {kind:'observed',stopped:1,skipped:2,failed:1};
const lifecycle = createNativeContainerDestructiveLifecycle({
  resolvePath: () => '/fixture/project', projectId: () => 'fixture-project', containerName: () => 'fixture-container',
  withLifecycleLock: (_prefix, callback) => {const result = callback(); outcomes.push(result); return result;},
  sessionClaims: () => [], ensureRuntime: () => undefined,
  managedIdentity: () => ({containerId:id,running:true}), cleanupDevices: () => cleanup,
});
assert.equal(lifecycle.remove('input'),undefined);
assert.deepEqual(calls,[['stop',id],['rm',id]]);
assert.deepEqual(outcomes.pop(),{kind:'failed',reason:'device-cleanup-incomplete',evidence:{
  target:{containerId:id,running:true},cleanup,stop:'completed',removal:'completed'}});
assert.deepEqual(messages.filter(row => row[0] === 'error'),[['error','[ccc] device cleanup incomplete before container stop: 1 failed']]);
assert.equal(messages.at(-1)[1],'Container removed');
for (const command of ['stop','rm']) {
  calls.length = 0; messages.length = 0; refusal = command;
  assert.throws(() => lifecycle.remove('input'), error => {
    assert.equal(error.message,command === 'stop' ? 'Failed to stop container.' : 'Failed to remove container.');
    assert.equal(error.cause,undefined); return true;
  });
  assert.deepEqual(calls,command === 'stop' ? [['stop',id]] : [['stop',id],['rm',id]]);
  assert.deepEqual(outcomes.pop(),{kind:'indeterminate',reason:command === 'stop' ? 'container-stop-unconfirmed' : 'container-remove-unconfirmed',evidence:{
    target:{containerId:id,running:true},cleanup,stop:command === 'stop' ? 'unconfirmed' : 'completed',removal:command === 'stop' ? 'not-run' : 'unconfirmed'}});
  assert.ok(!messages.some(row => row[1] === 'Container removed'));
  assert.equal(messages.some(row => row[1] === 'Container stopped'),command === 'rm');
}
process.stdout.write('emitted destructive outcomes verified');
`;
            expect(execFileSync(process.execPath, ["--input-type=module", "--eval", program], {
                cwd: root, encoding: "utf8", timeout: 10_000,
                env: { ...process.env, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root,
                    CCC_HOME: undefined, CCC_PROFILE: undefined },
            })).toBe("emitted destructive outcomes verified");
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
