import type {MiseConfigSetupPorts} from "../../ports/tooling/mise-config.js";

export function createMiseConfigSetup(ports: MiseConfigSetupPorts) {
    async function ensure(projectPath: string): Promise<undefined> {
        const configPath = ports.configPath(projectPath, "primary");
        if (ports.exists(configPath) || ports.exists(ports.configPath(projectPath, "alternate"))) return undefined;

        const skippedPath = ports.skipMarkerPath(projectPath);
        if (ports.exists(skippedPath)) return undefined;

        const versionFiles = ports.scanVersionFiles(projectPath);
        if (versionFiles.size === 0) return undefined;

        ports.report({kind: "missing-config"});
        const choice = await ports.chooseCreation();
        if (choice === "create") {
            ports.report({kind: "scanning"});
            const scannedFiles = ports.scanVersionFiles(projectPath);
            ports.runToolDetection(projectPath, configPath, scannedFiles);
            if (!ports.exists(configPath)) ports.writeDefaultConfig(configPath);
            ports.report({kind: "created", path: configPath});
        } else {
            ports.report({kind: "skipping"});
            if (choice === "remember-skip") {
                try {
                    ports.rememberSkip(skippedPath);
                    ports.report({kind: "remembered", path: skippedPath});
                } catch {
                    ports.report({kind: "preference-save-failed"});
                }
            }
        }
        return undefined;
    }

    return {ensure};
}
