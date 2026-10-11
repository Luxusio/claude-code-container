import { describe, expect, it } from "vitest";
import { createContainerLaunchArguments } from "../../application/container-launch-arguments.js";
import type { ContainerLaunchOptions } from "../../domain/container-launch-arguments.js";
import type { ContainerLaunchArgumentPorts } from "../../ports/container-launch-arguments.js";

function fixture() {
    const facts = { ownerDirectory: "/native/owner", clipboardPortFilePresent: true };
    const ports: ContainerLaunchArgumentPorts<object> = {
        observeHostFacts: () => facts, identityLabels: () => [["duplicate", "first"], ["duplicate", "second"]],
        readCliVersion: () => "version", readProjectMountIdentityLabel: () => "project.identity",
        readDeviceLabMountIdentityLabel: () => "device.identity", readCodexPackagesVolumeName: () => "packages",
        readCodexPackagesContainerDir: () => "/packages", readBrokerAuthContainerFile: () => "/auth",
        readClipboardFilesContainerDir: () => "/clipboard",
    };
    const options: ContainerLaunchOptions<object> = {
        containerName: "x".repeat(80), fullPath: "/project", projectMountPath: "/guest",
        credentialMounts: [{ hostPath: "/same", containerPath: "/credential" }, { hostPath: "/same", containerPath: "/credential" }],
        gitIdentityMounts: [{ hostPath: "/git", containerPath: "/git" }],
        claudeJsonFile: "/claude.json", miseVolumeName: "mise", pidsLimit: "300", imageName: "sha256:pinned",
        hostSshDir: "/ssh", sshAgentSocket: "/agent",
    };
    return { facts, options, app: createContainerLaunchArguments(ports) };
}
describe("semantic launch plan", () => {
    it("retains launch authority and ordered duplicate mounts", () => {
        const f = fixture(); const plan = f.app.buildPlan(f.options);
        expect(plan).toMatchObject({ containerName: f.options.containerName, hostname: "x".repeat(63), imageName: "sha256:pinned", network: "host", init: true, seccomp: "unconfined", capabilities: ["NET_ADMIN"] });
        expect(plan.operations.slice(0, 5)).toEqual([
            { kind: "bind", source: "/project", destination: "/guest" },
            { kind: "bind", source: "/same", destination: "/credential" },
            { kind: "bind", source: "/same", destination: "/credential" },
            { kind: "bind", source: "/git", destination: "/git", readonly: true },
            { kind: "bind", source: "/claude.json", destination: "/home/ccc/.claude.json" },
        ]);
        expect(plan.operations).toContainEqual({ kind: "execution", workdir: "/guest", pidsLimit: "300" });
        expect(plan.operations).toContainEqual({ kind: "socket" });
        expect(plan.operations).toContainEqual({ kind: "ssh-command" });
    });
    it("preserves owner overlays and readonly auth before persistent volumes", () => {
        const f = fixture(); Object.assign(f.options, { deviceLabStateHostDir: "/state", deviceLabOwnerId: "owner", deviceLabOwnerAuthFile: "/native/auth" });
        const ops = f.app.buildPlan(f.options).operations;
        const start = ops.findIndex(op => op.kind === "bind" && op.source === "/state");
        expect(ops.slice(start, start + 6)).toEqual([
            { kind: "bind", source: "/state", destination: "/home/ccc/.ccc/devices", readonly: true },
            { kind: "tmpfs", destination: "/home/ccc/.ccc/devices/owners", mode: 0o711, noexec: true, nosuid: true, nodev: true },
            { kind: "bind", source: "/native/owner", destination: "/home/ccc/.ccc/devices/owners/owner" },
            { kind: "tmpfs", destination: "/home/ccc/.ccc/devices/broker/auth", mode: 0o711, noexec: true, nosuid: true, nodev: true },
            { kind: "bind", source: "/native/auth", destination: "/auth", readonly: true },
            { kind: "env", key: "CCC_DEVICE_BROKER_AUTH_FILE", value: "/auth" },
        ]);
    });
    it("preserves clipboard and duplicate labels after extra mounts", () => {
        const f = fixture(); Object.assign(f.options, { identity: {}, projectMountIdentity: "physical", deviceLabMountIdentity: "devices", extraMounts: [{ hostPath: "/extra", containerPath: "/extra" }], clipboardPortFile: "/port", clipboardFilesHostDir: "/files", proxyEnabled: true, containerHostRemote: true });
        const ops = f.app.buildPlan(f.options).operations;
        expect(ops.slice(-8)).toEqual([
            { kind: "bind", source: "/extra", destination: "/extra" },
            { kind: "bind", source: "/port", destination: "/run/ccc/clipboard.port", readonly: true },
            { kind: "bind", source: "/files", destination: "/clipboard" },
            { kind: "management-labels", projectPath: "/project", profile: "", cliVersion: "version" },
            { kind: "label", key: "project.identity", value: "physical" },
            { kind: "label", key: "duplicate", value: "first" }, { kind: "label", key: "duplicate", value: "second" },
            { kind: "label", key: "device.identity", value: "devices" },
        ]);
        expect(ops).toContainEqual({ kind: "env", key: "CCC_PROXY_ENABLED", value: "1" });
        expect(ops).toContainEqual({ kind: "env", key: "CCC_CONTAINER_HOST_REMOTE", value: "1" });
        f.facts.clipboardPortFilePresent = false;
        expect(f.app.buildPlan(f.options).operations).not.toContainEqual({ kind: "bind", source: "/port", destination: "/run/ccc/clipboard.port", readonly: true });
    });
    it("retains group zero and omits unsupported lab state and devices", () => {
        const f = fixture(); f.options.labRunner = { status: "ready", stateVolumeName: "labs", stateContainerDir: "/labs", kvmDevicePath: "/dev/kvm", kvmGroupId: 0, networkMode: "user" };
        const ready = f.app.buildPlan(f.options).operations;
        expect(ready).toContainEqual({ kind: "group", id: 0 });
        expect(ready).toContainEqual({ kind: "device", source: "/dev/kvm", destination: "/dev/kvm" });
        f.options.labRunner = { ...f.options.labRunner, status: "unsupported", unsupportedReason: "unavailable" };
        const unsupported = f.app.buildPlan(f.options).operations;
        expect(unsupported.some(op => op.kind === "device" || op.kind === "group" || (op.kind === "bind" && op.source === "labs"))).toBe(false);
        expect(unsupported).toContainEqual({ kind: "env", key: "CCC_LAB_RUNNER_UNSUPPORTED_REASON", value: "unavailable" });
    });
});
