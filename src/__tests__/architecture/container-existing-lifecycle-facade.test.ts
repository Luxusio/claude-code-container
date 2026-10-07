import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContainerRestartRequiredError } from "../../container-restart-guidance.js";
import { createNativeContainerExistingLifecycle } from "../../composition/container-existing-lifecycle.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), runtime: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn,
}));
vi.mock("../../container-runtime.js", () => ({ runtimeCli: native.runtime }));

const id = "a".repeat(64);
const name = "fixture-container";
type SuppliedPorts = Parameters<typeof createNativeContainerExistingLifecycle>[0];

function fixture(overrides: Partial<SuppliedPorts> = {}) {
    const order: string[] = [];
    const effect = (label: string): (() => undefined) => () => { order.push(label); };
    const ports: SuppliedPorts = {
        listContainer: vi.fn(() => ({ known: true, containerId: id })),
        identity: vi.fn(() => ({ containerId: id, running: false })),
        managedIdentity: vi.fn(() => ({ containerId: id, running: true })),
        assertProjectSources: effect("project"),
        assertDeviceSources: effect("device"),
        assertFilesystemSources: effect("filesystem"),
        inspectContract: vi.fn(() => true),
        verifyBeforeSetup: effect("live"),
        safeToDefer: vi.fn(() => true),
        isRunning: vi.fn(() => true),
        canExec: vi.fn(() => true),
        canExecAfterBriefRetry: vi.fn(() => true),
        deviceSourcesMatch: vi.fn(() => true),
        syncMcp: effect("mcp"), fixSsh: effect("ssh"), syncGit: effect("git"),
        finish: vi.fn<SuppliedPorts["finish"]>((exactId) => { order.push(`finish:${exactId}`); }),
        ...overrides,
    };
    const destinations = vi.fn(() => ["/fixture/project", "/fixture/auth"]);
    const context: Parameters<typeof createNativeContainerExistingLifecycle>[1] = {
        startCli: "captured-runtime", requiredMountDestinations: destinations,
        projectPath: "/fixture/project", profile: "work",
    };
    return { order, ports, context, destinations, lifecycle: createNativeContainerExistingLifecycle(ports, context) };
}

