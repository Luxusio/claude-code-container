#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const resultsRoot = join(repoRoot, "results", "tests");
const args = process.argv.slice(2);
let activeChild;
let interrupted;
let captureError;
let logDescriptor;
let record;

const signalExitCode = signal => 128 + (constants.signals[signal] ?? 1);
const errorMessage = error => error instanceof Error ? error.message : String(error);

function writeJson(path, value) {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
    renameSync(temporary, path);
}

function log(chunk) {
    if (captureError) return;
    try {
        writeFileSync(logDescriptor, chunk);
    } catch (error) {
        captureError = error;
        process.stderr.write(`Unable to save test output: ${errorMessage(error)}\n`);
        activeChild?.kill("SIGTERM");
    }
}

function announce(message) {
    const line = message + "\n";
    log(line);
    process.stdout.write(line);
}

async function run(executable, childArgs) {
    return new Promise(resolve => {
        let spawnError;
        const child = spawn(executable, childArgs, {
            cwd: repoRoot,
            env: process.env,
            stdio: ["inherit", "pipe", "pipe"],
            windowsHide: true,
        });
        activeChild = child;
        child.stdout.on("data", log);
        child.stderr.on("data", log);
        // pipe applies backpressure without ending the parent terminal streams.
        child.stdout.pipe(process.stdout, { end: false });
        child.stderr.pipe(process.stderr, { end: false });
        child.once("error", error => { spawnError = error; });
        child.once("close", (code, signal) => {
            activeChild = undefined;
            resolve({ code: code ?? (signal ? signalExitCode(signal) : 1), signal, error: spawnError });
        });
    });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        interrupted ??= signal;
        activeChild?.kill(signal);
    });
}

let exitCode = 1;
try {
    mkdirSync(resultsRoot, { recursive: true });
    const startedAt = new Date().toISOString();
    const runDirectory = mkdtempSync(join(resultsRoot, `${startedAt.replace(/[:.]/g, "-")}-${process.pid}-`));
    const logFile = join(runDirectory, "test.log");
    const reportPath = join(runDirectory, "vitest.json");
    logDescriptor = openSync(logFile, "wx");
    record = {
        schemaVersion: 1,
        startedAt,
        finishedAt: null,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        args,
        runDirectory,
        logFile,
        reportFile: null,
        phase: "setup",
        status: "running",
        exitCode: null,
        signal: null,
    };
    const metadataPath = join(runDirectory, "run.json");
    writeJson(metadataPath, record);
    announce(`Test output: ${logFile}`);
    announce(`Test metadata: ${metadataPath}`);
    if (args.some(arg => /^--(?:reporter|reporters|outputFile)(?:$|[=.])/.test(arg))) {
        throw new Error("npm test manages --reporter and --outputFile to save results; use node scripts/run-vitest.mjs run for custom reporters.");
    }
    const npmCli = process.env.npm_execpath;
    if (process.platform === "win32" && !npmCli) {
        throw new Error("Unable to run script tests: npm_execpath is unavailable on Windows");
    }
    const stages = [
        ["script-tests", npmCli ? process.execPath : "npm", npmCli ? [npmCli, "run", "test:scripts"] : ["run", "test:scripts"]],
        ["vitest", process.execPath, [join(repoRoot, "scripts", "run-vitest.mjs"), "run", ...args,
            "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`]],
    ];
    for (const [phase, executable, childArgs] of stages) {
        if (interrupted || captureError) break;
        record.phase = phase;
        writeJson(metadataPath, record);
        const result = await run(executable, childArgs);
        exitCode = result.code;
        record.signal = interrupted ?? result.signal;
        if (result.error) throw result.error;
        if (exitCode !== 0 || record.signal || captureError) break;
    }
    record.reportFile = existsSync(reportPath) ? reportPath : null;
    if (exitCode === 0 && !interrupted && !captureError && !record.reportFile) {
        throw new Error("Vitest completed without saving its JSON report");
    }
} catch (error) {
    const message = `Unable to complete test run: ${errorMessage(error)}`;
    if (record) record.error = errorMessage(error);
    if (logDescriptor !== undefined) log(message + "\n");
    process.stderr.write(message + "\n");
    if (exitCode === 0) exitCode = 1;
} finally {
    if (interrupted && exitCode === 0) exitCode = signalExitCode(interrupted);
    if (captureError && exitCode === 0) exitCode = 1;
    if (record) {
        record.finishedAt = new Date().toISOString();
        record.exitCode = exitCode;
        record.signal ??= interrupted ?? null;
        record.status = record.signal ? "interrupted" : exitCode === 0 ? "passed" : "failed";
        if (captureError) record.error = errorMessage(captureError);
        announce(`Test results: ${record.runDirectory} (${record.status}, exit ${exitCode})`);
    }
    try {
        if (logDescriptor !== undefined) closeSync(logDescriptor);
        // A final log write can fail after a successful child has closed.
        if (captureError && exitCode === 0) exitCode = 1;
        if (record) {
            record.exitCode = exitCode;
            if (captureError) {
                record.error = errorMessage(captureError);
                if (!record.signal) record.status = "failed";
            }
            writeJson(join(record.runDirectory, "run.json"), record);
            const latestTemporary = join(resultsRoot, `.${basename(record.runDirectory)}.json`);
            writeFileSync(latestTemporary, JSON.stringify(record, null, 2) + "\n");
            renameSync(latestTemporary, join(resultsRoot, "latest.json"));
        }
    } catch (error) {
        process.stderr.write(`Unable to finalize test results: ${errorMessage(error)}\n`);
        if (exitCode === 0) exitCode = 1;
    }
    process.exitCode = exitCode;
}
