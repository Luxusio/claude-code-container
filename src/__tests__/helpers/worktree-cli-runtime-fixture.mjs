// Child-only isolation for the real registration-recovery CLI test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const home = process.env.CCC_TEST_WORKTREE_CLI_HOME;
if (!home || !path.isAbsolute(home)) throw new Error("Missing private worktree CLI fixture home");
os.homedir = () => home;
const nativeSpawn = cp.spawnSync;
cp.spawnSync = (command, ...args) => {
    const name = typeof command === "string" ? path.basename(command).replace(/\.exe$/i, "").toLowerCase() : "";
    if (name === "docker" || name === "podman") {
        fs.appendFileSync(path.join(home, "engine-rejected.jsonl"), JSON.stringify({ command, args }) + "\n");
        throw new Error("Worktree ownership fixture must not probe a host container engine");
    }
    return nativeSpawn(command, ...args);
};
syncBuiltinESMExports();
const runtime = await import(new URL("../../container-runtime.ts", import.meta.url).href);
if (process.env.CCC_TEST_WORKTREE_PIN_RUNTIME !== "0") {
    runtime._setRuntimeInfoForTest({ runtime: "docker", version: "fixture", socketPath: null });
}
