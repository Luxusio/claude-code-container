import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    cleanupOwnerDevices,
    deleteOwnerDevice,
    devicesCli,
    devicesCliAsync,
    pruneAllProjectDevices,
    pruneOwnerDevices,
    stopAllProjectDevices,
    stopOwnerDevice,
} from "../device-lab-admin.js";
import { readDeviceRuntimeProcessIdentity } from "../device-lab-process-identity.js";
import { createDeviceLabAdminTestFixture } from "./helpers/device-lab-admin-fixture.js";

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function replaceStateFromLockedChild(mutationFile: string, stateFile: string, successor: unknown): void {
    const script = `
        import { hostname } from "os";
        import { unlinkSync, writeFileSync } from "fs";
        const [mutationFile, stateFile, successor] = process.argv.slice(1);
        writeFileSync(mutationFile, JSON.stringify({ token: "test-holder", pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }), { flag: "wx" });
        setTimeout(() => {
            writeFileSync(stateFile, successor);
            unlinkSync(mutationFile);
        }, 150);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, mutationFile, stateFile, JSON.stringify(successor)], {
        stdio: "ignore",
        windowsHide: true,
    });
    child.unref();
    const deadline = Date.now() + 3000;
    while (!existsSync(mutationFile)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for test mutation lock: ${mutationFile}`);
        Atomics.wait(sleeper, 0, 0, 10);
    }
}

