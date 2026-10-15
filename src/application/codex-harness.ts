import type { CodexHarnessPorts } from "../ports/codex-harness.js";

export function createCodexHarness(ports: CodexHarnessPorts) {
    for (const name of ["withConfigLock", "prepareConfig", "executeBootstrap", "restoreAccess", "publishBootstrapOutput", "publishUnavailable"] as const) {
        if (!ports || typeof ports[name] !== "function") throw new TypeError(`Codex Harness requires ${name}`);
    }
    function ensure(containerName: string, profile?: string): void {
        try {
            ports.withConfigLock(() => {
                try {
                    ports.prepareConfig(containerName, profile);
                    const result = ports.executeBootstrap(containerName);
                    if (result.output) ports.publishBootstrapOutput(result.output);
                    if (result.kind === "failed") throw result.failure;
                } finally {
                    ports.restoreAccess(containerName, profile);
                }
            }, profile);
        } catch (error) {
            ports.publishUnavailable(error);
        }
    }
    return {ensure};
}
