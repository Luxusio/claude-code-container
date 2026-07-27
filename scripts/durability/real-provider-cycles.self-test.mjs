import assert from "assert/strict";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";
import {
    androidAvdHome,
    listOwnedAndroidAvdArtifacts,
    removeOwnedAndroidAvdArtifacts,
} from "../../device-lab-mcp/src/state/android-avd-storage.mjs";
import {
    androidAvdManagerInventoryInvocation,
    cleanupTestTempArtifacts,
    configureAndroidPhysicalDevice,
    deleteAndroidAvdName,
    formatResidueSummary,
    inspectTestOwnedResidue,
    recoverHyperVPrivateResidue,
    assertHyperVHostIdentityUnchanged,
    listAndroidAvdNames,
    listAndroidE2EAvdArtifactNames,
    listHyperVNetworkInventory,
    listHyperVVmInventory,
    parseHyperVNetworkInventory,
    parseHyperVVmInventory,
    listRunningAndroidAvdNames,
    main,
    parseRealProviderCycleArgs,
    parseAndroidPhysicalDeviceInventory,
    realProviderCycleCommand,
    recoverAndroidEmulatorResidue,
    recoverAndroidPhysicalDeviceResidue,
    selectAndroidPhysicalDevice,
    snapshotHyperVHostIdentity,
    runCycle,
    terminateTimedOutProcessTree,
    usage,
    verifySuccessfulProcessTree,
    writeResidueDiagnostic,
} from "./real-provider-cycles.mjs";

test("resolves Android AVD storage using Android SDK environment precedence", () => {
    assert.equal(androidAvdHome({ home: "/home/test", env: { ANDROID_AVD_HOME: "/avds", ANDROID_USER_HOME: "/android-user" } }), "/avds");
    assert.equal(androidAvdHome({ home: "/home/test", env: { ANDROID_USER_HOME: "/android-user" } }), "/android-user/avd");
    assert.equal(androidAvdHome({ home: "/home/test", env: { ANDROID_EMULATOR_HOME: "/emulator" } }), "/emulator/avd");
    assert.equal(androidAvdHome({ home: "/home/test", env: { ANDROID_SDK_HOME: "/legacy" } }), "/legacy/.android/avd");
    assert.equal(androidAvdHome({ home: "/home/test", env: {} }), "/home/test/.android/avd");
});

test("removes only exact owner-scoped Android AVD artifacts", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-avd-storage-"));
    const avdRoot = join(home, ".android", "avd");
    const owner = "0123456789abcdef";
    const owned = `ccc-${owner}-real-android-e2e-stale`;
    const foreign = "ccc-fedcba9876543210-real-android-e2e-stale";
    try {
        mkdirSync(join(avdRoot, `${owned}.avd`), { recursive: true });
        writeFileSync(join(avdRoot, `${owned}.avd`, "userdata-qemu.img"), "owned");
        writeFileSync(join(avdRoot, `${owned}.ini`), "path=owned");
        mkdirSync(join(avdRoot, `${foreign}.avd`));
        writeFileSync(join(avdRoot, `${foreign}.ini`), "path=foreign");
        mkdirSync(join(avdRoot, "Pixel_User.avd"));
        writeFileSync(join(avdRoot, "Pixel_User.ini"), "path=user");

        assert.deepEqual(
            listOwnedAndroidAvdArtifacts(owner, { home }).map((artifact) => artifact.name),
            [owned],
        );
        assert.deepEqual(removeOwnedAndroidAvdArtifacts(owned, owner, { home }), {
            name: owned,
            root: avdRoot,
            removed: 2,
        });
        assert.equal(existsSync(join(avdRoot, `${owned}.avd`)), false);
        assert.equal(existsSync(join(avdRoot, `${owned}.ini`)), false);
        assert.equal(existsSync(join(avdRoot, `${foreign}.avd`)), true);
        assert.equal(existsSync(join(avdRoot, "Pixel_User.avd")), true);
        assert.throws(
            () => removeOwnedAndroidAvdArtifacts("../../Pixel_User", owner, { home }),
            /refusing non-owned/,
        );
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("fails closed on symbolic Android AVD artifacts", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-avd-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "ccc-avd-outside-"));
    const avdRoot = join(home, ".android", "avd");
    const owner = "0123456789abcdef";
    const owned = `ccc-${owner}-real-android-e2e-link`;
    try {
        mkdirSync(avdRoot, { recursive: true });
        symlinkSync(outside, join(avdRoot, `${owned}.avd`), "dir");
        assert.throws(() => listOwnedAndroidAvdArtifacts(owner, { home }), /refusing symbolic/);
        assert.equal(existsSync(outside), true);
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    }
});

test("fails closed when the Android AVD storage root traverses a symbolic path", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-avd-root-link-"));
    const outside = mkdtempSync(join(tmpdir(), "ccc-avd-root-outside-"));
    const owner = "0123456789abcdef";
    const owned = `ccc-${owner}-real-android-e2e-root-link`;
    try {
        mkdirSync(join(home, ".android"), { recursive: true });
        mkdirSync(join(outside, `${owned}.avd`));
        writeFileSync(join(outside, `${owned}.avd`, "userdata-qemu.img"), "outside");
        symlinkSync(outside, join(home, ".android", "avd"), "dir");

        assert.throws(
            () => listOwnedAndroidAvdArtifacts(owner, { home }),
            /stable directory|symbolic or reparse path/,
        );
        assert.equal(existsSync(join(outside, `${owned}.avd`, "userdata-qemu.img")), true);
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    }
});

