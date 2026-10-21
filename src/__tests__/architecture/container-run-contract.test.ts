import { describe, expect, it, vi } from "vitest";
import { createContainerRunContract } from "../../application/container-run-contract.js";
import type {
    ContainerRunContractOptions, ContainerRunContractPorts, ContractEnvironment,
    ContractInspection, HostConfigurationFacts, TextFact,
} from "../../ports/container-run-contract.js";

const image = `sha256:${"1".repeat(64)}`;
const authPath = "/run/ccc/broker-auth";

function fixture(overrides: Partial<ContainerRunContractOptions> = {}) {
    const events: string[] = [];
    const options: ContainerRunContractOptions = {
        containerId: "pinned-id",
        identity: { uid: 1000, gid: 1001, mapping: "host", contractVersion: "1" },
        labRunner: {
            status: "ready", stateVolumeName: "lab-state", stateContainerDir: "/lab-state",
            networkMode: "user", kvmDevicePath: "/dev/kvm", kvmGroupId: 107,
        },
        brokerAuthContainerPath: authPath,
        ...overrides,
    };
    const environment: ContractEnvironment = {
        labRunner: "1", labStatus: "ready", labStateDirectory: "/lab-state", labNetworkMode: "user",
    };
    const labels = { version: "1", uid: "1000", gid: "1001", mapping: "host" };
    const host: HostConfigurationFacts = {
        privileged: false,
        initEnabled: vi.fn(() => true), deviceRequestsPresent: vi.fn(() => false),
        kvmReferencePresent: vi.fn(() => true),
        devices: vi.fn(() => [{ hostPath: "/dev/kvm", containerPath: "/dev/kvm" }]),
        groups: vi.fn(() => ["107"]), groupCount: vi.fn(() => 1),
    };
    const observation: ContractInspection = {
        runningState: vi.fn(() => "running" as const), imageId: vi.fn(() => image),
        identityLabels: vi.fn(() => labels), environment: vi.fn(() => environment),
        hostConfiguration: vi.fn(() => host), managedLabel: vi.fn(() => "true"),
        projectPathIdentity: vi.fn(() => "matching" as const),
        projectMountIdentity: vi.fn(() => ({ kind: "missing" as const })),
        deviceLabMountIdentity: vi.fn(() => ({ kind: "missing" as const })),
        containerId: vi.fn(() => "pinned-id"), brokerAuthMountPresent: vi.fn(() => false),
        verifyMounts: vi.fn(() => ({ kind: "verified" as const, via: "identity" as const })),
    };
    const ports = {
        inspect: vi.fn((): ContractInspection | null => observation),
        effectiveUserMatches: vi.fn(() => true), brokerAuthMountRequired: vi.fn(() => false),
        report: vi.fn((reason: string) => { events.push(`report:${reason}`); }),
        debugStrictFailure: vi.fn((reason: string) => { events.push(`debug:${reason}`); }),
        isRuntimeUnavailable: vi.fn((_error: unknown) => false),
    } satisfies ContainerRunContractPorts;
    return { options, environment, labels, host, observation, ports, events,
        app: createContainerRunContract(options, ports) };
}
type Fixture = ReturnType<typeof fixture>;
const unsupportedLab = (unsupportedReason?: string): ContainerRunContractOptions["labRunner"] => ({
    status: "unsupported", stateVolumeName: "lab-state", stateContainerDir: "/lab-state",
    networkMode: "user", unsupportedReason,
});
const strictFailure = (f: Fixture, reason: string) => {
    expect(f.app.matches(image, "live")).toBe(false);
    expect(f.events).toEqual([`report:${reason}`, `debug:${reason}`]);
};

