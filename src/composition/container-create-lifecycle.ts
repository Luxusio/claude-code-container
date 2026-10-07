import { spawnSync } from "child_process";
import { createContainerCreateLifecycle } from "../application/container-create-lifecycle.js";
import type { ContainerCreateLifecyclePorts } from "../ports/container-create-lifecycle.js";

type NativeCreatePorts = "create" | "removeRejected" | "explicitlyAbsent"
    | "reportCreating" | "reportLabWarning" | "reportCreateFailure";

export interface NativeContainerCreateLifecycleContext {
    createCli: string;
    beforeCreating?(): void;
    createFailureHint: string;
    labWarning(): { unsupportedReason?: string } | null;
    explicitlyNotFound(result: ReturnType<typeof spawnSync>): boolean;
}

export function createNativeContainerCreateLifecycle(
    ports: Omit<ContainerCreateLifecyclePorts, NativeCreatePorts>,
    context: NativeContainerCreateLifecycleContext,
) {
    return createContainerCreateLifecycle({
        ...ports,
        reportCreating: (name, debug) => {
            if (debug) console.error(`[ccc:debug] Container ${name} not found, creating`);
            context.beforeCreating?.();
            console.log("Creating container...");
        },
        reportLabWarning: () => {
            const warning = context.labWarning();
            if (warning) {
                console.warn(`[ccc] lab-runner profile requested but nested VM support is unavailable: ${warning.unsupportedReason}`);
                console.warn("[ccc] no lab state volume is mounted; device-lab reports linux-vm as unsupported/SKIP.");
            }
        },
        reportCreateFailure: () => { console.error(context.createFailureHint); },
        create: (args) => {
            const result = spawnSync(context.createCli, args, {
                encoding: "utf-8",
                stdio: ["inherit", "pipe", "inherit"],
            });
            return {
                get status() { return result.status; },
                get stdout() { return result.stdout; },
            };
        },
        removeRejected: (id) => {
            spawnSync(context.createCli, ["rm", "-f", id], {
                encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
            });
        },
        explicitlyAbsent: (id) => context.explicitlyNotFound(spawnSync(
            context.createCli,
            ["inspect", "-f", "{{.Id}}", id],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        )),
    });
}
