import { createContainerDestructiveLifecycle } from "../application/container-destructive-lifecycle.js";
import { runtimeSpawnSync, getRuntimeInvocation, runWithNativeRuntimeInvocation, type NativeRuntimeInvocation } from "../container-runtime.js";
import { formatContainerLifecycleCommandHint } from "../container-restart-guidance.js";
import type {
    ContainerDestructiveCommandObservation,
    ContainerDestructiveLifecycleOutcome,
    ContainerDestructiveLifecyclePorts,
} from "../ports/container-destructive-lifecycle.js";

type NativeDestructivePorts = "stop" | "remove" | "reportNotFound" | "reportStopping"
    | "reportStopped" | "reportRemoving" | "reportRemoved" | "reportDeviceCleanupFailure"
    | "throwSessionClaims";

function commandObservation(result: unknown): ContainerDestructiveCommandObservation {
    if (!result || typeof result !== "object" || Array.isArray(result)) return { kind: "unconfirmed" };
    const receipt = result as { status?: unknown; error?: unknown; signal?: unknown };
    return {
        kind: receipt.status === 0
            && (receipt.error === undefined || receipt.error === null)
            && (receipt.signal === undefined || receipt.signal === null)
            ? "completed" : "unconfirmed",
    };
}

export function createNativeContainerDestructiveLifecycle(
    ports: Omit<ContainerDestructiveLifecyclePorts, NativeDestructivePorts>,
) {
    function createLifecycle(operation: "stop" | "rm", profile?: string) {
        let invocation: NativeRuntimeInvocation | undefined;
        function inRuntime<T>(operation: () => T): T {
            invocation ??= getRuntimeInvocation();
            return runWithNativeRuntimeInvocation(invocation, operation);
        }
        return createContainerDestructiveLifecycle({
            ...ports,
            sessionClaims: (prefix, fullPath, profile) => inRuntime(() => ports.sessionClaims(prefix, fullPath, profile)),
            ensureRuntime: () => inRuntime(() => ports.ensureRuntime()),
            managedIdentity: (name, path) => inRuntime(() => ports.managedIdentity(name, path)),
            stop: (id) => inRuntime(() => {
                const stopped = runtimeSpawnSync(["stop", id], { stdio: "inherit", timeout: 30_000, killSignal: "SIGKILL" });
                return commandObservation(stopped);
            }),
            remove: (id) => inRuntime(() => {
                const removed = runtimeSpawnSync(["rm", id], { stdio: "inherit", timeout: 30_000, killSignal: "SIGKILL" });
                return commandObservation(removed);
            }),
            reportNotFound: () => { console.log("Container not found"); },
            reportStopping: (name, fullPath) => { console.log(`Stopping container ${JSON.stringify(name)} for workspace ${JSON.stringify(fullPath)}...`); },
            reportStopped: () => { console.log("Container stopped"); },
            reportRemoving: (name, fullPath) => { console.log(`Removing container ${JSON.stringify(name)} for workspace ${JSON.stringify(fullPath)}...`); },
            reportRemoved: () => { console.log("Container removed"); },
            reportDeviceCleanupFailure: (cleanup) => {
                console.error(cleanup.kind === "observed"
                    ? `[ccc] device cleanup incomplete before container stop: ${cleanup.failed} failed`
                    : "[ccc] device cleanup unavailable before container stop");
            },
            throwSessionClaims: (count, fullPath) => {
                throw new Error(`Container for workspace ${JSON.stringify(fullPath)} has ${count} remaining session ownership claim(s) after reconciliation; active or unobservable sessions and incomplete cleanup records are preserved.\n`
                    + "Remaining records are not necessarily active sessions. --force can interrupt active sessions and clean this project's devices; uncertain predecessor records remain unresolved.\n"
                    + `To explicitly force this operation, run in ${formatContainerLifecycleCommandHint({
                        workspacePath: fullPath, runtime: invocation!.runtime, profile, operation, force: true,
                    })}`);
            },
        });
    }

    function renderOutcome(outcome: ContainerDestructiveLifecycleOutcome): undefined {
        if (outcome.kind === "indeterminate") {
            throw new Error(outcome.reason === "container-stop-unconfirmed"
                ? "Failed to stop container." : "Failed to remove container.");
        }
    }

    return {
        stop: (...args: Parameters<ReturnType<typeof createLifecycle>["stop"]>): undefined => renderOutcome(createLifecycle("stop", args[1]).stop(...args)),
        remove: (...args: Parameters<ReturnType<typeof createLifecycle>["remove"]>): undefined => renderOutcome(createLifecycle("rm", args[1]).remove(...args)),
    };
}