describe("run contract state and fresh authority", () => {
    it.each(["preflight", "live"] as const)("admits a matching running %s without a deferred-user probe", phase => {
        const f = fixture();
        expect(f.app.matches(image, phase)).toBe(true);
        expect(f.observation.verifyMounts).toHaveBeenCalledExactlyOnceWith("strict");
        expect(f.ports.effectiveUserMatches).not.toHaveBeenCalled();
        expect(f.events).toEqual([]);
    });

    it("uses only stopped mount preflight for a confirmed stopped container", () => {
        const f = fixture();
        f.observation.runningState = () => "stopped";
        f.observation.verifyMounts = vi.fn(() => ({ kind: "preflight-verified" as const }));
        expect(f.app.matches(image, "preflight")).toBe(true);
        expect(f.observation.verifyMounts).toHaveBeenCalledExactlyOnceWith("stopped-preflight");
        expect(f.ports.effectiveUserMatches).not.toHaveBeenCalled();
    });

    it.each([
        ["preflight", "unknown", "container running state inspection failed"],
        ["live", "unknown", "container is not confirmed running during live verification"],
        ["live", "stopped", "container is not confirmed running during live verification"],
    ] as const)("refuses %s/%s before later observations", (phase, running, reason) => {
        const f = fixture(); f.observation.runningState = () => running;
        f.observation.imageId = vi.fn(() => { throw new Error("late image read"); });
        expect(f.app.matches(image, phase)).toBeNull();
        expect(f.events).toEqual([`report:${reason}`]);
        expect(f.observation.imageId).not.toHaveBeenCalled();
        expect(f.observation.verifyMounts).not.toHaveBeenCalled();
        expect(f.ports.effectiveUserMatches).not.toHaveBeenCalled();
    });

    it.each(["strict", "defer"] as const)("does not cache successful %s permission across inspections", mode => {
        const f = fixture();
        const check = () => mode === "strict" ? f.app.matches(image, "live") : f.app.safeToDefer();
        f.ports.inspect.mockReturnValueOnce(f.observation)
            .mockReturnValueOnce({ ...f.observation, containerId: () => "successor-id" })
            .mockReturnValueOnce(null);
        expect(check()).toBe(true);
        expect(check()).toBe(false);
        expect(check()).toBe(mode === "strict" ? null : false);
        expect(f.ports.inspect).toHaveBeenCalledTimes(3);
        expect(f.ports.report.mock.calls.map(([reason]) => reason)).toEqual([
            "container identity changed during contract inspection", "container contract inspection failed",
        ]);
    });
});

describe("strict run contract decisions", () => {
    it.each(["image", "version", "uid", "gid", "mapping"] as const)("rejects changed %s before mount proof", field => {
        const f = fixture();
        if (field === "image") f.observation.imageId = () => `sha256:${"2".repeat(64)}`;
        else f.labels[field] = "changed";
        strictFailure(f, "image or user identity changed");
        expect(f.observation.verifyMounts).not.toHaveBeenCalled();
        expect(f.observation.environment).not.toHaveBeenCalled();
    });

    const refusals: Array<[string, (f: Fixture) => void, string]> = [
        ["host config", f => { f.observation.hostConfiguration = () => null; }, "container host configuration is malformed"],
        ["management", f => { f.observation.managedLabel = () => null; }, "container is not CCC-managed"],
        ["missing project", f => { f.observation.projectPathIdentity = () => "missing"; }, "project path identity changed"],
        ["changed project", f => { f.observation.projectPathIdentity = () => "different"; }, "project path identity changed"],
        ["missing ID", f => { f.observation.containerId = () => null; }, "bind mount identities could not be verified"],
        ["changed ID", f => { f.observation.containerId = () => "successor"; }, "container identity changed during contract inspection"],
    ];
    it.each(refusals)("refuses %s before either policy can prove mounts", (_name, change, reason) => {
        const f = fixture(); change(f); strictFailure(f, reason);
        expect(f.observation.verifyMounts).not.toHaveBeenCalled();
        const deferred = fixture(); change(deferred);
        expect(deferred.app.safeToDefer()).toBe(false);
        expect(deferred.events).toEqual([`report:${reason}`]);
        expect(deferred.observation.verifyMounts).not.toHaveBeenCalled();
        expect(deferred.ports.effectiveUserMatches).not.toHaveBeenCalled();
    });

    const markers: Array<[string, TextFact, boolean]> = [
        ["missing", { kind: "missing" }, true], ["empty", { kind: "text", value: "" }, true],
        ["digest", { kind: "text", value: "a".repeat(64) }, true],
        ["invalid native value", { kind: "invalid" }, false],
        ["short", { kind: "text", value: "a".repeat(63) }, false],
        ["nonhex", { kind: "text", value: "g".repeat(64) }, false],
    ];
    it.each(markers)("preserves %s fingerprint policy with current proof", (_name, value, valid) => {
        for (const marker of ["projectMountIdentity", "deviceLabMountIdentity"] as const) {
            const f = fixture(); f.observation[marker] = () => value;
            expect(f.app.matches(image, "live")).toBe(valid);
            if (valid) expect(f.observation.verifyMounts).toHaveBeenCalledExactlyOnceWith("strict");
            else {
                expect(f.ports.report).toHaveBeenCalledWith(marker === "projectMountIdentity"
                    ? "project mount identity is malformed" : "device-lab mount identity is malformed");
                expect(f.observation.verifyMounts).not.toHaveBeenCalled();
            }
        }
    });

    it.each(["source", "daemon"])("keeps a %s proof refusal despite a valid fingerprint", source => {
        const f = fixture(); f.observation.projectMountIdentity = () => ({ kind: "text", value: "f".repeat(64) });
        f.observation.verifyMounts = () => ({ kind: "mismatch", reason: `${source} identity changed` });
        strictFailure(f, `${source} identity changed`);
    });

    it.each(["stale mount", "missing mount", "missing env", "wrong env", "stale empty env"])("rejects broker auth %s", scenario => {
        const f = fixture();
        const required = scenario !== "stale mount" && scenario !== "stale empty env";
        f.ports.brokerAuthMountRequired.mockReturnValue(required);
        f.observation.brokerAuthMountPresent = () => scenario !== "missing mount" && scenario !== "stale empty env";
        if (scenario === "wrong env") f.environment.brokerAuthFile = "/other";
        if (scenario === "stale empty env") f.environment.brokerAuthFile = "";
        strictFailure(f, scenario.endsWith("mount") ? "stale isolated device broker auth mount"
            : required ? "missing isolated device broker auth file environment" : "stale isolated device broker auth file environment");
    });

    it("admits selected broker auth only when its mount and environment agree", () => {
        const f = fixture(); f.ports.brokerAuthMountRequired.mockReturnValue(true);
        f.observation.brokerAuthMountPresent = () => true; f.environment.brokerAuthFile = authPath;
        expect(f.app.matches(image, "live")).toBe(true);
    });

    it.each([
        ["labRunner", undefined, "missing CCC_LAB_RUNNER=1"],
        ["labStatus", "old", "CCC_LAB_RUNNER_STATUS is old, expected ready"],
        ["labStateDirectory", "", "CCC_LAB_STATE_DIR is unset, expected /lab-state"],
        ["labNetworkMode", "old", "CCC_LAB_NET_MODE is old, expected user"],
        ["unsupportedReason", "", "stale unsupported reason env"],
    ] as const)("refuses stale %s environment", (key, value, reason) => {
        const f = fixture(); f.environment[key] = value; strictFailure(f, reason);
    });

    it("requires a configured unsupported reason and no VM resources", () => {
        const f = fixture({ labRunner: unsupportedLab("no kvm") }); f.environment.labStatus = "unsupported";
        f.environment.unsupportedReason = "no kvm";
        f.host.devices = () => []; f.host.groups = () => []; f.host.groupCount = () => 0;
        expect(f.app.matches(image, "live")).toBe(true);
        f.environment.unsupportedReason = "changed"; strictFailure(f, "unsupported reason changed");
    });
});

