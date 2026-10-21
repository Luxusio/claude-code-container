import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncReturns } from "child_process";
import { createNativeContainerCreateLifecycle } from "../../composition/container-create-lifecycle.js";
import { createNativeContainerCreatePorts } from "../../adapters/container-create-lifecycle.js";
import type { NativeContainerCreateLifecycleContext } from "../../composition/container-create-lifecycle.js";
import type { ContainerCreateLifecyclePorts } from "../../ports/container-create-lifecycle.js";
import {isAbsolute, resolve} from "node:path";

const native = vi.hoisted(() => ({
    bindGuard: Object.freeze({ root: "/fixture/home/.ccc" }) as import("../../ports/runtime-bind-authority.js").RuntimeBindGuard,
    creationTicket: Object.freeze({}) as import("../../ports/runtime-bind-authority.js").RuntimeBindCreationTicket,
    authorityEvents: [] as string[],
    authorityHeld: false,
    retainedAuthority: undefined as import("../../ports/runtime-bind-authority.js").RuntimeBindAuthorityFacts | undefined,
    spawn: vi.fn(), runtime: vi.fn(), remote: vi.fn(), family: vi.fn(),
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
            expect(resolve(typeof root === "string" ? root : root.root)).toBe(resolve(native.bindGuard.root));
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
    ...await original<typeof import("node:os")>(), homedir: () => "/fixture/home",
}));
vi.mock("../../container-runtime.js", async original => {
    const actual = await original<typeof import("../../container-runtime.js")>();
    const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../../ports/container-runtime-invocation.js");
    const invocation = actual.validateNativeRuntimeInvocation({
        version: 1, runtime: "docker", executable: "/fixture/runtime/docker",
        transport: { kind: "docker", host: "unix:///fixture/engine.sock", configDirectory: "/fixture/config",
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
    });
    const runner = () => { const capturedCli = "captured-runtime"; return { invocation,
        spawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => native.spawn(capturedCli, args, options),
    }; };
    return { ...actual, runtimeCli: native.runtime,
    isContainerHostRemote: native.remote,
    getRuntimeInfo: () => ({ runtime: "docker", dockerDesktop: false, socketPath: "/var/run/docker.sock" }),
    containerManagerSocketPath: () => "/var/run/docker.sock",
    containerManagerSocketMountArgs: () => ["-v", "/var/run/docker.sock:/var/run/docker.sock"],
    runtimeExtraRunArgs: () => [],
    bindMountArgs: (host: string, container: string, options?: { readonly?: boolean }) => ["-v", `${host}:${container}${options?.readonly ? ":ro" : ""}`],
        getRuntimeInvocation: () => invocation, bindNativeRuntimeInvocation: runner,
        runtimeSpawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => runner().spawnSync(args, options),
        runWithNativeRuntimeInvocation: <T>(_invocation: unknown, operation: () => T): T => operation() };
});
vi.mock("../../tool-registry.js", () => ({ getAllCredentialMounts: () => [] }));
vi.mock("../../device-lab-admin.js", () => ({ cleanupOwnerDevices: vi.fn() }));
vi.mock("../../session.js", () => ({
    getSessionLockClaimsForContainer: () => [],
    withContainerLifecycleLock: (_prefix: string, operation: () => unknown) => operation(),
    withProjectFamilyLifecycleLock: native.family,
}));
// Lock contention/native descriptor safety is covered by shared-mutation-lock.test.ts.
// This facade fixture owns fake host paths; bypass only the two startup lock namespaces.
vi.mock("@ccc/device-lab/device-lab-shared-state.js", async original => ({
    ...await original<typeof import("@ccc/device-lab/device-lab-shared-state.js")>(),
    withSharedMutationLock: (path: string, operation: () => unknown, options: { waitMs: number; reclaimStale?: boolean }) => {
        if (!/^\/fixture\/home\/\.ccc\/(?:codex-state\.lock|run\/locks\/identity-[a-f0-9]{64}\.lock)$/.test(path.replace(/\\/g, "/"))) throw new Error("unexpected fixture lock IO");
        expect(operation).toBeTypeOf("function");
        expect(options).toEqual({ waitMs: path.endsWith("codex-state.lock") ? 600_000 : 1_260_000, reclaimStale: false });
        return operation();
    },
}));

const id = "A".repeat(64);
const name = "fixture-container";
const request = { containerName: name, projectMountIdentity: "physical" };
const createOptions = { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"], timeout: 30000, killSignal: "SIGKILL" };
const cleanupOptions = { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, killSignal: "SIGKILL" };
type SuppliedPorts = Parameters<typeof createNativeContainerCreateLifecycle>[0];
const thrownValues = [["string", "native failure"], ["number", 7], ["boolean", false], ["null", null], ["undefined", undefined]] as const;

function result(status: number | null = 0, stdout = "", stderr = ""): SpawnSyncReturns<string> {
    return { status, stdout, stderr, pid: 1, output: [], signal: null };
}

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected exception");
}

function fixture(overrides: Partial<SuppliedPorts> = {}) {
    const order: string[] = [];
    const effect = (label: string): (() => undefined) => () => { order.push(label); };
    const args = ["run", "--detach", "fixture-image"];
    const ports: SuppliedPorts = {
        withFamilyLock: (prefix, operation) => { order.push(`lock:${prefix}`); return operation(); },
        namespaceExists: vi.fn(() => false), findCollision: vi.fn(() => null),
        assertProjectSources: effect("project"), assertDeviceSources: effect("device"),
        assertFilesystemSources: effect("filesystem"),
        verifyCreated: vi.fn(() => ({ kind: "verified", via: "identity" } as const)),
        syncMcp: vi.fn(effect("mcp")), fixSsh: vi.fn(effect("ssh")), syncGit: vi.fn(effect("git")),
        finish: vi.fn((target: string) => { order.push(`finish:${target}`); return "public-name"; }),
        ...overrides,
    };
    const context: NativeContainerCreateLifecycleContext = {
        createCli: "captured-runtime", createFailureHint: "original-init-hint",
        prepareRunArgs: vi.fn(() => { order.push("args"); return args; }),
        labWarning: vi.fn(() => { order.push("warning-fact"); return null; }),
        explicitlyNotFound: vi.fn(() => true),
    };
    return { order, args, ports, context, lifecycle: createNativeContainerCreateLifecycle(ports, context) };
}

beforeEach(() => {
    vi.resetAllMocks();
    native.bindGuard = Object.freeze({ root: resolve(native.bindGuard.root) }) as import("../../ports/runtime-bind-authority.js").RuntimeBindGuard;
    native.authorityEvents = []; native.authorityHeld = false;
    native.spawn.mockReturnValue(result(0, id));
    native.runtime.mockReturnValue("current-runtime");
    native.family.mockImplementation((_prefix, operation) => operation());
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("actual creation application through native composition", () => {
    it("constructs without native, fact, collaborator or presentation effects", () => {
        const f = fixture();
        expect(f.order).toEqual([]);
        for (const port of Object.values(f.ports)) if (vi.isMockFunction(port)) expect(port).not.toHaveBeenCalled();
        expect(f.context.labWarning).not.toHaveBeenCalled();
        expect(f.context.explicitlyNotFound).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
        expect(native.runtime).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
        expect(console.warn).not.toHaveBeenCalled();
    });

    it.each([
        "withFamilyLock", "namespaceExists", "findCollision", "assertProjectSources", "assertDeviceSources",
        "assertFilesystemSources", "verifyCreated", "syncMcp", "fixSsh", "syncGit", "finish",
    ] as const)("rejects missing supplied %s at construction before effects", port => {
        const f = fixture();
        const invalid = { ...f.ports, [port]: undefined } as unknown as SuppliedPorts;
        expect(() => createNativeContainerCreateLifecycle(invalid, f.context)).toThrow(TypeError);
        expect(f.order).toEqual([]);
        expect(native.spawn).not.toHaveBeenCalled();
        expect(f.context.prepareRunArgs).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
    });

    it("lets a native family guard skip its callback and return its own string", () => {
        const f = fixture({ withFamilyLock: () => "guard skipped" });
        expect(f.lifecycle.run(request)).toBe("guard skipped");
        expect(f.order).toEqual([]);
        expect(f.context.prepareRunArgs).not.toHaveBeenCalled();
        expect(f.context.labWarning).not.toHaveBeenCalled();
        expect(f.ports.namespaceExists).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
    });

    it("projects a successful callback to a string before the native guard returns its own string", () => {
        const callbackResults: unknown[] = [];
        const f = fixture({ withFamilyLock: (_prefix, operation) => { callbackResults.push(operation()); return "guard selected value"; } });
        expect(f.lifecycle.run(request)).toBe("guard selected value");
        expect(callbackResults).toEqual(["public-name"]);
        expect(f.ports.finish).toHaveBeenCalledExactlyOnceWith(id);
    });

    it("projects refusal inside the callback so a native guard can catch and recover", () => {
        const caught: unknown[] = [];
        const f = fixture({ namespaceExists: () => true, withFamilyLock: (_prefix, operation) => {
            try { operation(); } catch (error) { caught.push(error); }
            return "guard recovered";
        } });
        expect(f.lifecycle.run(request)).toBe("guard recovered");
        expect(caught).toHaveLength(1);
        expect(caught[0]).toMatchObject({ message: `Container namespace ${name} appeared during creation preflight; refusing replacement.` });
        expect(native.spawn).not.toHaveBeenCalled();
        expect(f.context.prepareRunArgs).not.toHaveBeenCalled();
    });

    it("projects every repeated native callback before the guard chooses its return", () => {
        const callbackResults: unknown[] = [];
        const f = fixture({ withFamilyLock: (_prefix, operation) => {
            callbackResults.push(operation(), operation());
            return "guard repeated";
        } });
        expect(f.lifecycle.run(request)).toBe("guard repeated");
        expect(callbackResults).toEqual(["public-name", "public-name"]);
        expect(native.spawn).toHaveBeenCalledTimes(2);
        expect(f.ports.finish).toHaveBeenNthCalledWith(1, id);
        expect(f.ports.finish).toHaveBeenNthCalledWith(2, id);
    });

    it("preserves a native guard throw after a projected callback without compensation", () => {
        const failure = { guard: "failed after callback" }; const callbackResults: unknown[] = [];
        const f = fixture({ withFamilyLock: (_prefix, operation) => {
            callbackResults.push(operation()); throw failure;
        } });
        expect(thrown(() => f.lifecycle.run(request))).toBe(failure);
        expect(callbackResults).toEqual(["public-name"]);
        expect(native.spawn).toHaveBeenCalledTimes(1);
        expect(f.context.explicitlyNotFound).not.toHaveBeenCalled();
    });

    it("resets primary and cleanup causes when a native guard catches an attempt and repeats", () => {
        const primary = new Error("first proof threw"), removal = new Error("first removal threw"), absence = new Error("first inspection threw");
        let attempt = 0; const caught: unknown[] = [];
        const verification = vi.fn<SuppliedPorts["verifyCreated"]>()
            .mockImplementationOnce(() => { throw primary; }).mockReturnValueOnce({ kind: "mismatch", reason: "second proof refused" });
        const f = fixture({ verifyCreated: verification, withFamilyLock: (_prefix, operation) => {
            for (let index = 0; index < 2; index++) { try { operation(); } catch (error) { caught.push(error); } }
            return "guard exhausted";
        } });
        // The second removal succeeds, independently of its absence result.
        native.spawn.mockImplementation((_cli, args: string[]) => {
            if (args[0] === "run") { attempt++; return result(0, id); }
            if (attempt === 1) throw args[0] === "rm" ? removal : absence;
            return args[0] === "rm" ? result() : result(1, "", "No such container");
        });
        expect(f.lifecycle.run(request)).toBe("guard exhausted");
        expect(caught).toHaveLength(2);
        expect(caught[0]).toMatchObject({ cause: primary, errors: [primary, removal, absence] });
        expect(caught[1]).toBeInstanceOf(Error);
        expect(caught[1]).not.toBeInstanceOf(AggregateError);
        expect((caught[1] as Error).message).toBe("created container bind mount identity verification failed (second proof refused)");
        expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(["run", "rm", "inspect", "run", "rm", "inspect"]);
    });

    it("preserves context and supplied method receivers through native wrappers", () => {
        const f = fixture();
        f.context.prepareRunArgs = function () { expect(this).toBe(f.context); return f.args; };
        f.ports.verifyCreated = function (target) {
            expect(this.finish).toBe(f.ports.finish); expect(target).toBe(id);
            return { kind: "verified", via: "identity" };
        };
        // Supply the methods before composition, just as the public caller does.
        const lifecycle = createNativeContainerCreateLifecycle(f.ports, f.context);
        expect(lifecycle.run(request)).toBe("public-name");
    });

    it("regression: retains a namespace check installed by the native guard across facade runs", () => {
        const appeared = vi.fn(() => true);
        const f = fixture({ withFamilyLock(_prefix, operation) {
            const value = operation();
            this.namespaceExists = appeared;
            return value;
        } });
        expect(f.lifecycle.run(request)).toBe("public-name");
        expect(() => f.lifecycle.run(request)).toThrow(`Container namespace ${name} appeared during creation preflight; refusing replacement.`);
        expect(appeared).toHaveBeenCalledExactlyOnceWith(name);
        expect(f.ports.namespaceExists).toHaveBeenCalledExactlyOnceWith(name);
        expect(f.context.prepareRunArgs).toHaveBeenCalledTimes(1);
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("captured-runtime", f.args, createOptions);
        expect(f.ports.finish).toHaveBeenCalledExactlyOnceWith(id);
    });

    it("regression: preserves a verifier property lookup failure after an earlier source proof installs it", () => {
        const primary = new Error("verifier lookup failed");
        const lookup = vi.fn(() => { throw primary; });
        const f = fixture({ assertProjectSources() {
            Object.defineProperty(this, "verifyCreated", { configurable: true, get: lookup });
            return undefined;
        } });
        const absent = result(1, "", "No such container");
        native.spawn.mockReturnValueOnce(result(0, id)).mockReturnValueOnce(result()).mockReturnValueOnce(absent);
        expect(thrown(() => f.lifecycle.run(request))).toBe(primary);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(f.ports.verifyCreated).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls).toEqual([
            ["captured-runtime", f.args, createOptions],
            ["captured-runtime", ["rm", "-f", id], cleanupOptions],
            ["captured-runtime", ["inspect", "-f", "{{.Id}}", id], { ...cleanupOptions, timeout: 5000 }],
        ]);
        expect(f.context.explicitlyNotFound).toHaveBeenCalledExactlyOnceWith(absent);
        expect(f.ports.finish).not.toHaveBeenCalled();
    });

    it("regression: inspects absence independently after a rejected-removal property lookup throws", () => {
        const primary = new Error("verification failed before removal lookup");
        const removal = new Error("removal lookup failed");
        const lookup = vi.fn(() => { throw removal; });
        const f = fixture({
            assertProjectSources(this: Pick<ContainerCreateLifecyclePorts<unknown>, "removeRejected">) {
                Object.defineProperty(this, "removeRejected", { configurable: true, get: lookup });
                return undefined;
            },
            verifyCreated: () => { throw primary; },
        });
        const absent = result(1, "", "No such container");
        native.spawn.mockReturnValueOnce(result(0, id)).mockReturnValueOnce(absent);
        const caught = thrown(() => f.lifecycle.run(request)) as AggregateError;
        expect(caught).toBeInstanceOf(AggregateError);
        expect(caught.cause).toBe(primary);
        expect(caught.errors).toHaveLength(2);
        expect(caught.errors[0]).toBe(primary);
        expect(caught.errors[1]).toBe(removal);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(native.spawn.mock.calls).toEqual([
            ["captured-runtime", f.args, createOptions],
            ["captured-runtime", ["inspect", "-f", "{{.Id}}", id], { ...cleanupOptions, timeout: 5000 }],
        ]);
        expect(f.context.explicitlyNotFound).toHaveBeenCalledExactlyOnceWith(absent);
        expect(f.ports.finish).not.toHaveBeenCalled();
    });

    it("regression: retains ordered primary, removal and absence property lookup failures", () => {
        const primary = new Error("verification failed before absence lookup");
        const removal = new Error("native removal threw");
        const absence = new Error("absence lookup failed");
        const lookup = vi.fn(() => { throw absence; });
        const f = fixture({
            assertProjectSources(this: Pick<ContainerCreateLifecyclePorts<unknown>, "explicitlyAbsent">) {
                Object.defineProperty(this, "explicitlyAbsent", { configurable: true, get: lookup });
                return undefined;
            },
            verifyCreated: () => { throw primary; },
        });
        native.spawn.mockImplementation((_cli, args: string[]) => {
            if (args[0] === "run") return result(0, id);
            throw removal;
        });
        const caught = thrown(() => f.lifecycle.run(request)) as AggregateError;
        expect(caught).toBeInstanceOf(AggregateError);
        expect(caught.cause).toBe(primary);
        expect(caught.errors).toHaveLength(3);
        expect(caught.errors[0]).toBe(primary);
        expect(caught.errors[1]).toBe(removal);
        expect(caught.errors[2]).toBe(absence);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(native.spawn.mock.calls).toEqual([
            ["captured-runtime", f.args, createOptions],
            ["captured-runtime", ["rm", "-f", id], cleanupOptions],
        ]);
        expect(f.context.explicitlyNotFound).not.toHaveBeenCalled();
        expect(f.ports.finish).not.toHaveBeenCalled();
    });

    it.each(["error", "undefined"] as const)("regression: preserves a %s verifier failure after an earlier proof replaces the receiver method", value => {
        const primary = value === "error" ? new Error("replacement verifier failed") : undefined;
        const replacement = vi.fn((_target: string) => { throw primary; });
        let projectProofs = 0;
        const f = fixture({ assertProjectSources() {
            projectProofs++;
            this.verifyCreated = replacement;
            return undefined;
        } });
        const absent = result(1, "", "No such container");
        native.spawn.mockReturnValueOnce(result(0, id)).mockReturnValueOnce(result()).mockReturnValueOnce(absent);
        expect(thrown(() => f.lifecycle.run(request))).toBe(primary);
        expect(projectProofs).toBe(2);
        expect(replacement).toHaveBeenCalledExactlyOnceWith(id);
        expect(f.ports.verifyCreated).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls).toEqual([
            ["captured-runtime", f.args, createOptions],
            ["captured-runtime", ["rm", "-f", id], cleanupOptions],
            ["captured-runtime", ["inspect", "-f", "{{.Id}}", id], { ...cleanupOptions, timeout: 5000 }],
        ]);
        expect(f.context.explicitlyNotFound).toHaveBeenCalledExactlyOnceWith(absent);
        expect(f.ports.finish).not.toHaveBeenCalled();
    });

    it.each(["error", "undefined"] as const)("regression: preserves a %s source failure after an earlier proof replaces a later receiver assertion", value => {
        const primary = value === "error" ? new Error("replacement device source failed") : undefined;
        const replacement = vi.fn(() => { throw primary; });
        const originalDeviceProof = vi.fn(() => undefined);
        let projectProofs = 0;
        const f = fixture({ assertDeviceSources: originalDeviceProof, assertProjectSources() {
            if (++projectProofs === 2) this.assertDeviceSources = replacement;
            return undefined;
        } });
        const absent = result(1, "", "No such container");
        native.spawn.mockReturnValueOnce(result(0, id)).mockReturnValueOnce(result()).mockReturnValueOnce(absent);
        expect(thrown(() => f.lifecycle.run(request))).toBe(primary);
        expect(projectProofs).toBe(2);
        expect(originalDeviceProof).toHaveBeenCalledTimes(1);
        expect(replacement).toHaveBeenCalledTimes(1);
        expect(f.ports.verifyCreated).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls).toEqual([
            ["captured-runtime", f.args, createOptions],
            ["captured-runtime", ["rm", "-f", id], cleanupOptions],
            ["captured-runtime", ["inspect", "-f", "{{.Id}}", id], { ...cleanupOptions, timeout: 5000 }],
        ]);
        expect(f.context.explicitlyNotFound).toHaveBeenCalledExactlyOnceWith(absent);
        expect(f.ports.finish).not.toHaveBeenCalled();
    });

    it.each(["errors", "undefined-primary", "undefined-cleanup"] as const)("regression: retains ordered %s failures when an earlier proof replaces receiver cleanup methods", values => {
        const primary = values === "undefined-primary" ? undefined : new Error("verification failed before replacement cleanup");
        const removal = values === "undefined-cleanup" ? undefined : new Error("replacement removal failed");
        const absence = values === "undefined-cleanup" ? undefined : new Error("replacement absence failed");
        const effects: string[] = [];
        const remove = vi.fn((target: string): undefined => { effects.push("remove:" + target); throw removal; });
        const inspect = vi.fn((target: string): boolean => { effects.push("absent:" + target); throw absence; });
        const f = fixture({
            assertProjectSources(this: Pick<ContainerCreateLifecyclePorts<unknown>, "removeRejected" | "explicitlyAbsent">) {
                this.removeRejected = remove;
                this.explicitlyAbsent = inspect;
                return undefined;
            },
            verifyCreated: target => { effects.push("verify:" + target); throw primary; },
        });
        native.spawn.mockImplementation((_cli, args: string[]) => { effects.push(args[0]); return result(0, id); });
        const caught = thrown(() => f.lifecycle.run(request)) as AggregateError;
        expect(caught).toBeInstanceOf(AggregateError);
        expect(caught.cause).toBe(primary);
        expect(caught.errors).toHaveLength(3);
        expect(caught.errors[0]).toBe(primary);
        expect(caught.errors[1]).toBe(removal);
        expect(caught.errors[2]).toBe(absence);
        expect(remove).toHaveBeenCalledExactlyOnceWith(id);
        expect(inspect).toHaveBeenCalledExactlyOnceWith(id);
        expect(effects).toEqual(["run", "verify:" + id, "remove:" + id, "absent:" + id]);
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("captured-runtime", f.args, createOptions);
        expect(f.ports.finish).not.toHaveBeenCalled();
    });

    it.each([undefined, false, true])("preserves streams/order/debug=%s and exact pinned handoff", debug => {
        const f = fixture(); const output: string[] = [];
        vi.mocked(console.error).mockImplementation(message => { output.push(`error:${message}`); });
        vi.mocked(console.log).mockImplementation(message => { output.push(`log:${message}`); });
        f.context.labWarning = () => { output.push("warning-fact"); return null; };
        expect(f.lifecycle.run({ ...request, debug })).toBe("public-name");
        expect(output).toEqual([...(debug ? [`error:[ccc:debug] Container ${name} not found, creating`] : []), "log:Creating container...", "warning-fact"]);
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("captured-runtime", f.args, createOptions);
        expect(f.order).toEqual(["lock:mount-physical", "args", "project", "device", "filesystem", "project", "device", "filesystem", "mcp", "ssh", "git", `finish:${id}`]);
        for (const port of [f.ports.verifyCreated, f.ports.syncMcp, f.ports.fixSsh, f.ports.syncGit, f.ports.finish]) expect(port).toHaveBeenCalledExactlyOnceWith(id);
        expect(native.runtime).not.toHaveBeenCalled();
    });

    it.each(["unsupported nested virtualization", undefined])("reads warning facts lazily and preserves reason %s", unsupportedReason => {
        const f = fixture(); const order: string[] = [];
        vi.mocked(console.log).mockImplementation(message => { order.push(`log:${message}`); });
        vi.mocked(console.warn).mockImplementation(message => { order.push(`warn:${message}`); });
        f.context.labWarning = () => { order.push("fact"); return { unsupportedReason }; };
        f.lifecycle.run(request);
        expect(order).toEqual([
            "log:Creating container...", "fact",
            `warn:[ccc] lab-runner profile requested but nested VM support is unavailable: ${unsupportedReason}`,
            "warn:[ccc] no lab state volume is mounted; device-lab reports linux-vm as unsupported/SKIP.",
        ]);
    });

    it("refuses namespace and collision before reading warning facts or preparing args", () => {
        for (const override of [{ namespaceExists: () => true }, { findCollision: () => ({ containerName: "owner" }) }]) {
            const f = fixture(override);
            expect(() => f.lifecycle.run(request)).toThrow();
            expect(f.context.labWarning).not.toHaveBeenCalled();
            expect(f.context.prepareRunArgs).not.toHaveBeenCalled();
            expect(native.spawn).not.toHaveBeenCalled();
        }
        expect(console.log).not.toHaveBeenCalled();
    });

    it.each([1, null])("native status %s fails without compensation", status => {
        native.spawn.mockReturnValue(result(status, id));
        const f = fixture();
        expect(() => f.lifecycle.run(request)).toThrow("Failed to create container");
        expect(console.error).toHaveBeenCalledExactlyOnceWith("original-init-hint");
        expect(native.spawn).toHaveBeenCalledTimes(1);
        expect(f.context.explicitlyNotFound).not.toHaveBeenCalled();
    });
    it("native create timeout retains its cause and grants no namespace compensation", () => {
        const failure = Object.assign(new Error("create timed out"), {code: "ETIMEDOUT"});
        native.spawn.mockReturnValue({...result(null, id), error: failure});
        const f = fixture();
        expect(thrown(() => f.lifecycle.run(request))).toMatchObject({cause: failure});
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("captured-runtime", f.args, createOptions);
        expect(f.context.explicitlyNotFound).not.toHaveBeenCalled();
        expect(f.ports.finish).not.toHaveBeenCalled();
        expect(f.ports.syncMcp).not.toHaveBeenCalled();
    });

    it("keeps native create causes out of semantic results across interleaved adapter instances", () => {
        const context: NativeContainerCreateLifecycleContext = {
            createCli: "captured-runtime", createFailureHint: "original-init-hint",
            prepareRunArgs: () => ["run", "--detach", "fixture-image"],
            labWarning: () => null, explicitlyNotFound: () => true,
        };
        const first = createNativeContainerCreatePorts(context);
        const second = createNativeContainerCreatePorts(context);
        const firstCause = new Error("first create timed out");
        const secondCause = new Error("second create timed out");
        const firstCauses: unknown[] = [], secondCauses: unknown[] = [];
        native.spawn.mockReturnValueOnce({ ...result(null), error: firstCause })
            .mockReturnValueOnce({ ...result(null), error: secondCause });
        expect(first.create(first.prepareCreate(), cause => { firstCauses.push(cause); })).toEqual({ kind: "failed" });
        expect(second.create(second.prepareCreate(), cause => { secondCauses.push(cause); })).toEqual({ kind: "failed" });
        expect(firstCauses).toEqual([firstCause]);
        expect(secondCauses).toEqual([secondCause]);
    });

    it("isolates native failure causes between facade instances and repeated runs", () => {
        const first = fixture(), second = fixture();
        const firstCause = new Error("first invocation timed out"), secondCause = new Error("second invocation timed out");
        native.spawn.mockReturnValueOnce({ ...result(null), error: firstCause })
            .mockReturnValueOnce({ ...result(null), error: secondCause }).mockReturnValueOnce(result(1));
        const firstFailure = thrown(() => first.lifecycle.run(request)) as Error;
        const secondFailure = thrown(() => second.lifecycle.run(request)) as Error;
        const nextFailure = thrown(() => first.lifecycle.run(request)) as Error;
        expect(firstFailure.cause).toBe(firstCause);
        expect(secondFailure.cause).toBe(secondCause);
        expect(nextFailure.message).toBe("Failed to create container");
        expect(nextFailure.cause).toMatchObject({ message: "Runtime exited with status 1" });
        expect(nextFailure.cause).not.toBe(firstCause);
        expect(native.spawn).toHaveBeenCalledTimes(3);
    });

    it.each([
        ["pull noise\n" + id + "\n", id],
        ["short 123456789abc x" + id + " " + id + "x " + id + " " + "b".repeat(64), id],
        ["noise " + "b".repeat(64) + " " + id, "b".repeat(64)],
    ])("pins the first complete 64hex token from %s", (stdout, expected) => {
        native.spawn.mockReturnValue(result(0, stdout));
        const f = fixture();
        expect(f.lifecycle.run(request)).toBe("public-name");
        for (const port of [f.ports.verifyCreated, f.ports.syncMcp, f.ports.fixSsh, f.ports.syncGit, f.ports.finish]) expect(port).toHaveBeenCalledExactlyOnceWith(expected);
    });
    it("refuses successful native status carrying an error without compensation", () => {
        const failure = new Error("native client failed after output");
        native.spawn.mockReturnValue({...result(0, id), error: failure});
        const f = fixture();
        expect(thrown(() => f.lifecycle.run(request))).toMatchObject({cause: failure});
        expect(native.spawn).toHaveBeenCalledOnce();
        expect(f.ports.verifyCreated).not.toHaveBeenCalled();
        expect(f.ports.finish).not.toHaveBeenCalled();
    });

    it.each(["", " \t\n", "123456789abc", "x" + id, id + "x", "g".repeat(64)])("refuses unpinned native output %s", stdout => {
        native.spawn.mockReturnValue(result(0, stdout));
        const f = fixture();
        expect(() => f.lifecycle.run(request)).toThrow("container runtime did not return an exact 64-hex container ID");
        expect(f.order).toEqual(["lock:mount-physical", "warning-fact", "args", "project", "device", "filesystem", "project", "device", "filesystem"]);
        expect(f.ports.verifyCreated).not.toHaveBeenCalled();
        expect(native.spawn).toHaveBeenCalledTimes(1);
    });

    it("compensates only the exact ID with captured CLI and independent absence classification", () => {
        const original = new Error("source swapped");
        const absentResult = result(1, "", "no such container");
        const removal = new Error("rm failed");
        native.spawn.mockReturnValueOnce(result(0, id)).mockReturnValueOnce({ status: 1, error: removal }).mockReturnValueOnce(absentResult);
        const f = fixture({ verifyCreated: () => { native.runtime.mockReturnValue("changed-runtime"); throw original; } });
        expect(thrown(() => f.lifecycle.run(request))).toMatchObject({cause: original, errors: [original, {cause: removal}]});
        expect(native.spawn.mock.calls).toEqual([
            ["captured-runtime", f.args, createOptions],
            ["captured-runtime", ["rm", "-f", id], cleanupOptions],
            ["captured-runtime", ["inspect", "-f", "{{.Id}}", id], { ...cleanupOptions, timeout: 5000 }],
        ]);
        expect(f.context.explicitlyNotFound).toHaveBeenCalledExactlyOnceWith(absentResult);
        expect(native.runtime).not.toHaveBeenCalled();
        expect(f.ports.syncMcp).not.toHaveBeenCalled();
    });

    it("retains cause when absence is not proved", () => {
        const original = { message: "proof failed" };
        const f = fixture({ verifyCreated: () => { throw original; } });
        f.context.explicitlyNotFound = () => false;
        const error = thrown(() => f.lifecycle.run(request)) as Error;
        expect(error.message).toBe(`proof failed; failed to remove rejected container ${id}`);
        expect(error.cause).toBe(original);
        expect(native.spawn).toHaveBeenCalledTimes(3);
    });
    it("rethrows original verification failure unchanged after successful exact-ID removal and proven absence", () => {
        const original = new Error("verification rejected");
        const absent = result(1, "", "No such container");
        native.spawn.mockReturnValueOnce(result(0, id)).mockReturnValueOnce(result()).mockReturnValueOnce(absent);
        const f = fixture({verifyCreated: () => { throw original; }});
        expect(thrown(() => f.lifecycle.run(request))).toBe(original);
        expect(f.context.explicitlyNotFound).toHaveBeenCalledExactlyOnceWith(absent);
        expect(native.spawn.mock.calls.slice(1).map(call => call[1])).toEqual([["rm", "-f", id], ["inspect", "-f", "{{.Id}}", id]]);
        expect(f.ports.finish).not.toHaveBeenCalled();
    });
    it.each(thrownValues)("rethrows a %s primary unchanged after proved absence", (_label, primary) => {
        const f = fixture({ verifyCreated: () => { throw primary; } });
        native.spawn.mockReturnValueOnce(result(0, id)).mockReturnValueOnce(result()).mockReturnValueOnce(result(1, "", "No such container"));
        expect(thrown(() => f.lifecycle.run(request))).toBe(primary);
        expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(["run", "rm", "inspect"]);
        expect(f.ports.finish).not.toHaveBeenCalled();
    });
    it.each(thrownValues)("preserves the legacy message formatter for an unproved %s primary", (_label, primary) => {
        const f = fixture({ verifyCreated: () => { throw primary; } });
        f.context.explicitlyNotFound = () => false;
        const caught = thrown(() => f.lifecycle.run(request));
        if (primary === null || primary === undefined) {
            expect(caught).toBeInstanceOf(TypeError);
        } else {
            expect(caught).toMatchObject({ message: `undefined; failed to remove rejected container ${id}`, cause: primary });
        }
        expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(["run", "rm", "inspect"]);
    });
    it.each(thrownValues)("retains a %s thrown cleanup value at each native compensation stage", (_label, cleanupFailure) => {
        for (const stage of ["remove", "inspect", "classifier"] as const) {
            const primary = new Error("verification rejected before " + stage);
            const f = fixture({ verifyCreated: () => { throw primary; } });
            const before = native.spawn.mock.calls.length;
            native.spawn.mockImplementation((_cli, args: string[]) => {
                if (args[0] === "run") return result(0, id);
                if (args[0] === "rm" && stage === "remove" || args[0] === "inspect" && stage === "inspect") throw cleanupFailure;
                return args[0] === "rm" ? result() : result(1, "", "No such container");
            });
            if (stage === "classifier") f.context.explicitlyNotFound = () => { throw cleanupFailure; };
            const caught = thrown(() => f.lifecycle.run(request)) as AggregateError;
            expect(caught).toBeInstanceOf(AggregateError);
            expect(caught.cause).toBe(primary);
            expect(caught.errors).toEqual([primary, cleanupFailure]);
            expect(caught.errors[1]).toBe(cleanupFailure);
            expect(native.spawn.mock.calls.slice(before).map(call => call[1][0])).toEqual(["run", "rm", "inspect"]);
            expect(f.ports.finish).not.toHaveBeenCalled();
        }
    });
    it("retains verification, removal and independent absence failures in occurrence order", () => {
        const original = new Error("verification rejected"), removal = new Error("removal threw"), inspection = new Error("inspection threw");
        const f = fixture({verifyCreated: () => { throw original; }});
        native.spawn.mockImplementation((_cli, args: string[]) => {
            if (args[0] === "run") return result(0, id);
            if (args[0] === "rm") throw removal;
            throw inspection;
        });
        expect(thrown(() => f.lifecycle.run(request))).toMatchObject({cause: original, errors: [original, removal, inspection]});
        expect(native.spawn.mock.calls.slice(1).map(call => call[1])).toEqual([["rm", "-f", id], ["inspect", "-f", "{{.Id}}", id]]);
        expect(f.context.explicitlyNotFound).not.toHaveBeenCalled();
        expect(f.ports.finish).not.toHaveBeenCalled();
    });
    it.each([{status: null}, {status: 1, error: new Error("inspect timed out"), stderr: "No such container"}])("refuses uncertain absence even with a permissive classifier: %j", probe => {
        const original = new Error("verification rejected");
        native.spawn.mockReturnValueOnce(result(0, id)).mockReturnValueOnce(result()).mockReturnValueOnce(probe);
        const f = fixture({verifyCreated: () => { throw original; }});
        const caught = thrown(() => f.lifecycle.run(request));
        expect(caught).toMatchObject({cause: original});
        expect(caught).toBeInstanceOf(AggregateError);
        expect(caught).toMatchObject({errors: [original, "error" in probe ? probe.error : {message: expect.stringContaining("did not complete")}]});
        expect(caught).not.toBe(original);
        expect(f.context.explicitlyNotFound).not.toHaveBeenCalled();
        expect(f.ports.finish).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls.slice(1).map(call => call[1])).toEqual([["rm", "-f", id], ["inspect", "-f", "{{.Id}}", id]]);
    });

    it.each(["create", "remove", "inspect", "classifier"])("preserves native %s failure with original verification outcome", stage => {
        const original = new Error("verification failed"); const failure = { stage };
        const f = fixture({ verifyCreated: () => { throw original; } });
        native.spawn.mockImplementation((_cli, args: string[]) => {
            if (args[0] === "run") {
                if (stage === "create") throw failure;
                return result(0, id);
            }
            if (args[0] === "rm" && stage === "remove") throw failure;
            if (args[0] === "inspect" && stage === "inspect") throw failure;
            return result();
        });
        if (stage === "classifier") f.context.explicitlyNotFound = () => { throw failure; };
        const caught = thrown(() => f.lifecycle.run(request));
        if (stage === "create") expect(caught).toBe(failure);
        else expect(caught).toMatchObject({cause: original, errors: [original, failure]});
        expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(
            stage === "create" ? ["run"] : ["run", "rm", "inspect"],
        );
        if (stage !== "create") expect(native.spawn.mock.calls.slice(1).map(call => call[1])).toEqual([["rm", "-f", id], ["inspect", "-f", "{{.Id}}", id]]);
    });

    it.each(["syncMcp", "fixSsh", "syncGit", "finish"] as const)("does not compensate late %s failure", port => {
        const failure = { port }; const f = fixture({ [port]: () => { throw failure; } });
        expect(thrown(() => f.lifecycle.run(request))).toBe(failure);
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("captured-runtime", f.args, createOptions);
        expect(f.context.explicitlyNotFound).not.toHaveBeenCalled();
    });
});

