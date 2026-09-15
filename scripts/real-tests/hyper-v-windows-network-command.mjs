import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptsDirectory, "..", "..");
const configPath = join(repositoryRoot, "tsconfig.hyper-v-windows.json");
const sourcePath = join(repositoryRoot, "src", "hyper-v-windows");
const hostEntryPath = join(scriptsDirectory, "hyper-v-windows-network-host.ts");
const compilerPath = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
const esbuildPath = join(repositoryRoot, "node_modules", "esbuild-wasm", "bin", "esbuild");
const powerShellValidatorPath = join(repositoryRoot, "scripts", "validate-hyper-v-powershell.mjs");
const compiledLibraryPath = join(repositoryRoot, "dist", "hyper-v-windows", "index.js");
const compiledHostPath = join(repositoryRoot, "dist", "real-tests", "hyper-v-windows-network-host.mjs");

function runNodeTool(toolPath, args, label) {
    const result = spawnSync(process.execPath, [toolPath, ...args], {
        cwd: repositoryRoot,
        stdio: "inherit",
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        if (result.error) process.stderr.write(`Unable to ${label}: ${result.error.message}\n`);
        return result.status ?? 1;
    }
    return 0;
}

function prepareSourceCheckout() {
    const compiled = runNodeTool(compilerPath, ["-p", configPath], "compile the Hyper-V Windows library");
    if (compiled !== 0) return compiled;
    const parsed = runNodeTool(
        powerShellValidatorPath,
        process.platform === "win32" ? ["--require-parser"] : [],
        "parse the Hyper-V Windows PowerShell programs",
    );
    if (parsed !== 0) return parsed;
    return runNodeTool(esbuildPath, [
        hostEntryPath,
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node20",
        `--outfile=${compiledHostPath}`,
    ], "bundle the Hyper-V Windows network host proof");
}

function runCommand() {
    const sourceCheckout = existsSync(configPath)
        && existsSync(sourcePath)
        && existsSync(hostEntryPath)
        && existsSync(compilerPath)
        && existsSync(esbuildPath);
    if (sourceCheckout) {
        const prepared = prepareSourceCheckout();
        if (prepared !== 0) return prepared;
    }
    if (!existsSync(compiledLibraryPath) || !existsSync(compiledHostPath)) {
        process.stderr.write("FAIL Hyper-V Windows typed network compiled entrypoint or host proof missing\n");
        return 1;
    }
    return runNodeTool(compiledHostPath, [], "run the Hyper-V Windows typed network host proof");
}

process.exitCode = runCommand();