describe("strict resource equality and deferred subset policy", () => {
    const resources: Array<[string, (f: Fixture) => void, string, boolean]> = [
        ["privilege", f => { f.host.privileged = true; }, "stale privileged container", false],
        ["init", f => { f.host.initEnabled = () => false; }, "missing init process", true],
        ["device request", f => { f.host.deviceRequestsPresent = () => true; }, "unexpected host device requests", false],
        ["missing KVM", f => { f.host.kvmReferencePresent = () => false; f.host.devices = () => []; }, "missing /dev/kvm device", true],
        ["extra device", f => { f.host.devices = () => [{ hostPath: "/dev/kvm", containerPath: "/dev/kvm" }, { hostPath: "/dev/other", containerPath: "/dev/other" }]; }, "unexpected VM device set", false],
        ["remapped KVM", f => { f.host.devices = () => [{ hostPath: "/dev/kvm", containerPath: "/dev/other" }]; }, "unexpected VM device set", false],
        ["missing group", f => { f.host.groups = () => []; f.host.groupCount = () => 0; }, "missing kvm group 107", true],
        ["extra group", f => { f.host.groups = () => ["107", "999"]; f.host.groupCount = () => 2; }, "unexpected extra VM group-add", false],
        ["duplicate group", f => { f.host.groups = () => ["107", "107"]; f.host.groupCount = () => 2; }, "unexpected extra VM group-add", true],
    ];
    it.each(resources)("preserves strict/defer differences for %s", (_name, change, strictReason, canDefer) => {
        const strict = fixture(); change(strict); strictFailure(strict, strictReason);
        const deferred = fixture(); change(deferred);
        expect(deferred.app.safeToDefer()).toBe(canDefer);
        expect(deferred.ports.debugStrictFailure).not.toHaveBeenCalled();
        if (canDefer) expect(deferred.ports.effectiveUserMatches).toHaveBeenCalledExactlyOnceWith(deferred.options.identity);
    });

    it.each(["devices", "groups"] as const)("unsupported settings reject stale %s in both policies", resource => {
        for (const mode of ["strict", "defer"] as const) {
            const f = fixture({ labRunner: unsupportedLab() }); f.environment.labStatus = "unsupported";
            if (resource === "devices") { f.host.groups = () => []; f.host.groupCount = () => 0; }
            else f.host.devices = () => [];
            if (mode === "strict") strictFailure(f, resource === "devices" ? "stale device on unsupported config" : "stale group-add on unsupported config");
            else {
                expect(f.app.safeToDefer()).toBe(false);
                expect(f.events).toEqual(["report:stale VM device or group on unsupported config"]);
            }
        }
    });
});