// Exercise the real public facade and both real applications; only native boundaries are mocked.
const docker = await import("../../docker.js");
const { IMAGE_NAME } = await import("../../utils.js");
const containerIdentity = await import("../../container-identity.js");
const sharedState = await import("@ccc/device-lab/device-lab-shared-state.js");
const baseImageId = `sha256:${"b".repeat(64)}`;
const identityImageId = `sha256:${"c".repeat(64)}`;
const project = resolve("/fixture/project");

function publicFixture() {
    native.authorityEvents = [];
    const identity = containerIdentity.resolveContainerIdentity();
    const identityLabels = { ...containerIdentity.getIdentityLabels(identity), "ccc.identity.base": baseImageId };
    const state = {
        createResult: result(0, "short-id"), remaining: result(1, "", "No such container"),
        changed: false, swapProject: false, currentCli: "captured-runtime",
        familyCalls: 0, existing: false, stopped: false, outdatedImage: false, runArgs: [] as string[], invalidMount: false,
        helperFailure: undefined as unknown,
    };
    native.runtime.mockImplementation(() => state.currentCli);
    native.remote.mockReturnValue(false);
    native.exists.mockReturnValue(false);
    native.realpath.mockImplementation((path: string) => path);
    const stat = (path: string) => ({
        isSymbolicLink: () => false, isDirectory: () => !path.endsWith(".json"),
        isFile: () => path.endsWith(".json"), dev: 1,
        ino: state.changed && path === project ? 2 : 1, size: 16, gid: 100,
    });
    native.lstat.mockImplementation(stat);
    native.stat.mockImplementation(stat);
    native.fstat.mockImplementation(() => stat("owner.json"));
    native.read.mockReturnValue(Buffer.from("fixture"));
    const markers = new Map<string, string>();
    native.write.mockImplementation((path: string, content: string) => { markers.set(path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1), content); });
    native.open.mockReturnValue(1);
    native.family.mockImplementation((_prefix, operation) => { state.familyCalls++; return operation(); });
    native.spawn.mockImplementation((_cli, args: string[], options?: { encoding?: string | null }) => {
        if (JSON.stringify(args) === JSON.stringify(["info", "--format", "{{.ID}}"])
            || JSON.stringify(args) === JSON.stringify(["exec", "--user", "root", id,
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "info", "--format", "{{.ID}}"])) {
            return result(0, "fixture-daemon\n");
        }
        if (args[0] === "images") return result(0, "image-id");
        if (args[0] === "image" && args[1] === "inspect") {
            expect(args[2]).toMatch(/^ccc-identity:[a-f0-9]{64}$/);
            return result(0, JSON.stringify([{ Id: identityImageId, Config: { User: "ccc", Labels: identityLabels } }]));
        }
        if (args[0] === "inspect" && args[1] === IMAGE_NAME && args.includes("{{.Id}}")) return result(0, baseImageId);
        if (args[0] === "run" && args[1] === "--rm") {
            expect(args.slice(0, 9)).toEqual(["run", "--rm", "--network", "none", "--user", "ccc", "--entrypoint", "/bin/sh", identityImageId]);
            return result(0, `${identity.uid}:${identity.gid}:/home/ccc:ccc`);
        }
        if (args[0] === "run") {
            expect(native.authorityHeld).toBe(true);
            expect(native.authorityEvents.at(-1)).toBe("begin");
            native.authorityEvents.push("run");
            state.runArgs = [...args];
            state.changed = state.swapProject;
            state.currentCli = "changed-runtime";
            return state.createResult;
        }
        if (args[0] === "ps" && args[1] === "-aq") return result(0, state.existing ? id : "");
        if (args[0] === "ps" && args[1] === "-q") return result(0, state.existing && !state.stopped ? id : "");
        if (args[0] === "start") { state.stopped = false; return result(); }
        if (args[0] === "inspect" && args.includes("{{.State.Running}}")) return result(0, state.existing && !state.stopped ? "true" : "false");
        if (args[0] === "inspect" && args.includes("{{.Id}}|{{.State.Running}}")) return result(0, `${id}|${!state.stopped}`);
        if (args[0] === "inspect" && args.includes("{{.Id}}|{{.State.Running}}|{{.Image}}")) return result(0, `${id}|true|${identityImageId}`);
        if (args[0] === "inspect" && args.includes("{{json .}}")) {
            const mounts: Array<{ Source: string; Destination: string; Type: string; RW: boolean }> = [];
            const labels: Record<string, string> = {};
            const env: string[] = [];
            for (let index = 0; index < state.runArgs.length; index++) {
                const argument = state.runArgs[index];
                const value = state.runArgs[index + 1];
                if (argument === "-v") {
                    const match = value.match(/^(.*):(\/[^:]+)(?::ro)?$/)!;
                    mounts.push({ Source: match[1], Destination: match[2], Type: state.invalidMount && match[1] === project ? "tmpfs" : isAbsolute(match[1]) ? "bind" : "volume", RW: !value.endsWith(":ro") });
                }
                if (argument === "--tmpfs") mounts.push({ Source: "", Destination: value.split(":")[0], Type: "tmpfs", RW: true });
                if (argument === "--label") labels[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
                if (argument === "-e") env.push(value);
            }
            return result(0, JSON.stringify({ Id: id, Image: state.outdatedImage ? `sha256:${"d".repeat(64)}` : identityImageId, State: { Running: !state.stopped }, Mounts: mounts, Config: { Labels: labels, Env: env, User: "ccc" }, HostConfig: { Init: true, Devices: [], DeviceRequests: [], GroupAdd: [], Privileged: false } }));
        }
        if (args[0] === "exec" && args[1] === id && args[2] === "sh" && args[4]?.includes('$(id -un)')) return result(0, `${identity.uid}:${identity.gid}:ccc:/home/ccc`);
        if (args[0] === "exec" && args.includes("ccc-ssh-copy") && state.helperFailure !== undefined) throw state.helperFailure;
        if (args[0] === "exec" && args[2] === "cat") {
            if (options?.encoding === null) return { ...result(), stdout: Buffer.from("fixture") };
            return result(0, markers.get(args[3].slice(args[3].lastIndexOf("/") + 1)) ?? "");
        }
        if (args[0] === "inspect" && args.includes("{{.Id}}")) return state.remaining;
        return result();
    });
    return state;
}

