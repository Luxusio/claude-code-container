import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerSource = fileURLToPath(new URL("../test.mjs", import.meta.url));
const fixtureProgram = `
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const config = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"));
const phase = process.env.FIXTURE_PHASE;
const args = process.argv.slice(2);
const held = config.hold === phase;
if (held) {
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
        process.stdout.write(phase + " received " + signal + "\\n");
        process.exit(0);
    });
}
writeFileSync(join(root, phase + "-args.json"), JSON.stringify(args));
if (phase === "scripts") {
    const directories = readdirSync(join(root, "results", "tests"), { withFileTypes: true }).filter(entry => entry.isDirectory());
    writeFileSync(join(root, "initialized.json"), JSON.stringify(directories.some(entry => existsSync(join(root, "results", "tests", entry.name, "test.log")))));
}
process.stdout.write(phase + " stdout\\n");
process.stderr.write(phase + " stderr\\n");
if (phase === "vitest") {
    const delimiter = args.indexOf("--");
    const options = delimiter === -1 ? args : args.slice(0, delimiter);
    const reporterArg = options.findLast(arg => arg.startsWith("--reporter=") && arg !== "--reporter=default");
    const reporterPath = reporterArg?.slice("--reporter=".length);
    const reportPath = reporterPath && join(dirname(reporterPath), "vitest.json");
    if (reporterPath && !readFileSync(reporterPath, "utf8").includes(JSON.stringify(reportPath))) throw new Error("Managed reporter does not bind its report path");
    if (reportPath) writeFileSync(reportPath, JSON.stringify({
        numPassedTests: config.vitestCode ? 0 : 1,
        numFailedTests: config.vitestCode ? 1 : 0,
        testResults: [{ assertionResults: [{ fullName: "fixture suite assertion", failureMessages: config.vitestCode ? ["fixture assertion failed\\n at fixture.test.ts:7:3"] : [] }] }],
    }));
}
if (held) {
    writeFileSync(join(root, phase + "-ready"), "ready");
    setInterval(() => {
        if (existsSync(join(root, "release"))) process.exit(0);
    }, 10);
    setTimeout(() => process.exit(92), 5000);
} else {
    // More than one pipe buffer verifies that close includes the trailing output.
    if (config.trailingOutput) process.stdout.write("x".repeat(96 * 1024) + phase + " trailing output\\n");
    process.exitCode = config[phase === "scripts" ? "scriptsCode" : "vitestCode"] ?? 0;
}
`;

function fixture(t, config = {}) {
    const root = mkdtempSync(join(tmpdir(), "ccc test runner "));
    const scripts = join(root, "scripts");
    mkdirSync(scripts);
    copyFileSync(runnerSource, join(scripts, "test.mjs"));
    writeFileSync(join(root, "fixture.json"), JSON.stringify(config));
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(scripts, "fixture.mjs"), fixtureProgram);
    writeFileSync(join(scripts, "fake-npm.mjs"), 'process.env.FIXTURE_PHASE = "scripts"; await import("./fixture.mjs");\n');
    writeFileSync(join(scripts, "run-vitest.mjs"), 'process.env.FIXTURE_PHASE = "vitest"; await import("./fixture.mjs");\n');
    const active = new Set();
    const descendantPids = new Set();
    t.after(async () => {
        for (const pid of descendantPids) {
            try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        for (const running of active) running.child.kill("SIGKILL");
        await Promise.allSettled([...active].map(running => running.completed));
        rmSync(root, { recursive: true, force: true });
    });
    const invocation = (args = [], env = {}) => ({
        args: [join(scripts, "test.mjs"), ...args],
        options: {
            cwd: root,
            env: { ...process.env, NODE_OPTIONS: "", npm_execpath: join(scripts, "fake-npm.mjs"), ...env },
            shell: false,
            windowsHide: true,
        },
    });
    const run = (args = [], env = {}) => {
        const invocationOptions = invocation(args, env);
        const result = spawnSync(process.execPath, invocationOptions.args, {
            ...invocationOptions.options, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
        });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.signal, null, result.stderr);
        return result;
    };
    const start = (args = [], env = {}) => {
        const invocationOptions = invocation(args, env);
        const child = spawn(process.execPath, invocationOptions.args, invocationOptions.options);
        const running = { child, stdout: "", stderr: "" };
        child.stdout.setEncoding("utf8").on("data", chunk => { running.stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", chunk => { running.stderr += chunk; });
        running.completed = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error(`Test runner timed out: ${running.stdout}\n${running.stderr}`));
            }, 10_000);
            child.once("error", error => { clearTimeout(timeout); reject(error); });
            child.once("close", (status, signal) => {
                clearTimeout(timeout);
                active.delete(running);
                resolve({ status, signal, stdout: running.stdout, stderr: running.stderr });
            });
        });
        active.add(running);
        return running;
    };
    const readJson = path => JSON.parse(readFileSync(join(root, path), "utf8"));
    const latest = () => {
        const metadata = readJson(join("results", "tests", "latest.json"));
        assert.deepEqual(metadata, JSON.parse(readFileSync(join(metadata.runDirectory, "run.json"), "utf8")));
        assert.equal(metadata.logFile, join(metadata.runDirectory, "test.log"));
        assert.equal(metadata.platform, process.platform);
        assert.equal(metadata.arch, process.arch);
        assert.equal(metadata.nodeVersion, process.version);
        assert.ok(Number.isFinite(Date.parse(metadata.startedAt)));
        assert.ok(Date.parse(metadata.finishedAt) >= Date.parse(metadata.startedAt));
        return metadata;
    };
    const fault = source => {
        const preload = join(root, "fault.cjs");
        writeFileSync(preload, source);
        return { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
    };
    return { root, run, start, readJson, latest, fault, ownPid: pid => descendantPids.add(pid) };
}