describe("deferred admission and failure translation", () => {
    it("allows additive drift only after effective-user and current mount proof", () => {
        const f = fixture();
        f.observation.imageId = vi.fn(() => { throw new Error("strict image read"); });
        f.observation.identityLabels = vi.fn(() => { throw new Error("strict labels read"); });
        f.observation.deviceLabMountIdentity = vi.fn(() => { throw new Error("strict lab marker read"); });
        f.observation.environment = vi.fn(() => { throw new Error("strict environment read"); });
        f.host.initEnabled = vi.fn(() => { throw new Error("strict init read"); });
        f.observation.verifyMounts = vi.fn(() => {
            expect(f.ports.effectiveUserMatches).toHaveBeenCalledExactlyOnceWith(f.options.identity);
            return { kind: "deferred" as const, reason: "missing additive mount", containerPath: "/extra" };
        });
        expect(f.app.safeToDefer()).toBe(true);
        expect(f.observation.verifyMounts).toHaveBeenCalledExactlyOnceWith("safe-defer");
        expect(f.observation.imageId).not.toHaveBeenCalled();
        expect(f.observation.environment).not.toHaveBeenCalled();
        expect(f.host.initEnabled).not.toHaveBeenCalled();
        expect(f.events).toEqual([]);
    });

    it.each(["stopped", "unknown"] as const)("refuses %s defer without live probes", running => {
        const f = fixture(); f.observation.runningState = () => running;
        expect(f.app.safeToDefer()).toBe(false);
        expect(f.events).toEqual(["report:container is not confirmed running for safe defer"]);
        expect(f.ports.effectiveUserMatches).not.toHaveBeenCalled();
        expect(f.observation.verifyMounts).not.toHaveBeenCalled();
    });

    it("refuses effective-user mismatch before mount proof", () => {
        const f = fixture(); f.ports.effectiveUserMatches.mockReturnValue(false);
        expect(f.app.safeToDefer()).toBe(false);
        expect(f.events).toEqual(["report:container UID/GID does not match the host identity"]);
        expect(f.observation.verifyMounts).not.toHaveBeenCalled();
    });

    it.each(["retryable", "mismatch"] as const)("preserves %s mount outcomes and skips later resources", kind => {
        for (const mode of ["strict", "defer"] as const) {
            const f = fixture(); f.observation.verifyMounts = () => ({ kind, reason: "proof reason" });
            f.host.devices = vi.fn(() => { throw new Error("late device read"); });
            expect(mode === "strict" ? f.app.matches(image, "live") : f.app.safeToDefer())
                .toBe(mode === "strict" && kind === "retryable" ? null : false);
            expect(f.events).toEqual(mode === "strict" && kind === "mismatch"
                ? ["report:proof reason", "debug:proof reason"] : ["report:proof reason"]);
            expect(f.host.devices).not.toHaveBeenCalled();
        }
    });

    it.each(["strict", "defer"] as const)("maps ordinary inner %s failures but propagates initial inspection faults", mode => {
        const f = fixture(); const fault = { kind: "native fault" };
        f.observation.verifyMounts = () => { throw fault; };
        const check = () => mode === "strict" ? f.app.matches(image, "live") : f.app.safeToDefer();
        expect(check()).toBe(mode === "strict" ? null : false);
        expect(f.events).toEqual(["report:container contract inspection failed"]);
        expect(f.ports.isRuntimeUnavailable).toHaveBeenCalledExactlyOnceWith(fault);
        f.ports.inspect.mockImplementation(() => { throw fault; }); f.events.length = 0;
        try { check(); expect.fail("initial inspection fault was swallowed"); } catch (error) { expect(error).toBe(fault); }
        expect(f.events).toEqual([]);
    });

    it.each(["strict", "defer"] as const)("rethrows the original runtime-unavailable object in %s", mode => {
        const f = fixture(); const unavailable = new Error("daemon unavailable");
        f.observation.verifyMounts = () => { throw unavailable; };
        f.ports.isRuntimeUnavailable.mockImplementation(error => error === unavailable);
        try {
            if (mode === "strict") f.app.matches(image, "live"); else f.app.safeToDefer();
            expect.fail("runtime error was swallowed");
        } catch (error) { expect(error).toBe(unavailable); }
        expect(f.events).toEqual([]);
    });
});
