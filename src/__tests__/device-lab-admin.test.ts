import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    cleanupOwnerDevices,
    deviceLabOwnerId,
    deleteOwnerDevice,
    formatDevicesBackends,
    formatDevicesDoctor,
    formatDevicesList,
    formatDevicesSmoke,
    formatDevicesStatus,
    pruneOwnerDevices,
    stopOwnerDevice,
} from "../device-lab-admin.js";

describe("device-lab admin CLI formatters", () => {
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    let homeDir: string | null = null;

    afterEach(() => {
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        homeDir = null;
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
    });

    function setupFixture(cwd: string) {
        homeDir = join(tmpdir(), `ccc-device-admin-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        process.env.HOME = homeDir;
        process.env.PATH = "/tmp/ccc-device-admin-empty-path";
        const owner = deviceLabOwnerId(cwd);
        const androidDir = join(homeDir, ".ccc/devices/owners", owner, "android");
        const iosDir = join(homeDir, ".ccc/devices/owners", owner, "ios");
        const windowsDir = join(homeDir, ".ccc/devices/owners", owner, "windows");
        const macosDir = join(homeDir, ".ccc/devices/owners", owner, "macos");
        const otherOwnerDir = join(homeDir, ".ccc/devices/owners", "other-owner", "android");
        mkdirSync(androidDir, { recursive: true });
        mkdirSync(iosDir, { recursive: true });
        mkdirSync(windowsDir, { recursive: true });
        mkdirSync(macosDir, { recursive: true });
        mkdirSync(otherOwnerDir, { recursive: true });
        const androidFile = join(androidDir, "devices.json");
        const iosFile = join(iosDir, "devices.json");
        const windowsFile = join(windowsDir, "devices.json");
        const macosFile = join(macosDir, "devices.json");
        const otherOwnerFile = join(otherOwnerDir, "devices.json");
        writeFileSync(androidFile, JSON.stringify({
            devices: [
                { id: "android-owned", name: "Pixel", status: "stopped", platform: "android", serial: "emulator-5554" },
                { id: "android-running", name: "Pixel Running", status: "running", platform: "android", serial: "emulator-5582", pid: 999999 },
            ],
        }));
        writeFileSync(iosFile, JSON.stringify({
            devices: [
                { id: "ios-owned", name: "iPhone", status: "booted", platform: "ios", udid: "IOS-UDID" },
                { id: "ios-stopped", name: "iPhone Stopped", status: "stopped", platform: "ios", udid: "IOS-STOPPED" },
            ],
        }));
        writeFileSync(windowsFile, JSON.stringify({
            devices: [{ id: "windows-owned", name: "Win", status: "running", platform: "windows" }],
        }));
        writeFileSync(macosFile, JSON.stringify({
            devices: [
                { id: "macos-owned", name: "Mac", status: "running", platform: "macos", provider: "tart", providerInstance: "ccc-mac" },
                { id: "macos-stopped", name: "Mac Stopped", status: "stopped", platform: "macos", provider: "tart", providerInstance: "ccc-mac-stopped" },
            ],
        }));
        writeFileSync(otherOwnerFile, JSON.stringify({
            devices: [{ id: "android-foreign", name: "Foreign", status: "running", platform: "android" }],
        }));
        return { owner, androidFile, iosFile, windowsFile, macosFile, otherOwnerFile };
    }

    function readDeviceIds(file: string) {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as { devices: Array<{ id: string; status?: string }> };
        return parsed.devices.map((device) => `${device.id}:${device.status || "unknown"}`);
    }

    function writeTool(binDir: string, name: string, body: string) {
        const path = join(binDir, name);
        writeFileSync(path, `#!/bin/sh\n${body}\n`);
        chmodSync(path, 0o755);
        return path;
    }

    it("formats owner-scoped device status without exposing other owners", () => {
        const cwd = "/project/admin-test";
        const { owner } = setupFixture(cwd);

        const output = formatDevicesStatus(cwd);

        expect(output).toContain(`owner: ${owner}`);
        expect(output).toContain("android-emulator: 2 device(s)");
        expect(output).toContain("ios-simulator: 2 device(s)");
        expect(output).not.toContain("android-foreign");
    });

    it("lists current-owner device definitions grouped by backend", () => {
        const cwd = "/project/admin-list-test";
        setupFixture(cwd);

        const output = formatDevicesList(cwd);

        expect(output).toContain("android-emulator:");
        expect(output).toContain("android-owned  name=Pixel  status=stopped  platform=android");
        expect(output).toContain("android-running  name=Pixel Running  status=running  platform=android");
        expect(output).toContain("ios-owned  name=iPhone  status=booted  platform=ios");
        expect(output).toContain("ios-stopped  name=iPhone Stopped  status=stopped  platform=ios");
        expect(output).toContain("windows-sandbox:");
        expect(output).not.toContain("android-foreign");
    });

    it("reports backend prerequisites as diagnostics without requiring devices", () => {
        const cwd = "/project/admin-backends-test";
        setupFixture(cwd);

        const backends = formatDevicesBackends(cwd);
        const doctor = formatDevicesDoctor(cwd);

        expect(backends).toContain("android-emulator:");
        expect(backends).toContain("adb: missing");
        expect(backends).toContain("xcrun: missing");
        expect(doctor).toContain("Startup policy: lazy; these diagnostics do not start devices");
        expect(doctor).toContain("android-emulator: missing");
    });

    it("reports smoke SKIP for missing host prerequisites without starting devices", () => {
        const cwd = "/project/admin-smoke-skip-test";
        setupFixture(cwd);

        const smoke = formatDevicesSmoke(cwd);

        expect(smoke).toContain("=== CCC Devices Smoke ===");
        expect(smoke).toContain("Startup policy: lazy; smoke checks do not start devices");
        expect(smoke).toContain("android-emulator: SKIP - missing adb, emulator");
        expect(smoke).toContain("ios-simulator: SKIP - missing xcrun");
        expect(smoke).toContain("windows-sandbox: SKIP - missing wsb");
        expect(smoke).toContain("macos-vm: SKIP - missing tart, vz, utmctl");
    });

    it("reports smoke PASS and FAIL from fake non-destructive host commands", () => {
        const cwd = "/project/admin-smoke-fake-test";
        setupFixture(cwd);
        const binDir = join(homeDir!, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        writeTool(binDir, "adb", "echo adb-version; exit 0");
        writeTool(binDir, "emulator", "echo avd-one; exit 0");
        writeTool(binDir, "xcrun", "echo '{\"devices\":{}}'; exit 0");
        writeTool(binDir, "wsb", "echo wsb-help; exit 0");
        writeTool(binDir, "tart", "echo tart-version >&2; exit 7");

        const smoke = formatDevicesSmoke(cwd);

        expect(smoke).toContain("android-emulator: PASS - adb and emulator responded");
        expect(smoke).toContain(`${join(binDir, "adb")} version -> 0`);
        expect(smoke).toContain(`${join(binDir, "emulator")} -list-avds -> 0`);
        expect(smoke).toContain("ios-simulator: PASS - xcrun simctl inventory responded");
        expect(smoke).toContain("windows-sandbox: PASS - wsb CLI responded");
        expect(smoke).toContain("macos-vm: FAIL - tart-version");
        expect(smoke).toContain(`${join(binDir, "tart")} --version -> 7`);
    });

    it("bounds smoke host command execution with a timeout", () => {
        const cwd = "/project/admin-smoke-timeout-test";
        setupFixture(cwd);
        const binDir = join(homeDir!, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        writeTool(binDir, "adb", `"${process.execPath}" -e 'setTimeout(() => {}, 1000)'`);
        writeTool(binDir, "emulator", "echo avd-one; exit 0");

        const smoke = formatDevicesSmoke(cwd, 50);

        expect(smoke).toContain("android-emulator: FAIL -");
        expect(smoke).toContain(`${join(binDir, "adb")} version -> unknown`);
        expect(smoke).toMatch(/ETIMEDOUT|timed out|Timeout/i);
    });

    it("stops an owned device without mutating other owner devices", () => {
        const cwd = "/project/admin-stop-test";
        const { androidFile, otherOwnerFile } = setupFixture(cwd);

        const result = stopOwnerDevice("android-running", cwd);

        expect(result.ok).toBe(true);
        expect(result.text).toContain("stopped: android-running");
        expect(readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:stopped"]);
        expect(readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("cleans up running current-owner devices across all backends and preserves stopped and foreign devices", () => {
        const cwd = "/project/admin-cleanup-all-test";
        const { androidFile, iosFile, windowsFile, macosFile, otherOwnerFile } = setupFixture(cwd);
        const binDir = join(homeDir!, "bin");
        const logPath = join(homeDir!, "cleanup.log");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        writeTool(binDir, "adb", `echo "adb $*" >> "${logPath}"; exit 0`);
        writeTool(binDir, "xcrun", `echo "xcrun $*" >> "${logPath}"; exit 0`);
        writeTool(binDir, "wsb", `echo "wsb $*" >> "${logPath}"; exit 0`);
        writeTool(binDir, "tart", `echo "tart $*" >> "${logPath}"; exit 0`);

        const cleanup = cleanupOwnerDevices(cwd);

        expect(cleanup.results.filter((result) => result.status === "stopped").map((result) => result.id).sort()).toEqual([
            "android-running",
            "ios-owned",
            "macos-owned",
            "windows-owned",
        ]);
        expect(readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:stopped"]);
        expect(readDeviceIds(iosFile)).toEqual(["ios-owned:stopped", "ios-stopped:stopped"]);
        expect(readDeviceIds(windowsFile)).toEqual(["windows-owned:stopped"]);
        expect(readDeviceIds(macosFile)).toEqual(["macos-owned:stopped", "macos-stopped:stopped"]);
        expect(readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("adb -s emulator-5582 emu kill");
        expect(log).toContain("xcrun simctl shutdown IOS-UDID");
        expect(log).toContain("wsb stop");
        expect(log).toContain("tart stop ccc-mac");
        expect(log).not.toContain("IOS-STOPPED");
        expect(log).not.toContain("ccc-mac-stopped");
    });

    it("cleanup is idempotent and tolerates missing stop tools", () => {
        const cwd = "/project/admin-cleanup-idempotent-test";
        const { androidFile, iosFile, windowsFile, macosFile, otherOwnerFile } = setupFixture(cwd);

        const first = cleanupOwnerDevices(cwd);
        const second = cleanupOwnerDevices(cwd);

        expect(first.results.filter((result) => result.status === "stopped").map((result) => result.id).sort()).toEqual([
            "android-running",
            "ios-owned",
            "macos-owned",
            "windows-owned",
        ]);
        expect(second.results.every((result) => result.status === "skipped")).toBe(true);
        expect(readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:stopped"]);
        expect(readDeviceIds(iosFile)).toEqual(["ios-owned:stopped", "ios-stopped:stopped"]);
        expect(readDeviceIds(windowsFile)).toEqual(["windows-owned:stopped"]);
        expect(readDeviceIds(macosFile)).toEqual(["macos-owned:stopped", "macos-stopped:stopped"]);
        expect(readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("cleanup records failed stop commands but still marks owned devices stopped for teardown", () => {
        const cwd = "/project/admin-cleanup-failure-test";
        const { androidFile, windowsFile, otherOwnerFile } = setupFixture(cwd);
        const binDir = join(homeDir!, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        writeTool(binDir, "adb", "echo adb-failed >&2; exit 9");
        writeTool(binDir, "wsb", "echo wsb-failed >&2; exit 8");

        const cleanup = cleanupOwnerDevices(cwd);

        const android = cleanup.results.find((result) => result.id === "android-running");
        const windows = cleanup.results.find((result) => result.id === "windows-owned");
        expect(android?.commands[0]).toEqual(expect.objectContaining({ status: 9, stderr: expect.stringContaining("adb-failed") }));
        expect(windows?.commands[0]).toEqual(expect.objectContaining({ status: 8, stderr: expect.stringContaining("wsb-failed") }));
        expect(readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:stopped"]);
        expect(readDeviceIds(windowsFile)).toEqual(["windows-owned:stopped"]);
        expect(readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("bounds cleanup stop command execution with a timeout", () => {
        const cwd = "/project/admin-cleanup-timeout-test";
        const { androidFile, otherOwnerFile } = setupFixture(cwd);
        const binDir = join(homeDir!, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        writeTool(binDir, "adb", `"${process.execPath}" -e 'setTimeout(() => {}, 1000)'`);

        const cleanup = cleanupOwnerDevices(cwd, 50);

        const android = cleanup.results.find((result) => result.id === "android-running");
        expect(android?.commands[0]).toEqual(expect.objectContaining({
            status: null,
            stderr: expect.stringMatching(/ETIMEDOUT|timed out|Timeout/i),
        }));
        expect(readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:stopped"]);
        expect(readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("refuses to stop unknown devices from other owner namespaces", () => {
        const cwd = "/project/admin-foreign-stop-test";
        const { otherOwnerFile } = setupFixture(cwd);

        const result = stopOwnerDevice("android-foreign", cwd);

        expect(result.ok).toBe(false);
        expect(result.text).toContain("Device not found for owner");
        expect(readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("deletes only owned stopped devices and refuses running definitions", () => {
        const cwd = "/project/admin-delete-test";
        const { androidFile, otherOwnerFile } = setupFixture(cwd);

        const running = deleteOwnerDevice("android-running", cwd);
        const stopped = deleteOwnerDevice("android-owned", cwd);

        expect(running.ok).toBe(false);
        expect(running.text).toContain("Refusing to delete android-running while status is running");
        expect(stopped.ok).toBe(true);
        expect(readDeviceIds(androidFile)).toEqual(["android-running:running"]);
        expect(readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("prunes current-owner stopped definitions while preserving running and foreign devices", () => {
        const cwd = "/project/admin-prune-test";
        const { androidFile, iosFile, otherOwnerFile } = setupFixture(cwd);

        const result = pruneOwnerDevices(cwd);

        expect(result.ok).toBe(true);
        expect(result.text).toContain("pruned: android-owned  backend=android-emulator");
        expect(readDeviceIds(androidFile)).toEqual(["android-running:running"]);
        expect(readDeviceIds(iosFile)).toEqual(["ios-owned:booted"]);
        expect(readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });
});
