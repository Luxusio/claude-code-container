import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { DISPLAY, PACKAGE_ROOT } from "./context.mjs";

export function run(cmd, args) {
    return spawnSync(cmd, args, {
        encoding: "utf-8",
        env: { ...process.env, DISPLAY },
    });
}

export function runWithTimeout(cmd, args, timeoutMs) {
    return spawnSync(cmd, args, {
        encoding: "utf-8",
        env: { ...process.env, DISPLAY },
        timeout: timeoutMs,
    });
}

export function runWithInput(cmd, args, input) {
    return spawnSync(cmd, args, {
        encoding: "utf-8",
        env: { ...process.env, DISPLAY },
        input,
    });
}

export function runBuffer(cmd, args) {
    return spawnSync(cmd, args, {
        env: { ...process.env, DISPLAY },
    });
}

export function commandPath(command) {
    const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
        encoding: "utf-8",
        env: process.env,
    });
    return result.status === 0 ? result.stdout.trim().split("\n")[0] : null;
}

export function localBinPath(command) {
    const candidates = [
        join(PACKAGE_ROOT, "node_modules/.bin", command),
        join(PACKAGE_ROOT, "../device-lab-mcp/node_modules/.bin", command),
        join(process.cwd(), "device-lab-mcp/node_modules/.bin", command),
    ];
    return candidates.find((candidate) => existsSync(candidate)) || null;
}
