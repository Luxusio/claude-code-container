import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    deviceLabOwnerId,
    deleteOwnerDevice,
    formatDevicesBackends,
    formatDevicesDoctor,
    formatDevicesList,
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
