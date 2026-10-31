import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContainerRestartRequiredError } from "../../container-restart-guidance.js";
import { createNativeContainerExistingLifecycle } from "../../composition/container-existing-lifecycle.js";
import { createContainerMountVerification } from "../../application/container-mount-verification.js";
import { createContainerRunContract } from "../../application/container-run-contract.js";
import type { ObservedMountContract, RequiredMountContract } from "../../bind-mount-verification.js";
import type { ContractInspection } from "../../ports/container-run-contract.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), runtime: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn,
}));
vi.mock("../../container-runtime.js", async () => {
    const { validateNativeRuntimeInvocation } = await import("../../adapters/container-runtime-invocation.js");
    const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../../ports/container-runtime-invocation.js");
    const invocation = validateNativeRuntimeInvocation({
        version: 1, runtime: "podman", executable: "/fixture/runtime/podman",
        transport: { kind: "podman-local", graphRoot: "/fixture/storage", runRoot: "/fixture/run",
            storageDriver: "overlay", storageOptions: [], transientStore: false },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
    });
    // This unit owner supplies the process leaf explicitly; emitted integration owns native routing.
    const runner = () => { const capturedCli = "podman"; return { invocation,
        spawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => native.spawn(capturedCli, args, options),
    }; };
    return { ...({ runtimeCli: native.runtime }), getRuntimeInvocation: () => invocation, bindNativeRuntimeInvocation: runner,
        runtimeSpawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => runner().spawnSync(args, options),
        runWithNativeRuntimeInvocation: <T>(_invocation: unknown, operation: () => T): T => operation() };
});

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
        startCli: "podman", requiredMountDestinations: destinations,
        projectPath: "/fixture/project", profile: "work",
    };
    return { order, ports, context, destinations, lifecycle: createNativeContainerExistingLifecycle(ports, context) };
}

