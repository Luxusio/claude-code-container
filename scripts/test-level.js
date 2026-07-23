#!/usr/bin/env node
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LEVELS = {
    0: {
        name: "level0",
        description: "default unit and fake-provider contract tests",
        files: [],
        nodeFiles: ["scripts/real-tests/level0-package-smoke.ts"],
    },
    1: {
        name: "level1",
        description: "opt-in non-destructive real-provider readiness tests",
        files: ["src/__tests__/device-lab.real-provider-readiness.test.ts"],
        nodeFiles: [
            "scripts/real-tests/level0-package-smoke.ts",
            "scripts/real-tests/level1-real-provider-readiness.ts",
            "scripts/real-tests/level1-dist-real-provider-readiness.ts",
            "scripts/real-tests/level1-display-e2e.ts",
        ],
    },
    2: {
        name: "level2",
        description: "opt-in real lab integration tests plus lower real levels",
        files: [
            "src/__tests__/device-lab.real-provider-readiness.test.ts",
            "src/__tests__/device-lab.real-host-integration.test.ts",
            "src/__tests__/device-lab.real-ios-e2e.test.ts",
            "src/__tests__/device-lab.real-android-emulator-e2e.test.ts",
            "src/__tests__/device-lab.real-macos-vm-e2e.test.ts",
            "src/__tests__/device-lab.real-windows-sandbox.test.ts",
            "src/__tests__/device-lab-mcp.real-linux-vm.test.ts",
        ],
        nodeFiles: [
            "scripts/real-tests/level0-package-smoke.ts",
            "scripts/real-tests/level1-real-provider-readiness.ts",
            "scripts/real-tests/level1-dist-real-provider-readiness.ts",
            "scripts/real-tests/level1-display-e2e.ts",
            "scripts/real-tests/level2-host-integration-slots.ts",
            "scripts/real-tests/level2-broker-e2e.ts",
            "scripts/real-tests/level2-dist-broker-e2e.ts",
            "scripts/real-tests/level2-ios-e2e.ts",
            "scripts/real-tests/level2-android-emulator-e2e.ts",
            "scripts/real-tests/level2-android-device-e2e.ts",
            "scripts/real-tests/level2-macos-vm-e2e.ts",
            "scripts/real-tests/level2-windows-sandbox.ts",
            "scripts/real-tests/level2-hyper-v-windows-vm.ts",
            "scripts/real-tests/level2-hyper-v-linux-vm.ts",
            "scripts/real-tests/level2-real-linux-vm.ts",
        ],
    },
    3: {
        name: "level3",
        description: "explicit destructive or physical-device tests plus lower real levels",
        files: [
            "src/__tests__/device-lab.real-provider-readiness.test.ts",
            "src/__tests__/device-lab.real-host-integration.test.ts",
            "src/__tests__/device-lab.real-ios-e2e.test.ts",
            "src/__tests__/device-lab.real-android-emulator-e2e.test.ts",
            "src/__tests__/device-lab.real-macos-vm-e2e.test.ts",
            "src/__tests__/device-lab.real-windows-sandbox.test.ts",
            "src/__tests__/device-lab-mcp.real-linux-vm.test.ts",
            "src/__tests__/device-lab.real-destructive.test.ts",
        ],
        nodeFiles: [
            "scripts/real-tests/level0-package-smoke.ts",
            "scripts/real-tests/level1-real-provider-readiness.ts",
            "scripts/real-tests/level1-dist-real-provider-readiness.ts",
            "scripts/real-tests/level1-display-e2e.ts",
            "scripts/real-tests/level2-host-integration-slots.ts",
            "scripts/real-tests/level2-broker-e2e.ts",
            "scripts/real-tests/level2-dist-broker-e2e.ts",
            "scripts/real-tests/level2-ios-e2e.ts",
            "scripts/real-tests/level2-android-device-e2e.ts",
            "scripts/real-tests/level2-macos-vm-e2e.ts",
            "scripts/real-tests/level2-windows-sandbox.ts",
            "scripts/real-tests/level2-hyper-v-windows-vm.ts",
            "scripts/real-tests/level2-hyper-v-linux-vm.ts",
            "scripts/real-tests/level2-real-linux-vm.ts",
            "scripts/real-tests/level3-real-destructive.ts",
        ],
    },
};

function normalizeLevel(value) {
    const text = String(value ?? "0").replace(/^level/i, "");
    const level = Number(text);
    return Number.isInteger(level) && LEVELS[level] ? level : null;
}

function usage() {
    return [
        "Usage: node scripts/test-level.js <0|1|2|3> [--dry-run|--list|--node-test|--compact|--provider-concurrency <1-8>|--fail-on-skip|--fail-on-coverage-gap|--json-summary|--json-summary-file <path>|--summarize-json <path>|--assert-json <path> [--platform-result]]",
        "",
        "Levels:",
        ...Object.entries(LEVELS).map(([level, config]) => `  ${level}: ${config.description}`),
    ].join("\n");
}

