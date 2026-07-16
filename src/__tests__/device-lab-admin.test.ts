import { dirname, join } from "path";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    deviceLabAllOwnersSnapshot,
    deviceLabBenchHealth,
    deviceLabOwnerId,
    deviceLabOwnerIdentity,
    formatDevicesAllProjectsList,
    formatDevicesBackends,
    formatDevicesDoctor,
    formatDevicesList,
    formatDevicesStatus,
} from "../device-lab-admin.js";
import { deviceLabContainerName, deviceLabOwnerFromProjectMountPath, deviceLabProjectMountPath } from "../device-lab-owner.js";
import { createDeviceLabAdminTestFixture } from "./helpers/device-lab-admin-fixture.js";

describe("device-lab admin CLI formatters", () => {
    const fixture = createDeviceLabAdminTestFixture();

    afterEach(() => {
        vi.restoreAllMocks();
        fixture.cleanup();
    });

    it("formats owner-scoped device status without exposing other owners", () => {
        const cwd = "/project/admin-test";
        const { owner } = fixture.setupFixture(cwd);

        const output = formatDevicesStatus(cwd);

        expect(output).toContain(`owner: ${owner}`);
        expect(output).toContain("android-emulator: 2 device(s)");
        expect(output).toContain("android-device: 2 device(s)");
        expect(output).toContain("ios-simulator: 2 device(s)");
        expect(output).toContain("ios-device: 1 device(s)");
        expect(output).not.toContain("android-foreign");
    });

    it("derives owner identity from the CCC container name and project mount path", () => {
        const cwd = "/home/user/project-a";
        const identity = deviceLabOwnerIdentity(cwd);

        expect(identity.basis).toBe(`${deviceLabContainerName(cwd)}:${deviceLabProjectMountPath(cwd)}`);
        expect(identity.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(identity.ownerId).toBe(deviceLabOwnerId(cwd));
    });

    it("uses distinct owner namespaces for profiles and different worktree paths", () => {
        const cwd = "/home/user/project-a";
        const worktree = "/home/user/project-a-worktree";

        expect(deviceLabOwnerId(cwd, "work")).not.toBe(deviceLabOwnerId(cwd));
        expect(deviceLabOwnerId(cwd, "work")).not.toBe(deviceLabOwnerId(cwd, "lab-runner"));
        expect(deviceLabOwnerId(cwd, "work")).not.toBe(deviceLabOwnerId(worktree, "work"));
    });

    it("derives the same owner from a canonical container project mount", () => {
        const cwd = "/home/user/project-a";
        const mountPath = deviceLabProjectMountPath(cwd);

        expect(deviceLabOwnerFromProjectMountPath(mountPath)).toEqual(expect.objectContaining({
            ownerId: deviceLabOwnerId(cwd),
            ownerBasis: `${deviceLabContainerName(cwd)}:${mountPath}`,
            projectMountPath: mountPath,
        }));
        expect(deviceLabOwnerFromProjectMountPath(mountPath, "work")).toEqual(expect.objectContaining({
            ownerId: deviceLabOwnerId(cwd, "work"),
            profile: "work",
        }));
    });

    it("rejects non-canonical project mounts and profiles", () => {
        const mountPath = deviceLabProjectMountPath("/home/user/project-a");

        expect(deviceLabOwnerFromProjectMountPath("/home/user/project-a")).toBeNull();
        expect(deviceLabOwnerFromProjectMountPath(`${mountPath}/child`)).toBeNull();
        expect(deviceLabOwnerFromProjectMountPath(`${mountPath}/../foreign`)).toBeNull();
        expect(deviceLabOwnerFromProjectMountPath("/project/not-a-generated-project-id")).toBeNull();
        expect(deviceLabOwnerFromProjectMountPath(mountPath, "INVALID PROFILE")).toBeNull();
    });

    it("formats status using the requested profile owner namespace", () => {
        const cwd = "/project/admin-profile-test";
        const { owner } = fixture.setupFixture(cwd, "work");

        const output = formatDevicesStatus(cwd, "work");
        const defaultOutput = formatDevicesStatus(cwd);

        expect(output).toContain(`owner: ${owner}`);
        expect(output).toContain("android-emulator: 2 device(s)");
        expect(defaultOutput).not.toContain(`owner: ${owner}`);
        expect(defaultOutput).toContain("android-emulator: 0 device(s)");
    });

    it("lists current-owner device definitions grouped by backend", () => {
        const cwd = "/project/admin-list-test";
        fixture.setupFixture(cwd);

        const output = formatDevicesList(cwd);

        expect(output).toContain("android-emulator:");
        expect(output).toContain("android-device:");
        expect(output).toContain("android-owned  name=Pixel  status=stopped  platform=android");
        expect(output).toContain("android-running  name=Pixel Running  status=running  platform=android");
        expect(output).toContain("android-real  name=Real Pixel  status=attached  platform=android");
        expect(output).toContain("ios-owned  name=iPhone  status=booted  platform=ios");
        expect(output).toContain("ios-stopped  name=iPhone Stopped  status=stopped  platform=ios");
        expect(output).toContain("ios-device:");
        expect(output).toContain("ios-real  name=Real iPhone  status=attached  platform=ios");
        expect(output).toContain("windows-sandbox:");
        expect(output).not.toContain("android-foreign");
    });

    it("all-projects list reads every project namespace without mutating state", () => {
        const cwd = "/project/admin-list-all-test";
        const { owner, androidFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const beforeOwned = readFileSync(androidFile, "utf-8");
        const beforeForeign = readFileSync(otherOwnerFile, "utf-8");

        const snapshot = deviceLabAllOwnersSnapshot();
        const output = formatDevicesAllProjectsList();

        expect(snapshot.owners.map((entry) => entry.ownerId).sort()).toEqual(["other-owner", owner].sort());
        expect(output).toContain("=== CCC Devices: All Projects ===");
        expect(output).toContain(`project: ${owner}`);
        expect(output).toContain("project: other-owner");
        expect(output).toContain("android-running  name=Pixel Running  status=running  platform=android");
        expect(output).toContain("android-foreign  name=Foreign  status=running  platform=android");
        expect(readFileSync(androidFile, "utf-8")).toBe(beforeOwned);
        expect(readFileSync(otherOwnerFile, "utf-8")).toBe(beforeForeign);
    });

    it("reports backend prerequisites as diagnostics without requiring devices", () => {
        const cwd = "/project/admin-backends-test";
        fixture.setupFixture(cwd);

        const backends = formatDevicesBackends(cwd);
        const doctor = formatDevicesDoctor(cwd);

        expect(backends).toContain("android-emulator:");
        expect(backends).toContain("android-device:");
        expect(backends).toContain("ios-device:");
        expect(backends).toContain("state: ");
        expect(backends).toContain("stateExists: true");
        expect(backends).toContain("ownerResolution: host-broker-resolve");
        expect(backends).toContain("environmentRequired: false");
        expect(backends).not.toContain("ownerBasisEnv:");
        expect(backends).not.toContain("ownerBasisMatches:");
        expect(backends).not.toContain("warning: device-lab container wiring is incomplete");
        expect(backends).toContain("adb: missing");
        expect(backends).toContain("xcrun: missing");
        expect(doctor).toContain("Startup policy: lazy; these diagnostics do not start devices");
        expect(doctor).not.toContain("warning: device-lab container wiring is incomplete");
        expect(doctor).toContain("android-emulator: missing");
        expect(doctor).toContain("Lab bench health:");
        expect(doctor).toContain("android-device: SKIP - missing adb");
    });

    it("does not report container wiring warning for host CLI with shared state", () => {
        const cwd = "/project/admin-backends-host-test";
        fixture.setupFixture(cwd);
        const originalContainer = process.env.container;
        delete process.env.container;

        try {
            const backends = formatDevicesBackends(cwd);
            const doctor = formatDevicesDoctor(cwd);

            expect(backends).toContain("ownerResolution: host-broker-resolve");
            expect(backends).toContain("environmentRequired: false");
            expect(backends).not.toContain("ownerBasisEnv:");
            expect(backends).not.toContain("ownerBasisMatches:");
            expect(backends).not.toContain("warning: device-lab container wiring is incomplete");
            expect(doctor).not.toContain("warning: device-lab container wiring is incomplete");
        } finally {
            if (originalContainer === undefined) delete process.env.container;
            else process.env.container = originalContainer;
        }
    });

    it("omits stale-container wiring warning when state root is present", () => {
        const cwd = "/project/admin-backends-wired-test";
        fixture.setupFixture(cwd);

        const backends = formatDevicesBackends(cwd);

        expect(backends).toContain("stateExists: true");
        expect(backends).toContain("ownerResolution: host-broker-resolve");
        expect(backends).toContain("environmentRequired: false");
        expect(backends).not.toContain("ownerBasisEnv:");
        expect(backends).not.toContain("ownerBasisMatches:");
        expect(backends).not.toContain("warning: device-lab container wiring is incomplete");
    });

    it("treats macOS VM as available when any supported provider is present", () => {
        const cwd = "/project/admin-macos-provider-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "tart", "echo tart 2.24.0; exit 0");

        const backends = formatDevicesBackends(cwd);
        const macosSection = backends.slice(backends.indexOf("macos-vm:"));

        expect(macosSection).toContain("status: available");
        expect(macosSection).toContain(`tart: ${join(binDir, "tart")}`);
        expect(macosSection).toContain("vz: missing");
        expect(macosSection).toContain("utmctl: missing");
    });

    it("reports healthy current-owner physical bench leases and inventory", () => {
        const cwd = "/project/admin-bench-healthy-test";
        const { owner } = fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "echo 'List of devices attached'; echo 'R5CREAL123 device product:pixel'; echo 'R5CREAL456 device product:pixel'; exit 0");
        fixture.writeTool(binDir, "xcrun", "echo 'Real iPhone (17.5) (REAL-IOS-UDID)'; exit 0");

        const health = deviceLabBenchHealth(cwd);
        const doctor = formatDevicesDoctor(cwd);

        expect(health.ownerId).toBe(owner);
        expect(health.backends.find((backend) => backend.backend === "android-device")).toEqual(expect.objectContaining({
            status: "PASS",
            devices: expect.arrayContaining([
                expect.objectContaining({ deviceId: "android-real", status: "healthy", hardwareId: "R5CREAL123", inventoryState: "present" }),
                expect.objectContaining({ deviceId: "android-real-recording", status: "healthy", hardwareId: "R5CREAL456", inventoryState: "present" }),
            ]),
        }));
        expect(health.backends.find((backend) => backend.backend === "ios-device")).toEqual(expect.objectContaining({
            status: "PASS",
            devices: [expect.objectContaining({ deviceId: "ios-real", status: "healthy", hardwareId: "REAL-IOS-UDID", inventoryState: "present" })],
        }));
        expect(JSON.stringify(health)).not.toContain("product:pixel");
        expect(doctor).toContain("android-real: healthy hardware=R5CREAL123 inventory=present");
        expect(doctor).toContain("ios-real: healthy hardware=REAL-IOS-UDID inventory=present");
    });

    it("classifies missing, expired, foreign, mismatch, and inventory-missing bench leases", () => {
        const cwd = "/project/admin-bench-policy-test";
        const { owner, androidDeviceFile, iosDeviceFile } = fixture.setupFixture(cwd);
        const androidDevices = fixture.readDevices(androidDeviceFile);
        const iosDevices = fixture.readDevices(iosDeviceFile);
        writeFileSync(androidDeviceFile, JSON.stringify({
            devices: [
                ...androidDevices,
                { id: "android-missing-lease", name: "Missing Lease", status: "attached", platform: "android", physical: true, serial: "NOLEASE" },
                { id: "android-expired", name: "Expired Lease", status: "attached", platform: "android", physical: true, serial: "EXPIRED" },
                { id: "android-foreign", name: "Foreign Lease", status: "attached", platform: "android", physical: true, serial: "FOREIGN" },
                { id: "android-mismatch", name: "Mismatch Lease", status: "attached", platform: "android", physical: true, serial: "MISMATCH" },
                { id: "android-detached", name: "Detached Physical", status: "detached", platform: "android", physical: true, serial: "DETACHED" },
                { id: "android-attached-nonphysical", name: "Attached Nonphysical", status: "attached", platform: "android", serial: "NONPHYSICAL" },
            ],
        }));
        writeFileSync(iosDeviceFile, JSON.stringify({
            devices: [
                ...iosDevices,
                { id: "ios-no-inventory", name: "Inventory Missing", status: "attached", platform: "ios", physical: true, udid: "IOS-NOT-LISTED" },
            ],
        }));
        const locks = [
            ["android-device", "EXPIRED", { ownerId: owner, deviceId: "android-expired", expiresAt: "2000-01-01T00:00:00.000Z" }],
            ["android-device", "FOREIGN", { ownerId: "other-owner", deviceId: "android-foreign", expiresAt: new Date(Date.now() + 60000).toISOString(), secret: "foreign-secret" }],
            ["android-device", "MISMATCH", { ownerId: owner, deviceId: "different-device", expiresAt: new Date(Date.now() + 60000).toISOString() }],
            ["ios-device", "IOS-NOT-LISTED", { ownerId: owner, deviceId: "ios-no-inventory", expiresAt: new Date(Date.now() + 60000).toISOString() }],
        ] as const;
        for (const [stateKey, hardwareId, lease] of locks) {
            const lock = fixture.physicalLeaseLockPath(stateKey, hardwareId);
            mkdirSync(dirname(lock), { recursive: true });
            writeFileSync(lock, JSON.stringify({ backend: stateKey, hardwareId, ...lease }));
        }
        unlinkSync(fixture.physicalLeaseLockPath("android-device", "R5CREAL456"));
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "echo 'R5CREAL123 device'; echo 'NOLEASE device'; echo 'EXPIRED device'; echo 'FOREIGN device'; echo 'MISMATCH device'; echo 'UNOWNED-SERIAL device'; exit 0");
        fixture.writeTool(binDir, "xcrun", "echo 'Real iPhone (17.5) (REAL-IOS-UDID)'; echo 'Other iPhone (IOS-NOT-LISTED-SUFFIX)'; exit 0");

        const health = deviceLabBenchHealth(cwd);
        const allChecks = health.backends.flatMap((backend) => backend.devices);
        const healthJson = JSON.stringify(health);

        expect(allChecks).toEqual(expect.arrayContaining([
            expect.objectContaining({ deviceId: "android-real-recording", status: "missing-lease" }),
            expect.objectContaining({ deviceId: "android-missing-lease", status: "missing-lease" }),
            expect.objectContaining({ deviceId: "android-expired", status: "expired-lease" }),
            expect.objectContaining({ deviceId: "android-foreign", status: "foreign-lease" }),
            expect.objectContaining({ deviceId: "android-mismatch", status: "device-mismatch" }),
            expect.objectContaining({ deviceId: "ios-no-inventory", status: "inventory-missing" }),
        ]));
        expect(allChecks.map((check) => check.deviceId)).not.toContain("android-detached");
        expect(allChecks.map((check) => check.deviceId)).not.toContain("android-attached-nonphysical");
        expect(healthJson).not.toContain("other-owner");
        expect(healthJson).not.toContain("foreign-secret");
        expect(healthJson).not.toContain("UNOWNED-SERIAL");
        expect(healthJson).not.toContain("IOS-NOT-LISTED-SUFFIX");
        const doctor = formatDevicesDoctor(cwd);
        expect(doctor).toContain("android-expired: expired-lease hardware=EXPIRED");
        expect(doctor).toContain("android-foreign: foreign-lease hardware=FOREIGN");
        expect(doctor).toContain("ios-no-inventory: inventory-missing hardware=IOS-NOT-LISTED");
    });

    it("reports physical bench inventory command failures without mutating device state", () => {
        const cwd = "/project/admin-bench-command-failure-test";
        const { androidDeviceFile } = fixture.setupFixture(cwd);
        const before = readFileSync(androidDeviceFile, "utf-8");
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "echo 'UNOWNED-SERIAL device'; echo adb-broken-secret >&2; exit 7");

        const health = deviceLabBenchHealth(cwd);
        const healthJson = JSON.stringify(health);

        expect(health.backends.find((backend) => backend.backend === "android-device")).toEqual(expect.objectContaining({
            status: "FAIL",
            detail: "inventory command failed with status 7",
        }));
        expect(healthJson).not.toContain("UNOWNED-SERIAL");
        expect(healthJson).not.toContain("adb-broken-secret");
        const doctor = formatDevicesDoctor(cwd);
        expect(doctor).toContain("android-device: FAIL - inventory command failed with status 7");
        expect(doctor).not.toContain("UNOWNED-SERIAL");
        expect(doctor).not.toContain("adb-broken-secret");
        expect(readFileSync(androidDeviceFile, "utf-8")).toBe(before);
    });
});