function captureFault(setup, rejectedText) {
    return setup.fault(`
const fs = require("node:fs");
const originalOpen = fs.openSync;
const originalWrite = fs.writeFileSync;
const logDescriptors = new Set();
fs.openSync = (path, ...args) => {
    const descriptor = originalOpen(path, ...args);
    if (String(path).endsWith("test.log")) logDescriptors.add(descriptor);
    return descriptor;
};
fs.writeFileSync = (file, ...args) => {
    if (logDescriptors.has(file) && String(args[0]).includes(${JSON.stringify(rejectedText)})) throw new Error("fixture capture write failed");
    return originalWrite(file, ...args);
};
require("node:module").syncBuiltinESMExports();
`);
}

function realNpmTree(setup) {
    writeFileSync(join(setup.root, "package.json"), JSON.stringify({
        type: "module", scripts: { "test:scripts": "node scripts/held.mjs" },
    }));
    writeFileSync(join(setup.root, "scripts", "held.mjs"), `
import { readFileSync, writeFileSync } from "node:fs";
const config = JSON.parse(readFileSync("fixture.json", "utf8"));
writeFileSync("held.pid", String(process.pid));
process.on("SIGTERM", () => {
    writeFileSync("held-signaled", "SIGTERM");
    if (!config.ignoreTerm) process.exit(0);
});
process.on("exit", () => writeFileSync("held-exited", "exited"));
writeFileSync("held-ready", "ready");
process.stdout.write("held tree output\\n");
setInterval(() => {}, 1000);
setTimeout(() => process.exit(92), 30_000);
`);
    return { npm_execpath: process.env.npm_execpath || "" };
}

