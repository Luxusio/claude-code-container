import { spawnSync } from "child_process";
import { join, resolve } from "path";
import { repoRoot } from "./helpers.ts";
import { withExclusiveRealProviderRunSync } from "./exclusive-real-provider-run.ts";
import { buildLevel3Artifacts, ensureHostBrokerReady } from "./support/level3-host.ts";

const resultFiles = process.argv.slice(2);
const assertMatrix = join(repoRoot, "scripts", "real-tests", "assert-matrix.ts");
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

function runLevel3() {
    const env = hiddenChildProcessEnv();
    const buildStatus = buildLevel3Artifacts(repoRoot, { env });
    if (buildStatus !== 0) return buildStatus;
    const brokerStatus = ensureHostBrokerReady(repoRoot, { env });
    if (brokerStatus !== 0) return brokerStatus;

    const vitest = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
    const config = join(repoRoot, "scripts", "real-tests", "vitest.level3.config.ts");
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
