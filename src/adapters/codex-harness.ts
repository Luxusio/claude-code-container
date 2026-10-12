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
        executeBootstrap: (containerName: string) => spawnSync(runtimeCli(), [
            "exec", "-i", "--workdir", "/home/ccc",
            "--env", "HOME=/home/ccc", "--env", "GIT_TERMINAL_PROMPT=0",
            containerName, "python3", "-",
        ], {input: CODEX_HARNESS_BOOTSTRAP, encoding: "utf-8", timeout: 135000}),
        restoreAccess: (container: string, profile?: string): void => restoreCodexConfigHostOwnership(container, profile),
        publishBootstrapOutput: (message: string): undefined => { console.error(message); return undefined; },
        publishUnavailable: (message: string): undefined => { console.warn(message); return undefined; },
    };
}
