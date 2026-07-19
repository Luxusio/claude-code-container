import { spawnSync } from "child_process";
import { join, resolve } from "path";
import { repoRoot } from "./helpers.mjs";
import { withExclusiveRealProviderRunSync } from "./exclusive-real-provider-run.mjs";

const resultFiles = process.argv.slice(2);
const assertMatrix = join(repoRoot, "scripts", "real-tests", "assert-matrix.mjs");
const hiddenChildProcessPreload = join(repoRoot, "scripts", "real-tests", "hidden-child-processes.cjs");

function hiddenChildProcessEnv() {
    if (process.platform !== "win32") return process.env;
    const preload = hiddenChildProcessPreload.replace(/\\/g, "/").replace(/"/g, '\\"');
    const nodeOptions = [process.env.NODE_OPTIONS?.trim(), `--require="${preload}"`].filter(Boolean).join(" ");
    return { ...process.env, NODE_OPTIONS: nodeOptions };
}

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        env: hiddenChildProcessEnv(),
        stdio: "inherit",
        windowsHide: true,
    });
    return result.status ?? 1;
}

function buildLevel3Artifacts() {
    const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    const compiled = spawnSync(process.execPath, [tsc], {
        cwd: repoRoot,
        env: hiddenChildProcessEnv(),
        encoding: "utf-8",
        windowsHide: true,
    });
    if (compiled.status !== 0) {
        process.stderr.write(compiled.stderr || compiled.stdout || "CCC host broker build failed\n");
        return compiled.status ?? 1;
    }
    const esbuild = join(repoRoot, "node_modules", "esbuild-wasm", "bin", "esbuild");
    const result = spawnSync(process.execPath, [
        esbuild,
        "device-lab-mcp/server.mjs",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--outfile=dist/device-lab-mcp/server.mjs",
        "--banner:js=// device-lab-mcp-version: 1",
    ], {
        cwd: repoRoot,
        env: hiddenChildProcessEnv(),
        encoding: "utf-8",
        windowsHide: true,
    });
    if (result.status === 0) return 0;
    process.stderr.write(result.stderr || result.stdout || "device-lab MCP build failed\n");
    return result.status ?? 1;
}

function ensureHostBrokerReady() {
    if (process.platform !== "win32") return 0;
    const cli = join(repoRoot, "dist", "index.js");
    const result = spawnSync(process.execPath, [cli, "devices", "broker", "status"], {
        cwd: repoRoot,
        env: hiddenChildProcessEnv(),
        encoding: "utf-8",
        timeout: 30000,
        windowsHide: true,
    });
    if (result.status === 0 && /brokerReady:\s*true/.test(result.stdout || "")) return 0;
    process.stderr.write(result.stderr || result.stdout || "CCC host broker owner-resolve preflight failed\n");
    return result.status ?? 1;
}

function runLevel3() {
    const buildStatus = buildLevel3Artifacts();
    if (buildStatus !== 0) return buildStatus;
    const brokerStatus = ensureHostBrokerReady();
    if (brokerStatus !== 0) return brokerStatus;

    const vitest = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
    const config = join(repoRoot, "scripts", "real-tests", "vitest.level3.config.mjs");
    return run(process.execPath, [vitest, "run", "--config", config]);
}

try {
    process.exitCode = resultFiles.length > 0
        ? run(process.execPath, [assertMatrix, ...resultFiles.map((file) => resolve(file))])
        : withExclusiveRealProviderRunSync("test:level3", runLevel3);
} catch (error) {
    process.stderr.write(`FAIL ${error?.message || String(error)}\n`);
    process.exitCode = 1;
}
