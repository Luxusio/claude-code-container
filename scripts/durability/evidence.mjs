import { rmSync } from "fs";

export function finalizeDurabilityEvidence(homeDir, failure, options = {}) {
    if (failure) {
        return {
            failure: new Error(`${failure.message}; durability artifacts preserved at ${homeDir}`),
            preserved: true,
            artifactPath: homeDir,
        };
    }
    try {
        (options.rmSyncImpl || rmSync)(homeDir, { recursive: true, force: true });
        return { failure: null, preserved: false, artifactPath: null };
    } catch (error) {
        return {
            failure: new Error(`temporary state cleanup failed: ${error.message}; durability artifacts preserved at ${homeDir}`),
            preserved: true,
            artifactPath: homeDir,
        };
    }
}
