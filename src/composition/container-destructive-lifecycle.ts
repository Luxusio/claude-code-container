import { createContainerDestructiveLifecycle } from "../application/container-destructive-lifecycle.js";
import { runtimeSpawnSync, getRuntimeInvocation, runWithNativeRuntimeInvocation, type NativeRuntimeInvocation } from "../container-runtime.js";
import type { ContainerDestructiveLifecyclePorts } from "../ports/container-destructive-lifecycle.js";

type NativeDestructivePorts = "stop" | "remove" | "reportNotFound" | "reportStopping"
    | "reportStopped" | "reportRemoving" | "reportRemoved" | "reportDeviceCleanupFailure"
    | "throwSessionClaims";

export function createNativeContainerDestructiveLifecycle(
    ports: Omit<ContainerDestructiveLifecyclePorts, NativeDestructivePorts>,
) {
    function createLifecycle() {
        let invocation: NativeRuntimeInvocation | undefined;
        function inRuntime<T>(operation: () => T): T {
            invocation ??= getRuntimeInvocation();
            return runWithNativeRuntimeInvocation(invocation, operation);
        }
        return createContainerDestructiveLifecycle({
            ...ports,
            ensureRuntime: () => inRuntime(() => ports.ensureRuntime()),
            managedIdentity: (name, path) => inRuntime(() => ports.managedIdentity(name, path)),
            stop: (id) => inRuntime(() => {
                const stopped = runtimeSpawnSync(["stop", id], { stdio: "inherit", timeout: 30_000, killSignal: "SIGKILL" });
                if (stopped.error || stopped.status !== 0) throw new Error("Failed to stop container.");
                return undefined;
            }),
            remove: (id) => inRuntime(() => {
                const removed = runtimeSpawnSync(["rm", id], { stdio: "inherit", timeout: 30_000, killSignal: "SIGKILL" });
                if (removed.error || removed.status !== 0) throw new Error("Failed to remove container.");
                return undefined;
            }),
            reportNotFound: () => { console.log("Container not found"); },
            reportStopping: (name, fullPath) => { console.log(`Stopping container ${JSON.stringify(name)} for workspace ${JSON.stringify(fullPath)}...`); },
            reportStopped: () => { console.log("Container stopped"); },
            reportRemoving: (name, fullPath) => { console.log(`Removing container ${JSON.stringify(name)} for workspace ${JSON.stringify(fullPath)}...`); },
            reportRemoved: () => { console.log("Container removed"); },
            reportDeviceCleanupFailure: (error) => {
                console.error(`[ccc] device cleanup failed before container stop: ${error instanceof Error ? error.message : String(error)}`);
            },
            throwSessionClaims: (count, fullPath) => {
                throw new Error(`Container for workspace ${JSON.stringify(fullPath)} has ${count} session ownership claim(s); close its other CCC sessions and retry.`);
            },
        });
    }
    return {
        stop: (...args: Parameters<ReturnType<typeof createLifecycle>["stop"]>) => createLifecycle().stop(...args),
        remove: (...args: Parameters<ReturnType<typeof createLifecycle>["remove"]>) => createLifecycle().remove(...args),
    };
}
