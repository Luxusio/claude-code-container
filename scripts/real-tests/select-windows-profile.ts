// Leaf module: Hyper-V Windows profile selection.
//
// IMPORTANT: the level-3 hyper-v LAUNCHER (scripts/real-tests/hyper-v.ts) runs WITHOUT the
// typescript-source-loader (package.json invokes `node scripts/real-tests/hyper-v.ts`), so it can
// only import modules whose whole graph is natively resolvable — i.e. no TS-style `.js` imports of
// `src/` modules. This module therefore imports ONLY node builtins and `ownerId` (a .mjs that pulls
// only builtins). Keep it dependency-light so both the launcher and the E2E can import it.
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ownerId } from "../../device-lab-mcp/src/context.mjs";

export function cachedImageManifests(options: any = {}) {
    const currentOwner = String(options.ownerId || ownerId());
    return [
        join(homedir(), ".ccc", "device-broker-private", "owners", currentOwner, "images", "hyper-v", "windows-11", "manifest.json"),
        join(homedir(), ".ccc", "device-broker-private", "images", "hyper-v", "windows-11", "manifest.json"),
    ];
}

export function selectHyperVWindowsProfile(options: any = {}) {
    const sourceImage = String(options.sourceImage || process.env.CCC_REAL_HYPER_V_WINDOWS_SOURCE_IMAGE || "").trim();
    const manifestPaths = options.cachedManifestPaths || (options.cachedManifestPath ? [options.cachedManifestPath] : cachedImageManifests(options));
    const manifestExists = options.existsSyncImpl || existsSync;
    let cachedWindows11 = false;
    for (const manifestPath of manifestPaths) {
        if (!manifestExists(manifestPath)) continue;
        try {
            const manifest = JSON.parse(String((options.readFileSyncImpl || readFileSync)(manifestPath, "utf8")));
            cachedWindows11 = manifest?.version === 3
                && manifest?.profile === "windows-11"
                && typeof manifest?.imagePath === "string"
                && manifest.imagePath.length > 0
                && manifestExists(manifest.imagePath);
        } catch {
            // Invalid or stale manifests are ignored so official automatic acquisition remains available.
        }
        if (cachedWindows11) break;
    }
    return sourceImage || cachedWindows11 ? "windows-11" : "windows-server";
}
