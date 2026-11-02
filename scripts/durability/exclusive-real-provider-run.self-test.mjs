import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSharedMutationLock } from "../../packages/device-lab/providers/application/shared-mutation-lock.mjs";
import {
    realProviderRunLockPath,
    withExclusiveRealProviderRun,
    withExclusiveRealProviderRunSync,
} from "../real-tests/exclusive-real-provider-run.ts";

let fixtureNumber = 0;
function coldLockFixture(identityDelayMs = 250, initialRecord) {
    const home = join(tmpdir(), `ccc-real-provider-admission-${++fixtureNumber}`);
    const file = realProviderRunLockPath({ home });
    const identity = { pid: 123, startToken: "cold-process", commandHash: "a".repeat(64) };
    let elapsed = 0, record = initialRecord, openClaims = 0, removals = 0, timeout;
    const readIdentity = () => { elapsed += identityDelayMs; return identity; };
    const locks = createSharedMutationLock({
        variant: "provider", key: path => path, ownerContext: () => [],
        runOwnerContext: (_key, _token, operation) => operation(), capture: () => [], check: () => undefined,
        token: () => "a".repeat(32), pid: () => identity.pid, host: () => "test-host", boot: () => "test-boot",
        platform: () => "win32", timestamp: () => new Date(1_000_000 + elapsed).toISOString(),
        now: () => 1_000_000 + elapsed, monotonic: () => elapsed,
        pauseSync: milliseconds => { elapsed += milliseconds; },
        pause: (milliseconds, signal) => {
            if (!signal) { elapsed += milliseconds; return Promise.resolve(); }
            return new Promise((_resolve, reject) => {
                const abort = () => reject(Object.assign(new Error("observation cancelled"), { name: "AbortError" }));
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
            });
        },
        openClaim: () => {
            openClaims++;
            if (record !== undefined) throw Object.assign(new Error("occupied"), { code: "EEXIST" });
            record = {};
            return 1;
        },
        writeClaim: (_descriptor, text) => { record = JSON.parse(text); }, closeClaim: () => undefined,
        readRaw: () => record === undefined ? { kind: "missing" } : { kind: "value", value: record },
        mtime: () => 0, alive: () => true, identitySync: readIdentity,
        identityAsync: async () => { await Promise.resolve(); return readIdentity(); },
        observe: () => "unavailable", matches: (expected, current) => expected.startToken === current.startToken,
        moveQualified: (_path, token) => {
            if (record?.token !== token) return false;
            record = undefined; removals++;
            return true;
        },
        moveMalformed: () => false, archives: () => [], removeArchive: () => false,
        errorCode: error => error?.code,
        timeout: () => (timeout = Object.assign(new Error("shared lock acquisition expired"), { code: "shared-mutation-lock-timeout" })),
    });
    return { file, options: { home, withLock: locks.withLock, withLockAsync: locks.withLockAsync },
        get elapsed() { return elapsed; }, get record() { return record; }, get openClaims() { return openClaims; },
        get removals() { return removals; }, get timeout() { return timeout; } };
}

test("default sync and async admission allow cold Windows identity work beyond 100ms", async () => {
    const sync = coldLockFixture();
    assert.equal(withExclusiveRealProviderRunSync("test:level3", () => "sync admitted", sync.options), "sync admitted");
    const asynchronous = coldLockFixture();
    assert.equal(await withExclusiveRealProviderRun("durability", async () => "async admitted", asynchronous.options), "async admitted");
    for (const fixture of [sync, asynchronous]) {
        assert.equal(fixture.elapsed, 250);
        assert.equal(fixture.openClaims, 1);
        assert.equal(fixture.record, undefined);
    }
});

