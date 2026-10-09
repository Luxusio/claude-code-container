import { spawnSync } from "child_process";
import { runtimeCli } from "../container-runtime.js";
import { withCodexConfigLock } from "../codex-config-lock.js";
import { prepareCodexConfigForContainer, restoreCodexConfigHostOwnership } from "../docker.js";
import { CODEX_HARNESS_BOOTSTRAP } from "./codex-harness-bootstrap.js";
import type { CodexHarnessPorts } from "../ports/codex-harness.js";

// Retain the native call intrinsic across message getter evaluation.
const invokeCaptured = Reflect.apply;

export function createNativeCodexHarnessPorts(): CodexHarnessPorts {
    return {
        get withConfigLock() {
            const selected = withCodexConfigLock;
            return <T>(operation: () => T, profile?: string): T => selected(operation, profile);
        },
        get prepareConfig() {
            const selected = prepareCodexConfigForContainer;
            return (container: string, profile?: string): void => selected(container, profile);
        },
        get executeBootstrap() {
            const selected = spawnSync;
            return (containerName: string) => selected(runtimeCli(), [
                "exec", "-i", "--workdir", "/home/ccc",
                "--env", "HOME=/home/ccc", "--env", "GIT_TERMINAL_PROMPT=0",
                containerName, "python3", "-",
            ], {input: CODEX_HARNESS_BOOTSTRAP, encoding: "utf-8", timeout: 135000});
        },
        get restoreAccess() {
            const selected = restoreCodexConfigHostOwnership;
            return (container: string, profile?: string): void => selected(container, profile);
        },
        get publishBootstrapOutput() {
            const receiver = console, selected = receiver.error;
            return (message: string): undefined => { invokeCaptured(selected, receiver, [message]); return undefined; };
        },
        get publishUnavailable() {
            const receiver = console, selected = receiver.warn;
            return (message: string): undefined => { invokeCaptured(selected, receiver, [message]); return undefined; };
        },
    };
}
