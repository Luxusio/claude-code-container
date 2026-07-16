import assert from "assert/strict";
import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";
import {
    inspectTestOwnedResidue,
    listAndroidAvdNames,
    main,
    parseRealProviderCycleArgs,
    realProviderCycleCommand,
    runCycle,
    terminateTimedOutProcessTree,
    verifySuccessfulProcessTree,
} from "./real-provider-cycles.mjs";

function successfulCycle(overrides = {}) {
    return {
        code: 0,
        signal: null,
        timedOut: false,
        output: "",
        processTree: { ok: true, errors: [], survivors: [] },
        ...overrides,
    };
}

test("parses a bounded real-provider cycle plan", () => {
    assert.deepEqual(parseRealProviderCycleArgs([
        "--target", "android-emulator", "--cycles", "3", "--timeout", "15m", "--dry-run",
    ]), {
        target: "android-emulator",
        cycles: 3,
        timeoutMs: 900_000,
        dryRun: true,
        help: false,
    });
    assert.throws(() => parseRealProviderCycleArgs(["--target", "unknown"]), /must be one of/);
    assert.throws(() => parseRealProviderCycleArgs(["--target", "android-device", "--cycles", "0"]), /1 to 100/);
});

test("maps targets to the exact existing real-test modules", () => {
    assert.match(realProviderCycleCommand("android-emulator").args.at(-1), /level2-android-emulator-e2e\.mjs$/);
    assert.match(realProviderCycleCommand("android-device").args.at(-1), /level2-android-device-e2e\.mjs$/);
    assert.match(realProviderCycleCommand("windows-sandbox").args.at(-1), /level2-windows-sandbox\.mjs$/);
    for (const target of ["android-emulator", "android-device", "windows-sandbox"]) {
        assert.equal(existsSync(realProviderCycleCommand(target).args.at(-1)), true, `${target} module must exist`);
    }
    for (const unsafeTarget of ["ios-simulator", "ios-device", "macos-vm"]) {
        assert.throws(() => realProviderCycleCommand(unsafeTarget), /unknown target/);
    }
});

test("parses the Android SDK AVD inventory and fails closed on command errors", () => {
    assert.deepEqual(listAndroidAvdNames({
        avdmanager: "avdmanager",
        spawnSyncImpl: () => ({ status: 0, stdout: "Pixel_1\r\nPixel_2\r\n", stderr: "" }),
    }), ["Pixel_1", "Pixel_2"]);
    assert.throws(() => listAndroidAvdNames({
        avdmanager: "avdmanager",
        spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "broken SDK" }),
    }), /Android AVD inventory failed: broken SDK/);
});