test("explicit short waits report acquisition failure before any claim or operation", async () => {
    for (const asynchronous of [false, true]) {
        const fixture = coldLockFixture();
        let entered = false;
        const operation = () => { entered = true; };
        const options = { ...fixture.options, waitMs: 100 };
        const check = error => {
            assert.equal(error.code, "real-provider-test-lock-unavailable");
            assert.equal(error.cause, fixture.timeout);
            assert.equal(error.lockPath, fixture.file);
            assert.match(error.message, /lock could not be acquired/);
            assert.match(error.message, /must not overlap/);
            assert.doesNotMatch(error.message, /already running|owner metadata unavailable/);
            return true;
        };
        if (asynchronous) await assert.rejects(withExclusiveRealProviderRun("durability", operation, options), check);
        else assert.throws(() => withExclusiveRealProviderRunSync("test:level3", operation, options), check);
        assert.equal(fixture.openClaims, 0);
        assert.equal(entered, false);
        assert.equal(fixture.record, undefined);
    }
});

test("explicit zero wait retains one-shot admission after cold identity initialization", async () => {
    const sync = coldLockFixture();
    assert.equal(withExclusiveRealProviderRunSync("test:level3", () => "sync admitted", { ...sync.options, waitMs: 0 }), "sync admitted");
    const asynchronous = coldLockFixture();
    assert.equal(await withExclusiveRealProviderRun("durability", async () => "async admitted", { ...asynchronous.options, waitMs: 0 }), "async admitted");
    for (const fixture of [sync, asynchronous]) {
        assert.equal(fixture.elapsed, 250);
        assert.equal(fixture.openClaims, 1);
    }
});

test("unknown live ownership remains protected with explicit zero wait", async () => {
    for (const asynchronous of [false, true]) {
        const owner = { token: "b".repeat(32), pid: 456, host: "test-host", bootId: "test-boot", processIdentityStatus: "unavailable" };
        const fixture = coldLockFixture(250, owner);
        let entered = false;
        const operation = () => { entered = true; };
        const options = { ...fixture.options, waitMs: 0 };
        if (asynchronous) await assert.rejects(withExclusiveRealProviderRun("durability", operation, options), { code: "real-provider-test-lock-unavailable" });
        else assert.throws(() => withExclusiveRealProviderRunSync("test:level3", operation, options), { code: "real-provider-test-lock-unavailable" });
        assert.equal(fixture.openClaims, 1);
        assert.equal(fixture.record, owner);
        assert.equal(fixture.removals, 0);
        assert.equal(entered, false);
    }
});

test("sync and async operation-owned lock timeouts retain their exact error identity", async () => {
    const failure = Object.assign(new Error("protected operation timeout"), { code: "shared-mutation-lock-timeout" });
    const sync = coldLockFixture();
    assert.throws(() => withExclusiveRealProviderRunSync("test:level3", () => { throw failure; }, sync.options), error => error === failure);
    const asynchronous = coldLockFixture();
    await assert.rejects(withExclusiveRealProviderRun("durability", async () => { throw failure; }, asynchronous.options), error => error === failure);
    assert.equal(sync.record, undefined);
    assert.equal(asynchronous.record, undefined);
});

test("level3 and durability share one real-provider lock and retain local self-contention", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-provider-lock-"));
    try {
        withExclusiveRealProviderRunSync("test:level3", () => {
            const lock = JSON.parse(readFileSync(realProviderRunLockPath({ home }), "utf8"));
            assert.equal(lock.pid, process.pid);
            assert.throws(
                () => withExclusiveRealProviderRunSync("real-provider durability", () => {}, { home, waitMs: 0 }),
                { code: "shared-mutation-lock-self-contention" },
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
                { code: "shared-mutation-lock-self-contention" },
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
                    process.exitCode = error.code === "real-provider-test-lock-unavailable"
                        && error.cause?.code === "shared-mutation-lock-timeout" ? 0 : 8;
                }
            `;
            const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
            assert.equal(child.status, 0, child.stderr);
            assert.match(child.stderr, /lock could not be acquired/);
            assert.match(child.stderr, /must not overlap/);
            assert.doesNotMatch(child.stderr, /already running/);
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
