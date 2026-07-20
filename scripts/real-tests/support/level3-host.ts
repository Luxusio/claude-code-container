import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

export function buildLevel3Artifacts(repoRoot, options: any = {}) {
    const spawn = options.spawn || spawnSync;
    const env = options.env || process.env;
    const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    const compiled = spawn(process.execPath, [tsc], { cwd: repoRoot, env, encoding: "utf-8", windowsHide: true });
    if (compiled.status !== 0) {
        process.stderr.write(compiled.stderr || compiled.stdout || "CCC host broker build failed\n");
        return compiled.status ?? 1;
    }
    const realTestsTypecheck = spawn(process.execPath, [tsc, "-p", join(repoRoot, "tsconfig.real-tests.json")], { cwd: repoRoot, env, encoding: "utf-8", windowsHide: true });
    if (realTestsTypecheck.status !== 0) {
        process.stderr.write(realTestsTypecheck.stderr || realTestsTypecheck.stdout || "Level 3 real-test typecheck failed\n");
        return realTestsTypecheck.status ?? 1;
    }
    const packageVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version;
    const builtUtils = join(repoRoot, "dist", "utils.js");
    writeFileSync(builtUtils, readFileSync(builtUtils, "utf-8").replace("__CLI_VERSION__", packageVersion));
    const esbuild = join(repoRoot, "node_modules", "esbuild-wasm", "bin", "esbuild");
    const bundled = spawn(process.execPath, [esbuild, "device-lab-mcp/server.mjs", "--bundle", "--platform=node", "--format=esm", "--outfile=dist/device-lab-mcp/server.mjs", "--banner:js=// device-lab-mcp-version: 1"], {
        cwd: repoRoot, env, encoding: "utf-8", windowsHide: true,
    });
    if (bundled.status === 0) return 0;
    process.stderr.write(bundled.stderr || bundled.stdout || "device-lab MCP build failed\n");
    return bundled.status ?? 1;
}

export function ensureHostBrokerReady(repoRoot, options: any = {}) {
    const spawn = options.spawn || spawnSync;
    const result = spawn(process.execPath, [join(repoRoot, "dist", "index.js"), "devices", "broker", "status"], {
        cwd: repoRoot,
        env: options.env || process.env,
        encoding: "utf-8",
        timeout: 30000,
        windowsHide: true,
    });
    if (result.status === 0 && /brokerReady:\s*true/.test(result.stdout || "")) return 0;
    process.stderr.write(result.stderr || result.stdout || "CCC host broker repair preflight failed\n");
    return result.status ?? 1;
}