test("preserves a same-name Android AVD generation recreated during cleanup", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-avd-recreated-"));
    const avdRoot = join(home, ".android", "avd");
    const owner = "0123456789abcdef";
    const owned = `ccc-${owner}-real-android-e2e-recreated`;
    const dataPath = join(avdRoot, `${owned}.avd`);
    try {
        mkdirSync(dataPath, { recursive: true });
        writeFileSync(join(dataPath, "userdata-qemu.img"), "old-generation");
        let recreated = false;
        assert.throws(() => removeOwnedAndroidAvdArtifacts(owned, owner, {
            home,
            onArtifactQuarantined: ({ originalPath }) => {
                if (recreated || originalPath !== dataPath) return;
                recreated = true;
                mkdirSync(dataPath);
                writeFileSync(join(dataPath, "userdata-qemu.img"), "new-generation");
            },
        }), /reappeared after cleanup/);
        assert.equal(readFileSync(join(dataPath, "userdata-qemu.img"), "utf8"), "new-generation");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("recovers owner-scoped Android AVD quarantine left by an interrupted cleanup", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-avd-quarantine-"));
    const avdRoot = join(home, ".android", "avd");
    const owner = "0123456789abcdef";
    const owned = `ccc-${owner}-real-android-e2e-interrupted`;
    const quarantine = join(avdRoot, `.ccc-avd-delete-${owned}-${"a".repeat(32)}`);
    try {
        mkdirSync(quarantine, { recursive: true });
        writeFileSync(join(quarantine, "userdata-qemu.img"), "stale");

        assert.deepEqual(
            listOwnedAndroidAvdArtifacts(owner, {
                home,
                suffixPattern: "real-android-e2e-[A-Za-z0-9._-]+",
            }).map((artifact) => artifact.name),
            [owned],
        );
        assert.equal(removeOwnedAndroidAvdArtifacts(owned, owner, {
            home,
            suffixPattern: "real-android-e2e-[A-Za-z0-9._-]+",
        }).removed, 1);
        assert.equal(existsSync(quarantine), false);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("restores a quarantined Android AVD when final liveness verification fails", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-avd-final-liveness-"));
    const avdRoot = join(home, ".android", "avd");
    const owner = "0123456789abcdef";
    const owned = `ccc-${owner}-real-android-e2e-became-active`;
    const dataPath = join(avdRoot, `${owned}.avd`);
    try {
        mkdirSync(dataPath, { recursive: true });
        writeFileSync(join(dataPath, "userdata-qemu.img"), "preserved");
        assert.throws(() => removeOwnedAndroidAvdArtifacts(owned, owner, {
            home,
            verifyInactive: () => false,
        }), /became active/);
        assert.equal(readFileSync(join(dataPath, "userdata-qemu.img"), "utf8"), "preserved");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

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
    assert.equal(parseRealProviderCycleArgs(["--target", "windows-vm"]).timeoutMs, 7 * 60 * 60_000);
    assert.equal(parseRealProviderCycleArgs(["--target", "linux-vm"]).timeoutMs, 7 * 60 * 60_000);
    assert.equal(parseRealProviderCycleArgs(["--target", "windows-vm", "--timeout", "30m"]).timeoutMs, 30 * 60_000);
    assert.match(usage(), /Hyper-V VM targets: 7h/);
    assert.doesNotMatch(usage(), /Hyper-V VM targets: 4h/);
});

test("maps targets to the exact existing real-test modules", () => {
    assert.match(realProviderCycleCommand("android-emulator").args.at(-1), /level2-android-emulator-e2e\.ts$/);
    assert.match(realProviderCycleCommand("android-device").args.at(-1), /level2-android-device-e2e\.ts$/);
    assert.match(realProviderCycleCommand("windows-sandbox").args.at(-1), /level2-windows-sandbox\.ts$/);
    assert.match(realProviderCycleCommand("windows-vm").args.at(-1), /level2-hyper-v-windows-vm\.ts$/);
    assert.match(realProviderCycleCommand("linux-vm").args.at(-1), /level2-hyper-v-linux-vm\.ts$/);
    for (const target of ["android-emulator", "android-device", "windows-sandbox", "windows-vm", "linux-vm"]) {
        assert.equal(existsSync(realProviderCycleCommand(target).args.at(-1)), true, `${target} module must exist`);
    }
    for (const unsafeTarget of ["ios-simulator", "ios-device", "macos-vm"]) {
        assert.throws(() => realProviderCycleCommand(unsafeTarget), /unknown target/);
    }
});

test("Hyper-V Linux target lets the provider test recover prior owner-scoped residue", async () => {
    let cycleRuns = 0;
    let residueInspections = 0;
    const code = await main(["--target", "linux-vm", "--cycles", "1"], {
        inspectTestOwnedResidue: () => (++residueInspections === 1 ? ["device-state:linux-hyper-v-real-e2e-stale"] : []),
        snapshotTestTempArtifacts: () => new Set(),
        snapshotHyperVHostIdentity: () => ({ vms: [], switches: [], nats: [], addresses: [] }),
        runCycle: async () => {
            cycleRuns += 1;
            return successfulCycle();
        },
    });
    assert.equal(code, 0);
    assert.equal(cycleRuns, 1);
    assert.equal(residueInspections, 2);
});

test("Hyper-V Windows target lets the provider test recover prior owner-scoped residue", async () => {
    let cycleRuns = 0;
    let residueInspections = 0;
    const code = await main(["--target", "windows-vm", "--cycles", "1"], {
        inspectTestOwnedResidue: () => (++residueInspections === 1 ? ["device-state:windows-vm-real-e2e-stale"] : []),
        snapshotTestTempArtifacts: () => new Set(),
        snapshotHyperVHostIdentity: () => ({ vms: [], switches: [], nats: [], addresses: [] }),
        runCycle: async () => {
            cycleRuns += 1;
            return successfulCycle();
        },
    });
    assert.equal(code, 0);
    assert.equal(cycleRuns, 1);
    assert.equal(residueInspections, 2);
});

test("Hyper-V durability fails when non-test host identities change during a clean cycle", async () => {
    let snapshots = 0;
    await assert.rejects(main(["--target", "windows-vm", "--cycles", "1"], {
        inspectTestOwnedResidue: () => [],
        snapshotTestTempArtifacts: () => new Set(),
        snapshotHyperVHostIdentity: () => ({
            vms: [{ vmId: snapshots++ === 0 ? "foreign-before" : "foreign-after" }],
            switches: [],
            nats: [],
            addresses: [],
        }),
        runCycle: async () => successfulCycle(),
    }), /Hyper-V host identity changed during cycle/);
    assert.equal(snapshots, 2);
});

test("Hyper-V durability refuses state-less host VM residue", async () => {
    let cycleRuns = 0;
    await assert.rejects(
        main(["--target", "windows-vm", "--cycles", "1"], {
            inspectTestOwnedResidue: () => ["host-vm:ccc-owner-windows-vm-real-e2e-stale"],
            snapshotTestTempArtifacts: () => new Set(),
            writeResidueDiagnostic: () => "residue.json",
            runCycle: async () => {
                cycleRuns += 1;
                return successfulCycle();
            },
        }),
        /test-owned residue before cycle 1: host-vm:/,
    );
    assert.equal(cycleRuns, 0);
});

test("Hyper-V durability refuses recovery while a mutation or operation lock is present", async () => {
    let cycleRuns = 0;
    await assert.rejects(
        main(["--target", "windows-vm", "--cycles", "1"], {
            inspectTestOwnedResidue: () => [
                "device-state:windows-vm-real-e2e-stale",
                "operation-lock:C:\\state\\operations\\test.lock:windows-vm-real-e2e-stale",
            ],
            snapshotTestTempArtifacts: () => new Set(),
            writeResidueDiagnostic: () => "residue.json",
            runCycle: async () => {
                cycleRuns += 1;
                return successfulCycle();
            },
        }),
        /test-owned residue before cycle 1: device-state:windows-vm-real-e2e-stale, operation-lock:test\.lock:windows-vm-real-e2e-stale/,
    );
    assert.equal(cycleRuns, 0);
});

test("Hyper-V target clears private-only residue before running a cycle", async () => {
    let cycleRuns = 0;
    let residueInspections = 0;
    let recoveryRuns = 0;
    const code = await main(["--target", "linux-vm", "--cycles", "1"], {
        inspectTestOwnedResidue: () => (++residueInspections === 1 ? ["private-artifact:/private/linux-hyper-v-real-e2e-stale"] : []),
        snapshotTestTempArtifacts: () => new Set(),
        snapshotHyperVHostIdentity: () => ({ vms: [], switches: [], nats: [], addresses: [] }),
        recoverHyperVPrivateResidue: async (target) => {
            recoveryRuns += 1;
            assert.equal(target, "linux-vm");
            return { privateArtifacts: 1 };
        },
        runCycle: async () => {
            cycleRuns += 1;
            return successfulCycle();
        },
    });
    assert.equal(code, 0);
    assert.equal(recoveryRuns, 1);
    assert.equal(cycleRuns, 1);
    assert.equal(residueInspections, 3);
});

test("auto-selects a deterministic authorized physical Android device", () => {
    const devices = parseAndroidPhysicalDeviceInventory([
        "List of devices attached",
        "Z-SERIAL device usb:1-1",
        "A-SERIAL device usb:1-2",
        "emulator-5554 device product:sdk",
        "OFFLINE offline usb:1-3",
        "UNAUTHORIZED unauthorized usb:1-4",
    ].join("\n"));
    assert.deepEqual(devices.map((device) => device.serial), ["Z-SERIAL", "A-SERIAL"]);
    assert.equal(selectAndroidPhysicalDevice(devices, [], "owner").serial, "A-SERIAL");
    assert.equal(selectAndroidPhysicalDevice(devices, [
        { hardwareId: "Z-SERIAL", ownerId: "owner" },
        { hardwareId: "A-SERIAL", ownerId: "foreign" },
    ], "owner").serial, "Z-SERIAL");
    assert.equal(selectAndroidPhysicalDevice(devices, [
        { hardwareId: "Z-SERIAL", ownerId: "foreign" },
        { hardwareId: "A-SERIAL", ownerId: "foreign" },
    ], "owner"), null);
});

test("configures the selected physical Android serial without overriding explicit configuration", () => {
    const explicitEnv = { CCC_REAL_ANDROID_DEVICE_SERIAL: "EXPLICIT" };
    assert.deepEqual(configureAndroidPhysicalDevice(explicitEnv, {
        spawnSyncImpl: () => { throw new Error("ADB must not run"); },
    }), { serial: "EXPLICIT", source: "configured", candidates: 1 });

    const env = {};
    assert.deepEqual(configureAndroidPhysicalDevice(env, {
        discovery: { adb: "adb" },
        owner: "owner",
        readLeases: () => [],
        spawnSyncImpl: () => ({ status: 0, stdout: "B device\nA device\n", stderr: "" }),
    }), { serial: "A", source: "auto", candidates: 2 });
    assert.equal(env.CCC_REAL_ANDROID_DEVICE_SERIAL, "A");
    assert.throws(() => configureAndroidPhysicalDevice({}, {
        discovery: { adb: "adb" },
        readLeases: () => [],
        spawnSyncImpl: () => ({ status: 0, stdout: "emulator-5554 device\nPHONE unauthorized\n", stderr: "" }),
    }), /no authorized physical Android device/);
    assert.throws(() => configureAndroidPhysicalDevice({}, {
        discovery: { adb: "adb" },
        owner: "owner",
        readLeases: () => [{ hardwareId: "PHONE", ownerId: "foreign" }],
        spawnSyncImpl: () => ({ status: 0, stdout: "PHONE device\n", stderr: "" }),
    }), /leased by other owners/);
});

test("removes only immediate test-prefixed temporary artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-real-cycle-temp-"));
    const artifact = join(root, "ccc-windows-sandbox-e2e-stale");
    const unrelated = join(root, "unrelated");
    try {
        mkdirSync(artifact);
        mkdirSync(unrelated);
        cleanupTestTempArtifacts("windows-sandbox", [artifact], { tempRoot: root });
        assert.equal(existsSync(artifact), false);
        assert.equal(existsSync(unrelated), true);
        assert.throws(
            () => cleanupTestTempArtifacts("windows-sandbox", [unrelated], { tempRoot: root }),
            /refusing to remove unverified test artifact/,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
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

test("Windows Android AVD inventory invokes avdmanager batch files through cmd.exe", () => {
    const avdmanager = "C:\\Users\\Test User\\Android\\Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat";
    assert.deepEqual(androidAvdManagerInventoryInvocation(avdmanager, "win32"), {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", `"${avdmanager}" list avd -c`],
    });
    let invocation;
    assert.deepEqual(listAndroidAvdNames({
        avdmanager,
        platform: "win32",
        spawnSyncImpl: (command, args) => {
            invocation = { command, args };
            return { status: 0, stdout: "Pixel_Windows\r\n", stderr: "" };
        },
    }), ["Pixel_Windows"]);
    assert.equal(invocation.command, "cmd.exe");
    assert.notEqual(invocation.command, avdmanager);
});

test("Android E2E AVD deletion uses identity-fenced artifacts without invoking avdmanager", () => {
    const owner = "0123456789abcdef";
    const avdName = `ccc-${owner}-real-android-e2e-stale`;
    let invoked = false;
    const result = deleteAndroidAvdName(avdName, {
        owner,
        platform: "win32",
        removeAndroidAvdArtifacts: () => ({ removed: 2 }),
        spawnSyncImpl: () => {
            invoked = true;
            return { status: 0, stdout: "", stderr: "" };
        },
    });
    assert.deepEqual(result, { artifactsRemoved: 2 });
    assert.equal(invoked, false);
});

test("rejects non-E2E Android AVD names before invoking avdmanager", () => {
    const owner = "0123456789abcdef";
    let invoked = false;
    assert.throws(() => deleteAndroidAvdName(`ccc-${owner}-%PATH%`, {
        owner,
        avdmanager: "avdmanager",
        spawnSyncImpl: () => {
            invoked = true;
            return { status: 0, stdout: "", stderr: "" };
        },
    }), /refusing non-owned Android E2E AVD deletion/);
    assert.equal(invoked, false);
});

test("lists live Android emulator AVD identities and fails closed on identity errors", () => {
    const calls = [];
    assert.deepEqual(listRunningAndroidAvdNames({
        adb: "adb",
        spawnSyncImpl: (_command, args) => {
            calls.push(args);
            if (args[0] === "devices") return { status: 0, stdout: "List of devices attached\nemulator-5554\tdevice\nphone\tdevice\n", stderr: "" };
            return { status: 0, stdout: "Test_AVD\nOK\n", stderr: "" };
        },
    }), ["Test_AVD"]);
    assert.deepEqual(calls, [["devices"], ["-s", "emulator-5554", "emu", "avd", "name"]]);
    assert.throws(() => listRunningAndroidAvdNames({
        adb: "adb",
        spawnSyncImpl: (_command, args) => args[0] === "devices"
            ? { status: 0, stdout: "emulator-5554\tdevice\n", stderr: "" }
            : { status: 1, stdout: "", stderr: "offline" },
    }), /identity inspection failed: offline/);
});

test("recovers only verified current-owner Android emulator E2E residue", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-android-recovery-home-"));
    const tempRoot = mkdtempSync(join(tmpdir(), "ccc-android-recovery-temp-"));
    const owner = "0123456789abcdef";
    const deviceId = "android-real-e2e-stale";
    const stateAvd = `ccc-${owner}-real-android-e2e-stale`;
    const orphanAvd = `ccc-${owner}-real-android-e2e-orphan`;
    const backendRoot = join(home, ".ccc", "devices", "owners", owner, "android");
    const statePath = join(backendRoot, "devices.json");
    const artifact = join(backendRoot, deviceId);
    const tempArtifact = join(tempRoot, "ccc-android-emulator-e2e-stale");
    let avds = [stateAvd, orphanAvd, "user-avd"];
    try {
        mkdirSync(artifact, { recursive: true });
        mkdirSync(tempArtifact);
        writeFileSync(statePath, JSON.stringify({ devices: [{ id: deviceId, ownerId: owner, backend: "android-emulator", avdName: stateAvd, status: "stopped" }] }));
        const deletedDevices = [];
        const deletedAvds = [];
        const result = await recoverAndroidEmulatorResidue({
            home,
            owner,
            tempRoot,
            listAndroidAvds: () => [...avds],
            listRunningAndroidAvds: () => [],
            deleteStateDevice: async (device) => {
                deletedDevices.push(device.id);
                avds = avds.filter((name) => name !== device.avdName);
                writeFileSync(statePath, JSON.stringify({ devices: [] }));
            },
            deleteAndroidAvd: (name) => {
                deletedAvds.push(name);
                avds = avds.filter((candidate) => candidate !== name);
            },
        });
        assert.deepEqual(deletedDevices, [deviceId]);
        assert.deepEqual(deletedAvds, [orphanAvd]);
        assert.deepEqual(avds, ["user-avd"]);
        assert.deepEqual(result, { devices: 1, avds: 1, ownerArtifacts: 1, tempArtifacts: 1 });
        assert.equal(existsSync(artifact), false);
        assert.equal(existsSync(tempArtifact), false);
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(tempRoot, { recursive: true, force: true });
    }
});

test("Android residue recovery rejects foreign state ownership and active orphan AVDs", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-android-recovery-guard-"));
    const owner = "0123456789abcdef";
    const backendRoot = join(home, ".ccc", "devices", "owners", owner, "android");
    const statePath = join(backendRoot, "devices.json");
    const avd = `ccc-${owner}-real-android-e2e-active`;
    try {
        mkdirSync(backendRoot, { recursive: true });
        writeFileSync(statePath, JSON.stringify({ devices: [{ id: "android-real-e2e-foreign", ownerId: "fedcba9876543210", avdName: avd }] }));
        await assert.rejects(recoverAndroidEmulatorResidue({ home, owner, listAndroidAvds: () => [] }), /foreign owner/);
        writeFileSync(statePath, JSON.stringify({ devices: [] }));
        await assert.rejects(recoverAndroidEmulatorResidue({
            home,
            owner,
            listAndroidAvds: () => [avd],
            listRunningAndroidAvds: () => [avd],
        }), /refusing to delete active orphan/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("recovers verified current-owner Android physical E2E residue", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-android-device-recovery-home-"));
    const tempRoot = mkdtempSync(join(tmpdir(), "ccc-android-device-recovery-temp-"));
    const owner = "0123456789abcdef";
    const deviceId = "android-device-real-e2e-stale";
    const backendRoot = join(home, ".ccc", "devices", "owners", owner, "android-device");
    const statePath = join(backendRoot, "devices.json");
    const artifact = join(backendRoot, deviceId);
    const tempArtifact = join(tempRoot, "android-device-e2e-stale");
    const lease = { backend: "android-device", hardwareId: "USB123", ownerId: owner, deviceId, claimId: "claim", claimNonce: "nonce", expiresAt: "2020-01-01T00:00:00.000Z" };
    let leases = [lease];
    try {
        mkdirSync(artifact, { recursive: true });
        mkdirSync(tempArtifact);
        writeFileSync(statePath, JSON.stringify({ devices: [{
            id: deviceId,
            ownerId: owner,
            backend: "android-device",
            serial: "USB123",
            leaseClaimId: "claim",
            leaseClaimNonce: "nonce",
        }] }));
        const result = await recoverAndroidPhysicalDeviceResidue({
            home,
            owner,
            tempRoot,
            detachStateDevice: async () => writeFileSync(statePath, JSON.stringify({ devices: [] })),
            readLeases: () => [...leases],
            releaseLeaseResidue: (_backend, expected, releaseOptions) => {
                assert.deepEqual(expected, { hardwareId: "USB123", deviceId, claimId: "claim", claimNonce: "nonce" });
                assert.deepEqual(releaseOptions, { requireExpired: true });
                leases = [];
                return { ok: true };
            },
        });
        assert.deepEqual(result, { devices: 1, leases: 1, ownerArtifacts: 1, tempArtifacts: 1 });
        assert.equal(existsSync(artifact), false);
        assert.equal(existsSync(tempArtifact), false);
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(tempRoot, { recursive: true, force: true });
    }
});

test("recovers a fresh Android physical aggregate orphan only in lock-absent mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-android-device-fresh-orphan-"));
    const owner = "0123456789abcdef";
    const lease = {
        backend: "android-device",
        hardwareId: "USB123",
        ownerId: owner,
        deviceId: "android-device-real-e2e-fresh-orphan",
        claimId: "claim",
        claimNonce: "nonce",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    let leases = [lease];
    try {
        const result = await recoverAndroidPhysicalDeviceResidue({
            home,
            owner,
            allowActiveAggregateOrphans: true,
            readLeases: () => [...leases],
            releaseLeaseResidue: (_backend, expected, releaseOptions) => {
                assert.deepEqual(expected, {
                    hardwareId: "USB123",
                    deviceId: lease.deviceId,
                    claimId: "claim",
                    claimNonce: "nonce",
                });
                assert.deepEqual(releaseOptions, { requireLockAbsent: true });
                leases = [];
                return { ok: true };
            },
            snapshotTempArtifacts: () => new Set(),
        });
        assert.equal(result.leases, 1);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("Android physical recovery rejects foreign state and lease conflicts", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-android-device-recovery-guard-"));
    const owner = "0123456789abcdef";
    const backendRoot = join(home, ".ccc", "devices", "owners", owner, "android-device");
    const statePath = join(backendRoot, "devices.json");
    try {
        mkdirSync(backendRoot, { recursive: true });
        writeFileSync(statePath, JSON.stringify({ devices: [{ id: "android-device-real-e2e-foreign", ownerId: "foreign", backend: "android-device", serial: "USB" }] }));
        await assert.rejects(recoverAndroidPhysicalDeviceResidue({ home, owner }), /foreign owner/);
        writeFileSync(statePath, JSON.stringify({ devices: [] }));
        await assert.rejects(recoverAndroidPhysicalDeviceResidue({
            home,
            owner,
            readLeases: () => [{ backend: "android-device", hardwareId: "USB", ownerId: owner, deviceId: "android-device-real-e2e-stale" }],
            releaseLeaseResidue: () => ({ ok: false, error: "physical-lease-residue-lock-conflict" }),
            snapshotTempArtifacts: () => new Set(),
        }), /lock-conflict/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
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

test("detects and recovers an owner-scoped AVD directory omitted by avdmanager", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-avd-directory-"));
    const owner = "0123456789abcdef";
    const avdName = `ccc-${owner}-real-android-e2e-unregistered`;
    const avdRoot = join(home, ".android", "avd");
    try {
        mkdirSync(join(avdRoot, `${avdName}.avd`), { recursive: true });
        writeFileSync(join(avdRoot, `${avdName}.avd`, "userdata-qemu.img"), "large-image-placeholder");
        assert.deepEqual(listAndroidE2EAvdArtifactNames({ home, owner }), [avdName]);
        assert.deepEqual(inspectTestOwnedResidue("android-emulator", {
            home,
            owner,
            listAndroidAvds: () => [],
        }), [`sdk-avd-artifact:${avdName}`]);

        const deleted = [];
        const result = await recoverAndroidEmulatorResidue({
            home,
            owner,
            listAndroidAvds: () => [],
            listRunningAndroidAvds: () => [],
            deleteAndroidAvd: (name) => {
                deleted.push(name);
                removeOwnedAndroidAvdArtifacts(name, owner, { home });
            },
            snapshotTempArtifacts: () => new Set(),
        });
        assert.deepEqual(deleted, [avdName]);
        assert.equal(existsSync(join(avdRoot, `${avdName}.avd`)), false);
        assert.deepEqual(result, { devices: 0, avds: 1, ownerArtifacts: 0, tempArtifacts: 0 });
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("removes Android E2E AVD artifacts without provider registration state", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-avd-partial-delete-"));
    const owner = "0123456789abcdef";
    const avdName = `ccc-${owner}-real-android-e2e-partial`;
    const avdRoot = join(home, ".android", "avd");
    try {
        mkdirSync(join(avdRoot, `${avdName}.avd`), { recursive: true });
        const result = deleteAndroidAvdName(avdName, {
            home,
            owner,
            verifyInactive: () => true,
        });
        assert.deepEqual(result, { artifactsRemoved: 1 });
        assert.equal(existsSync(join(avdRoot, `${avdName}.avd`)), false);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("detects test-owned Hyper-V VMs even when CCC owner state is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-"));
    const owner = "0123456789abcdef";
    const incarnationId = "a".repeat(32);
    const vmName = `ccc-${owner}-windows-vm-real-e2e-123-${incarnationId}`;
    try {
        assert.deepEqual(parseHyperVVmInventory(JSON.stringify({
            name: vmName,
            notes: `ccc-device-lab:${owner}:windows-vm-real-e2e-123`,
            vmId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
            diskPaths: ["C:\\ccc\\root.vhdx"],
            checkpoints: ["durability-checkpoint"],
        })), [{
            name: vmName,
            notes: `ccc-device-lab:${owner}:windows-vm-real-e2e-123`,
            vmId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            diskPaths: ["C:\\ccc\\root.vhdx"],
            checkpoints: ["durability-checkpoint"],
        }]);
        const residue = inspectTestOwnedResidue("windows-vm", {
            home,
            owner,
            listHyperVVms: () => [
                { name: vmName, notes: `ccc-device-lab:${owner}:windows-vm-real-e2e-123:${incarnationId}`, vmId: "id", diskPaths: ["C:\\ccc\\root.vhdx"], checkpoints: ["before-upgrade"] },
                { name: "foreign-vm", notes: "", vmId: "foreign", diskPaths: [] },
            ],
        });
        assert.deepEqual(residue, [
            `host-vm:${vmName}`,
            `host-vm-disk:${vmName}:C:\\ccc\\root.vhdx`,
            `host-vm-checkpoint:${vmName}:before-upgrade`,
        ]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("Windows Hyper-V inventory commands request disks, checkpoints, switches, NATs, and addresses", () => {
    const commands = [];
    const spawnSyncImpl = (_executable, args) => {
        commands.push(args.at(-1));
        return commands.length === 1
            ? { status: 0, stdout: "[]", stderr: "" }
            : { status: 0, stdout: JSON.stringify({ switches: [], nats: [], addresses: [] }), stderr: "" };
    };
    assert.deepEqual(listHyperVVmInventory({ platform: "win32", spawnSyncImpl }), []);
    assert.deepEqual(listHyperVNetworkInventory({ platform: "win32", spawnSyncImpl }), { switches: [], nats: [], addresses: [] });
    assert.match(commands[0], /Get-VMHardDiskDrive/);
    assert.match(commands[0], /Get-VMSnapshot/);
    assert.match(commands[1], /Get-VMSwitch/);
    assert.match(commands[1], /Get-NetNat/);
    assert.match(commands[1], /Get-NetIPAddress/);
});

test("Windows Hyper-V inventory reports the one-time management permission remedy", () => {
    assert.throws(() => listHyperVVmInventory({
        platform: "win32",
        spawnSyncImpl: () => ({
            status: 1,
            stdout: "",
            stderr: "hyper-v-management-permission-unavailable:run ccc devices setup hyper-v --confirm, approve the one-time elevation, then sign out and sign in once",
        }),
    }), /ccc devices setup hyper-v --confirm/);
});

test("Windows Hyper-V inventory preserves non-permission provider failures", () => {
    const stderr = "Get-VM: the virtualization provider is unavailable";
    assert.throws(() => listHyperVVmInventory({
        platform: "win32",
        spawnSyncImpl: (_executable, args) => {
            assert.match(args.at(-1), /if \(\$TokenHasRole\) \{ throw \$InventoryError \}/);
            assert.match(args.at(-1), /WindowsBuiltInRole\]::Administrator/);
            assert.match(args.at(-1), /throw \$InventoryError/);
            return { status: 1, stdout: "", stderr };
        },
    }), /virtualization provider is unavailable/);
});

test("snapshots and compares complete Hyper-V host identities", () => {
    const before = snapshotHyperVHostIdentity({
        listHyperVVms: () => [{ name: "foreign", notes: "foreign", vmId: "b", diskPaths: ["z", "a"], checkpoints: ["two", "one"] }],
        listHyperVNetworks: () => ({
            switches: [{ name: "switch", id: "switch-id", type: "External", notes: "foreign" }],
            nats: [{ name: "nat", prefix: "10.0.0.0/24", instanceId: "nat-id" }],
            addresses: [{ interfaceAlias: "vEthernet (switch)", address: "10.0.0.1", prefixLength: 24 }],
        }),
    });
    const same = snapshotHyperVHostIdentity({
        listHyperVVms: () => [{ name: "foreign", notes: "foreign", vmId: "b", diskPaths: ["a", "z"], checkpoints: ["one", "two"] }],
        listHyperVNetworks: () => ({
            switches: [{ name: "switch", id: "switch-id", type: "External", notes: "foreign" }],
            nats: [{ name: "nat", prefix: "10.0.0.0/24", instanceId: "nat-id" }],
            addresses: [{ interfaceAlias: "vEthernet (switch)", address: "10.0.0.1", prefixLength: 24 }],
        }),
    });
    assert.doesNotThrow(() => assertHyperVHostIdentityUnchanged(before, same));
    const replaced = structuredClone(same);
    replaced.nats[0].instanceId = "replacement-id";
    assert.throws(() => assertHyperVHostIdentityUnchanged(before, replaced), /Hyper-V host identity changed during cycle/);
});

test("Hyper-V host identity snapshot fails closed on incomplete network inventory", () => {
    assert.throws(() => snapshotHyperVHostIdentity({
        listHyperVVms: () => [],
        listHyperVNetworks: () => ({ switches: [], nats: null, addresses: [] }),
    }), /network identity inventory incomplete/);
});

test("Hyper-V host identity excludes only exact persisted managed network identities", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-identity-"));
    const networkRoot = join(home, ".ccc", "device-broker-private", "network");
    mkdirSync(networkRoot, { recursive: true });
    writeFileSync(join(networkRoot, "hyper-v.json"), JSON.stringify({
        version: 1,
        switchName: "CCC Device Lab",
        switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        marker: "ccc-device-lab:hyper-v-network:0123456789abcdef01234567",
        natName: "CCCDeviceLab-0123456789abcdef01234567",
        natInstanceId: "managed-nat-id",
        prefix: "172.29.0.0/24",
        gateway: "172.29.0.1",
        managedNat: true,
        allocations: [],
    }));
    try {
        const snapshot = snapshotHyperVHostIdentity({
            home,
            listHyperVVms: () => [],
            listHyperVNetworks: () => ({
                switches: [
                    { name: "CCC Device Lab", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", type: "Internal", notes: "ccc-device-lab:hyper-v-network:0123456789abcdef01234567" },
                    { name: "CCC Device Lab", id: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee", type: "Internal", notes: "ccc-device-lab:hyper-v-network:0123456789abcdef01234567" },
                ],
                nats: [
                    { name: "CCCDeviceLab-0123456789abcdef01234567", prefix: "172.29.0.0/24", instanceId: "managed-nat-id" },
                    { name: "CCCDeviceLab-0123456789abcdef01234567", prefix: "172.29.0.0/24", instanceId: "replacement-nat-id" },
                ],
                addresses: [
                    { interfaceAlias: "vEthernet (CCC Device Lab)", address: "172.29.0.1", prefixLength: 24 },
                    { interfaceAlias: "vEthernet (CCC Device Lab)", address: "172.29.0.2", prefixLength: 24 },
                ],
            }),
        });
        assert.deepEqual(snapshot.switches.map((item) => item.id), ["ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"]);
        assert.deepEqual(snapshot.nats.map((item) => item.instanceId), ["replacement-nat-id"]);
        assert.deepEqual(snapshot.addresses.map((item) => item.address), ["172.29.0.2"]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("preserves ambiguously identified Hyper-V VMs and does not attribute their disks or checkpoints", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-ambiguous-"));
    const owner = "0123456789abcdef";
    try {
        const residue = inspectTestOwnedResidue("windows-vm", {
            home,
            owner,
            listHyperVVms: () => [
                { name: `ccc-${owner}-windows-vm-real-e2e-name-only-${"a".repeat(32)}`, notes: "foreign", diskPaths: ["C:\\foreign.vhdx"], checkpoints: ["foreign-checkpoint"] },
                { name: "foreign-name", notes: `ccc-device-lab:${owner}:windows-vm-real-e2e-marker-only`, diskPaths: ["C:\\foreign-2.vhdx"], checkpoints: ["foreign-checkpoint-2"] },
            ],
        });
        assert.deepEqual(residue, [
            `ambiguous-host-vm:ccc-${owner}-windows-vm-real-e2e-name-only-${"a".repeat(32)}`,
            "ambiguous-host-vm:foreign-name",
        ]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("detects test-owned Hyper-V VHDX and exact mutation and operation locks", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-locks-"));
    const owner = "0123456789abcdef";
    const deviceId = "windows-vm-real-e2e-locked";
    const backendRoot = join(home, ".ccc", "devices", "owners", owner, "windows-vm");
    const deviceRoot = join(backendRoot, deviceId);
    const diskPath = join(deviceRoot, "disks", "root.vhdx");
    const mutationLock = join(backendRoot, "devices.mutation.lock");
    const operationKey = createHash("sha256").update(deviceId).digest("hex").slice(0, 32);
    const operationLock = join(backendRoot, "operations", `${operationKey}.lock`);
    try {
        mkdirSync(join(deviceRoot, "disks"), { recursive: true });
        mkdirSync(join(backendRoot, "operations"), { recursive: true });
        writeFileSync(join(backendRoot, "devices.json"), JSON.stringify({ devices: [{ id: deviceId }] }));
        writeFileSync(diskPath, "vhdx");
        writeFileSync(mutationLock, "lock");
        writeFileSync(operationLock, "lock");
        assert.deepEqual(inspectTestOwnedResidue("windows-vm", {
            home,
            owner,
            listHyperVVms: () => [],
        }), [
            `device-state:${deviceId}`,
            `owner-artifact:${deviceRoot}`,
            `vhdx:${diskPath}`,
            `operation-lock:${operationLock}:${deviceId}`,
            `mutation-lock:${mutationLock}`,
        ]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("detects and removes only current-owner test-prefixed Hyper-V private artifacts", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-private-"));
    const owner = "0123456789abcdef";
    const backendRoot = join(home, ".ccc", "device-broker-private", "owners", owner, "linux-vm");
    const testArtifact = join(backendRoot, "linux-hyper-v-real-e2e-123");
    const userArtifact = join(backendRoot, "user-linux-vm");
    try {
        mkdirSync(testArtifact, { recursive: true });
        mkdirSync(userArtifact, { recursive: true });
        assert.deepEqual(inspectTestOwnedResidue("linux-vm", {
            home,
            owner,
            listHyperVVms: () => [],
        }), [`private-artifact:${testArtifact}`]);
        assert.deepEqual(recoverHyperVPrivateResidue("linux-vm", { home, owner }), { privateArtifacts: 1 });
        assert.equal(existsSync(testArtifact), false);
        assert.equal(existsSync(userArtifact), true);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("detects current-owner test-prefixed Hyper-V network allocations", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-network-"));
    const owner = "0123456789abcdef";
    const networkRoot = join(home, ".ccc", "device-broker-private", "network");
    const networkPath = join(networkRoot, "hyper-v.json");
    try {
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(networkPath, JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            natName: "CCCDeviceLab",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            allocations: [
                { ownerId: owner, deviceId: "windows-vm-real-e2e-123", address: "172.29.0.10", allocatedAt: new Date().toISOString() },
                { ownerId: owner, deviceId: "user-windows-vm", address: "172.29.0.11", allocatedAt: new Date().toISOString() },
                { ownerId: "fedcba9876543210", deviceId: "windows-vm-real-e2e-456", address: "172.29.0.12", allocatedAt: new Date().toISOString() },
            ],
        }));
        assert.deepEqual(inspectTestOwnedResidue("windows-vm", {
            home,
            owner,
            listHyperVVms: () => [],
        }), [`network-allocation:${networkPath}:windows-vm-real-e2e-123`]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("parses independently observable Hyper-V network inventory sections", () => {
    assert.deepEqual(parseHyperVNetworkInventory(JSON.stringify({
        switches: [{ name: "CCC Device Lab", id: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", type: "Internal", notes: "ccc-device-lab:hyper-v-network:v1" }],
        nats: [{ name: "CCCDeviceLab", prefix: "172.29.0.0/24", instanceId: "ccc-nat-instance-1" }],
        addresses: [{ interfaceAlias: "vEthernet (CCC Device Lab)", address: "172.29.0.1", prefixLength: 24 }],
    })), {
        switches: [{ name: "CCC Device Lab", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", type: "Internal", notes: "ccc-device-lab:hyper-v-network:v1" }],
        nats: [{ name: "CCCDeviceLab", prefix: "172.29.0.0/24", instanceId: "ccc-nat-instance-1" }],
        addresses: [{ interfaceAlias: "vEthernet (CCC Device Lab)", address: "172.29.0.1", prefixLength: 24 }],
    });
    assert.deepEqual(parseHyperVNetworkInventory(JSON.stringify({ switches: null, nats: null, addresses: null })), {
        switches: null,
        nats: null,
        addresses: null,
    });
});

test("allows a valid Hyper-V bootstrap intent to be adopted by the next provider cycle", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-network-intent-"));
    const owner = "0123456789abcdef";
    const networkRoot = join(home, ".ccc", "device-broker-private", "network");
    const token = "a".repeat(24);
    try {
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(join(networkRoot, "hyper-v-intent.json"), JSON.stringify({
            version: 1,
            token,
            switchName: "CCC Device Lab",
            natName: `CCCDeviceLab-${token}`,
            marker: `ccc-device-lab:hyper-v-network:${token}`,
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            createdAt: new Date().toISOString(),
        }));
        assert.deepEqual(inspectTestOwnedResidue("linux-vm", {
            home,
            owner,
            listHyperVVms: () => [],
            listHyperVNetworks: () => ({
                switches: [{ name: "CCC Device Lab", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", type: "Internal", notes: `ccc-device-lab:hyper-v-network:${token}` }],
                nats: [{ name: `CCCDeviceLab-${token}`, prefix: "172.29.0.0/24" }],
                addresses: [{ interfaceAlias: "vEthernet (CCC Device Lab)", address: "172.29.0.1", prefixLength: 24 }],
            }),
        }), []);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("detects live CCC-owned Hyper-V switch, NAT, and gateway after the last allocation", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-live-network-"));
    const owner = "0123456789abcdef";
    const networkRoot = join(home, ".ccc", "device-broker-private", "network");
    try {
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(join(networkRoot, "hyper-v.json"), JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            natName: "CCCDeviceLab",
            natInstanceId: "ccc-nat-instance-1",
            managedNat: true,
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            allocations: [],
        }));
        assert.deepEqual(inspectTestOwnedResidue("windows-vm", {
            home,
            owner,
            listHyperVVms: () => [],
            listHyperVNetworks: () => ({
                switches: [{ name: "CCC Device Lab", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", type: "Internal", notes: "ccc-device-lab:hyper-v-network:v1" }],
                nats: [{ name: "CCCDeviceLab", prefix: "172.29.0.0/24", instanceId: "ccc-nat-instance-1" }],
                addresses: [{ interfaceAlias: "vEthernet (CCC Device Lab)", address: "172.29.0.1", prefixLength: 24 }],
            }),
        }), [
            "host-network-switch:CCC Device Lab",
            "host-network-nat:CCCDeviceLab",
            "host-network-address:vEthernet (CCC Device Lab):172.29.0.1/24",
        ]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("treats a replacement Hyper-V NAT instance as ambiguous", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-replaced-nat-"));
    const owner = "0123456789abcdef";
    const networkRoot = join(home, ".ccc", "device-broker-private", "network");
    try {
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(join(networkRoot, "hyper-v.json"), JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            marker: "ccc-device-lab:hyper-v-network:v1",
            natName: "CCCDeviceLab",
            natInstanceId: "ccc-nat-instance-expected",
            managedNat: true,
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            allocations: [],
        }));
        assert.deepEqual(inspectTestOwnedResidue("windows-vm", {
            home,
            owner,
            listHyperVVms: () => [],
            listHyperVNetworks: () => ({
                switches: [{ name: "CCC Device Lab", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", type: "Internal", notes: "ccc-device-lab:hyper-v-network:v1" }],
                nats: [{ name: "CCCDeviceLab", prefix: "172.29.0.0/24", instanceId: "ccc-nat-instance-replacement" }],
                addresses: [],
            }),
        }), [
            "host-network-switch:CCC Device Lab",
            "ambiguous-host-network-nat:CCCDeviceLab",
        ]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("preserves shared or ambiguous Hyper-V network resources", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-shared-network-"));
    const owner = "0123456789abcdef";
    const networkRoot = join(home, ".ccc", "device-broker-private", "network");
    try {
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(join(networkRoot, "hyper-v.json"), JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            natName: "CCCDeviceLab",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            allocations: [{ ownerId: owner, deviceId: "user-windows-vm", address: "172.29.0.10", allocatedAt: new Date().toISOString() }],
        }));
        assert.deepEqual(inspectTestOwnedResidue("windows-vm", {
            home,
            owner,
            listHyperVVms: () => [],
            listHyperVNetworks: () => ({
                switches: [{ name: "CCC Device Lab", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", type: "Internal", notes: "ccc-device-lab:hyper-v-network:v1" }],
                nats: [{ name: "CCCDeviceLab", prefix: "172.29.0.0/24" }],
                addresses: [],
            }),
        }), []);
        assert.deepEqual(inspectTestOwnedResidue("windows-vm", {
            home,
            owner,
            listHyperVVms: () => [],
            listHyperVNetworks: () => ({
                switches: [{ name: "CCC Device Lab", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", type: "Internal", notes: "foreign" }],
                nats: [{ name: "CCCDeviceLab", prefix: "172.29.0.0/24" }],
                addresses: [],
            }),
        }), ["ambiguous-host-network-switch:CCC Device Lab"]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("fails closed on malformed Hyper-V network allocation state", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-network-invalid-"));
    const owner = "0123456789abcdef";
    const networkRoot = join(home, ".ccc", "device-broker-private", "network");
    try {
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(join(networkRoot, "hyper-v.json"), JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            natName: "CCCDeviceLab",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            allocations: [{ ownerId: owner }],
        }));
        assert.throws(() => inspectTestOwnedResidue("linux-vm", {
            home,
            owner,
            listHyperVVms: () => [],
        }), /Hyper-V network allocation metadata malformed/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("fails closed when managed Hyper-V NAT state lacks its instance identity", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-real-cycle-hyper-v-network-unfenced-nat-"));
    const owner = "0123456789abcdef";
    const networkRoot = join(home, ".ccc", "device-broker-private", "network");
    try {
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(join(networkRoot, "hyper-v.json"), JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            natName: "CCCDeviceLab",
            managedNat: true,
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            allocations: [],
        }));
        assert.throws(() => inspectTestOwnedResidue("linux-vm", {
            home,
            owner,
            listHyperVVms: () => [],
        }), /Hyper-V network state metadata malformed/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("compacts large residue lists and preserves the full diagnostic in one bounded report", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-real-cycle-diagnostic-"));
    const items = [
        "device-state:android-real-e2e-stale",
        ...Array.from({ length: 8 }, (_, index) => `owner-artifact:C:\\Users\\Test\\.ccc\\android\\android-real-e2e-${index}`),
        "sdk-avd:ccc-owner-real-android-e2e-stale",
        "temp-artifact:C:\\Users\\Test\\Temp\\ccc-android-emulator-e2e-stale",
    ];
    try {
        const summary = formatResidueSummary(items);
        assert.match(summary, /^11 items \(device-state=1, owner-artifact=8, sdk-avd=1, temp-artifact=1\)/);
        assert.match(summary, /owner-artifact:android-real-e2e-0/);
        assert.doesNotMatch(summary, /android-real-e2e-7/);
        assert.ok(summary.length < 300);
        const report = writeResidueDiagnostic({
            target: "android-emulator",
            cycle: 1,
            phase: "preflight",
        }, items, { root });
        const payload = JSON.parse(readFileSync(report, "utf8"));
        assert.deepEqual(payload.items, items);
        assert.equal(readdirSync(root).length, 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
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
            configureAndroidPhysicalDevice: () => ({ serial: "TEST", source: "auto", candidates: 1 }),
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
            inspectTestOwnedResidue: () => [],
            snapshotTestTempArtifacts: () => new Set(),
            runningWindowsSandboxSessions: () => [1234],
        }),
        /refusing cycle 1\/1 while a Windows Sandbox session is active/,
    );
    assert.equal(invoked, false);
});

test("Windows target lets the provider test recover prior E2E residue", async () => {
    let cycleRuns = 0;
    let residueInspections = 0;
    const code = await main(["--target", "windows-sandbox", "--cycles", "1"], {
        inspectTestOwnedResidue: () => (++residueInspections === 1
            ? ["device-state:windows-real-sandbox-stale", "host-lock:C:/host-locks/windows-sandbox.json"]
            : []),
        snapshotTestTempArtifacts: () => new Set(),
        runningWindowsSandboxSessions: () => (cycleRuns === 0 ? [1234] : []),
        runCycle: async () => {
            cycleRuns += 1;
            return successfulCycle();
        },
    });
    assert.equal(code, 0);
    assert.equal(cycleRuns, 1);
    assert.equal(residueInspections, 2);
});

test("Windows target removes stale test temp artifacts before residue recovery", async () => {
    let artifactInspections = 0;
    let cleaned = false;
    const code = await main(["--target", "windows-sandbox", "--cycles", "1"], {
        inspectTestOwnedResidue: () => [],
        snapshotTestTempArtifacts: () => (++artifactInspections === 1
            ? new Set(["stale/ccc-windows-sandbox-e2e-old"])
            : new Set()),
        cleanupTestTempArtifacts: (_target, paths) => {
            cleaned = true;
            assert.deepEqual(paths, ["stale/ccc-windows-sandbox-e2e-old"]);
        },
        runningWindowsSandboxSessions: () => [],
        runCycle: async () => successfulCycle(),
    });
    assert.equal(code, 0);
    assert.equal(cleaned, true);
    assert.equal(artifactInspections, 3);
});

test("fails closed when Android residue recovery cannot clear state before cycle one", async () => {
    let invoked = false;
    let inspections = 0;
    await assert.rejects(
        main(["--target", "android-emulator", "--cycles", "1"], {
            inspectTestOwnedResidue: () => {
                inspections += 1;
                return ["device-state:android-real-e2e-stale"];
            },
            snapshotTestTempArtifacts: () => new Set(),
            recoverAndroidEmulatorResidue: async () => ({ devices: 1 }),
            writeResidueDiagnostic: () => "diagnostic.json",
            runCycle: async () => { invoked = true; return successfulCycle(); },
        }),
        /Android recovery did not clear residue before cycle 1: device-state:android-real-e2e-stale/,
    );
    assert.equal(invoked, false);
    assert.equal(inspections, 2);
});

test("runs the Android cycle after verified automatic residue recovery", async () => {
    let inspections = 0;
    let recovered = 0;
    let cycleRuns = 0;
    const code = await main(["--target", "android-emulator", "--cycles", "1"], {
        inspectTestOwnedResidue: () => (++inspections === 1 ? ["device-state:android-real-e2e-stale"] : []),
        snapshotTestTempArtifacts: () => new Set(),
        recoverAndroidEmulatorResidue: async () => {
            recovered += 1;
            return { devices: 1, avds: 1 };
        },
        runCycle: async () => {
            cycleRuns += 1;
            return successfulCycle();
        },
    });
    assert.equal(code, 0);
    assert.equal(recovered, 1);
    assert.equal(cycleRuns, 1);
    assert.equal(inspections, 3);
});

test("runs the Android physical cycle after verified automatic residue recovery", async () => {
    let inspections = 0;
    let recovered = 0;
    let cycleRuns = 0;
    const code = await main(["--target", "android-device", "--cycles", "1"], {
        configureAndroidPhysicalDevice: () => ({ serial: "TEST", source: "auto", candidates: 1 }),
        inspectTestOwnedResidue: () => (++inspections === 1 ? ["physical-lease-aggregate:stale"] : []),
        snapshotTestTempArtifacts: () => new Set(),
        recoverAndroidPhysicalDeviceResidue: async (options) => {
            assert.deepEqual(options, { allowActiveAggregateOrphans: true });
            recovered += 1;
            return { leases: 1 };
        },
        runCycle: async () => {
            cycleRuns += 1;
            return successfulCycle();
        },
    });
    assert.equal(code, 0);
    assert.equal(recovered, 1);
    assert.equal(cycleRuns, 1);
    assert.equal(inspections, 3);
});

test("recovers lock-absent Android physical residue after a successful cycle", async () => {
    let inspections = 0;
    let recoveries = 0;
    const code = await main(["--target", "android-device", "--cycles", "1"], {
        configureAndroidPhysicalDevice: () => ({ serial: "TEST", source: "auto", candidates: 1 }),
        inspectTestOwnedResidue: () => (++inspections === 2 ? ["physical-lease-aggregate:fresh"] : []),
        snapshotTestTempArtifacts: () => new Set(),
        recoverAndroidPhysicalDeviceResidue: async (options) => {
            assert.deepEqual(options, { allowActiveAggregateOrphans: true });
            recoveries += 1;
            return { leases: 1 };
        },
        runCycle: async () => successfulCycle(),
    });
    assert.equal(code, 0);
    assert.equal(recoveries, 1);
    assert.equal(inspections, 3);
});

test("fails closed when Android physical recovery cannot clear temporary artifacts", async () => {
    let invoked = false;
    await assert.rejects(
        main(["--target", "android-device", "--cycles", "1"], {
            configureAndroidPhysicalDevice: () => ({ serial: "TEST", source: "auto", candidates: 1 }),
            inspectTestOwnedResidue: () => [],
            snapshotTestTempArtifacts: () => new Set(["stale/android-device-e2e-artifact"]),
            writeResidueDiagnostic: () => "diagnostic.json",
            runCycle: async () => { invoked = true; return successfulCycle(); },
        }),
        /Android physical recovery did not clear residue before cycle 1: temp-artifact:stale\/android-device-e2e-artifact/,
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
        /Windows Sandbox session remained or appeared \(IDs: 5678\)/,
    );
    assert.equal(cycleRuns, 1);
    assert.equal(processInspections, 2);
});

test("failed cycle still reports process cleanup errors and post-failure residue", async () => {
    let inspections = 0;
    await assert.rejects(
        main(["--target", "android-device", "--cycles", "1"], {
            configureAndroidPhysicalDevice: () => ({ serial: "TEST", source: "auto", candidates: 1 }),
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
            configureAndroidPhysicalDevice: () => ({ serial: "TEST", source: "auto", candidates: 1 }),
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
