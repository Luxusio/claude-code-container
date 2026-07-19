import assert from "assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";
import { durabilityLaunchPlan, main, runDurabilityLauncher } from "./run.mjs";

test("source checkout builds before forwarding all durability arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-durability-source-"));
    try {
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "tsconfig.json"), "{}");
        const plan = durabilityLaunchPlan("real", ["--target", "android-emulator", "--cycles", "2"], {
            packageRoot: root,
            npmExecPath: "/opt/npm/bin/npm-cli.js",
            nodeExecPath: "/opt/node/bin/node",
        });
        assert.equal(plan.sourceCheckout, true);
        assert.equal(plan.build.command, "/opt/node/bin/node");
        assert.deepEqual(plan.build.args, ["/opt/npm/bin/npm-cli.js", "run", "build", "--silent"]);
        assert.deepEqual(plan.run.args.slice(-4), ["--target", "android-emulator", "--cycles", "2"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Windows source checkout invokes npm CLI through Node instead of spawning npm.cmd", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-durability-windows-source-"));
    try {
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "tsconfig.json"), "{}");
        const plan = durabilityLaunchPlan("real", ["--target", "windows-sandbox", "--cycles", "2"], {
            packageRoot: root,
            platform: "win32",
            npmExecPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
            nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
        });
        assert.equal(plan.build.command, "C:\\Program Files\\nodejs\\node.exe");
        assert.deepEqual(plan.build.args, [
            "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
            "run",
            "build",
            "--silent",
        ]);
        assert.notEqual(plan.build.command, "npm.cmd");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Windows direct invocation fails closed when npm CLI identity is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-durability-windows-no-npm-"));
    try {
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "tsconfig.json"), "{}");
        assert.throws(
            () => durabilityLaunchPlan("broker", [], { packageRoot: root, platform: "win32", npmExecPath: "" }),
            /requires npm_execpath/,
        );
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

test("real-provider launcher acquires exclusivity before build and marks the child", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-durability-exclusive-"));
    try {
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "tsconfig.json"), "{}");
        const events = [];
        const status = runDurabilityLauncher(["real", "--target", "windows-sandbox", "--cycles", "1"], {
            packageRoot: root,
            npmExecPath: "/opt/npm/bin/npm-cli.js",
            withExclusiveRealProviderRunSync: (_label, operation) => {
                events.push("lock");
                return operation();
            },
            spawnSyncImpl: () => {
                events.push(process.env.CCC_REAL_PROVIDER_RUN_LOCK_HELD === "1" ? "spawn-locked" : "spawn-unlocked");
                return { status: 0 };
            },
        });
        assert.equal(status, 0);
        assert.deepEqual(events, ["lock", "spawn-locked", "spawn-locked"]);
        assert.equal(process.env.CCC_REAL_PROVIDER_RUN_LOCK_HELD, undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
