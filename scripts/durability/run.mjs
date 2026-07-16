#!/usr/bin/env node

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "../..");

const RUNNERS = Object.freeze({
    broker: join(scriptDir, "device-lab.mjs"),
    real: join(scriptDir, "real-provider-cycles.mjs"),
});

export function durabilityLaunchPlan(mode, args, options = {}) {
    const root = options.packageRoot || packageRoot;
    const runner = RUNNERS[mode];
    if (!runner) throw new Error(`mode must be one of: ${Object.keys(RUNNERS).join(", ")}`);
    const sourceCheckout = existsSync(join(root, "src")) && existsSync(join(root, "tsconfig.json"));
    const distCli = join(root, "dist", "index.js");
    if (!sourceCheckout && !existsSync(distCli)) {
        throw new Error(`installed package is missing the built CLI: ${distCli}`);
    }
    return {
        sourceCheckout,
        build: sourceCheckout
            ? { command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "build", "--silent"] }
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
    const executed = spawnSyncImpl(plan.run.command, plan.run.args, {
        cwd: dependencies.packageRoot || packageRoot,
        stdio: "inherit",
        windowsHide: true,
    });
    if (executed.error) throw executed.error;
    return executed.status ?? 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(`FAIL durability launcher: ${error.message}`);
        process.exitCode = 1;
    }
}
