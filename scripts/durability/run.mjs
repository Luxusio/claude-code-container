#!/usr/bin/env node

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { withExclusiveRealProviderRunSync } from "../real-tests/exclusive-real-provider-run.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "../..");

const RUNNERS = Object.freeze({
    broker: join(scriptDir, "device-lab.mjs"),
    real: join(scriptDir, "real-provider-cycles.mjs"),
});

export function durabilityLaunchPlan(mode, args, options = {}) {
    const root = options.packageRoot || packageRoot;
    const platform = options.platform || process.platform;
    const runner = RUNNERS[mode];
    if (!runner) throw new Error(`mode must be one of: ${Object.keys(RUNNERS).join(", ")}`);
    const sourceCheckout = existsSync(join(root, "src")) && existsSync(join(root, "tsconfig.json"));
    const distCli = join(root, "dist", "index.js");
    if (!sourceCheckout && !existsSync(distCli)) {
        throw new Error(`installed package is missing the built CLI: ${distCli}`);
    }
    const npmExecPath = options.npmExecPath ?? process.env.npm_execpath;
    let build = null;
    if (sourceCheckout) {
        if (npmExecPath) {
            build = {
                command: options.nodeExecPath || process.execPath,
                args: [npmExecPath, "run", "build", "--silent"],
            };
        } else if (platform === "win32") {
            throw new Error("source checkout build on Windows requires npm_execpath; run this command through npm");
        } else {
            build = { command: "npm", args: ["run", "build", "--silent"] };
        }
    }
    const informational = args.includes("--dry-run") || args.includes("--help") || args.includes("-h");
    return {
        sourceCheckout,
        build,
        brokerRepair: mode === "real" && platform === "win32" && !informational
            ? { command: process.execPath, args: [distCli, "devices", "broker", "status"] }
            : null,
        run: { command: process.execPath, args: [runner, ...args] },
    };
}

export function main(args = process.argv.slice(2), dependencies = {}) {
    const [mode, ...forwardedArgs] = args;
    const plan = durabilityLaunchPlan(mode, forwardedArgs, dependencies);
    const spawnSyncImpl = dependencies.spawnSyncImpl || spawnSync;
    if (plan.build) {
        const built = spawnSyncImpl(plan.build.command, plan.build.args, {
            cwd: dependencies.packageRoot || packageRoot,
            stdio: "inherit",
            windowsHide: true,
        });
        if (built.error) throw built.error;
        if (built.status !== 0) return built.status ?? 1;
    }
    if (plan.brokerRepair) {
        const repaired = spawnSyncImpl(plan.brokerRepair.command, plan.brokerRepair.args, {
            cwd: dependencies.packageRoot || packageRoot,
            encoding: "utf8",
            timeout: 30_000,
            windowsHide: true,
        });
        if (repaired.error) throw repaired.error;
        if (repaired.status !== 0 || !/brokerReady:\s*true/.test(repaired.stdout || "")) {
            process.stderr.write(repaired.stderr || repaired.stdout || "CCC host broker preflight failed\n");
            return repaired.status ?? 1;
        }
    }
    const executed = spawnSyncImpl(plan.run.command, plan.run.args, {
        cwd: dependencies.packageRoot || packageRoot,
        stdio: "inherit",
        windowsHide: true,
    });
    if (executed.error) throw executed.error;
    return executed.status ?? 1;
}

export function runDurabilityLauncher(args = process.argv.slice(2), dependencies = {}) {
    const [mode, ...forwardedArgs] = args;
    const realProviderRun = mode === "real"
        && !forwardedArgs.includes("--dry-run")
        && !forwardedArgs.includes("--help")
        && !forwardedArgs.includes("-h");
    if (!realProviderRun) return main(args, dependencies);
    const withExclusive = dependencies.withExclusiveRealProviderRunSync || withExclusiveRealProviderRunSync;
    return withExclusive("real-provider durability", () => {
        const previous = process.env.CCC_REAL_PROVIDER_RUN_LOCK_HELD;
        process.env.CCC_REAL_PROVIDER_RUN_LOCK_HELD = "1";
        try {
            return main(args, dependencies);
        } finally {
            if (previous === undefined) delete process.env.CCC_REAL_PROVIDER_RUN_LOCK_HELD;
            else process.env.CCC_REAL_PROVIDER_RUN_LOCK_HELD = previous;
        }
    });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    try {
        process.exitCode = runDurabilityLauncher();
    } catch (error) {
        console.error(`FAIL durability launcher: ${error.message}`);
        process.exitCode = 1;
    }
}
