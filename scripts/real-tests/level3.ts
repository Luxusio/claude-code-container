import { join, resolve } from "path";
import { repoRoot } from "./helpers.ts";
import { withExclusiveRealProviderRun } from "./exclusive-real-provider-run.ts";
import { runSupervisedProcess } from "./supervised-process.ts";
import { buildLevel3Artifacts, ensureHostBrokerReady } from "./support/level3-host.ts";

const args = process.argv.slice(2);
const providerConcurrencyIndex = args.indexOf("--provider-concurrency");
const providerConcurrency = providerConcurrencyIndex >= 0 ? args[providerConcurrencyIndex + 1] : "";
if (providerConcurrencyIndex >= 0 && (!/^[1-8]$/.test(providerConcurrency))) {
    throw new Error("--provider-concurrency must be an integer from 1 to 8");
}
const resultFiles = args.filter((arg, index) => (
    arg !== "--provider-concurrency"
    && index !== (providerConcurrencyIndex >= 0 ? providerConcurrencyIndex + 1 : -1)
));
const assertMatrix = join(repoRoot, "scripts", "real-tests", "assert-matrix.ts");
const hiddenChildProcessPreload = join(repoRoot, "scripts", "real-tests", "hidden-child-processes.cjs");

function hiddenChildProcessEnv() {
    const baseEnv = providerConcurrency ? { ...process.env, CCC_LEVEL3_PROVIDER_CONCURRENCY: providerConcurrency } : process.env;
    if (process.platform !== "win32") return baseEnv;
    const preload = hiddenChildProcessPreload.replace(/\\/g, "/").replace(/"/g, '\\"');
    const nodeOptions = [baseEnv.NODE_OPTIONS?.trim(), `--require="${preload}"`].filter(Boolean).join(" ");
    return { ...baseEnv, NODE_OPTIONS: nodeOptions };
}

async function run(command, args) {
    const result = await runSupervisedProcess(command, args, {
        cwd: repoRoot,
        env: hiddenChildProcessEnv(),
    });
    return result.status ?? 1;
}

async function runLevel3() {
    const env = hiddenChildProcessEnv();
    const buildStatus = buildLevel3Artifacts(repoRoot, { env });
    if (buildStatus !== 0) return buildStatus;
    const brokerStatus = await ensureHostBrokerReady(repoRoot, { env });
    if (brokerStatus !== 0) return brokerStatus;

    const vitest = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
    const config = join(repoRoot, "scripts", "real-tests", "vitest.level3.config.ts");
    return await run(process.execPath, [vitest, "run", "--config", config]);
}

try {
    process.exitCode = resultFiles.length > 0
        ? await run(process.execPath, [assertMatrix, ...resultFiles.map((file) => resolve(file))])
        : await withExclusiveRealProviderRun("test:level3", runLevel3);
} catch (error) {
    process.stderr.write(`FAIL ${error?.message || String(error)}\n`);
    process.exitCode = 1;
}