async function waitFor(condition) {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
        assert.ok(Date.now() < deadline, "fixture did not become ready before deadline");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

test("captures both streams, complete trailing output, structured results, and forwarded filters", t => {
    const setup = fixture(t, { trailingOutput: true });
    const args = ["src/tests/a file.test.ts", "-t", "a name with spaces"];
    const result = setup.run(args);
    assert.equal(result.status, 0, result.stderr);
    const metadata = setup.latest();
    assert.equal(metadata.status, "passed");
    assert.equal(metadata.phase, "vitest");
    assert.equal(metadata.exitCode, 0);
    assert.equal(metadata.signal, null);
    assert.deepEqual(metadata.args, args);
    assert.equal(setup.readJson("initialized.json"), true);
    assert.deepEqual(setup.readJson("scripts-args.json"), ["run", "test:scripts"]);
    assert.deepEqual(setup.readJson("vitest-args.json"), [
        "run", "--reporter=default", `--reporter=${join(metadata.runDirectory, "vitest-reporter.mjs")}`, ...args,
    ]);
    assert.equal(metadata.reportFile, join(metadata.runDirectory, "vitest.json"));
    assert.equal(JSON.parse(readFileSync(metadata.reportFile, "utf8")).numPassedTests, 1);
    const log = readFileSync(metadata.logFile, "utf8");
    for (const phase of ["scripts", "vitest"]) {
        assert.ok(result.stdout.includes(`${phase} stdout\n`));
        assert.ok(result.stderr.includes(`${phase} stderr\n`));
        assert.ok(log.includes(`${phase} stdout\n`));
        assert.ok(log.includes(`${phase} stderr\n`));
        assert.ok(log.includes("x".repeat(96 * 1024) + `${phase} trailing output\n`));
    }
});

test("keeps managed report options before a user-supplied option delimiter", t => {
    const setup = fixture(t);
    const args = ["src/tests/a file.test.ts", "--"];
    const result = setup.run(args);
    assert.equal(result.status, 0, result.stderr);
    const metadata = setup.latest();
    assert.equal(metadata.status, "passed");
    assert.deepEqual(metadata.args, args);
    const forwarded = setup.readJson("vitest-args.json");
    const options = forwarded.slice(0, forwarded.indexOf("--"));
    assert.ok(options.includes("--reporter=default"));
    assert.ok(options.includes(`--reporter=${join(metadata.runDirectory, "vitest-reporter.mjs")}`));
    assert.equal(JSON.parse(readFileSync(metadata.reportFile, "utf8")).numPassedTests, 1);
});

test("announces the run directory and streams output before script tests finish", async t => {
    const setup = fixture(t, { hold: "scripts" });
    const running = setup.start();
    await waitFor(() => existsSync(join(setup.root, "scripts-ready")) && running.stdout.includes("scripts stdout"));
    const results = join(setup.root, "results", "tests");
    const directory = readdirSync(results, { withFileTypes: true }).find(entry => entry.isDirectory());
    assert.ok(directory);
    const runDirectory = join(results, directory.name);
    assert.ok(running.stdout.includes(runDirectory), running.stdout);
    assert.ok(readFileSync(join(runDirectory, "test.log"), "utf8").includes("scripts stdout"));
    writeFileSync(join(setup.root, "release"), "release");
    const result = await running.completed;
    assert.equal(result.status, 0, result.stderr);
});

test("retains old runs and publishes valid metadata for concurrent unique runs", async t => {
    const setup = fixture(t);
    assert.equal(setup.run().status, 0);
    const previous = setup.latest();
    const previousLog = readFileSync(previous.logFile, "utf8");
    const running = [setup.start(["first filter"]), setup.start(["second filter"])];
    const results = await Promise.all(running.map(child => child.completed));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const latest = setup.latest();
    const directories = readdirSync(join(setup.root, "results", "tests"), { withFileTypes: true }).filter(entry => entry.isDirectory());
    assert.equal(directories.length, 3);
    assert.notEqual(latest.runDirectory, previous.runDirectory);
    assert.equal(readFileSync(previous.logFile, "utf8"), previousLog);
    for (const directory of directories) {
        const metadata = setup.readJson(join("results", "tests", directory.name, "run.json"));
        assert.equal(metadata.status, "passed");
        assert.ok(existsSync(metadata.reportFile));
    }
});

test("short circuits a script-test failure and preserves its exact exit code", t => {
    const setup = fixture(t, { scriptsCode: 23 });
    const result = setup.run();
    assert.equal(result.status, 23, result.stderr);
    assert.equal(existsSync(join(setup.root, "vitest-args.json")), false);
    const metadata = setup.latest();
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.phase, "script-tests");
    assert.equal(metadata.exitCode, 23);
    assert.equal(metadata.reportFile, null);
    assert.ok(readFileSync(metadata.logFile, "utf8").includes("scripts stderr"));
});

test("preserves a Vitest failure code and its structured assertion details", t => {
    const setup = fixture(t, { vitestCode: 19 });
    const result = setup.run();
    assert.equal(result.status, 19, result.stderr);
    const metadata = setup.latest();
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.phase, "vitest");
    assert.equal(metadata.exitCode, 19);
    const report = JSON.parse(readFileSync(metadata.reportFile, "utf8"));
    assert.equal(report.numFailedTests, 1);
    assert.deepEqual(report.testResults[0].assertionResults[0], {
        fullName: "fixture suite assertion",
        failureMessages: ["fixture assertion failed\n at fixture.test.ts:7:3"],
    });
});

