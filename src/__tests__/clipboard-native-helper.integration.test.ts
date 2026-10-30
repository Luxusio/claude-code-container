import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const nativePlatform = process.platform;
const repository = fileURLToPath(new URL("../../", import.meta.url));
const driver = fileURLToPath(new URL("./helpers/clipboard-native-helper-driver.mjs", import.meta.url));
const cases = ["safe-missing-helper", "bin-symlink", "bin-writable", "run-symlink", "run-writable",
    "ccc-root-symlink", "ccc-root-writable", "substitute-bin"] as const;

// This is actual Darwin compilation and native filesystem qualification, not a
// simulated platform PASS. Portable framing tests remain in their own owner.
describe.runIf(nativePlatform === "darwin")("native clipboard daemon helper compilation", () => {
    it.each(cases)("qualifies production compiler/publication through %s", (kind, context) => {
        const compiler = spawnSync("/usr/bin/xcrun", ["--find", "clang"], {encoding: "utf8", timeout: 5000});
        if (compiler.error || compiler.status !== 0) {
            context.skip("Native Darwin command-line compiler is unavailable");
            return;
        }
        const root = mkdtempSync(join(tmpdir(), "ccc-native-helper-compile-"));
        let cleanupComplete = false;
        try {
            const execution = spawnSync(process.execPath, [driver, join(repository, "dist", "clipboard-server.js"),
                join(repository, "scripts", "clipboard-helper-darwin.m"), root, kind],
            {encoding: "utf8", timeout: 25_000, maxBuffer: 128 * 1024});
            expect(execution.error, `Native fixture retained at ${root}`).toBeUndefined();
            const fact = JSON.parse(execution.stdout.trim());
            cleanupComplete = fact.cleanupComplete === true;
            expect(execution.status, JSON.stringify(fact)).toBe(0);
            expect(fact.ok, JSON.stringify(fact)).toBe(true);
            expect(fact.ready).toEqual({portValid: true, tokenValid: true});
            expect(fact.runtimeInvoked).toBe(false);
            expect(fact.publicationCommitted).toBe(false);
            expect(fact.publicationAbsent).toBe(true);
            expect(fact.cleanupComplete).toBe(true);
            expect(fact.legacyPreserved).toBe(true);
            if (kind === "safe-missing-helper") {
                expect(fact.events.filter((event: {event: string; kind: string}) => event.event === "spawn" && event.kind === "compiler")).toHaveLength(1);
                expect(fact.helper).toMatchObject({regular: true, symlink: false, mode: 0o700, links: 1});
                expect(fact.helper.size).toBeGreaterThan(0);
                expect(fact.stagesRemaining).toEqual([]);
            } else if (kind === "substitute-bin") {
                expect(fact.events.some((event: {event: string}) => event.event === "substituted")).toBe(true);
                expect(fact.currentHelperAbsent).toBe(true);
                expect(fact.replacementPreserved).toBe(true);
            } else {
                expect(fact.events).toEqual([]);
                expect(fact.currentHelperAbsent).toBe(true);
                expect(fact.stagesRemaining).toEqual([]);
            }
        } finally {
            // An unconfirmed process is not cleanup authority. Its private
            // fixture stays available at the failure path for inspection.
            if (cleanupComplete) rmSync(root, {recursive: true, force: true});
        }
    }, 30_000);
});
