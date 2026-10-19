import { bindNativeRuntimeInvocation, getRuntimeInvocation, runtimeCli } from "../container-runtime.js";
import type { WorkspaceCliContainerRuntime } from "../ports/workspace/cli-removal.js";

export interface WorkspaceCliRemovalRunner {
    (command: string, args: string[], options: { encoding?: "utf-8"; stdio: "ignore" | ["ignore", "pipe", "pipe"] }): {
        error?: unknown; status: number | null; stdout?: unknown;
    };
}

export function createNativeWorkspaceCliContainerRuntime(
    runner?: WorkspaceCliRemovalRunner,
    cli?: string,
): WorkspaceCliContainerRuntime {
    let execute: WorkspaceCliRemovalRunner;
    let command: string;
    if (runner) {
        execute = runner;
        command = cli ?? runtimeCli();
    } else {
        const invocation = getRuntimeInvocation();
        if (cli !== undefined && cli !== invocation.runtime) {
            throw new Error("Workspace container runtime override does not match captured runtime authority.");
        }
        const bound = bindNativeRuntimeInvocation(invocation);
        execute = (_command, args, options) => bound.spawnSync(args, options);
        command = invocation.runtime;
    }
    return {
        listNames() {
            const result = execute(
                command,
                ["ps", "-a", "--format", "{{.Names}}"],
                { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
            );
            if (result.error || result.status !== 0) return { kind: "unavailable" };
            const output = typeof result.stdout === "string" ? result.stdout
                : Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8")
                : result.stdout == null ? "" : null;
            if (output === null) return { kind: "unavailable" };
            return {
                kind: "listed",
                names: output.split(/\r?\n/).map((name) => name.trim()),
            };
        },
        stop(id) {
            const result = execute(command, ["stop", id], { stdio: "ignore" });
            if (result.error || result.status !== 0) throw new Error("Failed to stop workspace container.");
            return undefined;
        },
        remove(id) {
            const result = execute(command, ["rm", id], { stdio: "ignore" });
            if (result.error || result.status !== 0) throw new Error("Failed to remove workspace container.");
            return undefined;
        },
    };
}
