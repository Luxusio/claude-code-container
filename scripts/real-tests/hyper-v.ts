import { join } from "path";
import { fileURLToPath } from "url";
import { repoRoot } from "./helpers.ts";
import { withExclusiveRealProviderRun } from "./exclusive-real-provider-run.ts";
import { runSupervisedProcess } from "./supervised-process.ts";
import { buildLevel3Artifacts, ensureHostBrokerReady } from "./support/level3-host.ts";

const targets = {
    all: ["level2-hyper-v-windows-vm.ts", "level2-hyper-v-linux-vm.ts"],
    windows: ["level2-hyper-v-windows-vm.ts"],
    linux: ["level2-hyper-v-linux-vm.ts"],
};

export function hyperVTestFiles(target: string) {
    const selected = targets[target as keyof typeof targets];
    if (!selected) throw new Error("--target must be one of: all, windows, linux");
    return selected.map((file) => join(repoRoot, "scripts", "real-tests", file));
}

export async function runHyperVTests(target: string, dependencies: any = {}) {
    const testFiles = hyperVTestFiles(target);
    const env = dependencies.env || process.env;
    const build = dependencies.buildLevel3ArtifactsImpl || buildLevel3Artifacts;
    const ensureBroker = dependencies.ensureHostBrokerReadyImpl || ensureHostBrokerReady;
    const runProcess = dependencies.runSupervisedProcessImpl || runSupervisedProcess;
    const buildStatus = build(repoRoot, { env });
    if (buildStatus !== 0) return buildStatus;
    const brokerStatus = await ensureBroker(repoRoot, { env });
    if (brokerStatus !== 0) return brokerStatus;
    const runner = join(repoRoot, "scripts", "real-tests", "run.ts");
    const result = await runProcess(process.execPath, [runner, "--compact", ...testFiles], {
        cwd: repoRoot,
        env,
    });
    return result.status ?? 1;
}

export async function runHyperVLevel3(args = process.argv.slice(2), dependencies: any = {}) {
    const targetIndex = args.indexOf("--target");
    const target = targetIndex >= 0 ? String(args[targetIndex + 1] || "") : "all";
    hyperVTestFiles(target);
    const withExclusive = dependencies.withExclusiveRealProviderRunImpl || withExclusiveRealProviderRun;
    return withExclusive(`test:level3:hyper-v:${target}`, () => runHyperVTests(target, dependencies));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    try {
        process.exitCode = await runHyperVLevel3();
    } catch (error: any) {
        process.stderr.write(`FAIL Hyper-V Level 3 launcher: ${error?.message || String(error)}\n`);
        process.exitCode = 1;
    }
}
