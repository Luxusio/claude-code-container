import { spawnSync } from "child_process";
import { createContainerExistingLifecycle } from "../application/container-existing-lifecycle.js";
import { runtimeCli } from "../container-runtime.js";
import { ContainerRestartRequiredError } from "../container-restart-guidance.js";
import type { ContainerExistingLifecyclePorts } from "../ports/container-existing-lifecycle.js";

type NativeLifecyclePorts = "start" | "stop" | "remove" | "reportContractMismatch"
    | "reportContractMatch" | "reportRestart" | "reportRecreation" | "reportDeferred"
    | "throwUnsafeDefer";

export interface NativeContainerExistingLifecycleContext {
    startCli: string;
    beforeStart?(): void;
    afterStart?(id: string): void;
    beforeRemove?(): void;
    requiredMountDestinations(): readonly string[];
    projectPath: string;
    profile?: string;
}

export function createNativeContainerExistingLifecycle(
    ports: Omit<ContainerExistingLifecyclePorts, NativeLifecyclePorts>,
    context: NativeContainerExistingLifecycleContext,
) {
    return createContainerExistingLifecycle({
        ...ports,
        start: (id) => {
            context.beforeStart?.();
            const started = spawnSync(context.startCli, ["start", id], { stdio: "inherit" });
            if (started.error || started.status !== 0) {
                throw new Error("Stopped container could not be restarted; automatic replacement was refused.");
            }
            context.afterStart?.(id);
        },
        stop: (id) => {
            const stopped = spawnSync(runtimeCli(), ["stop", id], {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "pipe"],
            });
            if (stopped.error || stopped.status !== 0) {
                throw new Error("Container replacement aborted because the idle running container could not be stopped.");
            }
        },
        remove: (id) => {
            context.beforeRemove?.();
            // Ordinary rm refuses removal if an external actor starts the container.
            const removed = spawnSync(runtimeCli(), ["rm", id], {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "pipe"],
            });
            if (removed.error || removed.status !== 0) {
                throw new Error("Container replacement aborted because the stopped container could not be removed.");
            }
        },
        reportContractMismatch: (name) => {
            console.error(`[ccc:debug] Container ${name} missing required mounts or VM run contract:`);
            for (const destination of context.requiredMountDestinations()) {
                console.error(`[ccc:debug]   required destination: ${destination}`);
            }
        },
        reportContractMatch: (name) => {
            console.error(`[ccc:debug] Container ${name} has all required mounts`);
        },
        reportRestart: (name) => {
            console.error(`[ccc:debug] Container ${name} exists, restarting`);
        },
        reportRecreation: (reason) => {
            console.log(`Recreating container (${reason})...`);
        },
        reportDeferred: (reason) => {
            console.warn(`[ccc] Container update deferred (${reason}) because the existing container is running. It will be applied after the container stops.`);
        },
        throwUnsafeDefer: (reason) => {
            throw new ContainerRestartRequiredError(reason, context.projectPath, runtimeCli(), context.profile);
        },
    });
}
