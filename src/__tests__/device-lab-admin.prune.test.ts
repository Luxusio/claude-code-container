import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DeviceLabProjectEnumerationError,
    deleteOwnerDevice,
    devicesCli,
    devicesCliAsync,
    formatDevicesAllProjectsList,
    pruneAllProjectDevices,
    pruneOwnerDevices,
    stopAllProjectDevices,
} from "../device-lab-admin.js";
import { createDeviceLabAdminTestFixture } from "./helpers/device-lab-admin-fixture.js";

describe("device-lab admin delete, prune, and CLI commands", () => {
    const fixture = createDeviceLabAdminTestFixture();

    afterEach(() => {
        vi.restoreAllMocks();
        fixture.cleanup();
    });

    it("deletes only owned stopped devices and refuses running definitions", () => {
        const cwd = "/project/admin-delete-test";
        const { androidFile, otherOwnerFile } = fixture.setupFixture(cwd);

        const running = deleteOwnerDevice("android-running", cwd);
        const stopped = deleteOwnerDevice("android-owned", cwd);

        expect(running.ok).toBe(false);
        expect(running.text).toContain("Refusing to delete android-running while status is running");
        expect(stopped.ok).toBe(true);
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-running:running"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("prunes current-owner stopped definitions while preserving running and foreign devices", () => {
        const cwd = "/project/admin-prune-test";
        const { androidFile, iosFile, otherOwnerFile } = fixture.setupFixture(cwd);

        const result = pruneOwnerDevices(cwd);

        expect(result.ok).toBe(true);
        expect(result.text).toContain("pruned: android-owned  backend=android-emulator");
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-running:running"]);
        expect(fixture.readDeviceIds(iosFile)).toEqual(["ios-owned:booted"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("prune --all-projects removes stopped and detached definitions across all projects only", () => {
        const cwd = "/project/admin-prune-all-test";
        const { androidFile, androidDeviceFile, iosFile, iosDeviceFile, windowsFile, macosFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const otherPhysicalDir = join(fixture.homeDir, ".ccc/devices/owners", "other-owner", "android-device");
        mkdirSync(otherPhysicalDir, { recursive: true });
        const otherPhysicalFile = join(otherPhysicalDir, "devices.json");
        writeFileSync(otherPhysicalFile, JSON.stringify({
            devices: [
                { id: "foreign-real-detached", name: "Foreign Real", status: "detached", platform: "android", physical: true, serial: "FOREIGN-REAL" },
                { id: "foreign-real-attached", name: "Foreign Attached", status: "attached", platform: "android", physical: true, serial: "FOREIGN-ATTACHED" },
            ],
        }));
        const matchingForeignLock = fixture.physicalLeaseLockPath("android-device", "FOREIGN-REAL");
        writeFileSync(matchingForeignLock, JSON.stringify({ backend: "android-device", hardwareId: "FOREIGN-REAL", ownerId: "other-owner", deviceId: "foreign-real-detached" }));

        const result = pruneAllProjectDevices();

        expect(result.ok).toBe(true);
        expect(result.text).toContain("projects: prune --all-projects");
        expect(result.text).toContain("project: other-owner");
        expect(result.text).toContain("pruned: android-owned  backend=android-emulator");
        expect(result.text).toContain("pruned: foreign-real-detached  backend=android-device");
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-running:running"]);
        expect(fixture.readDeviceIds(androidDeviceFile)).toEqual(["android-real:attached", "android-real-recording:attached"]);
        expect(fixture.readDeviceIds(iosFile)).toEqual(["ios-owned:booted"]);
        expect(fixture.readDeviceIds(iosDeviceFile)).toEqual(["ios-real:attached"]);
        expect(fixture.readDeviceIds(windowsFile)).toEqual(["windows-owned:running"]);
        expect(fixture.readDeviceIds(macosFile)).toEqual(["macos-owned:running"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
        expect(fixture.readDeviceIds(otherPhysicalFile)).toEqual(["foreign-real-attached:attached"]);
        expect(() => readFileSync(matchingForeignLock, "utf-8")).toThrow();
    });

    it("devices CLI exposes only the explicit all-projects commands", () => {
        const cwd = "/project/admin-cli-test";
        fixture.setupFixture(cwd);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(devicesCli(["list", "--all-projects"], cwd)).toBe(0);
        expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining("android-foreign"));
        expect(devicesCli(["prune", "--all-projects"], cwd)).toBe(0);
        expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining("projects: prune --all-projects"));
        expect(devicesCli(["list", "--all"], cwd)).toBe(1);
        expect(errorSpy).toHaveBeenLastCalledWith("Usage: ccc devices list [--all-projects]");
        expect(devicesCli(["admin", "list"], cwd)).toBe(1);
        expect(errorSpy).toHaveBeenLastCalledWith("Usage: ccc devices <status|list|create|start|stop|reboot|delete|snapshot|prune|backends|doctor|smoke|setup|broker>");
    });

    it("fails closed when the project namespace root is not a directory", async () => {
        const cwd = "/project/admin-invalid-project-root-test";
        fixture.setupFixture(cwd);
        const root = join(fixture.homeDir, ".ccc/devices/owners");
        rmSync(root, { recursive: true });
        writeFileSync(root, "invalid-project-root");
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(() => formatDevicesAllProjectsList()).toThrow(DeviceLabProjectEnumerationError);
        expect(devicesCli(["list", "--all-projects"], cwd)).toBe(1);
        expect(devicesCli(["prune", "--all-projects"], cwd)).toBe(1);
        expect(await devicesCliAsync(["stop", "--all-projects"], cwd)).toBe(1);
        expect(errorSpy).toHaveBeenCalledTimes(3);
        expect(errorSpy).toHaveBeenLastCalledWith("CCC device project enumeration failed: project-namespace-read-failed");
    });

    it("treats only an initially absent project namespace root as empty", () => {
        const cwd = "/project/admin-absent-project-root-test";
        fixture.setupFixture(cwd);
        const root = join(fixture.homeDir, ".ccc/devices/owners");
        rmSync(root, { recursive: true });
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

        expect(formatDevicesAllProjectsList()).toContain("(none)");
        expect(devicesCli(["list", "--all-projects"], cwd)).toBe(0);
        expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining("(none)"));
    });

    it("rejects a linked project namespace root before cross-project mutation", () => {
        const cwd = "/project/admin-linked-project-root-test";
        const { owner, androidFile } = fixture.setupFixture(cwd);
        const before = readFileSync(androidFile, "utf-8");
        const root = join(fixture.homeDir, ".ccc/devices/owners");
        const target = join(fixture.homeDir, ".ccc/devices/linked-owner-target");
        renameSync(root, target);
        symlinkSync(target, root, process.platform === "win32" ? "junction" : "dir");

        expect(() => stopAllProjectDevices()).toThrow(DeviceLabProjectEnumerationError);
        expect(() => pruneAllProjectDevices()).toThrow(DeviceLabProjectEnumerationError);
        expect(readFileSync(join(target, owner, "android/devices.json"), "utf-8")).toBe(before);
    });

    it("rejects a linked child project namespace without modifying its target", () => {
        const cwd = "/project/admin-linked-child-project-test";
        fixture.setupFixture(cwd);
        const root = join(fixture.homeDir, ".ccc/devices/owners");
        const target = join(fixture.homeDir, ".ccc/devices/external-owner-target");
        const targetFile = join(target, "android/devices.json");
        mkdirSync(join(target, "android"), { recursive: true });
        writeFileSync(targetFile, JSON.stringify({ devices: [{ id: "external-running", status: "running" }] }));
        const before = readFileSync(targetFile, "utf-8");
        symlinkSync(target, join(root, "linked-project"), process.platform === "win32" ? "junction" : "dir");

        expect(() => stopAllProjectDevices()).toThrow(DeviceLabProjectEnumerationError);
        expect(readFileSync(targetFile, "utf-8")).toBe(before);
    });
});
