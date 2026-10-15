import type { WorkspaceCliContainerRuntime } from "../ports/workspace/cli-removal.js";

export interface WorkspaceCliRemovalRunner {
    (command: string, args: string[], options: { encoding: "utf-8"; stdio: ["ignore", "pipe", "pipe"] }): {
        error?: unknown; status: number | null; stdout?: string | null;
    };
    (command: string, args: string[], options: { stdio: "ignore" }): {
        error?: unknown; status: number | null;
    };
}

export function createNativeWorkspaceCliContainerRuntime(
    runner: WorkspaceCliRemovalRunner,
    cli: string,
): WorkspaceCliContainerRuntime {
    return {
        listNames() {
            const result = runner(
                cli,
                ["ps", "-a", "--format", "{{.Names}}"],
                { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
            );
            if (result.error || result.status !== 0) return { kind: "unavailable" };
            return {
                kind: "listed",
                names: (result.stdout ?? "").split(/\r?\n/).map((name) => name.trim()),
            };
        },
        stop(id) {
            const result = runner(cli, ["stop", id], { stdio: "ignore" });
            if (result.error || result.status !== 0) throw new Error("Failed to stop workspace container.");
            return undefined;
        },
        remove(id) {
            const result = runner(cli, ["rm", id], { stdio: "ignore" });
            if (result.error || result.status !== 0) throw new Error("Failed to remove workspace container.");
            return undefined;
        },
    };
}