test("detects a test-created AVD that is absent from CCC state", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-avd-"));
    try {
        const residue = inspectTestOwnedResidue("android-emulator", {
            home,
            owner: "0123456789abcdef",
            listAndroidAvds: () => [
                "ccc-0123456789abcdef-real-android-e2e-123",
                "ccc-0123456789abcdef-user-avd",
                "ccc-fedcba9876543210-real-android-e2e-123",
            ],
        });
        assert.deepEqual(residue, ["sdk-avd:ccc-0123456789abcdef-real-android-e2e-123"]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("detects only current-owner test-prefixed state and leases", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-self-"));
    const owner = "0123456789abcdef";
    try {
        const backendRoot = join(home, ".ccc", "devices", "owners", owner, "android-device");
        const leaseRoot = join(home, ".ccc", "devices", "physical-leases", "android-device", "locks");
        mkdirSync(join(backendRoot, "android-device-real-e2e-1"), { recursive: true });
        mkdirSync(leaseRoot, { recursive: true });
        writeFileSync(join(backendRoot, "devices.json"), JSON.stringify({ devices: [
            { id: "android-device-real-e2e-1" },
            { id: "user-phone" },
        ] }));
        writeFileSync(join(leaseRoot, "test.json"), JSON.stringify({ ownerId: owner, deviceId: "android-device-real-e2e-1" }));
        writeFileSync(join(leaseRoot, "foreign.json"), JSON.stringify({ ownerId: "fedcba9876543210", deviceId: "android-device-real-e2e-2" }));
        writeFileSync(join(home, ".ccc", "devices", "physical-leases", "android-device.json"), JSON.stringify({ leases: [
            { ownerId: owner, deviceId: "android-device-real-e2e-1" },
            { ownerId: owner, deviceId: "user-phone" },
        ] }));
        const residue = inspectTestOwnedResidue("android-device", { home, owner });
        assert.equal(residue.length, 4);
        assert.ok(residue.every((item) => !item.includes("user-phone") && !item.includes("foreign.json")));
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("fails closed on malformed residue metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-malformed-"));
    const owner = "0123456789abcdef";
    try {
        const backendRoot = join(home, ".ccc", "devices", "owners", owner, "android");
        mkdirSync(backendRoot, { recursive: true });
        writeFileSync(join(backendRoot, "devices.json"), "{not-json");
        assert.throws(
            () => inspectTestOwnedResidue("android-emulator", { home, owner }),
            /device state metadata malformed/,
        );
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("fails closed on unreadable residue metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-unreadable-"));
    const owner = "0123456789abcdef";
    try {
        const aggregatePath = join(home, ".ccc", "devices", "physical-leases", "android-device.json");
        mkdirSync(aggregatePath, { recursive: true });
        assert.throws(
            () => inspectTestOwnedResidue("android-device", { home, owner }),
            /physical lease aggregate metadata unreadable/,
        );
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("timeout cleanup reports command errors and identity-verified survivors", async () => {
    const root = { pid: 321, ppid: 1, token: "windows:start-a", state: "" };
    const registry = new Map([[`${root.pid}:${root.token}`, root]]);
    const result = await terminateTimedOutProcessTree({}, root, registry, {
        platform: "win32",
        snapshot: () => [root],
        spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "access denied" }),
        verificationTimeoutMs: 0,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.survivors, [root]);
    assert.match(result.errors.join(" "), /taskkill failed.*access denied/);
    assert.match(result.errors.join(" "), /survivors: 321@windows:start-a/);
});

test("timeout failure includes cleanup errors", async () => {
    await assert.rejects(
        main(["--target", "android-emulator", "--cycles", "1"], {
            inspectTestOwnedResidue: () => [],
            snapshotTestTempArtifacts: () => new Set(),
            runCycle: async () => ({
                code: null,
                signal: "timeout",
                timedOut: true,
                output: "",
                cleanup: { ok: false, errors: ["survivors: 55@linux:100"], survivors: [{ pid: 55, token: "linux:100" }] },
            }),
        }),
        /cleanup failed \(survivors: 55@linux:100\)/,
    );
});

test("successful-cycle verification retains a sampled descendant after reparenting", async () => {
    const root = { pid: 100, ppid: 1, token: "linux:root", state: "S" };
    const child = { pid: 101, ppid: 100, token: "linux:child", state: "S" };
    const reparented = { ...child, ppid: 1 };
    const registry = new Map([[`${root.pid}:${root.token}`, root]]);
    const snapshots = [
        [root, child],
        [reparented],
        [reparented],
        [reparented],
    ];
    const result = await verifySuccessfulProcessTree(root, registry, {
        snapshot: () => snapshots.shift() || [reparented],
        sleep: async () => {},
        boundarySamples: 3,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.survivors, [child]);
    assert.match(result.errors.join(" "), /survivors: 101@linux:child/);
});

test("successful cycle fails on identity-verified descendant survivors without signaling them", async () => {
    const survivor = { pid: 202, ppid: 1, token: "linux:survivor", state: "S" };
    await assert.rejects(
        main(["--target", "android-emulator", "--cycles", "1"], {
            inspectTestOwnedResidue: () => [],
            snapshotTestTempArtifacts: () => new Set(),
            runCycle: async () => successfulCycle({
                processTree: {
                    ok: false,
                    errors: ["survivors: 202@linux:survivor"],
                    survivors: [survivor],
                },
            }),
        }),
        /process-tree cleanup\/verification failed: survivors: 202@linux:survivor/,
    );
});

test("successful cycle fails closed when process-tree verification is missing", async () => {
    await assert.rejects(
        main(["--target", "android-device", "--cycles", "1"], {
            inspectTestOwnedResidue: () => [],
            snapshotTestTempArtifacts: () => new Set(),
            runCycle: async () => ({ code: 0, signal: null, timedOut: false, output: "" }),
        }),
        /cycle process-tree verification result missing/,
    );
});

test("dry-run performs no provider execution", async () => {
    let invoked = false;
    const code = await main(["--target", "windows-sandbox", "--cycles", "2", "--dry-run"], {
        runCycle: async () => { invoked = true; return successfulCycle(); },
        runningWindowsSandboxSessions: () => { invoked = true; return []; },
    });
    assert.equal(code, 0);
    assert.equal(invoked, false);
});

test("Windows target refuses an existing Sandbox before provider execution", async () => {
    let invoked = false;
    await assert.rejects(
        main(["--target", "windows-sandbox", "--cycles", "1"], {
            runCycle: async () => { invoked = true; return successfulCycle(); },
            runningWindowsSandboxSessions: () => [1234],
        }),
        /refusing cycle 1\/1 while a Windows Sandbox session is active/,
    );
    assert.equal(invoked, false);
});

test("fails closed on test-owned state before cycle one", async () => {
    let invoked = false;
    await assert.rejects(
        main(["--target", "android-emulator", "--cycles", "1"], {
            inspectTestOwnedResidue: () => ["device-state:android-real-e2e-stale"],
            snapshotTestTempArtifacts: () => new Set(),
            runCycle: async () => { invoked = true; return successfulCycle(); },
        }),
        /test-owned residue before cycle 1: device-state:android-real-e2e-stale/,
    );
    assert.equal(invoked, false);
});

test("fails closed on test-owned temporary artifacts before cycle one", async () => {
    let invoked = false;
    await assert.rejects(
        main(["--target", "android-device", "--cycles", "1"], {
            inspectTestOwnedResidue: () => [],
            snapshotTestTempArtifacts: () => new Set(["stale/android-device-e2e-artifact"]),
            runCycle: async () => { invoked = true; return successfulCycle(); },
        }),
        /test-owned residue before cycle 1: temp-artifact:stale\/android-device-e2e-artifact/,
    );
    assert.equal(invoked, false);
});

test("Windows target detects a Sandbox process after a successful cycle", async () => {
    let processInspections = 0;
    let cycleRuns = 0;
    await assert.rejects(
        main(["--target", "windows-sandbox", "--cycles", "1"], {
            inspectTestOwnedResidue: () => [],
            snapshotTestTempArtifacts: () => new Set(),
            runningWindowsSandboxSessions: () => (++processInspections === 1 ? [] : [5678]),
            runCycle: async () => {
                cycleRuns += 1;
                return successfulCycle();
            },
        }),
        /Windows Sandbox session remained or appeared \(PIDs: 5678\)/,
    );
    assert.equal(cycleRuns, 1);
    assert.equal(processInspections, 2);
});

test("failed cycle still reports process cleanup errors and post-failure residue", async () => {
    let inspections = 0;
    await assert.rejects(
        main(["--target", "android-device", "--cycles", "1"], {
            inspectTestOwnedResidue: () => (++inspections === 1 ? [] : ["physical-lease:stale.json"]),
            snapshotTestTempArtifacts: () => new Set(),
            runCycle: async () => ({
                code: 1,
                signal: null,
                timedOut: false,
                output: "provider failed",
                processTree: {
                    ok: false,
                    errors: ["survivors: 303@linux:child"],
                    survivors: [{ pid: 303, token: "linux:child" }],
                },
            }),
        }),
        (error) => {
            assert.match(error.message, /failed with exit 1.*provider failed/s);
            assert.match(error.message, /process-tree cleanup\/verification failed: survivors: 303@linux:child/);
            assert.match(error.message, /leaked test-owned resources: physical-lease:stale\.json/);
            return true;
        },
    );
    assert.equal(inspections, 2);
});

test("failed cycle performs post-failure residue inspection even when runner throws", async () => {
    let inspections = 0;
    await assert.rejects(
        main(["--target", "android-device", "--cycles", "1"], {
            inspectTestOwnedResidue: () => (++inspections === 1 ? [] : ["device-state:ios-real-e2e-leak"]),
            snapshotTestTempArtifacts: () => new Set(),
            runCycle: async () => { throw new Error("spawn failed"); },
        }),
        /cycle runner threw: spawn failed.*leaked test-owned resources: device-state:ios-real-e2e-leak/,
    );
    assert.equal(inspections, 2);
});

test("unsupported process identity fails before a provider cycle is spawned", async () => {
    let spawned = false;
    await assert.rejects(
        runCycle("android-emulator", 1000, () => { spawned = true; }, {
            processIdentitySnapshot: () => { throw new Error("strong process identity unavailable"); },
        }),
        /strong process identity unavailable/,
    );
    assert.equal(spawned, false);
});

test("nonzero cycle exit cleans and verifies a tracked descendant process tree", {
    skip: !["linux", "win32"].includes(process.platform),
}, async () => {
    const fixture = [
        "const { spawn } = require('child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
        "console.log(`descendant=${child.pid}`);",
        "setTimeout(() => process.exit(7), 200);",
    ].join("\n");
    const result = await runCycle("android-emulator", 5000, (_command, _args, options) => spawn(
        process.execPath,
        ["-e", fixture],
        options,
    ));
    assert.equal(result.code, 7);
    assert.equal(result.timedOut, false);
    assert.equal(result.processTree.ok, true, result.processTree.errors.join("; "));
    assert.deepEqual(result.processTree.survivors, []);
    assert.match(result.output, /descendant=\d+/);
});