describe("existing container application through native composition", () => {
    it.each(["start", "remove"] as const)("preserves native %s timeout cause without namespace compensation", operation => {
        const failure = Object.assign(new Error("runtime timed out"), {code: "ETIMEDOUT"});
        native.spawn.mockReturnValue({status: null, error: failure});
        const f = fixture({isRunning: () => false});
        let caught: unknown;
        try {
            if (operation === "start") f.lifecycle.run({containerName: name});
            else f.lifecycle.replace({containerName: name, expectedContainerId: id, reason: "changed", replacementGuard: replace => { replace(); return true; }});
        } catch (error) { caught = error; }
        expect(caught).toMatchObject({cause: failure});
        expect(native.spawn.mock.calls.map(call => call[1])).toEqual([[operation === "start" ? "start" : "rm", id]]);
        expect(native.spawn.mock.calls[0][2]).toMatchObject({timeout: operation === "remove" ? 120000 : 30000});
        expect(f.ports.finish).not.toHaveBeenCalled(); expect(f.order).not.toContain("mcp");
    });
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
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("podman", ["start", id], { stdio: "inherit", timeout: 30000, killSignal: "SIGKILL" });
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
        const f = fixture({ inspectContract: () => false, identity: vi.fn(() => ({ containerId: id, running: true })) });
        const recreate = vi.fn();
        const guard = vi.fn((replace: () => void) => { replace(); return true; });
        expect(f.lifecycle.run({ containerName: name, managedProjectPath: "/fixture/project", initiallyRunningContainerId: id, replacementGuard: guard, onRecreate: recreate })).toEqual({ kind: "joined", containerId: id });
        expect(guard).toHaveBeenCalledTimes(1);
        expect(f.ports.managedIdentity).not.toHaveBeenCalled();
        expect(vi.mocked(f.ports.identity).mock.calls).toEqual([[name], [id]]);
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
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("podman", ["rm", id], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, killSignal: "SIGKILL" });
        expect(f.ports.managedIdentity).not.toHaveBeenCalled();
    });

    it("publishes intent before the captured ordinary stop and prepares retained state only after stopped proof", () => {
        let running = true;
        const f = fixture({
            inspectContract: (_id, report) => { report("missing mount /project/repo/nested/.git"); return false; },
            safeToDefer: (_id, report) => { report("missing mount /project/repo/nested/.git"); return false; },
            identity: vi.fn(() => ({ containerId: id, running })),
            managedIdentity: vi.fn(() => ({ containerId: id, running })),
            isRunning: () => running,
        });
        f.context.beforeStop = () => { f.order.push("intent"); };
        f.context.beforeRemove = () => {
            expect(running).toBe(false);
            f.order.push("retained-state");
        };
        native.spawn.mockImplementation((cli: string, args: readonly string[]) => {
            expect(cli).toBe("podman");
            if (args[0] === "stop") { expect(running).toBe(true); f.order.push("stop"); running = false; }
            else { expect(args[0]).toBe("rm"); expect(running).toBe(false); f.order.push("remove"); }
            return { status: 0 };
        });
        native.runtime.mockReturnValue("docker");
        const recreated = vi.fn();
        expect(f.lifecycle.run({ containerName: name, managedProjectPath: "/fixture/project",
            initiallyRunningContainerId: id, replacementGuard: operation => { operation(); return true; }, onRecreate: recreated,
        })).toEqual({ kind: "continue-to-create" });
        expect(native.spawn.mock.calls.map(call => call.slice(0, 2))).toEqual([
            ["podman", ["stop", id]], ["podman", ["rm", id]],
        ]);
        expect(native.spawn.mock.calls[0][2]).toMatchObject({ timeout: 30000, killSignal: "SIGKILL" });
        expect(native.spawn.mock.calls[1][2]).toMatchObject({ timeout: 120000, killSignal: "SIGKILL" });
        expect(f.order.indexOf("intent")).toBeLessThan(f.order.indexOf("stop"));
        expect(f.order.indexOf("stop")).toBeLessThan(f.order.indexOf("retained-state"));
        expect(f.order.indexOf("retained-state")).toBeLessThan(f.order.indexOf("remove"));
        expect(recreated).toHaveBeenCalledTimes(1);
        expect(f.ports.finish).not.toHaveBeenCalled();
        expect(native.runtime).not.toHaveBeenCalled();
    });

    it.each(["missing-first", "unavailable-first"] as const)("preserves the running container when real missing-mount evidence also contains unavailable proof (%s)", order => {
        const root: RequiredMountContract = { containerPath: "/fixture/project", type: "bind", readonly: false, presence: "core", sourceKind: "filesystem" };
        const missing = { ...root, containerPath: "/fixture/project/nested/.git" };
        const observed: ObservedMountContract[] = [{ sourceState: "present", containerPath: root.containerPath, type: "bind", writable: true }];
        const mounts = createContainerMountVerification(order === "missing-first" ? [missing, root] : [root, missing], {
            resetAttempt: () => {}, cleanup: () => {},
            observeHostIdentity: () => ({ kind: "verified", via: "identity" }),
            observeSource: () => ({ kind: "filesystem", pathMatch: "match" }),
            proveFilesystem: () => ({ kind: "retryable", reason: "root live source proof unavailable" }),
            proveDaemon: () => { throw new Error("unexpected daemon proof"); },
            inspectCreated: () => { throw new Error("unexpected created-container inspection"); },
            requiresFinalDaemonProof: () => false,
            withRetry: operation => operation(true),
        });
        const image = `sha256:${"1".repeat(64)}`;
        const observation: ContractInspection = {
            runningState: () => "running", imageId: () => image, containerId: () => id,
            identityLabels: () => ({ version: "1", uid: "1000", gid: "1000", mapping: "host" }),
            environment: () => ({ labRunner: "1", labStatus: "unsupported", labStateDirectory: "/lab", labNetworkMode: "user" }),
            hostConfiguration: () => ({ privileged: false, initEnabled: () => true, deviceRequestsPresent: () => false,
                kvmReferencePresent: () => false, devices: () => [], groups: () => [], groupCount: () => 0 }),
            managedLabel: () => "true", projectPathIdentity: () => "matching",
            projectMountIdentity: () => ({ kind: "missing" }), deviceLabMountIdentity: () => ({ kind: "missing" }),
            brokerAuthMountPresent: () => false,
            verifyMounts: mode => {
                if (mode === "stopped-preflight") throw new Error("unexpected stopped preflight");
                return mounts.verifyExisting(observed, mode);
            },
        };
        let report = (_reason: string): void => {};
        const contract = createContainerRunContract({ containerId: id,
            identity: { uid: 1000, gid: 1000, mapping: "host", contractVersion: "1" },
            labRunner: { status: "unsupported", stateVolumeName: "lab", stateContainerDir: "/lab", networkMode: "user" },
            brokerAuthContainerPath: "/run/broker-auth",
        }, {
            inspect: () => observation, effectiveUserMatches: () => true, brokerAuthMountRequired: () => false,
            report: reason => report(reason), debugStrictFailure: () => {}, isRuntimeUnavailable: () => false,
        });
        // Admission still refuses the missing core mount. A separate unavailable live proof
        // must reach lifecycle as unknown rather than authorizing destructive repair.
        expect(mounts.verifyExisting(observed, "strict")).toMatchObject({ kind: "mismatch", containerPath: missing.containerPath });
        expect(contract.matches(image, "live")).toBe(false);
        expect(contract.safeToDefer()).toBeNull();
        const f = fixture({
            identity: () => ({ containerId: id, running: true }),
            inspectContract: (_id, reportReason) => { report = reportReason; return contract.matches(image, "live"); },
            safeToDefer: (_id, reportReason) => { report = reportReason; return contract.safeToDefer(); },
        });
        const intent = vi.fn(), retained = vi.fn(), recreated = vi.fn();
        f.context.beforeStop = intent; f.context.beforeRemove = retained;
        expect(() => f.lifecycle.run({ containerName: name, managedProjectPath: root.containerPath,
            initiallyRunningContainerId: id, replacementGuard: operation => { operation(); return true; }, onRecreate: recreated,
        })).toThrow("root live source proof unavailable");
        expect(intent).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
        expect(retained).not.toHaveBeenCalled();
        expect(recreated).not.toHaveBeenCalled();
        expect(f.ports.managedIdentity).not.toHaveBeenCalled();
        expect(f.ports.finish).not.toHaveBeenCalled();
    });

    it.each([{ status: 1 }, { status: null }, { status: 0, error: new Error("stop timed out") }])("does not remove a running-repair target after failed or uncertain stop: %j", result => {
        const f = fixture({
            inspectContract: () => false, safeToDefer: () => false,
            identity: () => ({ containerId: id, running: true }),
            managedIdentity: () => ({ containerId: id, running: true }),
        });
        const intent = vi.fn(), retained = vi.fn(), recreated = vi.fn();
        f.context.beforeStop = intent;
        f.context.beforeRemove = retained;
        native.spawn.mockReturnValue(result);
        expect(() => f.lifecycle.run({ containerName: name, managedProjectPath: "/fixture/project",
            initiallyRunningContainerId: id, replacementGuard: operation => { operation(); return true; }, onRecreate: recreated,
        })).toThrow("could not be stopped");
        expect(intent).toHaveBeenCalledTimes(1);
        expect(native.spawn.mock.calls.map(call => call[1])).toEqual([["stop", id]]);
        expect(retained).not.toHaveBeenCalled();
        expect(recreated).not.toHaveBeenCalled();
    });

    it("does not stop if publishing the mutation intent fails", () => {
        const f = fixture({
            inspectContract: () => false, safeToDefer: () => false,
            identity: () => ({ containerId: id, running: true }),
            managedIdentity: () => ({ containerId: id, running: true }),
        });
        const failure = new Error("mutation intent could not be published");
        f.context.beforeStop = () => { throw failure; };
        expect(() => f.lifecycle.run({ containerName: name, managedProjectPath: "/fixture/project",
            initiallyRunningContainerId: id, replacementGuard: operation => { operation(); return true; },
        })).toThrow(failure);
        expect(native.spawn).not.toHaveBeenCalled();
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
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("podman", ["start", id], { stdio: "inherit", timeout: 30000, killSignal: "SIGKILL" });
    });
    it("reads required destinations only when reporting a mismatch and safely defers without MCP", () => {
        const f = fixture({ inspectContract: (_id, report) => { report("credential mount changed"); return false; }, identity: vi.fn(() => ({ containerId: id, running: true })) });
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

    it("throws the original restart-guidance class with captured runtime after the ambient selector changes", () => {
        const f = fixture({ inspectContract: () => false, safeToDefer: (_id, report) => { report("unsafe project source"); return false; }, identity: vi.fn(() => ({ containerId: id, running: true })) });
        native.runtime.mockReturnValue("docker");
        let failure: unknown;
        try { f.lifecycle.run({ containerName: name, replacementGuard: () => false }); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(ContainerRestartRequiredError);
        expect(failure).toMatchObject({ name: "ContainerRestartRequiredError", reason: "unsafe project source", workspacePath: "/fixture/project", runtime: "podman", profile: "work" });
        expect(native.runtime).not.toHaveBeenCalled();
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
            ["podman", ["rm", id], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, killSignal: "SIGKILL" }],
            ["podman", ["rm", id], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, killSignal: "SIGKILL" }],
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