function commandFor(level, options = {}) {
    const config = LEVELS[level];
    const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
    const vitestAvailable = !options.forceNodeTest && options.providerConcurrency === undefined && !options.compact && !options.failOnSkip && !options.failOnCoverageGap && !options.jsonSummary && !options.jsonSummaryFile && (level === 0
        ? existsSync(vitest)
        : existsSync(vitest) && config.files.every((file) => existsSync(join(root, file))));
    const mode = vitestAvailable ? "vitest" : "node-test";
    return {
        level,
        name: config.name,
        description: config.description,
        mode,
        command: process.execPath,
        args: mode === "vitest"
            ? [vitest, "run", ...(level > 0 ? ["--reporter", "verbose"] : []), ...config.files]
            : [
                join(root, "scripts", "real-tests", "run.ts"),
                ...(options.compact ? ["--compact"] : []),
                ...(options.failOnSkip ? ["--fail-on-skip"] : []),
                ...(options.failOnCoverageGap ? ["--fail-on-coverage-gap"] : []),
                ...(options.jsonSummary ? ["--json-summary"] : []),
                ...(options.jsonSummaryFile ? ["--json-summary-file", options.jsonSummaryFile] : []),
                "--provider-concurrency",
                String(options.providerConcurrency ?? (level === 3 ? 2 : 1)),
                ...config.nodeFiles.map((file) => join(root, file)),
            ],
        env: {
            CCC_TEST_LEVEL: String(level),
            ...(options.failOnSkip ? { CCC_REAL_DEVICE_LAB_FAIL_ON_SKIP: "1" } : {}),
        },
    };
}

const args = process.argv.slice(2);
const jsonSummaryFileIndex = args.indexOf("--json-summary-file");
const jsonSummaryFile = jsonSummaryFileIndex >= 0 ? args[jsonSummaryFileIndex + 1] : "";
const summarizeJsonIndex = args.indexOf("--summarize-json");
const summarizeJsonFile = summarizeJsonIndex >= 0 ? args[summarizeJsonIndex + 1] : "";
const assertJsonIndex = args.indexOf("--assert-json");
const assertJsonFile = assertJsonIndex >= 0 ? args[assertJsonIndex + 1] : "";
const providerConcurrencyIndex = args.indexOf("--provider-concurrency");
const providerConcurrencyText = providerConcurrencyIndex >= 0 ? args[providerConcurrencyIndex + 1] : "";
const providerConcurrency = providerConcurrencyText === "" ? undefined : Number(providerConcurrencyText);
if (providerConcurrency !== undefined && (!Number.isInteger(providerConcurrency) || providerConcurrency < 1 || providerConcurrency > 8)) {
    console.error("Provider concurrency must be an integer from 1 to 8.");
    process.exit(1);
}
if (args.includes("--list")) {
    console.log(usage());
    process.exit(0);
}
if (summarizeJsonIndex >= 0) {
    if (!summarizeJsonFile) {
        console.error(usage());
        process.exit(1);
    }
    const result = spawnSync(process.execPath, [join(root, "scripts", "real-tests", "summarize-json.ts"), summarizeJsonFile], {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
    });
    process.exit(result.status ?? 1);
}
if (assertJsonIndex >= 0) {
    if (!assertJsonFile) {
        console.error(usage());
        process.exit(1);
    }
    const result = spawnSync(process.execPath, [
        join(root, "scripts", "real-tests", "assert-json.ts"),
        assertJsonFile,
        ...(args.includes("--quiet") ? ["--quiet"] : []),
        ...(args.includes("--platform-result") ? ["--platform-result"] : []),
    ], {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
    });
    process.exit(result.status ?? 1);
}

const jsonSummaryFileValueIndex = jsonSummaryFileIndex >= 0 ? jsonSummaryFileIndex + 1 : -1;
const summarizeJsonFileValueIndex = summarizeJsonIndex >= 0 ? summarizeJsonIndex + 1 : -1;
const assertJsonFileValueIndex = assertJsonIndex >= 0 ? assertJsonIndex + 1 : -1;
const providerConcurrencyValueIndex = providerConcurrencyIndex >= 0 ? providerConcurrencyIndex + 1 : -1;
const level = normalizeLevel(args.find((arg, index) => (
    !arg.startsWith("--")
    && index !== jsonSummaryFileValueIndex
    && index !== summarizeJsonFileValueIndex
    && index !== assertJsonFileValueIndex
    && index !== providerConcurrencyValueIndex
)) ?? "0");
if (level === null) {
    console.error(usage());
    process.exit(1);
}

const planned = commandFor(level, {
    forceNodeTest: args.includes("--node-test"),
    compact: args.includes("--compact"),
    failOnSkip: args.includes("--fail-on-skip"),
    failOnCoverageGap: args.includes("--fail-on-coverage-gap"),
    jsonSummary: args.includes("--json-summary"),
    jsonSummaryFile,
    providerConcurrency,
});
if (args.includes("--dry-run")) {
    console.log(JSON.stringify(planned, null, 2));
    process.exit(0);
}

console.log(`Running ${planned.name}: ${planned.description}`);
const result = spawnSync(planned.command, planned.args, {
    cwd: root,
    env: { ...process.env, ...planned.env },
    stdio: "inherit",
    windowsHide: true,
});

process.exit(result.status ?? 1);
