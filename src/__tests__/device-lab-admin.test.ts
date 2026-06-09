import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
        const otherOwnerDir = join(homeDir, ".ccc/devices/owners", "other-owner", "android");
        mkdirSync(androidDir, { recursive: true });
        mkdirSync(iosDir, { recursive: true });
        mkdirSync(otherOwnerDir, { recursive: true });
        const androidFile = join(androidDir, "devices.json");
        const iosFile = join(iosDir, "devices.json");
        const otherOwnerFile = join(otherOwnerDir, "devices.json");
        writeFileSync(androidFile, JSON.stringify({
            devices: [
                { id: "android-owned", name: "Pixel", status: "stopped", platform: "android" },
                { id: "android-running", name: "Pixel Running", status: "running", platform: "android", pid: 999999 },
            ],
        }));
        writeFileSync(iosFile, JSON.stringify({
            devices: [{ id: "ios-owned", name: "iPhone", status: "booted", platform: "ios" }],
        }));
        writeFileSync(otherOwnerFile, JSON.stringify({
            devices: [{ id: "android-foreign", name: "Foreign", status: "running", platform: "android" }],
        }));
        return { owner, androidFile, iosFile, otherOwnerFile };
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
        expect(output).toContain("ios-simulator: 1 device(s)");
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