describe("public Docker creation cutover", () => {
    it.each(["reuse", "restart", "defer"] as const)("prepared %s queues its branch helper set until initialization", branch => {
        const state = publicFixture(); state.createResult = result(0, id);
        // Seed an actual valid native contract, then observe the existing branch.
        const seed = docker.prepareProjectContainerStartup();
        seed.start(project, () => {}, undefined, undefined, undefined, undefined, undefined, () => {});
        state.existing = true; state.stopped = branch === "restart"; state.outdatedImage = branch === "defer";
        native.exists.mockImplementation(path => String(path).endsWith(".gitconfig"));
        const originalStat = native.lstat.getMockImplementation()!;
        native.lstat.mockImplementation(path => String(path).endsWith("server.mjs")
            ? {isFile: () => true, isSymbolicLink: () => false, size: 16}
            : originalStat(path));
        const startup = docker.prepareProjectContainerStartup();
        native.spawn.mockClear();
        const ready = vi.fn();
        startup.start(project, () => {}, undefined, undefined, undefined, undefined, () => false, ready, branch === "defer" ? id : undefined);
        const helperCalls = () => native.spawn.mock.calls.filter(call => call[1].includes("ccc-ssh-copy")
            || call[1].includes("ccc-signing-key-rewrite") || call[1][0] === "cp" && String(call[1][1]).endsWith("server.mjs"));
        expect(ready).toHaveBeenCalledExactlyOnceWith(id, {startedByInvocation: branch === "restart"});
        expect(helperCalls()).toEqual([]);
        startup.initialize(id);
        expect(helperCalls().map(call => call[1].includes("ccc-ssh-copy") ? "ssh"
            : call[1].includes("ccc-signing-key-rewrite") ? "git" : "mcp"))
            .toEqual(branch === "defer" ? ["ssh", "git"] : ["mcp", "ssh", "git"]);
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "start").map(call => call[1])).toEqual(branch === "restart" ? [["start", id]] : []);
        expect(native.spawn.mock.calls.some(call => call[1][0] === "rm")).toBe(false);
    });
    it("rejects unexpected fixture lock paths before calling an operation", () => {
        const operation = vi.fn();
        expect(() => sharedState.withSharedMutationLock("/unexpected/private.lock", operation)).toThrow("unexpected fixture lock IO");
        expect(operation).not.toHaveBeenCalled();
    });

    it("publishes verified start and ready before helper failure", () => {
        const state = publicFixture(); state.createResult = result(0, id);
        const failure = { kind: "ssh helper failure" }; state.helperFailure = failure;
        const ready = vi.fn();
        const started = vi.fn(target => {
            expect(target).toBe(id);
            expect(native.spawn.mock.calls.some(call => call[1].includes("{{json .}}"))).toBe(true);
            expect(native.spawn.mock.calls.some(call => call[1].includes("ccc-ssh-copy"))).toBe(false);
        });
        expect(thrown(() => docker.startProjectContainer(project, () => {}, undefined, undefined, undefined, undefined, undefined, ready, undefined, started))).toBe(failure);
        expect(started).toHaveBeenCalledExactlyOnceWith(id);
        expect(ready).toHaveBeenCalledExactlyOnceWith(id, {startedByInvocation: true});
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "rm")).toEqual([]);
    });
    it("prepared startup publishes handoff while helpers wait for explicit initialization", () => {
        const state = publicFixture(); state.createResult = result(0, id);
        const startup = docker.prepareProjectContainerStartup();
        const ready = vi.fn(), started = vi.fn();
        startup.start(project, () => {}, undefined, undefined, undefined, undefined, undefined, ready, undefined, started);
        expect(started).toHaveBeenCalledExactlyOnceWith(id);
        expect(ready).toHaveBeenCalledExactlyOnceWith(id, {startedByInvocation: true});
        expect(native.spawn.mock.calls.some(call => call[1].includes("ccc-ssh-copy"))).toBe(false);
        startup.initialize(id);
        expect(native.spawn.mock.calls.some(call => call[1].includes("ccc-ssh-copy"))).toBe(true);
        expect(() => startup.initialize("successor")).toThrow("exact startup identity");
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "rm")).toEqual([]);
    });

    it("compensates rejected mounts before publishing start authority or ready", () => {
        const state = publicFixture(); state.createResult = result(0, id); state.invalidMount = true;
        const ready = vi.fn(); const started = vi.fn();
        expect(() => docker.startProjectContainer(project, () => {}, undefined, undefined, undefined, undefined, undefined, ready, undefined, started)).toThrow("created container bind mount identity verification failed");
        expect(started).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "rm")).toEqual([["captured-runtime", ["rm", "-f", id], cleanupOptions]]);
        expect(native.spawn.mock.calls.some(call => call[1].includes("ccc-ssh-copy"))).toBe(false);
    });

    it("compensates a throwing start-authority callback and preserves its exact cause", () => {
        const state = publicFixture(); state.createResult = result(0, id);
        const failure = { kind: "start authorization" }; const started = vi.fn(() => { throw failure; });
        const ready = vi.fn();
        expect(thrown(() => docker.startProjectContainer(project, () => {}, undefined, undefined, undefined, undefined, undefined, ready, undefined, started))).toBe(failure);
        expect(started).toHaveBeenCalledExactlyOnceWith(id); expect(ready).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "rm")).toEqual([["captured-runtime", ["rm", "-f", id], cleanupOptions]]);
        expect(native.spawn.mock.calls.some(call => call[1].includes("ccc-ssh-copy"))).toBe(false);
    });
    it("creates, verifies, synchronizes with captured runtime and returns the unchanged public name", () => {
        const state = publicFixture(); state.createResult = result(0, id);
        const ready = vi.fn();
        expect(docker.startProjectContainer(project, () => {}, undefined, undefined, undefined, undefined, undefined, ready)).toBe(docker.getContainerName(project));
        expect(ready).toHaveBeenCalledExactlyOnceWith(id, { startedByInvocation: true });
        expect(native.authorityEvents).toEqual(["record", "begin", "run", "settle"]);
        expect(state.familyCalls).toBe(1);
        expect(state.currentCli).toBe("changed-runtime");
        const run = native.spawn.mock.calls.find(call => call[1][0] === "run" && call[1][1] !== "--rm");
        expect(run?.[0]).toBe("captured-runtime");
        const proof = native.spawn.mock.calls.find(call => call[1].includes("{{json .}}"));
        expect(proof?.[0]).toBe("captured-runtime");
        expect(proof?.[1]).toEqual(["inspect", "-f", "{{json .}}", id]);
        const ssh = native.spawn.mock.calls.filter(call => call[1][0] === "exec" && call[1][2] === "sh" && !call[1][4]?.includes('$(id -un)'));
        expect(ssh).toHaveLength(1);
        expect(ssh[0][1]).toContain("ccc-ssh-copy");
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "exec" && call[1][4]?.includes('$(id -un)'))).toHaveLength(1);
        expect(ssh.every(call => call[0] === "captured-runtime" && call[1][1] === id)).toBe(true);
        expect(native.spawn.mock.calls.some(call => call[1][0] === "rm")).toBe(false);
    });

    it("joins an existing verified container without invoking fresh-create family guard or reports", () => {
        const state = publicFixture(); state.createResult = result(0, id);
        expect(docker.startProjectContainer(project, () => {})).toBe(docker.getContainerName(project));
        state.existing = true;
        native.spawn.mockClear(); native.family.mockClear(); vi.mocked(console.log).mockClear();
        expect(docker.startProjectContainer(project, () => {})).toBe(docker.getContainerName(project));
        expect(native.family).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls.some(call => call[1][0] === "run" && call[1][1] !== "--rm")).toBe(false);
        expect(console.log).not.toHaveBeenCalledWith("Creating container...");
    });

    it.each([undefined, "lab-runner"])("preserves lazy public lab warning profile=%s", profile => {
        publicFixture(); const order: string[] = [];
        vi.mocked(console.log).mockImplementation(message => { order.push(`log:${message}`); });
        vi.mocked(console.warn).mockImplementation(message => { order.push(`warn:${message}`); });
        expect(() => docker.startProjectContainer(project, () => {}, undefined, undefined, profile)).toThrow("exact 64-hex container ID");
        expect(order).toEqual([
            "log:Creating container...",
            ...(profile === "lab-runner" ? [
                `warn:[ccc] lab-runner profile requested but nested VM support is unavailable: ${process.platform === "linux" ? "/dev/kvm is not available on the container host" : "nested virtualization from the CCC container requires a Linux container host"}`,
                "warn:[ccc] no lab state volume is mounted; device-lab reports linux-vm as unsupported/SKIP.",
            ] : []),
        ]);
    });
    it("invokes actual create policy only inside the existing family guard and rejects missing ID", () => {
        const state = publicFixture(); const ensureDirs = vi.fn();
        expect(() => docker.startProjectContainer(project, ensureDirs)).toThrow(
            "created container bind mount identity verification failed (container runtime did not return an exact 64-hex container ID)",
        );
        expect(ensureDirs).toHaveBeenCalledTimes(1);
        expect(native.authorityEvents).toEqual(["record", "begin", "run"]);
        expect(state.familyCalls).toBe(1);
        expect(native.family.mock.calls[0][0]).toBe(`mount-${docker.bindMountSourceIdentityDigest({ realpath: project, dev: "1", ino: "1" })}`);
        const run = native.spawn.mock.calls.find(call => call[1][0] === "run" && call[1][1] !== "--rm");
        expect(run?.[0]).toBe("captured-runtime");
        expect(run?.[2]).toEqual(createOptions);
        expect(run?.[1]).toContain("ccc.managed=true");
        expect(run?.[1]).toContain(`ccc.project.path=${project}`);
        expect(native.spawn.mock.calls.some(call => call[1][0] === "rm")).toBe(false);
        expect(native.spawn.mock.calls.filter(call => call[1].includes("{{.Id}}"))).toEqual([
            ["captured-runtime", ["inspect", IMAGE_NAME, "--format", "{{.Id}}"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" }],
        ]);
        expect(console.log).toHaveBeenCalledWith("Creating container...");
    });

    it.each([1, null])("preserves exact native failure hint/status %s through public facade", status => {
        const state = publicFixture(); state.createResult = result(status);
        expect(() => docker.startProjectContainer(project, () => {})).toThrow("Failed to create container");
        expect(console.error).toHaveBeenCalledExactlyOnceWith(docker.CONTAINER_INIT_UNAVAILABLE_HINT);
        expect(native.spawn.mock.calls.some(call => call[1][0] === "rm")).toBe(false);
    });

    it("refuses a namespace that appears between existing flow and family callback", () => {
        const state = publicFixture();
        native.family.mockImplementation((_prefix, operation) => { state.existing = true; return operation(); });
        expect(() => docker.startProjectContainer(project, () => {})).toThrow("appeared during creation preflight; refusing replacement.");
        expect(native.spawn.mock.calls.some(call => call[1][0] === "run" && call[1][1] !== "--rm")).toBe(false);
        expect(console.log).not.toHaveBeenCalledWith("Creating container...");
    });

    it.each([
        [1, "No such container", undefined, true],
        [2, "NO SUCH OBJECT", undefined, true],
        [0, "No such container", undefined, false],
        [null, "No such container", undefined, false],
        [1, "permission denied", undefined, false],
        [1, "No such container", new Error("native error"), false],
    ] as const)("requires completed native absence classification status=%s stderr=%s", (status, stderr, error, absent) => {
        const state = publicFixture(); state.swapProject = true; state.createResult = result(0, id);
        state.remaining = { ...result(status, "", stderr), ...(error ? { error } : {}) };
        const failure = thrown(() => docker.startProjectContainer(project, () => {})) as Error;
        const primary = `bind mount source identity changed: ${project}`;
        if (error || status === null) {
            expect(failure).toBeInstanceOf(AggregateError);
            expect(failure).toMatchObject({
                cause: {message: primary},
                errors: [{message: primary}, error ?? {message: "Rejected container absence inspection did not complete."}],
            });
        } else {
            expect(failure.message).toBe(absent ? primary : `${primary}; failed to remove rejected container ${id}`);
            if (!absent) expect((failure.cause as Error).message).toBe(primary);
        }
        const calls = native.spawn.mock.calls.filter(call => call[1][0] === "run" && call[1][1] !== "--rm" || call[1][0] === "rm" || call[1][0] === "inspect" && call[1].at(-1) === id && call[1].includes("{{.Id}}"));
        expect(calls.map(call => [call[0], call[1][0]])).toEqual([["captured-runtime", "run"], ["captured-runtime", "rm"], ["captured-runtime", "inspect"]]);
        expect(calls[1]).toEqual(["captured-runtime", ["rm", "-f", id], cleanupOptions]);
        expect(calls[2]).toEqual(["captured-runtime", ["inspect", "-f", "{{.Id}}", id], { ...cleanupOptions, timeout: 5000 }]);
    });

});