test("rejects managed reporter and output options before starting test children", t => {
    const setup = fixture(t);
    for (const args of [
        ["--reporter=dot"], ["--reporter", "dot"], ["--outputFile=elsewhere.json"],
        ["--outputFile.json=elsewhere.json"], ["--outputFile.json", "elsewhere.json"],
        ["--output-file=elsewhere.json"], ["--output-file.json=elsewhere.json"],
        ["--output-file.json", "elsewhere.json"], ["--OUTPUT-FILE=elsewhere.json"],
    ]) {
        const result = setup.run(args);
        assert.notEqual(result.status, 0, JSON.stringify(args));
        assert.match(result.stderr, /reporter|output/i);
        assert.equal(existsSync(join(setup.root, "scripts-args.json")), false);
    }
});

for (const mode of ["directory", "existing latest"]) {
    test(`repairs per-run metadata when latest publication fails with ${mode}`, t => {
        const setup = fixture(t);
        const latestPath = join(setup.root, "results", "tests", "latest.json");
        let env = {};
        let previous;
        if (mode === "directory") {
            mkdirSync(latestPath, { recursive: true });
        } else {
            assert.equal(setup.run().status, 0);
            previous = readFileSync(latestPath, "utf8");
            env = setup.fault(`
const fs = require("node:fs");
const originalRename = fs.renameSync;
fs.renameSync = (source, destination) => {
    if (destination === ${JSON.stringify(latestPath)}) throw new Error("fixture latest publication failed");
    return originalRename(source, destination);
};
require("node:module").syncBuiltinESMExports();
`);
        }
        const result = setup.run([], env);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Unable to finalize test results/);
        const directories = readdirSync(join(setup.root, "results", "tests"), { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name !== "latest.json");
        const metadata = directories.map(entry => setup.readJson(join("results", "tests", entry.name, "run.json")))
            .find(record => record.status === "failed");
        assert.ok(metadata, "failed publication was persisted as a successful run");
        assert.equal(metadata.exitCode, 1);
        assert.equal(metadata.phase, "vitest");
        assert.equal(typeof metadata.error, "string");
        assert.ok(existsSync(metadata.reportFile));
        if (mode === "directory") assert.deepEqual(readdirSync(latestPath), []);
        else assert.equal(readFileSync(latestPath, "utf8"), previous);
    });
}

test("fails before running children when result storage cannot be initialized", t => {
    const setup = fixture(t);
    writeFileSync(join(setup.root, "results"), "a file cannot hold run directories");
    const result = setup.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /result|log|ENOTDIR|EEXIST/i);
    assert.equal(existsSync(join(setup.root, "scripts-args.json")), false);
});

test("records an operating-system child spawn failure without advancing to Vitest", t => {
    const setup = fixture(t);
    const env = setup.fault(`
const cp = require("node:child_process");
const { join } = require("node:path");
const originalSpawn = cp.spawn;
cp.spawn = (_command, args, options) => originalSpawn(join(__dirname, "missing-executable"), args, options);
require("node:module").syncBuiltinESMExports();
`);
    const result = setup.run([], env);
    assert.notEqual(result.status, 0);
    const metadata = setup.latest();
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.phase, "script-tests");
    assert.notEqual(metadata.exitCode, 0);
    assert.equal(metadata.reportFile, null);
    assert.equal(existsSync(join(setup.root, "vitest-args.json")), false);
    assert.match(result.stderr + readFileSync(metadata.logFile, "utf8"), /ENOENT|spawn|start/i);
});

for (const { label, config, rejectedText, expectedCode } of [
    { label: "active child output", config: { hold: "scripts" }, rejectedText: "scripts stdout", expectedCode: 1 },
    { label: "the successful final announcement", config: {}, rejectedText: "Test results:", expectedCode: 1 },
    { label: "the failed final announcement", config: { vitestCode: 19 }, rejectedText: "Test results:", expectedCode: 19 },
]) test(`fails capture of ${label} and preserves an existing test failure code`, t => {
    const setup = fixture(t, config);
    const env = captureFault(setup, rejectedText);
    const result = setup.run([], env);
    assert.equal(result.status, expectedCode, result.stderr);
    assert.match(result.stderr, /fixture capture write failed/);
    const metadata = setup.latest();
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.exitCode, expectedCode);
    if (config.hold === "scripts") assert.equal(existsSync(join(setup.root, "vitest-args.json")), false);
});

