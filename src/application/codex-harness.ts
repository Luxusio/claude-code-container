import { codexHarnessExecutionFailure, codexHarnessUnavailableMessage } from "../domain/codex-harness.js";
import type { CodexHarnessPorts } from "../ports/codex-harness.js";

export function createCodexHarness(ports: CodexHarnessPorts) {
    for (const name of ["withConfigLock", "prepareConfig", "executeBootstrap", "restoreAccess", "publishBootstrapOutput", "publishUnavailable"] as const) {
        let target: object | null = ports;
        let descriptor: PropertyDescriptor | undefined;
        while (target != null) {
            descriptor = Object.getOwnPropertyDescriptor(target, name);
            if (descriptor) break;
            target = Object.getPrototypeOf(target);
        }
        if (!descriptor || ("value" in descriptor && typeof descriptor.value !== "function")) throw new TypeError(`Codex Harness requires ${name}`);
    }
    function ensure(containerName: string, profile?: string): void {
        try {
            ports.withConfigLock(() => {
                try {
                    ports.prepareConfig(containerName, profile);
                    const result = ports.executeBootstrap(containerName);
                    if (result.stdout?.trim()) ports.publishBootstrapOutput(result.stdout.trim());
                    if (result.error || result.status !== 0) throw codexHarnessExecutionFailure(result);
                } finally {
                    ports.restoreAccess(containerName, profile);
                }
            }, profile);
        } catch (error) {
            ports.publishUnavailable(codexHarnessUnavailableMessage(error));
        }
    }
    return {ensure};
}
