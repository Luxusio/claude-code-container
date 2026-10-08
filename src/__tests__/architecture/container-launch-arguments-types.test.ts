import { expect, expectTypeOf, it } from "vitest";
import { createContainerLaunchArguments, createContainerMountArguments } from "../../application/container-launch-arguments.js";
import type { BindMountArgumentOptions, ContainerLaunchOptions, LaunchRuntimeFacts } from "../../domain/container-launch-arguments.js";
import type { ContainerLaunchArgumentPorts, ContainerMountArgumentPorts } from "../../ports/container-launch-arguments.js";
import type { DockerRunArgsOptions, LabRunnerRunConfig } from "../../docker.js";
import type { ContainerIdentity } from "../../container-identity.js";

function contracts(launchPorts: ContainerLaunchArgumentPorts<ContainerIdentity>, mountPorts: ContainerMountArgumentPorts, options: DockerRunArgsOptions, lab: LabRunnerRunConfig) {
    const inward: ContainerLaunchOptions<ContainerIdentity> = options;
    const launch = createContainerLaunchArguments(launchPorts), mounts = createContainerMountArguments(mountPorts);
    const args: string[] = launch.buildRunArgs(inward);
    args.push("mutable"); options.credentialMounts.push({ hostPath: "/source", containerPath: "/target" }); lab.kvmGroupId = 0;
    const bindOptions: BindMountArgumentOptions = { readonly: true, sourceNamespace: "daemon" };
    mounts.bindMountArgs("/source", "/target", bindOptions).push("mutable");
    // @ts-expect-error Captured runtime facts are synchronous.
    createContainerMountArguments({ ...mountPorts, readRuntimeInfo: async () => mountPorts.readRuntimeInfo() });
    // @ts-expect-error Native capture must return an executable, not its result.
    createContainerLaunchArguments({ ...launchPorts, captureExistsSync: () => true });
    // @ts-expect-error Client and daemon are the only supported source namespaces.
    mounts.bindMountArgs("/source", "/target", { sourceNamespace: "unknown" });
    // @ts-expect-error A foreign identity cannot replace the native caller's opaque identity.
    launch.buildRunArgs({ ...inward, identity: "foreign" });
    // @ts-expect-error Original mount collections remain mutable.
    const immutable: ContainerLaunchOptions<ContainerIdentity> = { ...inward, credentialMounts: [] as readonly { hostPath: string; containerPath: string }[] };
    void immutable;
    return args;
}

it("retains mutable public launch contracts and synchronous inward operation types", () => {
    expectTypeOf<ReturnType<typeof createContainerMountArguments>["bindMountArgs"]>().returns.toEqualTypeOf<string[]>();
    expectTypeOf<LaunchRuntimeFacts["runtime"]>().toEqualTypeOf<"docker" | "podman">();
    expectTypeOf<DockerRunArgsOptions>().toExtend<ContainerLaunchOptions<ContainerIdentity>>();
    expect(typeof contracts).toBe("function");
});
