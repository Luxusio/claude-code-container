import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn,
}));
vi.mock("../../container-runtime.js", async original => ({
    ...await original<typeof import("../../container-runtime.js")>(), runtimeCli: native.runtime,
}));
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
            order.push(`lock:${prefix}`); callback(); order.push("unlock"); return undefined;
        },
        sessionClaims: prefix => { order.push(`claims:${prefix}`); return []; },
        ensureRuntime: () => { order.push("runtime-ready"); },
        managedIdentity: (name, path) => {
            order.push(`identity:${name}:${path}`); return { containerId: id, running: true };
        },
        cleanupDevices: (path, timeout, profile) => {
            order.push(`cleanup:${path}:${timeout}:${String(profile)}`);
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
    native.lock.mockImplementation((prefix: string, callback: () => undefined) => {
        native.order.push(`lock:${prefix}`); callback(); native.order.push("unlock"); return "incidental";
    });
    native.cleanup.mockImplementation(() => { native.order.push("cleanup"); return { cleaned: true }; });
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

    it("selects the current runtime separately for exact-ID stop and plain rm with inherited stdio", () => {
        native.runtime.mockReturnValueOnce("docker").mockReturnValueOnce("podman");
        const f = fixture(); expect(f.lifecycle.remove("input")).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual([
            ["docker", ["stop", id], { stdio: "inherit", timeout: 30000, killSignal: "SIGKILL" }],
            ["podman", ["rm", id], { stdio: "inherit", timeout: 30000, killSignal: "SIGKILL" }],
        ]);
        expect(native.runtime).toHaveBeenCalledTimes(2);
        expect(native.order).toEqual([fixtureStopping, "log:Container stopped", fixtureRemoving, "log:Container removed"]);
        expect(f.order).toEqual([
            "resolve:input", "project:/full/project", "lock:project-id", "claims:project-id", "runtime-ready",
            "resolve:input", "name:/full/project:undefined", "resolve:input", "identity:fixture-container:/full/project",
            "resolve:input", "cleanup:/full/project:5000:undefined", "unlock",
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
        expect(cleanup).not.toHaveBeenCalled(); expect(native.runtime).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled(); expect(console.log).toHaveBeenCalledExactlyOnceWith("Container not found");
    });

    it.each(["stop", "remove"] as const)("%s rejects raw claims with the guard workspace and close/retry guidance before effects", operation => {
        const f = fixture({ sessionClaims: () => ["stale", "live"] });
        let failure: unknown;
        try { f.lifecycle[operation]("input"); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('Container for workspace "/full/project" has 2 session ownership claim(s); close its other CCC sessions and retry.');
        expect(f.order).toEqual(["resolve:input", "project:/full/project", "lock:project-id"]);
        expect(native.order).toEqual([]); expect(native.runtime).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
    });

    it.each(["stop", "remove"] as const)("%s formats Error and non-Error device cleanup warnings then continues", operation => {
        for (const failure of [new Error("device-cleanup"), "device-cleanup", null, undefined]) {
            native.order.length = 0;
            const f = fixture({ cleanupDevices: () => { throw failure; } });
            f.lifecycle[operation]("input");
            const detail = failure instanceof Error ? failure.message : String(failure);
            expect(native.order[0]).toBe(`error:[ccc] device cleanup failed before container stop: ${detail}`);
            expect(native.order.at(-1)).toBe(operation === "stop" ? "log:Container stopped" : "log:Container removed");
        }
    });

    it.each(["stop", "remove"] as const)("%s preserves a cleanup warning conversion failure before dispatch", operation => {
        const failure = new Error("string-conversion");
        const f = fixture({ cleanupDevices: () => { throw { toString: () => { throw failure; } }; } });
        expect(() => f.lifecycle[operation]("input")).toThrow(failure);
        expect(native.spawn).not.toHaveBeenCalled(); expect(console.log).not.toHaveBeenCalled();
    });

    const failedResults = [{ status: 1 }, { status: null }, { status: 0, error: new Error("native-error") }];
    for (const operation of ["stop", "rm"] as const) {
        it.each(failedResults)(`retains ${operation} result failure and suppresses later dispatch/success: %j`, result => {
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
        expect(native.spawn).not.toHaveBeenCalled(); expect(console.log).toHaveBeenCalledExactlyOnceWith('Stopping container "fixture-container" for workspace "/full/project"...');
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
            return { status: 0, stdout: args[0] === "inspect" ? identity(running, managed) : "", stderr: "" };
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
            `lock:${prefix}`, `claims:${prefix}`, "native:info", "native:inspect", "cleanup",
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
        expect(execute(root, undefined, { force: true })).toBeUndefined();
        expect(native.cleanup).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(["info", "inspect"]);
        expect(console.log).toHaveBeenCalledExactlyOnceWith("Container not found");
    });

    it("discards cleanup report, preserves warning and stopped remove behavior", () => {
        provider(false); native.cleanup.mockImplementation(() => { throw new Error("cleanup-failed"); });
        expect(removeProjectContainer(root)).toBeUndefined();
        expect(console.error).toHaveBeenCalledExactlyOnceWith("[ccc] device cleanup failed before container stop: cleanup-failed");
        expect(console.log).not.toHaveBeenCalledWith("Container stopped");
        expect(native.spawn.mock.calls.filter(call => ["stop", "rm"].includes(call[1][0]))).toEqual([["docker", ["rm", id], { stdio: "inherit", timeout: 30000, killSignal: "SIGKILL" }]]);
    });
});
