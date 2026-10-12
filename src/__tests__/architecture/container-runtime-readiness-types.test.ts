import { describe, expect, it } from "vitest";
import { createContainerRuntimeReadiness } from "../../application/container-runtime-readiness.js";
import type { RuntimeInfo } from "../../container-runtime.js";
import { ensureDockerRunning } from "../../docker.js";
import type { ContainerRuntimeReadinessPorts, ContainerRuntimeReadinessResult, ContainerRuntimeRepairCategory } from "../../ports/container-runtime-readiness.js";

// Uncalled consumers enforce synchronous observations and semantic result narrowing.
function compileContracts(ports: ContainerRuntimeReadinessPorts, nativeInfo: RuntimeInfo) {
    const result: ContainerRuntimeReadinessResult = createContainerRuntimeReadiness(ports).run();
    if (result.kind === "refused") {
        const runtime: "docker" | "podman" = result.runtime;
        const category: ContainerRuntimeRepairCategory = result.repairCategory;
        void [runtime, category];
    } else {
        // @ts-expect-error Ready does not require runtime facts.
        void result.runtime;
    }
    const publicResult: void = ensureDockerRunning();
    createContainerRuntimeReadiness({ ...ports, runtimeInfo: () => nativeInfo });
    createContainerRuntimeReadiness({ ...ports, runtimeInfo: () => ({ runtime: "docker", flavor: "future-flavor" }) });
    void publicResult;

    // @ts-expect-error Running observation is required.
    createContainerRuntimeReadiness({ runtimeInfo: ports.runtimeInfo });
    // @ts-expect-error Runtime facts are required for refusal.
    createContainerRuntimeReadiness({ isRunning: ports.isRunning });
    // @ts-expect-error Running observation is synchronous.
    createContainerRuntimeReadiness({ ...ports, isRunning: async () => true });
    // @ts-expect-error Runtime facts are synchronous.
    createContainerRuntimeReadiness({ ...ports, runtimeInfo: async () => nativeInfo });
    // @ts-expect-error Running observation returns a boolean.
    createContainerRuntimeReadiness({ ...ports, isRunning: () => "running" });
    // @ts-expect-error Facts include a flavor.
    createContainerRuntimeReadiness({ ...ports, runtimeInfo: () => ({ runtime: "docker" }) });
    // @ts-expect-error Only supported runtimes may select repair guidance.
    createContainerRuntimeReadiness({ ...ports, runtimeInfo: () => ({ runtime: "containerd", flavor: "unknown" }) });
    // @ts-expect-error Refusal requires a repair category.
    const incomplete: ContainerRuntimeReadinessResult = { kind: "refused", runtime: "docker" };
    // @ts-expect-error Repair categories are finite.
    const unknownCategory: ContainerRuntimeRepairCategory = "future-flavor";
    // @ts-expect-error Public facade preserves its legacy void signature.
    const strictPublicResult: undefined = ensureDockerRunning();
    void [incomplete, unknownCategory, strictPublicResult];
}
void compileContracts;

describe("container runtime readiness consumed contracts", () => {
    it("allows semantic refusal to be consumed without CLI effects", () => {
        const result: ContainerRuntimeReadinessResult = createContainerRuntimeReadiness({
            isRunning: () => false,
            runtimeInfo: () => ({ runtime: "podman", flavor: "podman-machine" }),
        }).run();
        expect(result.kind === "refused" && result.repairCategory).toBe("podman-machine");
    });
});
