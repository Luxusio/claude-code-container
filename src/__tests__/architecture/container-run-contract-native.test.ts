import { describe, expect, it, vi } from "vitest";
import { createContainerRunContract } from "../../application/container-run-contract.js";
import { createNativeContainerRunContractPorts } from "../../adapters/container-run-contract-observations.js";
import type { NativeContainerRunContractContext } from "../../adapters/container-run-contract-observations.js";
import type { InspectedContainerMount } from "../../adapters/container-mount-observations.js";
import type { ContainerRunContractOptions, ContainerRunContractMountMode, ContainerRunContractMountVerification } from "../../ports/container-run-contract.js";

const image = `sha256:${"1".repeat(64)}`;
const authPath = "/run/ccc/broker-auth";
const options: ContainerRunContractOptions = {
    containerId: "pinned-id", identity: { uid: 1000, gid: 1001, mapping: "host", contractVersion: "1" },
    labRunner: { status: "ready", stateVolumeName: "state", stateContainerDir: "/lab-state",
        networkMode: "user", kvmDevicePath: "/dev/kvm", kvmGroupId: 107 },
    brokerAuthContainerPath: authPath,
};

function fixture() {
    const labels: Record<string, unknown> = {
        "ccc.managed": "true", "ccc.project.path": "/host/project", "ccc.identity.version": "1",
        "ccc.identity.uid": "1000", "ccc.identity.gid": "1001", "ccc.identity.mapping": "host",
    };
    const config = { Labels: labels, Env: ["CCC_LAB_RUNNER=1", "CCC_LAB_RUNNER_STATUS=ready",
        "CCC_LAB_STATE_DIR=/lab-state", "CCC_LAB_NET_MODE=user"] as unknown };
    const host: Record<string, unknown> = {
        Privileged: false, Init: true, Devices: [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm" }],
        DeviceRequests: [], GroupAdd: [107],
    };
    const mounts: InspectedContainerMount[] = [{ Type: "bind", Source: "/host/project", Destination: "/workspace", RW: true }];
    const raw: Record<string, unknown> = {
        Id: "pinned-id", Image: image, State: { Running: true }, Config: config, HostConfig: host, Mounts: mounts,
    };
    const context = {
        containerId: "pinned-id", projectPath: "/host/project", brokerAuthContainerPath: authPath,
        requiredMounts: [{ containerPath: "/workspace" }],
        inspect: vi.fn((): Record<string, unknown> | null => raw), selectedRuntime: vi.fn(() => "docker"),
        projectPathMatches: vi.fn((observed: string, expected: string) => observed === expected),
        effectiveUserMatches: vi.fn((_identity: ContainerRunContractOptions["identity"]) => true),
        verifyMounts: vi.fn((_mounts: InspectedContainerMount[], _mode: ContainerRunContractMountMode): ContainerRunContractMountVerification => ({ kind: "verified", via: "identity" })),
        report: vi.fn((_reason: string) => {}), debugStrictFailure: vi.fn((_reason: string) => {}),
        isRuntimeUnavailable: vi.fn((_error: unknown) => false),
    } satisfies NativeContainerRunContractContext;
    const ports = createNativeContainerRunContractPorts(context);
    return { labels, config, host, mounts, raw, context, ports, app: createContainerRunContract(options, ports) };
}

describe("native run contract observations", () => {
    it.each([
        [true, "running"], [false, "stopped"], [undefined, "unknown"], [null, "unknown"], ["true", "unknown"],
    ])("decodes running state %s without granting truthy authority", (running, expected) => {
        const f = fixture(); f.raw.State = { Running: running };
        expect(f.ports.inspect()?.runningState()).toBe(expected);
        expect(f.context.verifyMounts).not.toHaveBeenCalled();
    });

    it("preserves absent inspection without acquiring later native observations", () => {
        const f = fixture(); f.context.inspect.mockReturnValue(null);
        expect(f.ports.inspect()).toBeNull();
        expect(f.context.selectedRuntime).not.toHaveBeenCalled();
        expect(f.context.projectPathMatches).not.toHaveBeenCalled();
        expect(f.context.effectiveUserMatches).not.toHaveBeenCalled();
    });

    it("separates text labels, marker states, and native project path comparison", () => {
        const f = fixture(); f.labels["ccc.identity.uid"] = 1000;
        f.labels["ccc.project.mount-identity"] = ""; f.labels["ccc.device-lab.mount-identity"] = null;
        let observed = f.ports.inspect()!;
        expect(observed.identityLabels()).toEqual({ version: "1", uid: null, gid: "1001", mapping: "host" });
        expect(observed.projectMountIdentity()).toEqual({ kind: "text", value: "" });
        expect(observed.deviceLabMountIdentity()).toEqual({ kind: "invalid" });
        expect(observed.projectPathIdentity()).toBe("matching");
        expect(f.context.projectPathMatches).toHaveBeenCalledExactlyOnceWith("/host/project", "/host/project");
        delete f.labels["ccc.project.mount-identity"]; delete f.labels["ccc.project.path"];
        observed = f.ports.inspect()!;
        expect(observed.projectMountIdentity()).toEqual({ kind: "missing" });
        expect(observed.projectPathIdentity()).toBe("missing");
        f.labels["ccc.project.path"] = "/other";
        expect(f.ports.inspect()?.projectPathIdentity()).toBe("different");
    });

    it("splits environment at the first equals sign, retains empty values and uses the last occurrence", () => {
        const f = fixture(); f.config.Env = ["CCC_LAB_RUNNER=old", "=ignored", "CCC_LAB_RUNNER=1",
            "CCC_DEVICE_BROKER_AUTH_FILE=", "CCC_LAB_RUNNER_UNSUPPORTED_REASON=reason=detail", 12, null];
        expect(f.ports.inspect()?.environment()).toEqual({
            labRunner: "1", brokerAuthFile: "", unsupportedReason: "reason=detail",
            labStatus: undefined, labStateDirectory: undefined, labNetworkMode: undefined,
        });
        f.config.Env = "CCC_LAB_RUNNER=1";
        expect(f.ports.inspect()?.environment().labRunner).toBeUndefined();
    });

    it.each(["Devices", "DeviceRequests", "GroupAdd"])("rejects missing or malformed %s instead of treating it as an empty array", key => {
        for (const value of [undefined, "[]", {}, false]) {
            const f = fixture();
            if (value === undefined) delete f.host[key]; else f.host[key] = value;
            expect(f.ports.inspect()?.hostConfiguration()).toBeNull();
        }
    });

    it.each([
        { name: "null", value: null }, { name: "array", value: [] }, { name: "boolean", value: false },
        { name: "nonboolean privilege", value: { Privileged: "false", Devices: [], DeviceRequests: [], GroupAdd: [] } },
    ])("refuses malformed host configuration $name", ({ value }) => {
        const f = fixture(); f.raw.HostConfig = value;
        expect(f.ports.inspect()?.hostConfiguration()).toBeNull();
    });

    it("accepts legacy null arrays and preserves native device/group coercion", () => {
        const f = fixture(); f.host.Devices = null; f.host.DeviceRequests = null; f.host.GroupAdd = null;
        let host = f.ports.inspect()!.hostConfiguration()!;
        expect([host.devices(), host.groups(), host.groupCount(), host.deviceRequestsPresent(), host.kvmReferencePresent()])
            .toEqual([[], [], 0, false, false]);
        f.host.Devices = [null, 4, { PathOnHost: 12, PathInContainer: false }, { PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm" }];
        f.host.GroupAdd = [107, null, "107"]; f.host.DeviceRequests = [{}]; f.host.Init = "true";
        host = f.ports.inspect()!.hostConfiguration()!;
        expect(host.devices()).toEqual([{ hostPath: "12", containerPath: "" }, { hostPath: "/dev/kvm", containerPath: "/dev/kvm" }]);
        expect(host.groups()).toEqual(["107", "null", "107"]);
        expect(host.groupCount()).toBe(3); expect(host.deviceRequestsPresent()).toBe(true);
        expect(host.kvmReferencePresent()).toBe(true); expect(host.initEnabled()).toBe(false);
    });

    it.each(["docker", "podman"])("uses the selected %s runtime for omitted DeviceRequests", runtime => {
        const f = fixture(); delete f.host.DeviceRequests; f.raw.Runtime = runtime === "docker" ? "podman" : "docker";
        f.context.selectedRuntime.mockReturnValue(runtime);
        expect(f.ports.inspect()?.hostConfiguration() !== null).toBe(runtime === "podman");
        expect(f.app.matches(image, "live")).toBe(runtime === "podman");
        f.host.DeviceRequests = "malformed";
        expect(f.ports.inspect()?.hostConfiguration()).toBeNull();
    });

    it("uses each fresh inspection's mounts for broker selection and bound proof", () => {
        const f = fixture();
        const firstMounts = f.mounts;
        const secondMounts: InspectedContainerMount[] = [{ Destination: authPath, Source: "/other/auth", Type: "bind", RW: false }];
        f.context.inspect.mockReturnValueOnce({ ...f.raw, Mounts: firstMounts })
            .mockReturnValueOnce({ ...f.raw, Mounts: secondMounts });
        const first = f.ports.inspect()!; const second = f.ports.inspect()!;
        expect(first.brokerAuthMountPresent()).toBe(false); expect(second.brokerAuthMountPresent()).toBe(true);
        first.verifyMounts("stopped-preflight"); second.verifyMounts("safe-defer");
        expect(f.context.verifyMounts.mock.calls[0]).toEqual([firstMounts, "stopped-preflight"]);
        expect(f.context.verifyMounts.mock.calls[0][0]).toBe(firstMounts);
        expect(f.context.verifyMounts.mock.calls[1][0]).toBe(secondMounts);
        expect(f.ports.brokerAuthMountRequired()).toBe(false);
        const authRequired = createNativeContainerRunContractPorts({ ...f.context,
            requiredMounts: [...f.context.requiredMounts, { containerPath: authPath }],
        });
        expect(authRequired.brokerAuthMountRequired()).toBe(true);
    });
});

describe("native staged faults at the run contract boundary", () => {
    it.each(["device", "group"] as const)("keeps JSON %s coercion behind earlier refusal decisions", field => {
        for (const decision of ["image", "management", "state", "mount"] as const) {
            const f = fixture();
            if (field === "device") f.host.Devices = [{ PathOnHost: { toString: "invalid" }, PathInContainer: "/dev/kvm" }];
            else f.host.GroupAdd = [{ toString: "invalid" }];
            let reason: string;
            if (decision === "image") { f.raw.Image = `sha256:${"2".repeat(64)}`; reason = "image or user identity changed"; }
            else if (decision === "management") { f.labels["ccc.managed"] = "false"; reason = "container is not CCC-managed"; }
            else if (decision === "state") { f.raw.State = { Running: false }; reason = "container is not confirmed running during live verification"; }
            else { f.context.verifyMounts.mockReturnValue({ kind: "mismatch", reason: "source changed" }); reason = "source changed"; }
            expect(f.app.matches(image, "live")).toBe(decision === "state" ? null : false);
            expect(f.context.report.mock.calls).toEqual([[reason]]);
            expect(f.context.isRuntimeUnavailable).not.toHaveBeenCalled();
        }
    });

    it.each(["device", "group"] as const)("maps an admitted JSON %s coercion fault to the existing inner-failure outcomes", field => {
        for (const mode of ["strict", "defer"] as const) {
            const f = fixture();
            if (field === "device") f.host.Devices = [{ PathOnHost: { toString: "invalid" }, PathInContainer: "/dev/kvm" }];
            else f.host.GroupAdd = [{ toString: "invalid" }];
            expect(mode === "strict" ? f.app.matches(image, "live") : f.app.safeToDefer()).toBe(mode === "strict" ? null : false);
            expect(f.context.report.mock.calls).toEqual([["container contract inspection failed"]]);
            expect(f.context.debugStrictFailure).not.toHaveBeenCalled();
            expect(f.context.isRuntimeUnavailable.mock.calls[0][0]).toBeInstanceOf(TypeError);
        }
    });

    it("keeps native inspection exceptions outside diagnostic translation", () => {
        const f = fixture(); const fault = { transport: "unavailable" };
        f.context.inspect.mockImplementation(() => { throw fault; });
        for (const check of [() => f.app.matches(image, "live"), () => f.app.safeToDefer()]) {
            try { check(); expect.fail("inspection fault was swallowed"); } catch (error) { expect(error).toBe(fault); }
        }
        expect(f.context.report).not.toHaveBeenCalled();
        expect(f.context.isRuntimeUnavailable).not.toHaveBeenCalled();
    });
});
