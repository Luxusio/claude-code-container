import type { CodexHostAccessPorts } from "../../ports/credentials/codex-host-access.js";

export function createCodexHostAccessRestoration(ports: CodexHostAccessPorts) {
    function restore(target: string, profile?: string): undefined {
        const configFile = ports.resolveConfig(profile);
        try {
            ports.accessConfig(configFile);
            return;
        } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (code === "ENOENT") return;
            if (code !== "EACCES" && code !== "EPERM") {
                ports.warn(configFile, error);
                return;
            }
        }

        // Repair only the inaccessible file after proving its host parent.
        try {
            if (!ports.hasHostIdentity()) {
                throw new Error("host user identity is unavailable; automatic access repair skipped");
            }
            const parent = ports.inspectParent(configFile);
            const config = ports.inspectConfig(configFile);
            if (!parent.isDirectory() || parent.uid !== ports.currentHostUid() || !config.isFile()) {
                throw new Error("automatic repair requires a regular config file in a non-symlink directory owned by the host user");
            }
            ports.repairConfig(target, configFile);
            ports.accessConfig(configFile);
        } catch (error) {
            // Access failures remain best effort during session/env-file cleanup.
            ports.warn(configFile, error);
        }
    }

    return { restore };
}
