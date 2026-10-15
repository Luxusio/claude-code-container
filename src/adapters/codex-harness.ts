import { spawnSync } from "child_process";
import { runtimeCli } from "../container-runtime.js";
import { withCodexConfigLock } from "../codex-config-lock.js";
import { prepareCodexConfigForContainer, restoreCodexConfigHostOwnership } from "../docker.js";
import { CODEX_HARNESS_BOOTSTRAP } from "./codex-harness-bootstrap.js";
import type { CodexHarnessPorts } from "../ports/codex-harness.js";

export function createNativeCodexHarnessPorts(): CodexHarnessPorts {
    return {
        withConfigLock: <T>(operation: () => T, profile?: string): T => withCodexConfigLock(operation, profile),
        prepareConfig: (container: string, profile?: string): void => prepareCodexConfigForContainer(container, profile),
        executeBootstrap: (containerName: string) => {
            const result = spawnSync(runtimeCli(), [
                "exec", "-i", "--workdir", "/home/ccc",
                "--env", "HOME=/home/ccc", "--env", "GIT_TERMINAL_PROMPT=0",
                containerName, "python3", "-",
            ], {input: CODEX_HARNESS_BOOTSTRAP, encoding: "utf-8", timeout: 135000});
            const output = result.stdout?.trim() ?? "";
            if (result.error || result.status !== 0) {
                return {kind: "failed", output, failure: new Error(result.error?.message ?? (result.stderr?.trim() || `bootstrap exited ${result.status}`))};
            }
            return {kind: "completed", output};
        },
        restoreAccess: (container: string, profile?: string): void => restoreCodexConfigHostOwnership(container, profile),
        publishBootstrapOutput: (message: string): undefined => { console.error(message); return undefined; },
        publishUnavailable: (error: unknown): undefined => {
            console.warn(`[ccc] Harness is unavailable: ${error instanceof Error ? error.message : String(error)}. Codex will continue. Check the container's ~/.codex/config.toml and Harness installation, then retry ccc codex.`);
            return undefined;
        },
    };
}
