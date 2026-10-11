import { expect, expectTypeOf, it } from "vitest";
import { createContainerLaunchArguments } from "../../application/container-launch-arguments.js";
import type { ContainerLaunchOptions, ContainerLaunchPlan } from "../../domain/container-launch-arguments.js";
import type { ContainerLaunchArgumentPorts } from "../../ports/container-launch-arguments.js";
import type { DockerRunArgsOptions } from "../../docker.js";
import type { ContainerIdentity } from "../../container-identity.js";

function contracts(ports: ContainerLaunchArgumentPorts<ContainerIdentity>, options: DockerRunArgsOptions) {
    const inward: ContainerLaunchOptions<ContainerIdentity> = options;
    const launch = createContainerLaunchArguments(ports);
    const plan: ContainerLaunchPlan = launch.buildPlan(inward);
    // @ts-expect-error Foreign identities cannot replace the caller's identity.
    launch.buildPlan({ ...inward, identity: "foreign" });
    // @ts-expect-error Host observations must remain synchronous.
    createContainerLaunchArguments({ ...ports, observeHostFacts: async () => ({ clipboardPortFilePresent: false }) });
    // @ts-expect-error Native argv is not a semantic launch plan.
    const argv: string[] = plan;
    void argv;
    return plan;
}
it("retains public options and semantic return types", () => {
    expectTypeOf<DockerRunArgsOptions>().toExtend<ContainerLaunchOptions<ContainerIdentity>>();
    expect(typeof contracts).toBe("function");
});
