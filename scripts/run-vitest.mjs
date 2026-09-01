#!/usr/bin/env node
import { spawn, spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const preloadPath = join(repoRoot, "scripts", "real-tests", "hidden-child-processes.cjs");
const vitestArgs = process.argv.slice(2);

function hiddenChildProcessEnv() {
    if (process.platform !== "win32") return process.env;
    const preload = preloadPath.replace(/\\/g, "/").replace(/"/g, '\\"');
    const nodeOptions = [process.env.NODE_OPTIONS?.trim(), `--require="${preload}"`].filter(Boolean).join(" ");
    return { ...process.env, NODE_OPTIONS: nodeOptions };
}

function buildBeforeRun(env) {
    if (!vitestArgs.includes("run") || process.env.CCC_E2E_SKIP_BUILD === "1") return env;
    const npmCli = process.env.npm_execpath;
    if (process.platform === "win32" && !npmCli) {
        console.error("Unable to build test artifacts: npm_execpath is unavailable on Windows");
        process.exit(1);
    }
    const executable = process.platform === "win32" ? process.execPath : "npm";
    const args = process.platform === "win32" ? [npmCli, "run", "build"] : ["run", "build"];
    const built = spawnSync(executable, args, {
        cwd: repoRoot,
        env,
        stdio: "inherit",
        windowsHide: true,
    });
    if (built.error || built.status !== 0) {
        console.error(`Unable to build test artifacts: ${built.error?.message || `npm exited ${built.status ?? "without status"}`}`);
        process.exit(built.status ?? 1);
    }
    return { ...env, CCC_E2E_SKIP_BUILD: "1" };
}

const child = spawn(process.execPath, [vitest, ...vitestArgs], {
    cwd: repoRoot,
    env: buildBeforeRun(hiddenChildProcessEnv()),
    stdio: "inherit",
    windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
}
child.once("error", (error) => {
    console.error(`Unable to start Vitest: ${error.message}`);
    process.exitCode = 1;
});
child.once("exit", (code) => {
    process.exitCode = code ?? 1;
});