// Native context facts are required and remain synchronous, independent of native result types.
if (false) {
    declareContextContracts();
}
function declareContextContracts() {
    const ports = {} as SuppliedPorts;
    const context = {} as NativeContainerCreateLifecycleContext;
    const result: string = createNativeContainerCreateLifecycle(ports, context).run(request);
    const locked: string = ports.withFamilyLock("family", () => "native callback value");
    // @ts-expect-error Native context cannot be omitted.
    createNativeContainerCreateLifecycle(ports);
    // @ts-expect-error Warning facts remain synchronous.
    createNativeContainerCreateLifecycle(ports, { ...context, labWarning: async () => null });
    // @ts-expect-error Explicit absence classifier cannot be asynchronous.
    createNativeContainerCreateLifecycle(ports, { ...context, explicitlyNotFound: async () => true });
    // @ts-expect-error The original hint is required, avoiding a Docker import cycle.
    const incomplete: NativeContainerCreateLifecycleContext = { createCli: "cli", labWarning: () => null, explicitlyNotFound: () => true };
    // @ts-expect-error The supplied native lock stays synchronous and returns a string.
    createNativeContainerCreateLifecycle({ ...ports, withFamilyLock: async (_prefix, operation) => operation() }, context);
    // @ts-expect-error The supplied native callback stays synchronous.
    ports.withFamilyLock("family", async () => "native callback value");
    // @ts-expect-error Core outcomes cannot replace the supplied native lock's string ABI.
    createNativeContainerCreateLifecycle({ ...ports, withFamilyLock: (_prefix, _operation) => ({ kind: "completed", value: "native" }) }, context);
    void [incomplete, result, locked];
}
