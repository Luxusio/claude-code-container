import assert from "assert/strict";
import test from "node:test";
import {
    identityIsAlive,
    liveOwnedProcessIdentities,
    processIdentitySnapshot,
    processIdentityKey,
    sameProcessIdentity,
    sampleOwnedProcessIdentities,
} from "./process-identity.mjs";

const identity = (pid, ppid, token) => ({ pid, ppid, token, state: "" });

test("process identity rejects PID reuse", () => {
    const original = identity(100, 1, "start-a");
    const reused = identity(100, 1, "start-b");
    assert.equal(sameProcessIdentity(original, reused), false);
    assert.equal(identityIsAlive(original, [reused]), false);
});

test("unsupported platforms fail closed instead of using coarse PID timestamps", () => {
    assert.throws(
        () => processIdentitySnapshot({ platform: "darwin" }),
        /strong process identity is unavailable on darwin/,
    );
});

test("sampling retains reparented descendants by identity and ignores reused PIDs", () => {
    const root = identity(100, 1, "root-a");
    const child = identity(101, 100, "child-a");
    const registry = new Map();
    sampleOwnedProcessIdentities(root, registry, [root, child]);
    assert.deepEqual([...registry.keys()].sort(), [processIdentityKey(root), processIdentityKey(child)].sort());

    const reparented = identity(101, 1, "child-a");
    const reusedRoot = identity(100, 1, "root-b");
    assert.deepEqual(liveOwnedProcessIdentities(registry, [reusedRoot, reparented]), [child]);
    assert.throws(
        () => sampleOwnedProcessIdentities(root, registry, [reusedRoot, reparented]),
        /refusing uncertain ownership/,
    );
});
