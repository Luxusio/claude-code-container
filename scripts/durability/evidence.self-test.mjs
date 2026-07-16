import assert from "assert/strict";
import test from "node:test";
import { finalizeDurabilityEvidence } from "./evidence.mjs";

test("preserves the isolated durability HOME after a test failure", () => {
    let removed = false;
    const result = finalizeDurabilityEvidence("/tmp/ccc-failed", new Error("request failed"), {
        rmSyncImpl: () => { removed = true; },
    });
    assert.equal(removed, false);
    assert.equal(result.preserved, true);
    assert.match(result.failure.message, /request failed.*artifacts preserved at \/tmp\/ccc-failed/);
});

test("deletes the isolated durability HOME only after success", () => {
    let removed = null;
    const result = finalizeDurabilityEvidence("/tmp/ccc-passed", null, {
        rmSyncImpl: (path) => { removed = path; },
    });
    assert.equal(removed, "/tmp/ccc-passed");
    assert.equal(result.failure, null);
    assert.equal(result.preserved, false);
});

test("preserves evidence and reports a successful-run cleanup failure", () => {
    const result = finalizeDurabilityEvidence("/tmp/ccc-cleanup-failed", null, {
        rmSyncImpl: () => { throw new Error("busy"); },
    });
    assert.equal(result.preserved, true);
    assert.match(result.failure.message, /cleanup failed: busy.*artifacts preserved/);
});
