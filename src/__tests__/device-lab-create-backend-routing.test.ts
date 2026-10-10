import { beforeEach, describe, expect, it, vi } from "vitest";

// These are native leaves, not substitute provider handlers or lifecycle policy.
// Record before throwing so even a caught effect cannot look like routing success.
const boundary = vi.hoisted(() => {
    const calls: string[] = [];
    const reject = (name: string) => (..._args: unknown[]): never => {
        calls.push(name);
        throw new Error(`Foreign create reached ${name}`);
    };
    return { calls, reject };
});

vi.mock("../../packages/device-lab/providers/state/device-store.mjs", async importOriginal => ({
    ...await importOriginal<typeof import("../../packages/device-lab/providers/state/device-store.mjs")>(),
    withOwnerDeviceOperation: boundary.reject("owner-device-operation"),
    withOwnerDeviceOperations: boundary.reject("owner-device-operations"),
    readOwnerDevices: boundary.reject("read-owner-devices"),
    findOwnerDevice: boundary.reject("find-owner-device"),
    claimOwnerDevice: boundary.reject("claim-owner-device"),
    transitionOwnerDeviceRecord: boundary.reject("transition-owner-device"),
    updateOwnerDevice: boundary.reject("update-owner-device"),
    mutateOwnerDevices: boundary.reject("mutate-owner-devices"),
    writeOwnerDevices: boundary.reject("write-owner-devices"),
}));
vi.mock("../../packages/device-lab/providers/state/android-emulator-port-allocation.mjs", async importOriginal => ({
    ...await importOriginal<typeof import("../../packages/device-lab/providers/state/android-emulator-port-allocation.mjs")>(),
    withAndroidEmulatorPortAllocation: boundary.reject("android-port-allocation-lock"),
    resolveAndroidEmulatorPort: boundary.reject("android-port-allocation"),
}));
vi.mock("../../packages/device-lab/providers/commands.mjs", async importOriginal => ({
    ...await importOriginal<typeof import("../../packages/device-lab/providers/commands.mjs")>(),
    commandPath: boundary.reject("provider-discovery"),
    localBinPath: boundary.reject("provider-local-bin"),
    run: boundary.reject("provider-run"),
    runBuffer: boundary.reject("provider-run-buffer"),
    runWithInput: boundary.reject("provider-run-input"),
    runWithTimeout: boundary.reject("provider-run-timeout"),
}));
vi.mock("child_process", async importOriginal => ({
    ...await importOriginal<typeof import("node:child_process")>(),
    spawn: boundary.reject("native-spawn"),
    spawnSync: boundary.reject("native-spawn-sync"),
    exec: boundary.reject("native-exec"),
    execSync: boundary.reject("native-exec-sync"),
    execFile: boundary.reject("native-exec-file"),
    execFileSync: boundary.reject("native-exec-file-sync"),
    fork: boundary.reject("native-fork"),
}));
vi.mock("fs", async importOriginal => ({
    ...await importOriginal<typeof import("node:fs")>(),
    mkdirSync: boundary.reject("native-mkdir"),
    mkdtempSync: boundary.reject("native-mkdtemp"),
    openSync: boundary.reject("native-open"),
    writeFileSync: boundary.reject("native-write-file"),
    writeSync: boundary.reject("native-write"),
    renameSync: boundary.reject("native-rename"),
    unlinkSync: boundary.reject("native-unlink"),
    rmSync: boundary.reject("native-remove"),
    copyFileSync: boundary.reject("native-copy"),
    fchmodSync: boundary.reject("native-fchmod"),
}));

import { handleAndroidTool } from "../../packages/device-lab/providers/backends/android.mjs";
import { handleIosTool } from "../../packages/device-lab/providers/backends/ios-simulator.mjs";
import { handleWindowsTool } from "../../packages/device-lab/providers/backends/windows-sandbox.mjs";

beforeEach(() => {
    // No effect is permitted during import or between foreign requests.
    expect(boundary.calls).toEqual([]);
});

describe("actual create handlers decline foreign backend hints before native effects", () => {
    it.each([
        ["Android", handleAndroidTool, "ios-simulator"],
        ["Android", handleAndroidTool, "macos-vm"],
        ["Android", handleAndroidTool, "windows-sandbox"],
        ["Android", handleAndroidTool, "android-device"],
        ["iOS", handleIosTool, "android-emulator"],
        ["iOS", handleIosTool, "macos-vm"],
        ["iOS", handleIosTool, "windows-sandbox"],
        ["iOS", handleIosTool, "ios-device"],
        ["Windows", handleWindowsTool, "android-emulator"],
        ["Windows", handleWindowsTool, "ios-simulator"],
        ["Windows", handleWindowsTool, "macos-vm"],
    ] as const)("%s declines foreign create row %#", async (_provider, handle, backend) => {
        const result = await handle("device_create", {
            backend,
            deviceId: "foreign-create-routing",
            name: "Foreign Create Routing",
            createAvd: true,
            createSimulator: true,
            provider: "tart",
            image: "fixture-image",
        });
        expect(result).toBeUndefined();
        expect(boundary.calls).toEqual([]);
    });
});