function replacePhysicalLeaseFromLockedChild(
    leaseMutationFile: string,
    aggregateMutationFile: string,
    leaseFile: string,
    aggregateFile: string,
    successor: unknown,
): void {
    const script = `
        import { hostname } from "os";
        import { unlinkSync, writeFileSync } from "fs";
        const [leaseMutationFile, aggregateMutationFile, leaseFile, aggregateFile, successor] = process.argv.slice(1);
        const lock = (token) => JSON.stringify({ token, pid: process.pid, host: hostname(), createdAt: new Date().toISOString() });
        writeFileSync(leaseMutationFile, lock("lease-holder"), { flag: "wx" });
        setTimeout(() => {
            writeFileSync(aggregateMutationFile, lock("aggregate-holder"), { flag: "wx" });
            writeFileSync(leaseFile, successor);
            writeFileSync(aggregateFile, JSON.stringify({ leases: [JSON.parse(successor)] }));
            unlinkSync(aggregateMutationFile);
            unlinkSync(leaseMutationFile);
        }, 150);
    `;
    const child = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        script,
        leaseMutationFile,
        aggregateMutationFile,
        leaseFile,
        aggregateFile,
        JSON.stringify(successor),
    ], {
        stdio: "ignore",
        windowsHide: true,
    });
    child.unref();
    const deadline = Date.now() + 3000;
    while (!existsSync(leaseMutationFile)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for test lease mutation lock: ${leaseMutationFile}`);
        Atomics.wait(sleeper, 0, 0, 10);
    }
}

function holdLeaseThenOwnerMutationLock(leaseMutationFile: string, ownerMutationFile: string): void {
    const script = `
        import { hostname } from "os";
        import { mkdirSync, unlinkSync, writeFileSync } from "fs";
        import { dirname } from "path";
        const [leaseMutationFile, ownerMutationFile] = process.argv.slice(1);
        const lock = () => JSON.stringify({ token: Math.random().toString(16), pid: process.pid, host: hostname(), createdAt: new Date().toISOString() });
        const acquire = (file) => {
            mkdirSync(dirname(file), { recursive: true });
            while (true) {
                try { writeFileSync(file, lock(), { flag: "wx" }); return; }
                catch (error) { if (error?.code !== "EEXIST") throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
            }
        };
        acquire(leaseMutationFile);
        setTimeout(() => {
            acquire(ownerMutationFile);
            setTimeout(() => {
                unlinkSync(ownerMutationFile);
                unlinkSync(leaseMutationFile);
            }, 100);
        }, 100);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, leaseMutationFile, ownerMutationFile], {
        stdio: "ignore",
        windowsHide: true,
    });
    child.unref();
    const deadline = Date.now() + 3000;
    while (!existsSync(leaseMutationFile)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for test lease mutation lock: ${leaseMutationFile}`);
        Atomics.wait(sleeper, 0, 0, 10);
    }
}

describe("device-lab admin cleanup and stop commands", () => {
    const fixture = createDeviceLabAdminTestFixture();

    afterEach(() => {
        vi.restoreAllMocks();
        fixture.cleanup();
    });

    it("stops an owned device without mutating other owner devices", () => {
        const cwd = "/project/admin-stop-test";
        const { androidFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "exit 0");

        const result = stopOwnerDevice("android-running", cwd);

        expect(result.ok).toBe(true);
        expect(result.text).toContain("stopped: android-running");
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:stopped"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("waits for the shared device operation lock and refuses to stop a successor generation", () => {
        const cwd = "/project/admin-stop-operation-race-test";
        const { androidFile } = fixture.setupFixture(cwd);
        const operationKey = createHash("sha256").update("android-running").digest("hex").slice(0, 32);
        const operationLock = join(dirname(androidFile), "operations", `${operationKey}.lock`);
        mkdirSync(dirname(operationLock), { recursive: true });
        const successorState = {
            devices: [{ id: "android-running", name: "Successor", status: "running", platform: "android", serial: "emulator-5682", runtimeId: "successor-runtime" }],
        };
        replaceStateFromLockedChild(operationLock, androidFile, successorState);
        const binDir = join(fixture.homeDir, "bin");
        const commandLog = join(fixture.homeDir, "adb.log");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", `echo invoked >> "${commandLog}"; exit 0`);

        const result = stopOwnerDevice("android-running", cwd);

        expect(result.ok).toBe(false);
        expect(result.text).toContain("reason: owner-device-state-conflict");
        expect(existsSync(commandLog)).toBe(false);
        expect(JSON.parse(readFileSync(androidFile, "utf8"))).toEqual(successorState);
        expect(existsSync(operationLock)).toBe(false);
    });

    it("preserves a successor generation written while a direct stop command is running", () => {
        const cwd = "/project/admin-stop-cas-race-test";
        const { androidFile } = fixture.setupFixture(cwd);
        const successorState = {
            devices: [{ id: "android-running", name: "Successor", status: "running", platform: "android", serial: "emulator-5782", runtimeId: "successor-after-provider" }],
        };
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", `printf '%s' '${JSON.stringify(successorState)}' > "${androidFile}"; exit 0`);

        const result = stopOwnerDevice("android-running", cwd);

        expect(result.ok).toBe(false);
        expect(result.text).toContain("reason: owner-device-state-conflict");
        expect(JSON.parse(readFileSync(androidFile, "utf8"))).toEqual(successorState);
    });

    it("preserves a same-id successor written while provider deletion is running", () => {
        const cwd = "/project/admin-delete-cas-race-test";
        const { macosFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(macosFile).map((device) => device.id === "macos-stopped"
            ? { ...device, snapshots: [{ provider: "tart", providerInstance: "ccc-mac-stopped-snapshot" }] }
            : device);
        writeFileSync(macosFile, JSON.stringify({ devices }));
        const successorState = {
            devices: [{ id: "macos-stopped", name: "Successor", status: "stopped", platform: "macos", provider: "tart", providerInstance: "ccc-successor", runtimeId: "successor-delete" }],
        };
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "tart", `printf '%s' '${JSON.stringify(successorState)}' > "${macosFile}"; exit 0`);

        const result = deleteOwnerDevice("macos-stopped", cwd);

        expect(result.ok).toBe(false);
        expect(result.text).toContain("reason: owner-device-state-conflict");
        expect(JSON.parse(readFileSync(macosFile, "utf8"))).toEqual(successorState);
    });

    it("preserves a live broker-owned Appium runtime during direct cleanup", () => {
        const cwd = "/project/admin-live-appium-cleanup-test";
        const { androidFile } = fixture.setupFixture(cwd);
        const processIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!processIdentity) throw new Error("current process identity unavailable");
        const devices = fixture.readDevices(androidFile).map((device) => device.id === "android-running" ? {
            ...device,
            appium: {
                authority: "host-broker",
                processOwner: "host-broker",
                startedBy: "broker.appium.start",
                runtimeId: "live-admin-appium",
                serverPid: process.pid,
                processIdentity,
            },
        } : device);
        writeFileSync(androidFile, JSON.stringify({ devices }));
        const before = readFileSync(androidFile, "utf8");
        const binDir = join(fixture.homeDir, "bin");
        const commandLog = join(fixture.homeDir, "adb.log");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", `echo "$*" >> "${commandLog}"; exit 0`);

        const result = cleanupOwnerDevices(cwd);
        const live = result.results.find((candidate) => candidate.id === "android-running");

        expect(live).toEqual(expect.objectContaining({ status: "failed", reason: "appium-runtime-active" }));
        expect(readFileSync(androidFile, "utf8")).toBe(before);
        expect(existsSync(commandLog) ? readFileSync(commandLog, "utf8") : "").not.toContain("emulator-5582");
    });

    it("preserves direct-provider Appium metadata and its physical lease when signaling fails", () => {
        const cwd = "/project/admin-direct-appium-signal-failure-test";
        const { iosDeviceFile } = fixture.setupFixture(cwd);
        const processIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!processIdentity) throw new Error("current process identity unavailable");
        const devices = fixture.readDevices(iosDeviceFile).map((device) => device.id === "ios-real" ? {
            ...device,
            appium: {
                authority: "direct-provider",
                processOwner: "device-lab-mcp",
                startedBy: "direct-provider",
                runtimeId: "direct-appium-signal-failure",
                serverPid: process.pid,
                processIdentity,
            },
        } : device);
        writeFileSync(iosDeviceFile, JSON.stringify({ devices }));
        const leaseFile = fixture.physicalLeaseLockPath("ios-device", "REAL-IOS-UDID");
        const before = readFileSync(iosDeviceFile, "utf8");
        vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
            if (pid === process.pid && signal === "SIGTERM") {
                const error = new Error("signal denied") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
            }
            return true;
        });

        const result = cleanupOwnerDevices(cwd, 25);

        expect(result.results.find((candidate) => candidate.id === "ios-real")).toEqual(expect.objectContaining({
            status: "failed",
            reason: "appium-process-signal-failed",
        }));
        expect(readFileSync(iosDeviceFile, "utf8")).toBe(before);
        expect(existsSync(leaseFile)).toBe(true);
    });

    it("preserves direct recording metadata and its physical lease while the owned process is still alive", () => {
        const cwd = "/project/admin-direct-recording-still-alive-test";
        const { androidDeviceFile } = fixture.setupFixture(cwd);
        const processIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!processIdentity) throw new Error("current process identity unavailable");
        const devices = fixture.readDevices(androidDeviceFile).map((device) => device.id === "android-real-recording" ? {
            ...device,
            recording: {
                active: true,
                runtimeId: "direct-recording-still-alive",
                pid: process.pid,
                processIdentity,
                provider: "adb-screenrecord",
            },
        } : device);
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL456");
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "exit 0");
        vi.spyOn(process, "kill").mockImplementation(() => true);

        const result = cleanupOwnerDevices(cwd, 25);

        expect(result.results.find((candidate) => candidate.id === "android-real-recording")).toEqual(expect.objectContaining({
            status: "failed",
            reason: "recording-process-still-active",
        }));
        expect(fixture.readDevices(androidDeviceFile).find((device) => device.id === "android-real-recording")?.recording).toEqual(expect.objectContaining({
            runtimeId: "direct-recording-still-alive",
        }));
        expect(existsSync(leaseFile)).toBe(true);
    });

    it("preserves a concurrent successor physical state and lease during cleanup finalization", () => {
        const cwd = "/project/admin-physical-cleanup-successor-test";
        const { owner, androidDeviceFile } = fixture.setupFixture(cwd);
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL456");
        const successorDevice = {
            id: "android-real-recording",
            name: "Successor Recording",
            status: "attached",
            platform: "android",
            physical: true,
            serial: "R5CREAL456",
            leaseClaimId: "successor-claim",
            leaseClaimNonce: "successor-nonce",
            recording: { active: true, runtimeId: "successor-recording" },
        };
        const successorState = { devices: [successorDevice] };
        const successorLease = {
            backend: "android-device",
            hardwareId: "R5CREAL456",
            ownerId: owner,
            deviceId: "android-real-recording",
            claimId: "successor-claim",
            claimNonce: "successor-nonce",
        };
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", [
            `printf '%s' '${JSON.stringify(successorState)}' > "${androidDeviceFile}"`,
            `printf '%s' '${JSON.stringify(successorLease)}' > "${leaseFile}"`,
            "exit 0",
        ].join("; "));

        const result = stopOwnerDevice("android-real-recording", cwd);

        expect(result.ok).toBe(false);
        expect(result.text).toContain("reason: owner-device-state-conflict");
        expect(JSON.parse(readFileSync(androidDeviceFile, "utf8"))).toEqual(successorState);
        expect(JSON.parse(readFileSync(leaseFile, "utf8"))).toEqual(successorLease);
    });

    it("fails closed instead of pruning a malformed owner state file", () => {
        const cwd = "/project/admin-malformed-state-test";
        const { androidFile } = fixture.setupFixture(cwd);
        const malformed = JSON.stringify({ devices: [{ id: "same", status: "stopped" }, { id: "same", status: "stopped" }] });
        writeFileSync(androidFile, malformed);

        expect(() => pruneOwnerDevices(cwd)).toThrow("owner-devices-state-invalid");
        expect(readFileSync(androidFile, "utf8")).toBe(malformed);
    });

    it("explicit stop preserves active state when the backend stop command fails", () => {
        const cwd = "/project/admin-stop-failure-test";
        const { androidFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "echo stop-failed >&2; exit 9");

        const result = stopOwnerDevice("android-running", cwd);

        expect(result.ok).toBe(false);
        expect(result.text).toContain("failed: android-running");
        expect(result.text).toContain("command:");
        expect(result.text).toContain("-> 9");
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:running"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("cleans up running current-owner devices across all backends and preserves stopped and foreign devices", () => {
        const cwd = "/project/admin-cleanup-all-test";
        const { owner, androidFile, androidDeviceFile, iosFile, iosDeviceFile, windowsFile, macosFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        const logPath = join(fixture.homeDir, "cleanup.log");
        const windowsLock = join(fixture.homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
        mkdirSync(binDir, { recursive: true });
        mkdirSync(dirname(windowsLock), { recursive: true });
        writeFileSync(windowsLock, JSON.stringify({
            provider: "windows-sandbox",
            ownerId: owner,
            deviceId: "windows-owned",
            sandboxId: "12345678-1234-4234-9234-1234567890ab",
        }));
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", `echo "adb $*" >> "${logPath}"; exit 0`);
        fixture.writeTool(binDir, "xcrun", `echo "xcrun $*" >> "${logPath}"; exit 0`);
        fixture.writeTool(binDir, "wsb", `echo "wsb $*" >> "${logPath}"; exit 0`);
        fixture.writeTool(binDir, "tart", `echo "tart $*" >> "${logPath}"; exit 0`);

        const cleanup = cleanupOwnerDevices(cwd);

        expect(cleanup.results.filter((result) => result.status === "stopped").map((result) => result.id).sort()).toEqual([
            "android-real",
            "android-real-recording",
            "android-running",
            "ios-owned",
            "ios-real",
            "macos-owned",
            "windows-owned",
        ]);
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:stopped"]);
        expect(fixture.readDeviceIds(androidDeviceFile)).toEqual(["android-real:detached", "android-real-recording:detached"]);
        expect(fixture.readDeviceIds(iosFile)).toEqual(["ios-owned:stopped", "ios-stopped:stopped"]);
        expect(fixture.readDeviceIds(iosDeviceFile)).toEqual(["ios-real:detached"]);
        expect(fixture.readDeviceIds(windowsFile)).toEqual(["windows-owned:stopped"]);
        expect(fixture.readDeviceIds(macosFile)).toEqual(["macos-owned:stopped", "macos-stopped:stopped"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("adb -s emulator-5582 emu kill");
        expect(log).toContain("adb -s R5CREAL456 shell pkill -2 screenrecord");
        expect(log).toContain("xcrun simctl shutdown IOS-UDID");
        expect(log).not.toContain("xcrun simctl shutdown REAL-IOS-UDID");
        expect(log).not.toContain("adb -s R5CREAL123 emu kill");
        expect(log).not.toContain("adb -s R5CREAL456 emu kill");
        expect(log).toContain("wsb stop --id 12345678-1234-4234-9234-1234567890ab");
        expect(log).toContain("tart stop ccc-mac");
        expect(log).not.toContain("IOS-STOPPED");
        expect(log).not.toContain("ccc-mac-stopped");
        expect(() => readFileSync(fixture.physicalLeaseLockPath("android-device", "R5CREAL123"), "utf-8")).toThrow();
        expect(() => readFileSync(fixture.physicalLeaseLockPath("android-device", "R5CREAL456"), "utf-8")).toThrow();
        expect(() => readFileSync(fixture.physicalLeaseLockPath("ios-device", "REAL-IOS-UDID"), "utf-8")).toThrow();
        expect(() => readFileSync(windowsLock, "utf-8")).toThrow();
        expect(readFileSync(fixture.physicalLeaseLockPath("android-device", "FOREIGN-REAL"), "utf-8")).toContain("other-owner");
    });

    it("does not delete a successor physical lease installed while admin waits for the shared lock", () => {
        const cwd = "/project/admin-physical-lease-race-test";
        const { androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        devices[0].status = "detached";
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        const mutationFile = leaseFile.replace(/\.json$/, ".mutation.lock");
        const successor = {
            backend: "android-device",
            hardwareId: "R5CREAL123",
            ownerId: "successor-owner",
            deviceId: "successor-device",
            claimId: "successor-claim",
        };
        replaceStateFromLockedChild(mutationFile, leaseFile, successor);

        const result = deleteOwnerDevice("android-real", cwd);

        expect(result.ok).toBe(true);
        expect(JSON.parse(readFileSync(leaseFile, "utf-8"))).toEqual(successor);
        expect(existsSync(mutationFile)).toBe(false);
    });

    it("does not delete a same-owner same-device successor physical lease generation", () => {
        const cwd = "/project/admin-physical-lease-generation-race-test";
        const { owner, androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        devices[0] = { ...devices[0], status: "detached", leaseClaimId: "previous-claim", leaseClaimNonce: "previous-nonce" };
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        writeFileSync(leaseFile, JSON.stringify({
            backend: "android-device",
            hardwareId: "R5CREAL123",
            ownerId: owner,
            deviceId: "android-real",
            claimId: "previous-claim",
            claimNonce: "previous-nonce",
        }));
        const mutationFile = leaseFile.replace(/\.json$/, ".mutation.lock");
        const successor = {
            backend: "android-device",
            hardwareId: "R5CREAL123",
            ownerId: owner,
            deviceId: "android-real",
            claimId: "successor-claim",
            claimNonce: "successor-nonce",
        };
        replaceStateFromLockedChild(mutationFile, leaseFile, successor);

        const result = deleteOwnerDevice("android-real", cwd);

        expect(result.ok).toBe(true);
        expect(JSON.parse(readFileSync(leaseFile, "utf-8"))).toEqual(successor);
        expect(existsSync(mutationFile)).toBe(false);
    });

    it("removes matching physical lease lock and aggregate entry when deleting a device", () => {
        const cwd = "/project/admin-physical-lease-aggregate-delete-test";
        const { owner, androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        devices[0] = { ...devices[0], status: "detached", leaseClaimId: "aggregate-claim", leaseClaimNonce: "aggregate-nonce" };
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const lease = {
            backend: "android-device",
            hardwareId: "R5CREAL123",
            ownerId: owner,
            deviceId: "android-real",
            claimId: "aggregate-claim",
            claimNonce: "aggregate-nonce",
        };
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        const aggregateFile = join(fixture.homeDir, ".ccc/devices/physical-leases/android-device.json");
        writeFileSync(leaseFile, JSON.stringify(lease));
        writeFileSync(aggregateFile, JSON.stringify({ leases: [lease] }));

        const result = deleteOwnerDevice("android-real", cwd);

        expect(result.ok, result.text).toBe(true);
        expect(existsSync(leaseFile)).toBe(false);
        expect(JSON.parse(readFileSync(aggregateFile, "utf-8"))).toEqual({ leases: [] });
    });

    it("removes matching physical lease lock and aggregate entry when stopping a device", () => {
        const cwd = "/project/admin-physical-lease-aggregate-stop-test";
        const { owner, androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        const current = devices.find((device) => device.id === "android-real-recording")!;
        current.leaseClaimId = "stop-claim";
        current.leaseClaimNonce = "stop-nonce";
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const lease = {
            backend: "android-device",
            hardwareId: "R5CREAL456",
            ownerId: owner,
            deviceId: "android-real-recording",
            claimId: "stop-claim",
            claimNonce: "stop-nonce",
        };
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL456");
        const aggregateFile = join(fixture.homeDir, ".ccc/devices/physical-leases/android-device.json");
        writeFileSync(leaseFile, JSON.stringify(lease));
        writeFileSync(aggregateFile, JSON.stringify({ leases: [lease] }));
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "exit 0");

        const result = stopOwnerDevice("android-real-recording", cwd);

        expect(result.ok, result.text).toBe(true);
        expect(existsSync(leaseFile)).toBe(false);
        expect(JSON.parse(readFileSync(aggregateFile, "utf-8"))).toEqual({ leases: [] });
        expect(fixture.readDevices(androidDeviceFile).find((device) => device.id === "android-real-recording")?.status).toBe("detached");
    });

    it("removes matching physical lease lock and aggregate entry when pruning a device", () => {
        const cwd = "/project/admin-physical-lease-aggregate-prune-test";
        const { owner, androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        const current = devices.find((device) => device.id === "android-real")!;
        current.status = "detached";
        current.leaseClaimId = "prune-claim";
        current.leaseClaimNonce = "prune-nonce";
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const lease = {
            backend: "android-device",
            hardwareId: "R5CREAL123",
            ownerId: owner,
            deviceId: "android-real",
            claimId: "prune-claim",
            claimNonce: "prune-nonce",
        };
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        const aggregateFile = join(fixture.homeDir, ".ccc/devices/physical-leases/android-device.json");
        writeFileSync(leaseFile, JSON.stringify(lease));
        writeFileSync(aggregateFile, JSON.stringify({ leases: [lease] }));

        const result = pruneOwnerDevices(cwd);

        expect(result.ok, result.text).toBe(true);
        expect(existsSync(leaseFile)).toBe(false);
        expect(JSON.parse(readFileSync(aggregateFile, "utf-8"))).toEqual({ leases: [] });
        expect(fixture.readDevices(androidDeviceFile).find((device) => device.id === "android-real")).toBeUndefined();
    });

    it("removes a stale matching aggregate lease without deleting a successor lock", () => {
        const cwd = "/project/admin-physical-lease-aggregate-stale-prune-test";
        const { owner, androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        const current = devices.find((device) => device.id === "android-real")!;
        current.status = "detached";
        current.leaseClaimId = "stale-claim";
        current.leaseClaimNonce = "stale-nonce";
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const stale = {
            backend: "android-device",
            hardwareId: "R5CREAL123",
            ownerId: owner,
            deviceId: "android-real",
            claimId: "stale-claim",
            claimNonce: "stale-nonce",
        };
        const successor = { ...stale, claimId: "successor-claim", claimNonce: "successor-nonce" };
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        const aggregateFile = join(fixture.homeDir, ".ccc/devices/physical-leases/android-device.json");
        writeFileSync(leaseFile, JSON.stringify(successor));
        writeFileSync(aggregateFile, JSON.stringify({ leases: [stale] }));

        const result = pruneOwnerDevices(cwd);

        expect(result.ok, result.text).toBe(true);
        expect(JSON.parse(readFileSync(leaseFile, "utf-8"))).toEqual(successor);
        expect(JSON.parse(readFileSync(aggregateFile, "utf-8"))).toEqual({ leases: [] });
        expect(fixture.readDevices(androidDeviceFile).find((device) => device.id === "android-real")).toBeUndefined();
    });

    it("rolls back both physical lease stores when prune loses the owner-state generation", () => {
        const cwd = "/project/admin-physical-lease-prune-rollback-test";
        const { owner, androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        const current = devices.find((device) => device.id === "android-real")!;
        current.status = "detached";
        current.leaseClaimId = "rollback-claim";
        current.leaseClaimNonce = "rollback-nonce";
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const lease = {
            backend: "android-device",
            hardwareId: "R5CREAL123",
            ownerId: owner,
            deviceId: "android-real",
            claimId: "rollback-claim",
            claimNonce: "rollback-nonce",
        };
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        const aggregateFile = join(fixture.homeDir, ".ccc/devices/physical-leases/android-device.json");
        writeFileSync(leaseFile, JSON.stringify(lease));
        writeFileSync(aggregateFile, JSON.stringify({ leases: [lease] }));
        const successor = { ...current, status: "attached", updatedAt: "successor" };
        replaceStateFromLockedChild(join(dirname(androidDeviceFile), "devices.mutation.lock"), androidDeviceFile, { devices: devices.map((device) => device.id === current.id ? successor : device) });

        const result = pruneOwnerDevices(cwd);

        expect(result.ok).toBe(true);
        expect(result.text).not.toContain("pruned: android-real  backend=android-device");
        expect(fixture.readDevices(androidDeviceFile).find((device) => device.id === "android-real")).toEqual(successor);
        expect(JSON.parse(readFileSync(leaseFile, "utf-8"))).toEqual(lease);
        expect(JSON.parse(readFileSync(aggregateFile, "utf-8"))).toEqual({ leases: [lease] });
    });

    it("preserves a concurrent successor in both physical lease stores", () => {
        const cwd = "/project/admin-physical-lease-aggregate-successor-test";
        const { owner, androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        devices[0] = { ...devices[0], status: "detached", leaseClaimId: "previous-claim", leaseClaimNonce: "previous-nonce" };
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const previous = {
            backend: "android-device",
            hardwareId: "R5CREAL123",
            ownerId: owner,
            deviceId: "android-real",
            claimId: "previous-claim",
            claimNonce: "previous-nonce",
        };
        const successor = { ...previous, claimId: "successor-claim", claimNonce: "successor-nonce" };
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        const leaseMutationFile = leaseFile.replace(/\.json$/, ".mutation.lock");
        const aggregateFile = join(fixture.homeDir, ".ccc/devices/physical-leases/android-device.json");
        const aggregateMutationFile = aggregateFile.replace(/\.json$/, ".mutation.lock");
        writeFileSync(leaseFile, JSON.stringify(previous));
        writeFileSync(aggregateFile, JSON.stringify({ leases: [previous] }));
        replacePhysicalLeaseFromLockedChild(leaseMutationFile, aggregateMutationFile, leaseFile, aggregateFile, successor);

        const result = deleteOwnerDevice("android-real", cwd);

        expect(result.ok).toBe(true);
        expect(JSON.parse(readFileSync(leaseFile, "utf-8"))).toEqual(successor);
        expect(JSON.parse(readFileSync(aggregateFile, "utf-8"))).toEqual({ leases: [successor] });
        expect(existsSync(leaseMutationFile)).toBe(false);
        expect(existsSync(aggregateMutationFile)).toBe(false);
    });

    it("fails closed and preserves owner and lock state when the physical lease aggregate is invalid", () => {
        const cwd = "/project/admin-physical-lease-invalid-aggregate-test";
        const { androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        devices[0].status = "detached";
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        const leaseBefore = readFileSync(leaseFile, "utf-8");
        const aggregateFile = join(fixture.homeDir, ".ccc/devices/physical-leases/android-device.json");
        writeFileSync(aggregateFile, "{invalid-aggregate");

        const result = deleteOwnerDevice("android-real", cwd);

        expect(result.ok).toBe(false);
        expect(result.text).toContain("reason: physical-lease-release-failed");
        expect(fixture.readDevices(androidDeviceFile).find((device) => device.id === "android-real")).toEqual(devices[0]);
        expect(readFileSync(leaseFile, "utf-8")).toBe(leaseBefore);
        expect(readFileSync(aggregateFile, "utf-8")).toBe("{invalid-aggregate");
    });

    it("prunes physical devices without inverting lease and owner-state locks", () => {
        const cwd = "/project/admin-physical-prune-lock-order-test";
        const { androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        devices[0].status = "detached";
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        const leaseMutationFile = leaseFile.replace(/\.json$/, ".mutation.lock");
        const ownerMutationFile = join(dirname(androidDeviceFile), "devices.mutation.lock");
        holdLeaseThenOwnerMutationLock(leaseMutationFile, ownerMutationFile);

        const startedAt = Date.now();
        const result = pruneAllProjectDevices();

        expect(Date.now() - startedAt).toBeLessThan(3000);
        expect(result.ok).toBe(true);
        expect(result.text).toContain("pruned: android-real");
        expect(fixture.readDevices(androidDeviceFile).find((device) => device.id === "android-real")).toBeUndefined();
        expect(existsSync(leaseFile)).toBe(false);
        expect(existsSync(leaseMutationFile)).toBe(false);
        expect(existsSync(ownerMutationFile)).toBe(false);
    });

    it("does not delete a successor Windows Sandbox claim installed while admin waits for the shared lock", () => {
        const cwd = "/project/admin-windows-lock-race-test";
        const { owner, windowsFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(windowsFile);
        devices[0].status = "stopped";
        writeFileSync(windowsFile, JSON.stringify({ devices }));
        const lockFile = join(fixture.homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
        const mutationFile = join(fixture.homeDir, ".ccc/devices/host-locks/windows-sandbox.mutation.lock");
        mkdirSync(dirname(lockFile), { recursive: true });
        writeFileSync(lockFile, JSON.stringify({
            provider: "windows-sandbox",
            ownerId: owner,
            deviceId: "windows-owned",
            sandboxId: "12345678-1234-4234-9234-1234567890ab",
        }));
        const successor = {
            provider: "windows-sandbox",
            ownerId: "successor-owner",
            deviceId: "successor-device",
            sandboxId: "successor-sandbox",
            claimId: "successor-claim",
        };
        replaceStateFromLockedChild(mutationFile, lockFile, successor);

        const result = deleteOwnerDevice("windows-owned", cwd);

        expect(result.ok).toBe(true);
        expect(JSON.parse(readFileSync(lockFile, "utf-8"))).toEqual(successor);
        expect(existsSync(mutationFile)).toBe(false);
    });

    it("preserves a concurrently added owner device while admin deletes another device", () => {
        const cwd = "/project/admin-owner-state-race-test";
        const { owner, androidFile } = fixture.setupFixture(cwd);
        const mutationFile = join(dirname(androidFile), "devices.mutation.lock");
        const successorState = {
            devices: [
                { id: "android-owned", name: "Pixel", status: "stopped", platform: "android", serial: "emulator-5554" },
                { id: "concurrent-device", name: "Concurrent", status: "stopped", platform: "android", ownerId: owner },
            ],
        };
        replaceStateFromLockedChild(mutationFile, androidFile, successorState);

        const result = deleteOwnerDevice("android-owned", cwd);

        expect(result.ok).toBe(true);
        expect(fixture.readDeviceIds(androidFile)).toEqual(["concurrent-device:stopped"]);
        expect(existsSync(mutationFile)).toBe(false);
    });

    it("cleans stale process metadata without signaling unverified legacy pids", () => {
        const cwd = "/project/admin-cleanup-stale-metadata-test";
        const { androidFile, iosFile, windowsFile, macosFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const android = fixture.readDevices(androidFile);
        android.push({
            id: "android-stale-recording",
            name: "Pixel Stale Recording",
            status: "stopped",
            platform: "android",
            serial: "emulator-5590",
            pid: 10101,
            appium: { serverPid: 20202 },
            recording: { active: true, pid: 30303, provider: "adb-screenrecord" },
        });
        writeFileSync(androidFile, JSON.stringify({ devices: android }));
        const ios = fixture.readDevices(iosFile);
        ios.push({
            id: "ios-stale-recording",
            name: "iPhone Stale Recording",
            status: "stopped",
            platform: "ios",
            udid: "IOS-STALE",
            appium: { serverPid: 40404 },
            recording: { active: true, pid: 50505, provider: "simctl-recordVideo" },
        });
        writeFileSync(iosFile, JSON.stringify({ devices: ios }));
        const windows = fixture.readDevices(windowsFile);
        windows.push({
            id: "windows-stale-pid",
            name: "Win Stale Pid",
            status: "stopped",
            platform: "windows",
            pid: 60606,
        });
        writeFileSync(windowsFile, JSON.stringify({ devices: windows }));
        const macos = fixture.readDevices(macosFile);
        macos.push({
            id: "macos-stale-pid",
            name: "Mac Stale Pid",
            status: "stopped",
            platform: "macos",
            provider: "tart",
            providerInstance: "ccc-mac-stale",
            pid: 70707,
        });
        writeFileSync(macosFile, JSON.stringify({ devices: macos }));
        const binDir = join(fixture.homeDir, "bin");
        const logPath = join(fixture.homeDir, "cleanup-stale.log");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", `echo "adb $*" >> "${logPath}"; exit 0`);
        fixture.writeTool(binDir, "xcrun", `echo "xcrun $*" >> "${logPath}"; exit 0`);
        fixture.writeTool(binDir, "wsb", `echo "wsb $*" >> "${logPath}"; exit 0`);
        fixture.writeTool(binDir, "tart", `echo "tart $*" >> "${logPath}"; exit 0`);
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

        const cleanup = cleanupOwnerDevices(cwd);

        expect(cleanup.results.filter((result) => result.status === "stopped").map((result) => result.id)).toEqual(expect.arrayContaining([
            "android-running",
            "android-stale-recording",
            "ios-owned",
            "ios-stale-recording",
            "macos-stale-pid",
            "macos-owned",
            "windows-stale-pid",
            "windows-owned",
        ]));
        expect(killSpy).not.toHaveBeenCalled();

        const androidAfter = fixture.readDevices(androidFile);
        expect(androidAfter.find((device) => device.id === "android-stale-recording")).toEqual(expect.objectContaining({
            status: "stopped",
            pid: null,
            appium: null,
            recording: null,
        }));
        const iosAfter = fixture.readDevices(iosFile);
        expect(iosAfter.find((device) => device.id === "ios-stale-recording")).toEqual(expect.objectContaining({
            status: "stopped",
            appium: null,
            recording: null,
        }));
        expect(fixture.readDevices(windowsFile).find((device) => device.id === "windows-stale-pid")).toEqual(expect.objectContaining({
            status: "stopped",
            pid: null,
        }));
        expect(fixture.readDevices(macosFile).find((device) => device.id === "macos-stale-pid")).toEqual(expect.objectContaining({
            status: "stopped",
            pid: null,
        }));
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("adb -s emulator-5590 shell pkill -2 screenrecord");
        expect(log).not.toContain("adb -s emulator-5590 emu kill");
        expect(log).not.toContain("xcrun simctl shutdown IOS-STALE");
        expect(log).not.toContain("tart stop ccc-mac-stale");
    });

    it("clears volatile metadata without signaling invalid or identity-free pids", () => {
        const cwd = "/project/admin-cleanup-stale-pid-values-test";
        const { androidFile } = fixture.setupFixture(cwd);
        const android = fixture.readDevices(androidFile);
        android.push({
            id: "android-invalid-pids",
            name: "Pixel Invalid Pids",
            status: "stopped",
            platform: "android",
            serial: "emulator-5594",
            pid: 0,
            appium: { serverPid: "not-a-number" },
            recording: { active: true, pid: 80808, provider: "adb-screenrecord" },
        });
        writeFileSync(androidFile, JSON.stringify({ devices: android }));
        const binDir = join(fixture.homeDir, "bin");
        const logPath = join(fixture.homeDir, "cleanup-invalid-pids.log");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", `echo "adb $*" >> "${logPath}"; exit 0`);
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
            throw new Error("stale pid");
        });

        const cleanup = cleanupOwnerDevices(cwd);

        expect(cleanup.results.find((result) => result.id === "android-invalid-pids")?.status).toBe("stopped");
        expect(killSpy).not.toHaveBeenCalled();
        expect(fixture.readDevices(androidFile).find((device) => device.id === "android-invalid-pids")).toEqual(expect.objectContaining({
            status: "stopped",
            pid: null,
            appium: null,
            recording: null,
        }));
        expect(readFileSync(logPath, "utf-8")).toContain("adb -s emulator-5594 shell pkill -2 screenrecord");
    });

    it("cleanup preserves active state for retry when lifecycle stop tools are missing", () => {
        const cwd = "/project/admin-cleanup-idempotent-test";
        const { androidFile, androidDeviceFile, iosFile, iosDeviceFile, windowsFile, macosFile, otherOwnerFile } = fixture.setupFixture(cwd);

        const first = cleanupOwnerDevices(cwd);
        const second = cleanupOwnerDevices(cwd);

        expect(first.results.filter((result) => result.status === "failed").map((result) => result.id).sort()).toEqual([
            "android-running",
            "ios-owned",
            "macos-owned",
            "windows-owned",
        ]);
        expect(first.results.filter((result) => result.status === "stopped").map((result) => result.id).sort()).toEqual([
            "android-real",
            "android-real-recording",
            "ios-real",
        ]);
        expect(second.results.filter((result) => result.status === "failed").map((result) => result.id).sort()).toEqual([
            "android-running",
            "ios-owned",
            "macos-owned",
            "windows-owned",
        ]);
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:running"]);
        expect(fixture.readDeviceIds(androidDeviceFile)).toEqual(["android-real:detached", "android-real-recording:detached"]);
        expect(fixture.readDeviceIds(iosFile)).toEqual(["ios-owned:booted", "ios-stopped:stopped"]);
        expect(fixture.readDeviceIds(iosDeviceFile)).toEqual(["ios-real:detached"]);
        expect(fixture.readDeviceIds(windowsFile)).toEqual(["windows-owned:running"]);
        expect(fixture.readDeviceIds(macosFile)).toEqual(["macos-owned:running", "macos-stopped:stopped"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("cleanup records failed stop commands and preserves active state for retry", () => {
        const cwd = "/project/admin-cleanup-failure-test";
        const { androidFile, windowsFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "echo adb-failed >&2; exit 9");
        fixture.writeTool(binDir, "wsb", "echo wsb-failed >&2; exit 8");

        const cleanup = cleanupOwnerDevices(cwd);

        const android = cleanup.results.find((result) => result.id === "android-running");
        const windows = cleanup.results.find((result) => result.id === "windows-owned");
        expect(android?.status).toBe("failed");
        expect(windows?.status).toBe("failed");
        expect(android?.commands[0]).toEqual(expect.objectContaining({ status: 9, stderr: expect.stringContaining("adb-failed") }));
        expect(windows?.commands[0]).toEqual(expect.objectContaining({ status: 8, stderr: expect.stringContaining("wsb-failed") }));
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:running"]);
        expect(fixture.readDevices(androidFile).find((device) => device.id === "android-running")).toEqual(expect.objectContaining({
            serial: "emulator-5582",
            pid: 999999,
        }));
        expect(fixture.readDeviceIds(windowsFile)).toEqual(["windows-owned:running"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("stop --all-projects cleans active devices and matching physical leases across all projects", () => {
        const cwd = "/project/admin-stop-all-test";
        const { androidFile, androidDeviceFile, iosFile, iosDeviceFile, windowsFile, macosFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const otherPhysicalDir = join(fixture.homeDir, ".ccc/devices/owners", "other-owner", "android-device");
        mkdirSync(otherPhysicalDir, { recursive: true });
        const otherPhysicalFile = join(otherPhysicalDir, "devices.json");
        writeFileSync(otherPhysicalFile, JSON.stringify({
            devices: [{ id: "foreign-real", name: "Foreign Real", status: "attached", platform: "android", physical: true, serial: "FOREIGN-REAL" }],
        }));
        const matchingForeignLock = fixture.physicalLeaseLockPath("android-device", "FOREIGN-REAL");
        writeFileSync(matchingForeignLock, JSON.stringify({ backend: "android-device", hardwareId: "FOREIGN-REAL", ownerId: "other-owner", deviceId: "foreign-real" }));
        const binDir = join(fixture.homeDir, "bin");
        const logPath = join(fixture.homeDir, "admin-stop-all.log");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", `echo "adb $*" >> "${logPath}"; exit 0`);
        fixture.writeTool(binDir, "xcrun", `echo "xcrun $*" >> "${logPath}"; exit 0`);
        fixture.writeTool(binDir, "wsb", `echo "wsb $*" >> "${logPath}"; exit 0`);
        fixture.writeTool(binDir, "tart", `echo "tart $*" >> "${logPath}"; exit 0`);

        const result = stopAllProjectDevices();

        expect(result.ok).toBe(true);
        expect(result.text).toContain("projects: stop --all-projects");
        expect(result.text).toContain("project: other-owner");
        expect(result.text).toContain("stopped: android-running  backend=android-emulator");
        expect(result.text).toContain("stopped: android-foreign  backend=android-emulator");
        expect(result.text).toContain("stopped: foreign-real  backend=android-device");
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:stopped"]);
        expect(fixture.readDeviceIds(androidDeviceFile)).toEqual(["android-real:detached", "android-real-recording:detached"]);
        expect(fixture.readDeviceIds(iosFile)).toEqual(["ios-owned:stopped", "ios-stopped:stopped"]);
        expect(fixture.readDeviceIds(iosDeviceFile)).toEqual(["ios-real:detached"]);
        expect(fixture.readDeviceIds(windowsFile)).toEqual(["windows-owned:stopped"]);
        expect(fixture.readDeviceIds(macosFile)).toEqual(["macos-owned:stopped", "macos-stopped:stopped"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:stopped"]);
        expect(fixture.readDeviceIds(otherPhysicalFile)).toEqual(["foreign-real:detached"]);
        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("adb -s emulator-5582 emu kill");
        expect(log).toContain("adb -s R5CREAL456 shell pkill -2 screenrecord");
        expect(log).not.toContain("adb -s R5CREAL123 emu kill");
        expect(log).not.toContain("adb -s FOREIGN-REAL emu kill");
        expect(log).toContain("xcrun simctl shutdown IOS-UDID");
        expect(log).toContain("wsb stop --id 12345678-1234-4234-9234-1234567890ab");
        expect(log).toContain("tart stop ccc-mac");
        expect(() => readFileSync(fixture.physicalLeaseLockPath("android-device", "R5CREAL123"), "utf-8")).toThrow();
        expect(() => readFileSync(fixture.physicalLeaseLockPath("android-device", "R5CREAL456"), "utf-8")).toThrow();
        expect(() => readFileSync(fixture.physicalLeaseLockPath("ios-device", "REAL-IOS-UDID"), "utf-8")).toThrow();
        expect(() => readFileSync(matchingForeignLock, "utf-8")).toThrow();
    });

    it("stop --all-projects reports failures and preserves retryable active definitions", () => {
        const cwd = "/project/admin-stop-all-failure-test";
        const { androidFile, windowsFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "echo adb-failed >&2; exit 9");
        fixture.writeTool(binDir, "wsb", "echo wsb-failed >&2; exit 8");

        const result = stopAllProjectDevices();

        expect(result.ok).toBe(false);
        expect(result.text).toContain("failed: android-running  backend=android-emulator");
        expect(result.text).toContain("failed: android-foreign  backend=android-emulator");
        expect(result.text).toContain("failed: windows-owned  backend=windows-sandbox");
        expect(result.text).toContain("failed: 5");
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:running"]);
        expect(fixture.readDeviceIds(windowsFile)).toEqual(["windows-owned:running"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("routes the public stop --all-projects CLI through cross-project cleanup", () => {
        const cwd = "/project/admin-stop-all-cli-test";
        const { androidFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "exit 0");
        fixture.writeTool(binDir, "xcrun", "exit 0");
        fixture.writeTool(binDir, "wsb", "exit 0");
        fixture.writeTool(binDir, "tart", "exit 0");
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

        expect(devicesCli(["stop", "--all-projects"], cwd)).toBe(0);
        expect(logSpy).toHaveBeenLastCalledWith(expect.stringContaining("projects: stop --all-projects"));
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:stopped"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:stopped"]);
    });

    it("keeps stop --all-projects out of single-device broker routing", async () => {
        const cwd = "/project/admin-stop-all-async-cli-test";
        const { androidFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "exit 0");
        fixture.writeTool(binDir, "xcrun", "exit 0");
        fixture.writeTool(binDir, "wsb", "exit 0");
        fixture.writeTool(binDir, "tart", "exit 0");
        const invokeOwnerRpc = vi.fn();
        vi.spyOn(console, "log").mockImplementation(() => undefined);

        expect(await devicesCliAsync(["stop", "--all-projects"], cwd, undefined, { invokeOwnerRpc })).toBe(0);
        expect(invokeOwnerRpc).not.toHaveBeenCalled();
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:stopped"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:stopped"]);
    });

    it("bounds cleanup stop command execution with a timeout", () => {
        const cwd = "/project/admin-cleanup-timeout-test";
        const { androidFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", `"${process.execPath}" -e 'setTimeout(() => {}, 1000)'`);

        const cleanup = cleanupOwnerDevices(cwd, 50);

        const android = cleanup.results.find((result) => result.id === "android-running");
        expect(android?.status).toBe("failed");
        expect(android?.commands[0]).toEqual(expect.objectContaining({
            status: null,
            stderr: expect.stringMatching(/ETIMEDOUT|timed out|Timeout/i),
        }));
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-owned:stopped", "android-running:running"]);
        expect(fixture.readDevices(androidFile).find((device) => device.id === "android-running")).toEqual(expect.objectContaining({
            serial: "emulator-5582",
            pid: 999999,
        }));
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("refuses to stop unknown devices from other owner namespaces", () => {
        const cwd = "/project/admin-foreign-stop-test";
        const { otherOwnerFile } = fixture.setupFixture(cwd);

        const result = stopOwnerDevice("android-foreign", cwd);

        expect(result.ok).toBe(false);
        expect(result.text).toContain("Device not found for owner");
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it("deletes managed stopped macOS VM provider resources before removing device metadata", () => {
        const cwd = "/project/admin-delete-macos-managed-test";
        const { macosFile } = fixture.setupFixture(cwd);
        const macos = fixture.readDevices(macosFile);
        const stopped = macos.find((device) => device.id === "macos-stopped");
        Object.assign(stopped!, {
            providerResourceManaged: true,
            snapshots: [
                { id: "snap-clean", name: "Clean", provider: "tart", providerInstance: "ccc-mac-stopped-snap" },
            ],
            restoreRecovery: {
                provider: "tart",
                candidateProviderInstance: "ccc-mac-stopped-restore",
            },
        });
        writeFileSync(macosFile, JSON.stringify({ devices: macos }));
        const binDir = join(fixture.homeDir, "bin");
        const logPath = join(fixture.homeDir, "admin-delete-macos-managed.log");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "tart", `echo "tart $*" >> "${logPath}"; exit 0`);

        const result = deleteOwnerDevice("macos-stopped", cwd);

        expect(result.ok).toBe(true);
        expect(result.text).toContain("deleted: macos-stopped");
        expect(fixture.readDeviceIds(macosFile)).toEqual(["macos-owned:running"]);
        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("tart delete ccc-mac-stopped-snap");
        expect(log).toContain("tart delete ccc-mac-stopped-restore");
        expect(log).toContain("tart delete ccc-mac-stopped");
    });

    it("preserves managed macOS VM metadata when provider resource deletion fails", () => {
        const cwd = "/project/admin-delete-macos-managed-failure-test";
        const { macosFile } = fixture.setupFixture(cwd);
        const macos = fixture.readDevices(macosFile);
        const stopped = macos.find((device) => device.id === "macos-stopped");
        Object.assign(stopped!, { providerResourceManaged: true });
        writeFileSync(macosFile, JSON.stringify({ devices: macos }));
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "tart", `if [ "$2" = "ccc-mac-stopped" ]; then echo tart-delete-failed >&2; exit 7; fi; exit 0`);

        const result = deleteOwnerDevice("macos-stopped", cwd);

        expect(result.ok).toBe(false);
        expect(result.text).toContain("failed: macos-stopped");
        expect(result.text).toContain("-> 7");
        expect(fixture.readDeviceIds(macosFile)).toEqual(["macos-owned:running", "macos-stopped:stopped"]);
    });

    it("preserves managed stopped macOS VM provider resources during owner prune", () => {
        const cwd = "/project/admin-prune-macos-managed-test";
        const { macosFile } = fixture.setupFixture(cwd);
        const macos = fixture.readDevices(macosFile);
        const stopped = macos.find((device) => device.id === "macos-stopped");
        Object.assign(stopped!, { providerResourceManaged: true });
        writeFileSync(macosFile, JSON.stringify({ devices: macos }));

        const result = pruneOwnerDevices(cwd);

        expect(result.ok).toBe(true);
        expect(result.text).not.toContain("pruned: macos-stopped");
        expect(fixture.readDeviceIds(macosFile)).toEqual(["macos-owned:running", "macos-stopped:stopped"]);
    });

    it("preserves managed stopped macOS VM provider resources during global prune", () => {
        const cwd = "/project/admin-prune-all-macos-managed-test";
        const { macosFile } = fixture.setupFixture(cwd);
        const macos = fixture.readDevices(macosFile);
        const stopped = macos.find((device) => device.id === "macos-stopped");
        Object.assign(stopped!, { providerResourceManaged: true });
        writeFileSync(macosFile, JSON.stringify({ devices: macos }));

        const result = pruneAllProjectDevices();

        expect(result.ok).toBe(true);
        expect(result.text).not.toContain("pruned: macos-stopped");
        expect(fixture.readDeviceIds(macosFile)).toEqual(["macos-owned:running", "macos-stopped:stopped"]);
    });
});
