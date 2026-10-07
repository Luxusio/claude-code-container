import type { CodexPreparationPorts } from "../../ports/credentials/codex-config-preparation.js";
import { createCodexConfigPreparation } from "../codex-config-preparation.js";

export function createOrderedCodexConfigPreparation(ports: CodexPreparationPorts) {
    function prepare(target: string, profile?: string): undefined {
        const configFile = ports.resolveConfig(profile);
        let containerUid: string | undefined;
        const getContainerUid = (): string => {
            if (containerUid === undefined) {
                containerUid = ports.mappedContainerUid(target);
            }
            return containerUid;
        };
        const validateHostDirectory = (): void => {
            if (!ports.hasHostIdentity()) {
                throw new Error("Unable to prepare Codex credentials: host user identity is unavailable");
            }
            const parent = ports.inspectParent(configFile);
            if (!parent.isDirectory() || parent.uid !== ports.currentHostUid()) {
                throw new Error("Unable to prepare Codex credentials: automatic repair requires a non-symlink directory owned by the host user");
            }
        };
        const validateHostConfig = (allowAbsent: boolean): void => {
            try {
                const metadata = ports.inspectConfig(configFile);
                if (!metadata.isFile() || metadata.nlink !== 1) {
                    throw new Error("Unable to prepare Codex credentials: automatic repair requires a regular non-symlink, single-link config file");
                }
            } catch (error) {
                if (allowAbsent && (error as { code?: unknown }).code === "ENOENT") return;
                throw error;
            }
        };

        // Establish parent access before the file probe can report absence.
        createCodexConfigPreparation({
            probe: () => ports.probeDirectory(target, configFile),
            repair: () => {
                validateHostDirectory();
                validateHostConfig(true);
                return ports.repairDirectory(target, configFile, getContainerUid());
            },
            finalize: () => ports.verifyDirectory(target, configFile),
        }).run(target);
        createCodexConfigPreparation({
            probe: () => ports.probeConfig(target, configFile),
            repair: () => {
                validateHostDirectory();
                validateHostConfig(false);
                return ports.repairConfig(target, configFile, getContainerUid());
            },
            finalize: () => ports.verifyConfig(target, configFile),
        }).run(target);
    }

    return { prepare };
}
