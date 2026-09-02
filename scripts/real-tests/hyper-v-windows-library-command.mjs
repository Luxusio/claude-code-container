import { createHash } from "crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

import {
    isAdministrator,
    requestAdministrator,
    resolveTrustedWindowsPowerShell,
} from "./hyper-v-windows-library-elevation.mjs";
import { HYPER_V_WINDOWS_LIBRARY_SCENARIO_STEP_COUNT } from "./hyper-v-windows-library-steps.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptsDirectory, "..", "..");
const configPath = join(repositoryRoot, "tsconfig.hyper-v-windows.json");
const sourcePath = join(repositoryRoot, "src", "hyper-v-windows");
const compiledPath = join(repositoryRoot, "dist", "hyper-v-windows", "index.js");
const compiledLauncherPath = join(repositoryRoot, "dist", "real-tests", "hyper-v-windows-library.mjs");
const privilegedEntryPath = join(scriptsDirectory, "hyper-v-windows-library-privileged.ts");
const privilegedBundlePath = join(repositoryRoot, "dist", "real-tests", "hyper-v-windows-library-privileged.mjs");
const esbuildPath = join(repositoryRoot, "node_modules", "esbuild-wasm", "bin", "esbuild");
const vitestRunnerPath = join(repositoryRoot, "scripts", "run-vitest.mjs");
const hostSpecPath = join(scriptsDirectory, "hyper-v-windows-library-host.test.ts");
const compilerPath = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
const powerShellValidatorPath = join(repositoryRoot, "scripts", "validate-hyper-v-powershell.mjs");
const MAX_PRIVILEGED_BUNDLE_BYTES = 8 * 1024 * 1024;
const PRIVILEGED_RESULT_MARKER = "CCC_HYPER_V_WINDOWS_LIBRARY_PRIVILEGED_RESULT:";

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
        process.platform === "win32"
            ? ["--require-parser", "--library-fixture-only"]
            : ["--library-fixture-only"],
        "parse the Hyper-V Windows library fixture",
    );
    if (parsed !== 0) return parsed;
    return runNodeTool(esbuildPath, [
        privilegedEntryPath,
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node20",
        "--loader:.ps1=text",
        `--outfile=${privilegedBundlePath}`,
    ], "bundle the privileged Hyper-V Windows library scenario");
}

function runVitestHostSpec(precomputedResult) {
    const result = spawnSync(process.execPath, [vitestRunnerPath, "run", hostSpecPath, "--reporter=default"], {
        cwd: repositoryRoot,
        env: {
            ...process.env,
            CCC_E2E_SKIP_BUILD: "1",
            CCC_HYPER_V_WINDOWS_LIBRARY_REAL: "1",
            ...(precomputedResult
                ? { CCC_HYPER_V_WINDOWS_LIBRARY_PRECOMPUTED: Buffer.from(JSON.stringify(precomputedResult), "utf8").toString("base64") }
                : {}),
        },
        stdio: "inherit",
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        if (result.error) process.stderr.write(`Unable to run Hyper-V Windows library Vitest spec: ${result.error.message}\n`);
        return result.status ?? 1;
    }
    return 0;
}

function digestFile(path) {
    return new Promise((resolve, reject) => {
        const digest = createHash("sha256");
        const input = createReadStream(path);
        input.once("error", reject);
        input.on("data", (chunk) => digest.update(chunk));
        input.once("end", () => resolve(digest.digest("hex")));
    });
}

async function privilegedPayload() {
    const size = statSync(privilegedBundlePath).size;
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PRIVILEGED_BUNDLE_BYTES) {
        throw new Error("elevation-program-size-invalid");
    }
    const programBytes = readFileSync(privilegedBundlePath);
    return {
        programBytes,
        programDigest: createHash("sha256").update(programBytes).digest("hex"),
        nodeDigest: await digestFile(process.execPath),
    };
}

function compactPrecomputedResult(execution) {
    if (execution.errorCode) return { status: 1, errorCode: execution.errorCode };
    const frames = execution.stdout.split(/\r?\n/).filter((line) => line.startsWith(PRIVILEGED_RESULT_MARKER));
    if (frames.length !== 1) return { status: 1, errorCode: "elevation-child-result-invalid" };
    try {
        const encoded = frames[0].slice(PRIVILEGED_RESULT_MARKER.length);
        if (encoded.length > 64 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
            return { status: 1, errorCode: "elevation-child-result-invalid" };
        }
        const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid");
        if (result.ok === true && Array.isArray(result.steps)
            && result.steps.length === HYPER_V_WINDOWS_LIBRARY_SCENARIO_STEP_COUNT
            && result.steps.every((step) => typeof step === "string" && step.length > 0 && step.length <= 256)) {
            return { status: execution.status, steps: result.steps };
        }
        if (result.ok === false && typeof result.errorCode === "string"
            && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.errorCode)) {
            const completedSteps = Number.isInteger(result.completedSteps)
                && result.completedSteps >= 0
                && result.completedSteps <= HYPER_V_WINDOWS_LIBRARY_SCENARIO_STEP_COUNT
                ? result.completedSteps
                : 0;
            return { status: 1, errorCode: `${result.errorCode}[steps=${completedSteps}]` };
        }
    } catch {
        // Return the stable protocol failure below.
    }
    return { status: 1, errorCode: "elevation-child-result-invalid" };
}

async function runCommand() {
    const sourceCheckout = existsSync(configPath) && existsSync(sourcePath)
        && existsSync(hostSpecPath) && existsSync(vitestRunnerPath) && existsSync(privilegedEntryPath);
    if (sourceCheckout) {
        const prepared = prepareSourceCheckout();
        if (prepared !== 0) return prepared;
    }
    if (!existsSync(compiledPath) || !existsSync(compiledLauncherPath) || !existsSync(privilegedBundlePath)) {
        process.stderr.write("FAIL Hyper-V Windows library compiled entrypoint or launcher missing\n");
        return 1;
    }

    if (process.platform === "win32") {
        try {
            const powerShellPath = resolveTrustedWindowsPowerShell();
            if (!isAdministrator({ powerShellPath })) {
                process.stdout.write("REQUEST Hyper-V Windows library administrator permission via UAC\n");
                const payload = await privilegedPayload();
                const elevated = await requestAdministrator({
                    powerShellPath,
                    nodePath: process.execPath,
                    ...payload,
                });
                if (sourceCheckout) return runVitestHostSpec(compactPrecomputedResult(elevated));
                if (elevated.stdout) process.stdout.write(elevated.stdout);
                if (elevated.stderr) process.stderr.write(elevated.stderr);
                if (elevated.errorCode || elevated.status !== 0) {
                    process.stderr.write(`FAIL Hyper-V Windows library real-host elevation: ${elevated.errorCode ?? "elevation-child-failed"}\n`);
                }
                return elevated.status;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : "elevation-probe-failed";
            process.stderr.write(`FAIL Hyper-V Windows library real-host elevation: ${message}\n`);
            return 1;
        }
    }

    if (sourceCheckout) return runVitestHostSpec();
    const { runHyperVWindowsLibraryLevel3 } = await import(pathToFileURL(compiledLauncherPath).href);
    return runHyperVWindowsLibraryLevel3();
}

process.exitCode = await runCommand();
