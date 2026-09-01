import { createRequire } from "module";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../..");
const { installHiddenWindowsChildProcesses } = require("../../scripts/real-tests/hidden-child-processes.cjs") as {
    installHiddenWindowsChildProcesses: (target: Record<string | symbol, unknown>, platform: NodeJS.Platform) => boolean;
};

describe("Windows test child-process policy", () => {
    it("loads the policy in Level 3 and both Vitest entry points", () => {
        const level3 = readFileSync(join(repoRoot, "scripts/real-tests/level3.ts"), "utf8");
        const level3Host = readFileSync(join(repoRoot, "scripts/real-tests/support/level3-host.ts"), "utf8");
        const vitestRunner = readFileSync(join(repoRoot, "scripts/run-vitest.mjs"), "utf8");
        const level3Config = readFileSync(join(repoRoot, "scripts/real-tests/vitest.level3.config.ts"), "utf8");
        const vitestConfig = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");

        expect(level3).toContain("hidden-child-processes.cjs");
        expect(level3).toContain("NODE_OPTIONS");
        expect(level3Host).toContain('[join(repoRoot, "dist", "index.js"), "devices", "broker", "status"]');
        expect(level3Host).toContain("brokerReady:\\s*true");
        expect(vitestRunner).toContain("hidden-child-processes.cjs");
        expect(vitestRunner).toContain("windowsHide: true");
        expect(vitestRunner).toContain("process.env.npm_execpath");
        expect(vitestRunner).toContain('process.env.CCC_E2E_SKIP_BUILD === "1"');
        expect(vitestRunner).toContain('process.platform === "win32" ? process.execPath : "npm"');
        expect(vitestRunner).not.toContain('process.platform === "win32" ? "npm.cmd" : "npm"');
        expect(level3Config).toContain("setupFiles: [\"./scripts/real-tests/hidden-child-processes.cjs\"]");
        expect(vitestConfig).toContain("setupFiles: ['./scripts/real-tests/hidden-child-processes.cjs']");
        expect(vitestConfig).toContain("Math.min(8, Math.floor(availableParallelism() / 2))");
        expect(vitestConfig).toContain("maxWorkers,");
    });

    it("overrides explicit visible-window options across every child-process API", () => {
        const calls: Array<{ method: string; options: Record<string, unknown> }> = [];
        const target = Object.fromEntries([
            "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork",
        ].map((method) => [method, (...args: unknown[]) => {
            const options = [...args].reverse().find((arg) => arg && typeof arg === "object" && !Array.isArray(arg)) as Record<string, unknown> | undefined;
            calls.push({ method, options: options || {} });
            return { method };
        }]));

        expect(installHiddenWindowsChildProcesses(target, "win32")).toBe(true);
        target.spawn("node", ["server.mjs"], { windowsHide: false });
        target.spawnSync("adb", ["devices"], {});
        target.exec("adb devices", { windowsHide: false });
        target.execSync("adb devices", {});
        target.execFile("java", ["-version"], { windowsHide: false });
        target.execFileSync("java", ["-version"], {});
        target.fork("worker.js", [], { windowsHide: false });

        expect(calls.map((call) => call.method)).toEqual([
            "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork",
        ]);
        for (const call of calls) expect(call.options.windowsHide).toBe(true);
        expect(installHiddenWindowsChildProcesses(target, "win32")).toBe(false);
    });

    it("synchronizes patched child-process functions into ESM named exports", () => {
        const preload = join(repoRoot, "scripts/real-tests/hidden-child-processes.cjs");
        const script = [
            `const policy = require(${JSON.stringify(preload)});`,
            'const childProcess = require("node:child_process");',
            'policy.installHiddenWindowsChildProcesses(childProcess, "win32");',
            'import("node:child_process").then((esm) => process.stdout.write(String(esm.spawn === childProcess.spawn)));',
        ].join("\n");
        const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", windowsHide: true });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("true");
    });
});
