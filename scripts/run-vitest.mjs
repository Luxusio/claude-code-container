#!/usr/bin/env node
import { spawn, spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

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
    if (process.env.CCC_E2E_SKIP_BUILD === "1") return env;
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

function runVitest(env) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [vitest, ...vitestArgs], {
            cwd: repoRoot,
            env,
            stdio: "inherit",
            windowsHide: true,
        });
        const forwardInterrupt = () => child.kill("SIGINT");
        const forwardTermination = () => child.kill("SIGTERM");
        process.once("SIGINT", forwardInterrupt);
        process.once("SIGTERM", forwardTermination);
        child.once("error", (error) => {
            console.error(`Unable to start Vitest: ${error.message}`);
        });
        child.once("close", (code) => {
            process.removeListener("SIGINT", forwardInterrupt);
            process.removeListener("SIGTERM", forwardTermination);
            resolve(code ?? 1);
        });
    });
}

const delimiter = vitestArgs.indexOf("--");
const options = delimiter < 0 ? vitestArgs : vitestArgs.slice(0, delimiter);
const filesOnlyOptions = options.filter(arg => /^--(?:no-)?files-?only(?:=|$)/i.test(arg));
// Plain `list` imports test modules, including native readiness checks.
const queryOnly = (options[0] === "list" && filesOnlyOptions.length === 1 && ["--filesOnly", "--files-only", "--filesOnly=true", "--files-only=true"].includes(filesOnlyOptions[0]))
    || options.some(arg => ["--help", "-h", "--version", "-v"].includes(arg));
try {
    const env = queryOnly ? hiddenChildProcessEnv() : buildBeforeRun(hiddenChildProcessEnv());
    if (!queryOnly && Number(env.CCC_TEST_LEVEL || 0) >= 2) {
        await import(pathToFileURL(join(repoRoot, "scripts", "real-tests", "typescript-source-loader.mjs")).href);
        const { withExclusiveRealProviderRun } = await import("./real-tests/exclusive-real-provider-run.ts");
        process.exitCode = await withExclusiveRealProviderRun("Vitest native providers", () => runVitest(env));
    } else {
        process.exitCode = await runVitest(env);
    }
} catch (error) {
    console.error(`FAIL ${error?.message || String(error)}`);
    process.exitCode = 1;
}
