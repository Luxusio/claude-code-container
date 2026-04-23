import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { homedir } from "os";

// Duplicate the small path logic from scripts/ui-toolchain.js to keep src/
// self-contained and avoid TS rootDir issues (scripts/ is outside src/).
// If the canonical logic changes, update both places.
// Fields: binDir, binPath (CLI shim), spawnPath (what launchUi actually spawns), distDir.
function _uiBinPaths(platform: string): { binDir: string; binPath: string; spawnPath: string; distDir: string } {
    if (platform === "win32") {
        const localAppData =
            process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
        const binDir = join(localAppData, "Programs", "ccc", "ui");
        return {
            binDir,
            binPath: join(binDir, "ccc-ui.cmd"),
            spawnPath: join(binDir, "ccc-ui.exe"),
            distDir: binDir,
        };
    } else {
        const base = "/usr/local/bin";
        return {
            binDir: join(base, "ccc-ui-dist"),
            binPath: join(base, "ccc-ui"),
            spawnPath: join(base, "ccc-ui"),
            distDir: join(base, "ccc-ui-dist"),
        };
    }
}

/**
 * launchUi(extraArgs) — locate and spawn the installed ccc-ui Tauri binary.
 *
 * Dev mode (CCC_DEV=1): spawns `npm --prefix <repoRoot>/ui run tauri dev` instead.
 * Production: spawns the installed binary from _uiBinPaths().
 */
export async function launchUi(extraArgs: string[]): Promise<void> {
    const devMode = process.env.CCC_DEV === "1" || extraArgs.includes("--dev");

    if (devMode) {
        // Locate the repo root relative to this compiled file (dist/ui-launcher.js)
        const thisFile = fileURLToPath(import.meta.url);
        const repoRoot = dirname(dirname(thisFile)); // dist/ -> repo root
        const uiDir = join(repoRoot, "ui");

        console.log(`[ccc ui] Dev mode — running: npm --prefix ${uiDir} run tauri dev`);
        const result = spawnSync(
            "npm",
            ["--prefix", uiDir, "run", "tauri", "dev"],
            { stdio: "inherit" },
        );
        process.exit(result.status ?? 0);
        return;
    }

    const paths = _uiBinPaths(process.platform);
    const spawnPath = paths.spawnPath;

    if (!existsSync(spawnPath)) {
        console.error(`ccc ui binary not installed.`)
        console.error(``)
        console.error(`For local dev (from a cloned repo):`)
        console.error(`  CCC_DEV=1 ccc ui   # runs npm run tauri dev`)
        console.error(``)
        console.error(`For production install:`)
        console.error(`  Re-run: sudo npm install -g claude-code-container`)
        console.error(`  or from source: sudo npm run install:global`)
        console.error(``)
        console.error(`If postinstall was skipped or failed, build manually:`)
        console.error(`  cd <install-location>/ui`)
        console.error(`  npm install && npm run build`)
        console.error(`  cd src-tauri && cargo build`)
        console.error(``)
        console.error(`Expected binary path: ${spawnPath}`)
        process.exit(1)
    }

    const result = spawnSync(spawnPath, extraArgs, { stdio: "inherit" });
    if (result.error) {
        console.error(`ccc ui: failed to spawn ${spawnPath}:`);
        console.error(`  ${result.error.message}`);
        process.exit(1);
    }
    process.exit(result.status ?? 1);
}
