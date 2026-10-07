import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncReturns } from "child_process";
import { createNativeContainerCreateLifecycle } from "../../composition/container-create-lifecycle.js";
import type { NativeContainerCreateLifecycleContext } from "../../composition/container-create-lifecycle.js";

const native = vi.hoisted(() => ({
    spawn: vi.fn(), runtime: vi.fn(), remote: vi.fn(), family: vi.fn(),
    exists: vi.fn(), stat: vi.fn(), lstat: vi.fn(), read: vi.fn(), write: vi.fn(),
    realpath: vi.fn(), mkdir: vi.fn(), open: vi.fn(), fstat: vi.fn(), close: vi.fn(), rm: vi.fn(),
}));
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
vi.mock("../../container-runtime.js", () => ({
    runtimeCli: native.runtime,
    isContainerHostRemote: native.remote,
    getRuntimeInfo: () => ({ runtime: "docker", dockerDesktop: false }),
    runtimeExtraRunArgs: () => [],
    bindMountArgs: (host: string, container: string, options?: { readonly?: boolean }) => ["-v", `${host}:${container}${options?.readonly ? ":ro" : ""}`],
}));
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
        if (!/^\/fixture\/home\/\.ccc\/(?:codex-state\.lock|run\/locks\/identity-[a-f0-9]{64}\.lock)$/.test(path)) throw new Error("unexpected fixture lock IO");
        expect(operation).toBeTypeOf("function");
        expect(options).toEqual({ waitMs: path.endsWith("codex-state.lock") ? 600_000 : 1_260_000, reclaimStale: false });
        return operation();
    },
}));

const id = "A".repeat(64);
const name = "fixture-container";
const request = { containerName: name, projectMountIdentity: "physical" };
const createOptions = { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"] };
const cleanupOptions = { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] };
type SuppliedPorts = Parameters<typeof createNativeContainerCreateLifecycle>[0];

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
        prepareRunArgs: vi.fn(() => { order.push("args"); return args; }),
        assertProjectSources: effect("project"), assertDeviceSources: effect("device"),
        assertFilesystemSources: effect("filesystem"),
        verifyCreated: vi.fn(() => ({ kind: "verified", via: "identity" } as const)),
        syncMcp: vi.fn(effect("mcp")), fixSsh: vi.fn(effect("ssh")), syncGit: vi.fn(effect("git")),
        finish: vi.fn((target: string) => { order.push(`finish:${target}`); return "public-name"; }),
        ...overrides,
    };
    const context: NativeContainerCreateLifecycleContext = {
        createCli: "captured-runtime", createFailureHint: "original-init-hint",
        labWarning: vi.fn(() => { order.push("warning-fact"); return null; }),
        explicitlyNotFound: vi.fn(() => true),
    };
    return { order, args, ports, context, lifecycle: createNativeContainerCreateLifecycle(ports, context) };
}

