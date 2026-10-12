import { describe, expect, it, vi } from "vitest";
import { createContainerRuntimeReadiness } from "../../application/container-runtime-readiness.js";
import type { ContainerRuntimeReadinessPorts } from "../../ports/container-runtime-readiness.js";

const flavors = ["docker-native", "docker-rootless", "docker-desktop", "podman-rootful", "podman-rootless", "podman-machine", "unknown", "future-flavor"];

describe("container runtime readiness semantic policy", () => {
    it("returns ready without collecting unused runtime facts", () => {
        const runtimeInfo = vi.fn(() => { throw new Error("unused facts"); });
        expect(createContainerRuntimeReadiness({ isRunning: () => true, runtimeInfo }).run()).toEqual({ kind: "ready" });
        expect(runtimeInfo).not.toHaveBeenCalled();
    });

    for (const runtime of ["docker", "podman"] as const) {
        it.each(flavors)(`selects ${runtime} repair category for %s`, flavor => {
            const runtimeInfo = vi.fn(() => ({ runtime, flavor }));
            const repairCategory = runtime === "docker"
                ? flavor === "docker-desktop" ? "docker-desktop" : "docker-service"
                : flavor === "podman-machine" ? "podman-machine"
                    : flavor === "podman-rootless" ? "podman-rootless" : "podman-service";
            expect(createContainerRuntimeReadiness({ isRunning: () => false, runtimeInfo }).run())
                .toEqual({ kind: "refused", runtime, repairCategory });
            expect(runtimeInfo).toHaveBeenCalledTimes(1);
        });
    }

    it.each(["isRunning", "runtimeInfo"] as const)("preserves synchronous %s fault identity", step => {
        for (const failure of [new Error("native fault"), { failure: step }]) {
            const runtimeInfo = vi.fn(() => {
                if (step === "runtimeInfo") throw failure;
                return { runtime: "podman" as const, flavor: "unknown" };
            });
            const ports: ContainerRuntimeReadinessPorts = {
                isRunning: () => { if (step === "isRunning") throw failure; return false; },
                runtimeInfo,
            };
            let caught: unknown;
            try { createContainerRuntimeReadiness(ports).run(); } catch (error) { caught = error; }
            expect(caught).toBe(failure);
            expect(runtimeInfo).toHaveBeenCalledTimes(step === "isRunning" ? 0 : 1);
        }
    });
});