for (const mode of ["interruption", "capture failure", "ignored SIGTERM"]) {
    test(`stops the real npm shell descendant tree after ${mode}`, { skip: process.platform === "win32" }, async t => {
        const setup = fixture(t, { ignoreTerm: mode === "ignored SIGTERM" });
        const env = realNpmTree(setup);
        if (mode === "capture failure") Object.assign(env, captureFault(setup, "held tree output"));
        const running = setup.start([], env);
        await waitFor(() => existsSync(join(setup.root, "held-ready")));
        setup.ownPid(Number(readFileSync(join(setup.root, "held.pid"), "utf8")));
        const stoppedAt = Date.now();
        if (mode !== "capture failure") running.child.kill("SIGTERM");
        const result = await running.completed;
        assert.ok(Date.now() - stoppedAt < 5_000, "descendant tree did not stop within the escalation bound");
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(join(setup.root, "held-signaled"), "utf8"), "SIGTERM");
        assert.equal(existsSync(join(setup.root, "held-exited")), mode !== "ignored SIGTERM");
        assert.equal(existsSync(join(setup.root, "vitest-args.json")), false);
        const metadata = setup.latest();
        assert.equal(metadata.phase, "script-tests");
        assert.equal(metadata.reportFile, null);
        assert.equal(metadata.status, mode === "capture failure" ? "failed" : "interrupted");
        assert.equal(metadata.signal, mode === "capture failure" ? null : "SIGTERM");
        if (mode === "capture failure") assert.match(result.stderr, /fixture capture write failed/);
    });
}

test("stops an ignoring same-group descendant after its parent closes all captured pipes", { skip: process.platform === "win32" }, async t => {
    const setup = fixture(t);
    const env = realNpmTree(setup);
    writeFileSync(join(setup.root, "scripts", "held.mjs"), `
import { spawn } from "node:child_process";
spawn(process.execPath, ["scripts/no-pipes.mjs"], { stdio: "ignore" });
setInterval(() => {}, 1000);
`);
    writeFileSync(join(setup.root, "scripts", "no-pipes.mjs"), `
import { writeFileSync } from "node:fs";
writeFileSync("held.pid", String(process.pid));
process.on("SIGTERM", () => {});
let count = 0;
writeFileSync("heartbeat", String(count));
setInterval(() => writeFileSync("heartbeat", String(++count)), 20);
writeFileSync("held-ready", "ready");
setTimeout(() => process.exit(92), 30_000);
`);
    const running = setup.start([], env);
    await waitFor(() => existsSync(join(setup.root, "held-ready")));
    setup.ownPid(Number(readFileSync(join(setup.root, "held.pid"), "utf8")));
    running.child.kill("SIGTERM");
    const result = await running.completed;
    assert.notEqual(result.status, 0);
    const heartbeat = readFileSync(join(setup.root, "heartbeat"), "utf8");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(readFileSync(join(setup.root, "heartbeat"), "utf8"), heartbeat, "descendant survived after wrapper completion");
    assert.equal(setup.latest().status, "interrupted");
    assert.equal(existsSync(join(setup.root, "vitest-args.json")), false);
});

for (const [phase, signal] of [["scripts", "SIGTERM"], ["vitest", "SIGINT"]]) {
    test(`records ${signal} during ${phase} even when the child exits successfully`, { skip: process.platform === "win32" }, async t => {
        const setup = fixture(t, { hold: phase });
        const running = setup.start();
        await waitFor(() => existsSync(join(setup.root, `${phase}-ready`)));
        running.child.kill(signal);
        const result = await running.completed;
        assert.notEqual(result.status, 0);
        const metadata = setup.latest();
        assert.equal(metadata.status, "interrupted");
        assert.equal(metadata.phase, phase === "scripts" ? "script-tests" : "vitest");
        assert.equal(metadata.signal, signal);
        assert.notEqual(metadata.exitCode, 0);
        assert.ok(readFileSync(metadata.logFile, "utf8").includes(`${phase} received ${signal}`));
        if (phase === "scripts") assert.equal(existsSync(join(setup.root, "vitest-args.json")), false);
    });
}
