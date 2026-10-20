import type { spawnSync } from "child_process";
import { getRuntimeInvocation, bindNativeRuntimeInvocation, runWithNativeRuntimeInvocation } from "../container-runtime.js";
import type { ContainerCreateLifecyclePorts, ContainerCreateResult } from "../ports/container-create-lifecycle.js";

type NativeCreatePorts = "prepareCreate" | "create" | "removeRejected" | "explicitlyAbsent"
    | "reportCreating" | "reportLabWarning" | "reportCreateFailure";

export interface NativeContainerCreateLifecycleContext {
    createCli: string;
    prepareRunArgs(): string[];
    beforeCreating?(): void;
    createFailureHint: string;
    labWarning(): { unsupportedReason?: string } | null;
    explicitlyNotFound(result: ReturnType<typeof spawnSync>): boolean;
}

export function createNativeContainerCreatePorts(
    context: NativeContainerCreateLifecycleContext,
) {
    for (const name of ["prepareRunArgs", "labWarning", "explicitlyNotFound"] as const) {
        if (typeof context?.[name] !== "function") {
            throw new TypeError(`Container create lifecycle requires a callable ${name} context method.`);
        }
    }
    if (context.beforeCreating !== undefined && typeof context.beforeCreating !== "function") {
        throw new TypeError("Container create lifecycle requires a callable beforeCreating context method.");
    }
    const invocation = getRuntimeInvocation();
    const runner = bindNativeRuntimeInvocation(invocation);
    return {
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
        prepareCreate: () => ({ cli: context.createCli, args: runWithNativeRuntimeInvocation(invocation, () => context.prepareRunArgs()) }),
        create: (prepared: { cli: string; args: string[] }, captureFailure?: (cause: unknown) => undefined): ContainerCreateResult => {
            const result = runner.spawnSync(prepared.args, {
                timeout: 30_000, killSignal: "SIGKILL",
                encoding: "utf-8",
                stdio: ["inherit", "pipe", "inherit"],
            });
            if (result.error || result.status !== 0) {
                captureFailure?.(result.error ?? new Error(`Runtime exited with status ${result.status}`));
                return { kind: "failed" };
            }
            const containerId = (result.stdout ?? "").trim().split(/\s+/)
                .find(token => /^[a-f0-9]{64}$/i.test(token)) ?? null;
            return { kind: "created", containerId };
        },
        removeRejected: (id) => {
            const removed = runner.spawnSync(["rm", "-f", id], {
                timeout: 30_000, killSignal: "SIGKILL",
                encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
            });
            if (removed.error || removed.status !== 0) throw new Error("Failed to remove rejected container", { cause: removed.error ?? new Error(removed.stderr || `Runtime exited with status ${removed.status}`) });
        },
        explicitlyAbsent: (id) => {
            const result = runner.spawnSync(["inspect", "-f", "{{.Id}}", id],
                { encoding: "utf-8", timeout: 5_000, killSignal: "SIGKILL", stdio: ["pipe", "pipe", "pipe"] });
            if (result.error) throw result.error;
            if (result.status === null) throw new Error("Rejected container absence inspection did not complete.");
            return context.explicitlyNotFound(result);
        },
    } satisfies Pick<ContainerCreateLifecyclePorts<{ cli: string; args: string[] }>, NativeCreatePorts>;
}