beforeEach(() => {
    vi.resetAllMocks();
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
            expect(f.ports.prepareRunArgs).not.toHaveBeenCalled();
            expect(native.spawn).not.toHaveBeenCalled();
        }
        expect(console.log).not.toHaveBeenCalled();
    });

    it.each([1, null])("native status %s does not read stdout or native error", status => {
        const accesses: string[] = [];
        native.spawn.mockReturnValue({
            get status() { accesses.push("status"); return status; },
            get stdout(): never { accesses.push("stdout"); throw new Error("eager stdout"); },
            get error(): never { throw new Error("error field read"); },
        });
        const f = fixture();
        expect(() => f.lifecycle.run(request)).toThrow("Failed to create container");
        expect(accesses).toEqual(["status"]);
        expect(console.error).toHaveBeenCalledExactlyOnceWith("original-init-hint");
        expect(native.spawn).toHaveBeenCalledTimes(1);
        expect(f.context.explicitlyNotFound).not.toHaveBeenCalled();
    });

    it("status zero ignores the native error field and reads stdout after status", () => {
        const accesses: string[] = [];
        native.spawn.mockReturnValue({
            get status() { accesses.push("status"); return 0; },
            get stdout() { accesses.push("stdout"); return `pull noise\n${id}\n`; },
            get error(): never { throw new Error("error field read"); },
        });
        expect(fixture().lifecycle.run(request)).toBe("public-name");
        expect(accesses).toEqual(["status", "stdout"]);
        expect(console.error).not.toHaveBeenCalled();
    });

    it("compensates only the exact ID with captured CLI and independent absence classification", () => {
        const original = new Error("source swapped");
        const absentResult = result(1, "", "no such container");
        native.spawn.mockReturnValueOnce(result(0, id)).mockReturnValueOnce({ status: 1, error: new Error("rm failed") }).mockReturnValueOnce(absentResult);
        const f = fixture({ verifyCreated: () => { native.runtime.mockReturnValue("changed-runtime"); throw original; } });
        expect(thrown(() => f.lifecycle.run(request))).toBe(original);
        expect(native.spawn.mock.calls).toEqual([
            ["captured-runtime", f.args, createOptions],
            ["captured-runtime", ["rm", "-f", id], cleanupOptions],
            ["captured-runtime", ["inspect", "-f", "{{.Id}}", id], cleanupOptions],
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

    it.each(["create", "stdout", "remove", "inspect", "classifier"])("propagates native %s throw at original boundary", stage => {
        const original = new Error("verification failed"); const failure = { stage };
        const f = fixture({ verifyCreated: () => { throw original; } });
        native.spawn.mockImplementation((_cli, args: string[]) => {
            if (args[0] === "run") {
                if (stage === "create") throw failure;
                return { status: 0, get stdout() { if (stage === "stdout") throw failure; return id; } };
            }
            if (args[0] === "rm" && stage === "remove") throw failure;
            if (args[0] === "inspect" && stage === "inspect") throw failure;
            return result();
        });
        if (stage === "classifier") f.context.explicitlyNotFound = () => { throw failure; };
        expect(thrown(() => f.lifecycle.run(request))).toBe(failure);
        expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(
            stage === "create" || stage === "stdout" ? ["run"] : stage === "remove" ? ["run", "rm"] : ["run", "rm", "inspect"],
        );
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
const project = "/fixture/project";

function publicFixture() {
    const identity = containerIdentity.resolveContainerIdentity();
    const identityLabels = { ...containerIdentity.getIdentityLabels(identity), "ccc.identity.base": baseImageId };
    const state = {
        createResult: result(0, "short-id"), remaining: result(1, "", "No such container"),
        changed: false, swapProject: false, currentCli: "captured-runtime",
        familyCalls: 0, existing: false, runArgs: [] as string[], invalidMount: false,
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
    native.write.mockImplementation((path: string, content: string) => { markers.set(path.slice(path.lastIndexOf("/") + 1), content); });
    native.open.mockReturnValue(1);
    native.family.mockImplementation((_prefix, operation) => { state.familyCalls++; return operation(); });
    native.spawn.mockImplementation((_cli, args: string[], options?: { encoding?: string | null }) => {
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
            state.runArgs = [...args];
            state.changed = state.swapProject;
            state.currentCli = "changed-runtime";
            return state.createResult;
        }
        if (args[0] === "ps" && args[1] === "-aq") return result(0, state.existing ? id : "");
        if (args[0] === "ps" && args[1] === "-q") return result(0, state.existing ? id : "");
        if (args[0] === "inspect" && args.includes("{{.State.Running}}")) return result(0, state.existing ? "true" : "false");
        if (args[0] === "inspect" && args.includes("{{.Id}}|{{.State.Running}}")) return result(0, `${id}|true`);
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
                    mounts.push({ Source: match[1], Destination: match[2], Type: state.invalidMount && match[1] === project ? "tmpfs" : match[1].startsWith("/") ? "bind" : "volume", RW: !value.endsWith(":ro") });
                }
                if (argument === "--tmpfs") mounts.push({ Source: "", Destination: value.split(":")[0], Type: "tmpfs", RW: true });
                if (argument === "--label") labels[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
                if (argument === "-e") env.push(value);
            }
            return result(0, JSON.stringify({ Id: id, Image: identityImageId, State: { Running: true }, Mounts: mounts, Config: { Labels: labels, Env: env, User: "ccc" }, HostConfig: { Init: true, Devices: [], DeviceRequests: [], GroupAdd: [], Privileged: false } }));
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
    it("rejects unexpected fixture lock paths before calling an operation", () => {
        const operation = vi.fn();
        expect(() => sharedState.withSharedMutationLock("/unexpected/private.lock", operation)).toThrow("unexpected fixture lock IO");
        expect(operation).not.toHaveBeenCalled();
    });

    it("publishes verified start before helper failure without firing final ready", () => {
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
        expect(ready).not.toHaveBeenCalled();
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
    it("creates, verifies, synchronizes with current runtime and returns the unchanged public name", () => {
        const state = publicFixture(); state.createResult = result(0, id);
        const ready = vi.fn();
        expect(docker.startProjectContainer(project, () => {}, undefined, undefined, undefined, undefined, undefined, ready)).toBe(docker.getContainerName(project));
        expect(ready).toHaveBeenCalledExactlyOnceWith(id, { startedByInvocation: true });
        expect(state.familyCalls).toBe(1);
        const run = native.spawn.mock.calls.find(call => call[1][0] === "run" && call[1][1] !== "--rm");
        expect(run?.[0]).toBe("captured-runtime");
        const proof = native.spawn.mock.calls.find(call => call[1].includes("{{json .}}"));
        expect(proof?.[0]).toBe("changed-runtime");
        expect(proof?.[1]).toEqual(["inspect", "-f", "{{json .}}", id]);
        const ssh = native.spawn.mock.calls.filter(call => call[1][0] === "exec" && call[1][2] === "sh" && !call[1][4]?.includes('$(id -un)'));
        expect(ssh).toHaveLength(1);
        expect(ssh[0][1]).toContain("ccc-ssh-copy");
        expect(native.spawn.mock.calls.filter(call => call[1][0] === "exec" && call[1][4]?.includes('$(id -un)'))).toHaveLength(1);
        expect(ssh.every(call => call[0] === "changed-runtime" && call[1][1] === id)).toBe(true);
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
                "warn:[ccc] lab-runner profile requested but nested VM support is unavailable: /dev/kvm is not available on the container host",
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
        expect(state.familyCalls).toBe(1);
        expect(native.family.mock.calls[0][0]).toBe(`mount-${docker.bindMountSourceIdentityDigest({ realpath: project, dev: "1", ino: "1" })}`);
        const run = native.spawn.mock.calls.find(call => call[1][0] === "run" && call[1][1] !== "--rm");
        expect(run?.[0]).toBe("captured-runtime");
        expect(run?.[2]).toEqual(createOptions);
        expect(run?.[1]).toContain("ccc.managed=true");
        expect(run?.[1]).toContain(`ccc.project.path=${project}`);
        expect(native.spawn.mock.calls.some(call => call[1][0] === "rm")).toBe(false);
        expect(native.spawn.mock.calls.filter(call => call[1].includes("{{.Id}}"))).toEqual([
            ["captured-runtime", ["inspect", IMAGE_NAME, "--format", "{{.Id}}"], cleanupOptions],
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
    ] as const)("uses unchanged explicit absence classifier status=%s stderr=%s", (status, stderr, error, absent) => {
        const state = publicFixture(); state.swapProject = true; state.createResult = result(0, id);
        state.remaining = { ...result(status, "", stderr), ...(error ? { error } : {}) };
        const failure = thrown(() => docker.startProjectContainer(project, () => {})) as Error;
        const primary = `bind mount source identity changed: ${project}`;
        expect(failure.message).toBe(absent ? primary : `${primary}; failed to remove rejected container ${id}`);
        if (!absent) expect((failure.cause as Error).message).toBe(primary);
        const calls = native.spawn.mock.calls.filter(call => call[1][0] === "run" && call[1][1] !== "--rm" || call[1][0] === "rm" || call[1][0] === "inspect" && call[1].at(-1) === id && call[1].includes("{{.Id}}"));
        expect(calls.map(call => [call[0], call[1][0]])).toEqual([["captured-runtime", "run"], ["captured-runtime", "rm"], ["captured-runtime", "inspect"]]);
        expect(calls[1]).toEqual(["captured-runtime", ["rm", "-f", id], cleanupOptions]);
        expect(calls[2]).toEqual(["captured-runtime", ["inspect", "-f", "{{.Id}}", id], cleanupOptions]);
    });

    it("retains lazy run argument environment observations after Creating output", () => {
        publicFixture(); const observations: string[] = [];
        vi.mocked(console.log).mockImplementation(message => {
            if (message === "Creating container...") { observations.push("creating"); vi.stubEnv("CCC_DISABLE_PROXY", "1"); }
        });
        native.remote.mockImplementation(() => { observations.push("remote"); return true; });
        expect(() => docker.startProjectContainer(project, () => {})).toThrow("exact 64-hex container ID");
        const args = native.spawn.mock.calls.find(call => call[1][0] === "run" && call[1][1] !== "--rm")?.[1] as string[];
        expect(args).not.toContain("CCC_PROXY_ENABLED=1");
        expect(args).toContain("CCC_CONTAINER_HOST_REMOTE=1");
        expect(observations.slice(-3)).toEqual(["creating", "remote", "remote"]);
    });
});

// Native context facts are required and remain synchronous, independent of native result types.
if (false) {
    declareContextContracts();
}
function declareContextContracts() {
    const ports = {} as SuppliedPorts;
    const context = {} as NativeContainerCreateLifecycleContext;
    // @ts-expect-error Native context cannot be omitted.
    createNativeContainerCreateLifecycle(ports);
    // @ts-expect-error Warning facts remain synchronous.
    createNativeContainerCreateLifecycle(ports, { ...context, labWarning: async () => null });
    // @ts-expect-error Explicit absence classifier cannot be asynchronous.
    createNativeContainerCreateLifecycle(ports, { ...context, explicitlyNotFound: async () => true });
    // @ts-expect-error The original hint is required, avoiding a Docker import cycle.
    const incomplete: NativeContainerCreateLifecycleContext = { createCli: "cli", labWarning: () => null, explicitlyNotFound: () => true };
    void incomplete;
}
