import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    realProviderRunLockPath,
    withExclusiveRealProviderRun,
    withExclusiveRealProviderRunSync,
} from "../real-tests/exclusive-real-provider-run.ts";

test("level3 and durability share one fail-fast real-provider lock", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-provider-lock-"));
    try {
        withExclusiveRealProviderRunSync("test:level3", () => {
            const lock = JSON.parse(readFileSync(realProviderRunLockPath({ home }), "utf8"));
            assert.equal(lock.pid, process.pid);
            assert.throws(
                () => withExclusiveRealProviderRunSync("real-provider durability", () => {}, { home, waitMs: 0 }),
                (error) => error?.code === "real-provider-test-already-running"
                    && error.message.includes(`pid=${process.pid}`)
                    && error.message.includes("must not overlap"),
            );
        }, { home });
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("async durability lock excludes a synchronous level3 run and releases afterward", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-provider-async-lock-"));
    try {
        await withExclusiveRealProviderRun("real-provider durability", async () => {
            assert.throws(
                () => withExclusiveRealProviderRunSync("test:level3", () => {}, { home, waitMs: 0 }),
                { code: "real-provider-test-already-running" },
            );
        }, { home });
        assert.equal(withExclusiveRealProviderRunSync("test:level3", () => "released", { home }), "released");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("real-provider lock releases when the protected operation throws", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-provider-failed-lock-"));
    try {
        assert.throws(
            () => withExclusiveRealProviderRunSync("test:level3", () => { throw new Error("test failure"); }, { home }),
            /test failure/,
        );
        assert.equal(withExclusiveRealProviderRunSync("durability", () => "recovered", { home }), "recovered");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("real-provider lock excludes a separate process", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-provider-cross-process-lock-"));
    const helperUrl = new URL("../real-tests/exclusive-real-provider-run.ts", import.meta.url).href;
    try {
        withExclusiveRealProviderRunSync("parent level3", () => {
            const script = `
                const { withExclusiveRealProviderRunSync } = await import(${JSON.stringify(helperUrl)});
                try {
                    withExclusiveRealProviderRunSync("child durability", () => {}, { home: ${JSON.stringify(home)}, waitMs: 0 });
                    process.exitCode = 9;
                } catch (error) {
                    process.stderr.write(error.message);
                    process.exitCode = error.code === "real-provider-test-already-running" ? 0 : 8;
                }
            `;
            const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
            assert.equal(child.status, 0, child.stderr);
            assert.match(child.stderr, new RegExp(`pid=${process.pid}`));
        }, { home });
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("real-provider lock recovers after an owner process exits without releasing", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-provider-dead-owner-lock-"));
    const helperUrl = new URL("../real-tests/exclusive-real-provider-run.ts", import.meta.url).href;
    try {
        const script = `
            const { withExclusiveRealProviderRunSync } = await import(${JSON.stringify(helperUrl)});
            withExclusiveRealProviderRunSync("abandoned durability", () => process.exit(0), { home: ${JSON.stringify(home)} });
        `;
        const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
        assert.equal(child.status, 0, child.stderr);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 125);
        assert.equal(withExclusiveRealProviderRunSync("recovered level3", () => "recovered", { home }), "recovered");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
