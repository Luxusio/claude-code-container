import { spawnSync } from "child_process";
import { createContainerCreateLifecycle } from "../application/container-create-lifecycle.js";
import type { ContainerCreateLifecyclePorts } from "../ports/container-create-lifecycle.js";

type NativeCreatePorts = "failCreate" | "prepareCreate" | "create" | "removeRejected" | "explicitlyAbsent"
    | "reportCreating" | "reportLabWarning" | "reportCreateFailure";

export interface NativeContainerCreateLifecycleContext {
    createCli: string;
    prepareRunArgs(): string[];
    beforeCreating?(): void;
    createFailureHint: string;
    labWarning(): { unsupportedReason?: string } | null;
    explicitlyNotFound(result: ReturnType<typeof spawnSync>): boolean;
}

export function createNativeContainerCreateLifecycle(
    ports: Omit<ContainerCreateLifecyclePorts<{ cli: string; args: string[] }>, NativeCreatePorts>,
    context: NativeContainerCreateLifecycleContext,
) {
    return createContainerCreateLifecycle({
        ...ports,
        failCreate: (failure) => {
            switch (failure.kind) {
                case "namespace-appeared":
                    throw new Error(`Container namespace ${failure.containerName} appeared during creation preflight; refusing replacement.`);
                case "collision":
                    throw new Error(
                        `CCC container ${failure.containerName} already owns this physical project `
                        + `for profile ${failure.profile}; refusing duplicate container creation. `
                        + "The existing container was preserved.",
                    );
                case "create-failed":
                    throw new Error("Failed to create container");
                case "missing-id-verification":
                    throw new Error("created container bind mount identity verification failed (container runtime did not return an exact 64-hex container ID)");
                case "verification-failed":
                    throw new Error(`created container bind mount identity verification failed (${failure.reason})`);
                case "rejected-removal-failed":
                    throw new Error(
                        `${(failure.error as Error).message}; failed to remove rejected container ${failure.containerId}`,
                        { cause: failure.error },
                    );
                case "unpinned-session":
                    throw new Error("Container runtime did not return the created container ID; refusing an unpinned session.");
            }
        },
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
        // Preparation captures native argv before inward source assertions.
        prepareCreate: () => ({ cli: context.createCli, args: context.prepareRunArgs() }),
        create: (prepared) => {
            const result = spawnSync(prepared.cli, prepared.args, {
                encoding: "utf-8",
                stdio: ["inherit", "pipe", "inherit"],
            });
            if (result.status !== 0) return { kind: "failed" };
            const containerId = (result.stdout ?? "").trim().split(/\s+/)
                .find(token => /^[a-f0-9]{64}$/i.test(token)) ?? null;
            return { kind: "created", containerId };
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