describe("existing container application through native composition", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        native.runtime.mockReturnValue("podman");
        native.spawn.mockReturnValue({ status: 0 });
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it("constructs without observations, runtime selection, subprocesses or presentation", () => {
        const f = fixture();
        expect(f.order).toEqual([]);
        for (const value of Object.values(f.ports)) {
            if (vi.isMockFunction(value)) expect(value).not.toHaveBeenCalled();
        }
        expect(f.destinations).not.toHaveBeenCalled();
        expect(native.runtime).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("reuses exact identity through separate synchronization and the shared finish", () => {
        const f = fixture();
        expect(f.lifecycle.run({ containerName: name, debug: true })).toEqual({ kind: "joined", containerId: id });
        expect(f.order).toEqual(["project", "device", "filesystem", "project", "device", "filesystem", "live", "mcp", "ssh", "git", `finish:${id}`]);
        expect(f.ports.canExec).toHaveBeenCalledExactlyOnceWith(id);
        expect(f.ports.canExecAfterBriefRetry).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledExactlyOnceWith(`[ccc:debug] Container ${name} has all required mounts`);
        expect(native.runtime).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
    });

    it("uses captured runtime only for pinned restart, with inherited stdio", () => {
        const f = fixture({ isRunning: () => false });
        expect(f.lifecycle.run({ containerName: name, debug: true })).toEqual({ kind: "joined", containerId: id });
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("captured-runtime", ["start", id], { stdio: "inherit" });
        expect(native.runtime).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenNthCalledWith(2, `[ccc:debug] Container ${name} exists, restarting`);
        expect(f.order.slice(-4)).toEqual(["mcp", "ssh", "git", `finish:${id}`]);
    });

    it.each([{ status: 1 }, { status: null }, { status: 0, error: new Error("start denied") }])("refuses restart failure without synchronization/removal: %j", result => {
        native.spawn.mockReturnValue(result);
        const f = fixture({ isRunning: () => false });
        expect(() => f.lifecycle.run({ containerName: name })).toThrow("Stopped container could not be restarted; automatic replacement was refused.");
        expect(native.spawn).toHaveBeenCalledTimes(1);
        expect(f.ports.finish).not.toHaveBeenCalled();
        expect(f.order).not.toContain("mcp");
        expect(native.runtime).not.toHaveBeenCalled();
    });

    it("defers a safe mismatch on the startup-running ID even when the guard authorizes replacement", () => {
        const f = fixture({ inspectContract: () => false });
        const recreate = vi.fn();
        const guard = vi.fn((replace: () => void) => { replace(); return true; });
        expect(f.lifecycle.run({ containerName: name, managedProjectPath: "/fixture/project", initiallyRunningContainerId: id, replacementGuard: guard, onRecreate: recreate })).toEqual({ kind: "joined", containerId: id });
        expect(guard).toHaveBeenCalledTimes(1);
        expect(f.ports.managedIdentity).not.toHaveBeenCalled();
        expect(f.ports.identity).toHaveBeenCalledExactlyOnceWith(name);
        expect(native.runtime).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
        expect(recreate).not.toHaveBeenCalled();
        expect(f.ports.safeToDefer).toHaveBeenCalledExactlyOnceWith(id, expect.any(Function));
        expect(f.ports.finish).toHaveBeenCalledExactlyOnceWith(id);
        expect(f.order.slice(-3)).toEqual(["ssh", "git", `finish:${id}`]);
        expect(f.order).not.toContain("mcp");
    });
    it("uses ordinary non-force removal on the captured stopped path without stop or managed reinspection", () => {
        const f = fixture();
        expect(f.lifecycle.replace({ containerName: name, expectedContainerId: id, reason: "changed", replacementGuard: operation => { operation(); return true; } })).toBe(true);
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("podman", ["rm", id], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
        expect(f.ports.managedIdentity).not.toHaveBeenCalled();
    });

    it.each([{ status: 1 }, { status: null }, { status: 0, error: new Error("remove denied") }])("preserves stopped removal failure, suppressing callbacks: %j", result => {
        const f = fixture();
        native.spawn.mockReturnValue(result);
        const recreated = vi.fn();
        expect(() => f.lifecycle.replace({ containerName: name, expectedContainerId: id, managedProjectPath: "/fixture/project", reason: "changed", replacementGuard: replace => { replace(); return true; }, onRecreate: recreated })).toThrow("Container replacement aborted because the stopped container could not be removed.");
        expect(recreated).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(["rm"]);
        expect(console.log).toHaveBeenCalledTimes(1);
        expect(vi.mocked(f.ports.identity).mock.calls).toEqual([[name], [id]]);
        expect(f.ports.managedIdentity).not.toHaveBeenCalled();
    });

    it.each([null, { containerId: "successor", running: false }, { containerId: id, running: true }])("preserves last-check disappearance, successor or external start without native effects: %j", current => {
        const identity = vi.fn<SuppliedPorts["identity"]>().mockReturnValueOnce({ containerId: id, running: false }).mockReturnValueOnce(current);
        const f = fixture({ identity });
        expect(f.lifecycle.replace({ containerName: name, expectedContainerId: id, reason: "changed", replacementGuard: replace => { replace(); return true; } })).toBe(false);
        expect(identity.mock.calls).toEqual([[name], [id]]);
        expect(f.ports.managedIdentity).not.toHaveBeenCalled();
        expect(native.runtime).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
    });

    it("refuses an initially observed running container even when the guard later stops it", () => {
        const identity = vi.fn<SuppliedPorts["identity"]>().mockReturnValue({ containerId: id, running: true });
        const f = fixture({ identity });
        expect(f.lifecycle.replace({ containerName: name, reason: "changed", replacementGuard: replace => {
            identity.mockReturnValue({ containerId: id, running: false }); replace(); return true;
        } })).toBe(false);
        expect(identity).toHaveBeenCalledExactlyOnceWith(name);
        expect(native.spawn).not.toHaveBeenCalled();
        expect(native.runtime).not.toHaveBeenCalled();
    });

    it("runs the removal boundary before native execution and preserves its failure identity", () => {
        const failure = new Error("project root changed");
        const f = fixture();
        f.context.beforeRemove = () => { throw failure; };
        expect(() => f.lifecycle.replace({ containerName: name, reason: "changed", replacementGuard: replace => { replace(); return true; } })).toThrow(failure);
        expect(native.runtime).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
    });

    it("runs restart boundaries around captured-runtime start before synchronization", () => {
        const f = fixture({ isRunning: () => false });
        f.context.beforeStart = () => { f.order.push("before-start"); };
        f.context.afterStart = exactId => { f.order.push(`after-start:${exactId}`); };
        native.spawn.mockImplementation(() => { f.order.push("native-start"); return { status: 0 }; });
        expect(f.lifecycle.run({ containerName: name })).toEqual({ kind: "joined", containerId: id });
        expect(f.order.slice(-8)).toEqual(["before-start", "native-start", `after-start:${id}`, "live", "mcp", "ssh", "git", `finish:${id}`]);
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("captured-runtime", ["start", id], { stdio: "inherit" });
    });
    it("reads required destinations only when reporting a mismatch and safely defers without MCP", () => {
        const f = fixture({ inspectContract: (_id, report) => { report("credential mount changed"); return false; } });
        f.destinations.mockReturnValue(["/updated/destination"]);
        expect(f.lifecycle.run({ containerName: name, debug: true, replacementGuard: () => false })).toEqual({ kind: "joined", containerId: id });
        expect(vi.mocked(console.error).mock.calls).toEqual([
            [`[ccc:debug] Container ${name} missing required mounts or VM run contract:`],
            ["[ccc:debug]   required destination: /updated/destination"],
        ]);
        expect(console.warn).toHaveBeenCalledExactlyOnceWith("[ccc] Container update deferred (credential mount changed) because the existing container is running. It will be applied after the container stops.");
        expect(f.order.slice(-3)).toEqual(["ssh", "git", `finish:${id}`]);
        expect(f.order).not.toContain("mcp");
        expect(native.spawn).not.toHaveBeenCalled();
        expect(native.runtime).not.toHaveBeenCalled();
    });

    it("throws the original restart-guidance class with runtime selected at the unsafe-defer point", () => {
        const f = fixture({ inspectContract: () => false, safeToDefer: (_id, report) => { report("unsafe project source"); return false; } });
        let failure: unknown;
        try { f.lifecycle.run({ containerName: name, replacementGuard: () => false }); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(ContainerRestartRequiredError);
        expect(failure).toMatchObject({ name: "ContainerRestartRequiredError", reason: "unsafe project source", workspacePath: "/fixture/project", runtime: "podman", profile: "work" });
        expect(native.runtime).toHaveBeenCalledTimes(1);
        expect(native.spawn).not.toHaveBeenCalled();
        expect(f.ports.finish).not.toHaveBeenCalled();
    });

    it("propagates shared finish failure after synchronization without a second join or recreation", () => {
        const failure = new Error("Container identity changed before session handoff; refusing to join.");
        const f = fixture({ finish: () => { throw failure; } });
        expect(() => f.lifecycle.run({ containerName: name })).toThrow(failure);
        expect(f.order.slice(-3)).toEqual(["mcp", "ssh", "git"]);
        expect(native.spawn).not.toHaveBeenCalled();
    });

    it("keeps repeated guarded replacement effects and false-after-success semantics", () => {
        const f = fixture();
        const callback = vi.fn();
        expect(f.lifecycle.replace({ containerName: name, reason: "changed", replacementGuard: replace => { replace(); replace(); return false; }, onRecreate: callback })).toBe(false);
        expect(native.spawn.mock.calls).toEqual([
            ["podman", ["rm", id], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }],
            ["podman", ["rm", id], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }],
        ]);
        expect(callback).toHaveBeenCalledTimes(2);
    });

    it("does not fabricate rollback when recreation callback throws after successful removal", () => {
        const failure = new Error("caller refused after removal");
        const f = fixture();
        expect(() => f.lifecycle.replace({ containerName: name, reason: "changed", replacementGuard: replace => { replace(); return true; }, onRecreate: () => { throw failure; } })).toThrow(failure);
        expect(native.spawn).toHaveBeenCalledTimes(1);
        expect(native.spawn.mock.calls[0][1]).toEqual(["rm", id]);
    });
});
