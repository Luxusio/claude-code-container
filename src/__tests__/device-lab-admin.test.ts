import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    deviceLabOwnerId,
    formatDevicesBackends,
    formatDevicesDoctor,
    formatDevicesList,
    formatDevicesStatus,
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
        writeFileSync(join(androidDir, "devices.json"), JSON.stringify({
            devices: [{ id: "android-owned", name: "Pixel", status: "stopped", platform: "android" }],
        }));
        writeFileSync(join(iosDir, "devices.json"), JSON.stringify({
            devices: [{ id: "ios-owned", name: "iPhone", status: "booted", platform: "ios" }],
        }));
        writeFileSync(join(otherOwnerDir, "devices.json"), JSON.stringify({
            devices: [{ id: "android-foreign", name: "Foreign", status: "running", platform: "android" }],
        }));
        return owner;
    }

    it("formats owner-scoped device status without exposing other owners", () => {
        const cwd = "/project/admin-test";
        const owner = setupFixture(cwd);

        const output = formatDevicesStatus(cwd);

        expect(output).toContain(`owner: ${owner}`);
        expect(output).toContain("android-emulator: 1 device(s)");
        expect(output).toContain("ios-simulator: 1 device(s)");
        expect(output).not.toContain("android-foreign");
    });

    it("lists current-owner device definitions grouped by backend", () => {
        const cwd = "/project/admin-list-test";
        setupFixture(cwd);

        const output = formatDevicesList(cwd);

        expect(output).toContain("android-emulator:");
        expect(output).toContain("android-owned  name=Pixel  status=stopped  platform=android");
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
});
