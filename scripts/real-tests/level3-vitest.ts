import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.ts";

const outputFile = resolve(join(repoRoot, "results", `device-lab-level3-${process.platform}.json`));
const runner = join(repoRoot, "scripts", "test-level.js");

function realTestEnv() {
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "VITEST" && !key.startsWith("VITEST_")));
}

function run(args) {
    return spawnSync(process.execPath, args, {
        cwd: repoRoot,
        env: realTestEnv(),
        encoding: "utf-8",
        windowsHide: true,
        timeout: 30 * 60 * 1000,
    });
}

function resultFailure(result) {
    let summary = null;
    try {
        summary = JSON.parse(readFileSync(outputFile, "utf-8"));
    } catch {
        // Fall back to the collector output when no result was written.
    }
    const failedSteps = (summary?.records || [])
        .filter((record) => record?.status === "FAIL")
        .slice(0, 10)
        .map((record) => `${record.test}${record.step ? ` > ${record.step}` : ""}: ${record.reason || "failed"}`);
    const output = String(result.stderr || result.stdout || "Level 3 collector failed")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-5);
    return [...failedSteps, ...output].filter(Boolean).join("\n");
}

mkdirSync(dirname(outputFile), { recursive: true });
rmSync(outputFile, { force: true });
const collected = run([
    runner,
    "3",
    "--node-test",
    "--compact",
    "--json-summary-file",
    outputFile,
]);

let summary = null;
try {
    summary = JSON.parse(readFileSync(outputFile, "utf-8"));
} catch {
    // A collector bootstrap failure is represented by the fallback test below.
}
const records = Array.isArray(summary?.records) ? summary.records : [];
const failedRecords = records.filter((record) => record?.status === "FAIL");
const grouped = new Map();
for (const record of records) {
    const testName = String(record?.test || "unnamed real-provider test");
    grouped.set(testName, [...(grouped.get(testName) || []), record]);
}

describe("device-lab Level 3", () => {
    if (!summary || records.length === 0) {
        it("collects real-provider test records", () => {
            expect(collected.status, resultFailure(collected)).toBe(0);
            expect(records.length, "Level 3 collector returned no test records").toBeGreaterThan(0);
        });
        return;
    }

    for (const [testName, testRecords] of grouped) {
        describe(testName, () => {
            for (const [index, record] of testRecords.entries()) {
                const caseName = String(record?.step || (testRecords.length === 1 ? "completes" : `case ${index + 1}`));
                if (record?.status === "SKIP") {
                    it.skip(`${caseName} - ${record.reason || "not available on this host"}`, () => undefined);
                    continue;
                }
                it(caseName, () => {
                    expect(record?.status, record?.reason || `${testName} > ${caseName} failed`).toBe("PASS");
                });
            }
        });
    }

    if (failedRecords.length > 0) {
        it.skip("validates provider coverage matrix - blocked by failed provider cases", () => undefined);
    } else {
        it("validates provider coverage matrix", () => {
            expect(collected.status, resultFailure(collected)).toBe(0);
            const validated = run([runner, "--assert-json", outputFile, "--quiet", "--platform-result"]);
            expect(validated.status, resultFailure(validated)).toBe(0);
        });
    }
});
