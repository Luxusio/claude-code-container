import assert from "assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";
import { durabilityLaunchPlan, main } from "./run.mjs";

test("source checkout builds before forwarding all durability arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-durability-source-"));
    try {
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "tsconfig.json"), "{}");
        const plan = durabilityLaunchPlan("real", ["--target", "android-emulator", "--cycles", "2"], { packageRoot: root });
        assert.equal(plan.sourceCheckout, true);
        assert.deepEqual(plan.build.args, ["run", "build", "--silent"]);
        assert.deepEqual(plan.run.args.slice(-4), ["--target", "android-emulator", "--cycles", "2"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("installed package skips build only when dist CLI exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-durability-installed-"));
    try {
        mkdirSync(join(root, "dist"));
        writeFileSync(join(root, "dist", "index.js"), "");
        const plan = durabilityLaunchPlan("broker", ["--iterations", "1"], { packageRoot: root });
        assert.equal(plan.sourceCheckout, false);
        assert.equal(plan.build, null);
        assert.deepEqual(plan.run.args.slice(-2), ["--iterations", "1"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("installed package fails closed when dist CLI is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-durability-missing-dist-"));
    try {
        assert.throws(() => durabilityLaunchPlan("real", [], { packageRoot: root }), /missing the built CLI/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("launcher stops after a failed source build", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-durability-build-fail-"));
    try {
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "tsconfig.json"), "{}");
        let calls = 0;
        const status = main(["broker", "--iterations", "1"], {
            packageRoot: root,
            spawnSyncImpl: () => { calls += 1; return { status: 7 }; },
        });
        assert.equal(status, 7);
        assert.equal(calls, 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
