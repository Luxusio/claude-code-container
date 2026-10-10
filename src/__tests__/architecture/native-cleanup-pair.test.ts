import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as vm from "node:vm";
import * as fs from "node:fs";
import * as os from "node:os";
import { createNativeCleanupRealm, project, type NativeDevice } from "../helpers/native-cleanup-fixture.js";

function observeCleanup(
    setup: (realm: ReturnType<typeof createNativeCleanupRealm>) => void,
    observe?: (realm: ReturnType<typeof createNativeCleanupRealm>, value: ReturnType<ReturnType<typeof createNativeCleanupRealm>["native"]["cleanupOwnerDevices"]> | undefined) => void,
) {
    {
        const realm = createNativeCleanupRealm();
        try {
            realm.assertZero(); setup(realm); realm.assertZero();
            let value: ReturnType<typeof realm.native.cleanupOwnerDevices> | undefined;
            let thrown: unknown;
            try { value = realm.native.cleanupOwnerDevices(project, 5000); }
            catch (error) { thrown = error; }
            // Required even after a business helper catches or propagates a fault.
            realm.assertZero();
            if (realm.state.unlinkError) expect(thrown).toBe(realm.state.unlinkError);
            else expect(thrown).toBeUndefined();
            observe?.(realm, value);
            realm.assertZero();
        } finally { realm.cleanup(); }
    }
}
const running: NativeDevice = { id: "native-a", name: "Native", status: "running", serial: "emulator-5554", runtimeId: "generation-1" };
const defaultAndroid = (realm: ReturnType<typeof createNativeCleanupRealm>) => realm.writeJson(realm.ownerFile("android"), { devices: [running] });

describe("real native cleanup current native cleanup behavior", () => {
    it("preserves complete backend scan, native operation/mutation locks and provider stop order", () => {
        observeCleanup(defaultAndroid, (realm, result) => {
            expect(result?.results).toMatchObject([{ id: "native-a", status: "stopped" }]);
            const command = realm.trace.findIndex(row => row[0] === "spawnSync" && row[1] === "/controlled/adb");
            const mutation = realm.trace.findIndex(row => row[0] === "fs.openSync" && String(row[1]).endsWith("devices.mutation.lock"));
            expect(command).toBeGreaterThan(0); expect(mutation).toBeGreaterThan(command);
            expect(realm.readJson(realm.ownerFile("android")).devices[0].status).toBe("stopped");
        });
    });
    it("refuses an operation-lock successor generation before a provider command", () => {
        observeCleanup(realm => {
            defaultAndroid(realm);
            realm.state.beforeOperationOpen = () => realm.writeJson(realm.ownerFile("android"), { devices: [{ ...running, runtimeId: "successor", serial: "emulator-9999" }] });
        }, (realm, result) => {
            expect(result?.results[0].reason).toBe("owner-device-state-conflict");
            expect(realm.trace.some(row => row[0] === "spawnSync" && row[1] === "/controlled/adb")).toBe(false);
            expect(realm.readJson(realm.ownerFile("android")).devices[0].runtimeId).toBe("successor");
        });
    });
    it("preserves a same-ID successor published during provider stop", () => {
        observeCleanup(realm => {
            defaultAndroid(realm);
            realm.state.afterCommand = () => realm.writeJson(realm.ownerFile("android"), { devices: [{ ...running, runtimeId: "after-provider" }] });
        }, (realm, result) => {
            expect(result?.results[0].reason).toBe("owner-device-state-conflict");
            expect(realm.readJson(realm.ownerFile("android")).devices[0].runtimeId).toBe("after-provider");
        });
    });
    it("does not publish stopped state after provider failure", () => {
        observeCleanup(realm => { defaultAndroid(realm); realm.state.commandStatus = 7; }, (realm, result) => {
            expect(result?.results[0].reason).toBe("provider-stop-failed");
            expect(realm.readJson(realm.ownerFile("android")).devices[0].status).toBe("running");
        });
    });
    it.each(["appium", "recording"])("refuses live broker-owned %s through actual native identity inspection", label => {
        observeCleanup(realm => {
            const metadata = label === "appium" ? {
                authority: "host-broker", processOwner: "host-broker", startedBy: "broker.appium.start",
                runtimeId: "live", serverPid: 999002, processIdentity: realm.identity(),
            } : { processOwner: "host-broker", startedBy: "broker.device.recording.start",
                runtimeId: "live", pid: 999002, processIdentity: realm.identity() };
            realm.writeJson(realm.ownerFile("android"), { devices: [{ ...running, [label]: metadata }] });
        }, (realm, result) => {
            expect(result?.results[0].status).toBe("failed");
            expect(result?.results[0].reason).toContain(label === "appium" ? "appium" : "recording");
            expect(realm.trace.some(row => row[0] === "spawnSync" && row[1] === "/controlled/adb")).toBe(false);
        });
    });
    it("fails closed when recording identity is unavailable", () => {
        observeCleanup(realm => {
            realm.writeJson(realm.ownerFile("android"), { devices: [{ ...running, recording: {
                processOwner: "host-broker", startedBy: "broker.device.recording.start",
                runtimeId: "live", pid: 999002, processIdentity: realm.identity(),
            } }] });
            realm.state.identityUnavailable = true;
        }, (_realm, result) => expect(result?.results[0].reason).toBe("recording-runtime-identity-unavailable"));
    });
    it("retains direct recording signal-before-provider order and exit confirmation", () => {
        observeCleanup(realm => realm.writeJson(realm.ownerFile("android"), { devices: [{ ...running, recording: {
            runtimeId: "recording", pid: 999002, processIdentity: realm.identity(),
        } }] }), (realm, result) => {
            expect(result?.results[0].status).toBe("stopped");
            const signal = realm.trace.findIndex(row => row[0] === "process.kill" && row[2] === "SIGINT");
            const command = realm.trace.findIndex(row => row[0] === "spawnSync" && row[1] === "/controlled/adb");
            expect(signal).toBeGreaterThan(0); expect(command).toBeGreaterThan(signal);
        });
    });
    it.each([false, true])("releases only matching Windows Sandbox singleton (foreign=%s)", foreign => {
        observeCleanup(realm => {
            defaultAndroid(realm);
            realm.writeJson(realm.ownerFile("windows"), { devices: [{ id: "sandbox", status: "running", sandboxId: "12345678-1234-1234-1234-123456789abc" }] });
            realm.writeJson(path.join(realm.home, ".ccc/devices/host-locks/windows-sandbox.json"), {
                provider: "windows-sandbox", ownerId: foreign ? "foreign" : realm.ownerId, deviceId: "sandbox",
                sandboxId: "12345678-1234-1234-1234-123456789abc",
            });
        }, (realm, result) => {
            expect(result?.results.find(row => row.id === "sandbox")?.status).toBe("stopped");
            const removals = realm.trace.filter(row => row[0] === "fs.unlinkSync" && String(row[1]).endsWith("windows-sandbox.json"));
            expect(removals).toHaveLength(foreign ? 0 : 1);
        });
    });
    it.each([false, true])("physical cleanup preserves matching versus foreign lease authority (foreign=%s)", foreign => {
        observeCleanup(realm => {
            defaultAndroid(realm);
            const device = { id: "physical", status: "attached", serial: "physical-serial", hardwareId: "physical-serial" };
            realm.writeJson(realm.ownerFile("android-device"), { devices: [device] });
            const lease = { backend: "android-device", hardwareId: "physical-serial", ownerId: foreign ? "foreign" : realm.ownerId,
                deviceId: "physical", expiresAt: "2026-10-10T00:00:00Z" };
            realm.writeJson(path.join(realm.home, ".ccc/devices/physical-leases/android-device/locks/physical-serial.json"), lease);
            realm.writeJson(path.join(realm.home, ".ccc/devices/physical-leases/android-device.json"), { leases: [lease] });
        }, (realm, result) => {
            expect(result?.results.find(row => row.id === "physical")?.status).toBe("stopped");
            const aggregate = realm.readJson(path.join(realm.home, ".ccc/devices/physical-leases/android-device.json"));
            expect(aggregate.leases).toHaveLength(foreign ? 1 : 0);
            expect(realm.readJson(realm.ownerFile("android-device")).devices[0].status).toBe("detached");
        });
    });
    it("preserves an exact-owner successor physical lease generation", () => {
        observeCleanup(realm => {
            defaultAndroid(realm);
            realm.writeJson(realm.ownerFile("android-device"), { devices: [{ id: "physical", status: "attached",
                serial: "physical-serial", leaseClaimId: "old-claim", leaseClaimNonce: "old-nonce" }] });
            const successor = { backend: "android-device", hardwareId: "physical-serial", ownerId: realm.ownerId,
                deviceId: "physical", claimId: "next-claim", claimNonce: "next-nonce" };
            realm.writeJson(path.join(realm.home, ".ccc/devices/physical-leases/android-device/locks/physical-serial.json"), successor);
            realm.writeJson(path.join(realm.home, ".ccc/devices/physical-leases/android-device.json"), { leases: [successor] });
        }, (realm, result) => {
            expect(result?.results.find(row => row.id === "physical")?.status).toBe("stopped");
            const aggregate = realm.readJson(path.join(realm.home, ".ccc/devices/physical-leases/android-device.json"));
            expect(aggregate.leases[0].claimId).toBe("next-claim");
            expect(realm.readJson(path.join(realm.home, ".ccc/devices/physical-leases/android-device/locks/physical-serial.json")).claimNonce).toBe("next-nonce");
        });
    });
    it("restores the aggregate after an allocated lease unlink failure and checks zero denials after the throw", () => {
        observeCleanup(realm => {
            defaultAndroid(realm);
            realm.writeJson(realm.ownerFile("android-device"), { devices: [{ id: "physical", status: "attached", serial: "physical-serial" }] });
            const lease = { backend: "android-device", hardwareId: "physical-serial", ownerId: realm.ownerId, deviceId: "physical" };
            realm.writeJson(path.join(realm.home, ".ccc/devices/physical-leases/android-device/locks/physical-serial.json"), lease);
            realm.writeJson(path.join(realm.home, ".ccc/devices/physical-leases/android-device.json"), { leases: [lease] });
            realm.state.unlinkError = Object.assign(new Error("allocated unlink failure"), { code: "EACCES" });
        }, (realm, result) => {
            expect(result).toBeUndefined();
            expect(realm.readJson(path.join(realm.home, ".ccc/devices/physical-leases/android-device.json")).leases).toHaveLength(1);
            expect(realm.readJson(realm.ownerFile("android-device")).devices[0].status).toBe("attached");
        });
    });
    it("retains skipped devices without inventing lifecycle commands", () => {
        observeCleanup(realm => realm.writeJson(realm.ownerFile("android"), { devices: [{ ...running, status: "stopped" }] }), (_realm, result) => {
            expect(result?.results[0].status).toBe("skipped");
            expect(result?.results[0].commands).toEqual([]);
        });
    });
    it("counts negative FS/fd/link/callback/network/process controls before throw", () => {
        const realm = createNativeCleanupRealm();
        const probes = [() => realm.fencedFs.copyFileSync("/outside", "/outside-other"),
            () => realm.fencedFs.fchmodSync(99999, 0o600), () => realm.fencedFs.readFile("/outside", () => {}),
            () => realm.fencedFs.promises.open("/outside"), () => realm.fencedFs.createReadStream("/outside"),
            () => realm.fencedFs.symlinkSync("/outside", path.join(realm.home, "link")),
            () => realm.childProcess.exec("anything"), () => realm.nativeProcess.kill(123456, "SIGTERM"),
            () => vm.runInContext("fetch('https://unallocated.invalid')", realm.context),
            () => vm.runInContext("process.send({})", realm.context)];
        try {
            realm.assertZero();
            for (const [index, probe] of probes.entries()) {
                expect(probe).toThrow("DENIED"); expect(realm.denied).toBe(index + 1);
            }
        } finally { realm.cleanup(); }
    });
    it("counts denial before following an inside-root symlink leaf or ancestor", () => {
        const realm = createNativeCleanupRealm();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-native-cleanup-negative-target-"));
        // Both roots are test-owned. No unknown host pathname is followed even
        // if the containment guard regresses; the target holds only fixture data.
        fs.writeFileSync(path.join(outside, "sentinel"), "owned outside fixture");
        const leaf = path.join(realm.home, "leaf-link");
        const ancestor = path.join(realm.home, "ancestor-link");
        fs.symlinkSync(path.join(outside, "sentinel"), leaf);
        fs.symlinkSync(outside, ancestor, "dir");
        try {
            realm.assertZero();
            expect(realm.fencedFs.lstatSync(leaf).isSymbolicLink()).toBe(true);
            expect(realm.denied).toBe(0);
            const probes = [
                () => realm.fencedFs.existsSync(leaf),
                () => realm.fencedFs.statSync(leaf),
                () => realm.fencedFs.readdirSync(ancestor),
                () => realm.fencedFs.existsSync(path.join(ancestor, "sentinel")),
                () => realm.fencedFs.lstatSync(path.join(ancestor, "sentinel")),
                () => realm.fencedFs.statSync(path.join(ancestor, "sentinel")),
                () => realm.fencedFs.readdirSync(path.join(ancestor, "nested")),
            ];
            for (const [index, probe] of probes.entries()) {
                expect(probe).toThrow("DENIED symlink traversal");
                expect(realm.denied).toBe(index + 1);
            }
            // Preserve raw spelling: path.join would erase the very traversal
            // this negative fixture must exercise. The symlink points to a
            // child of the separately owned target, so OS link/.. would reach
            // that target's sentinel if a wrapper forwarded this unchecked.
            const nestedTarget = path.join(outside, "nested-target");
            fs.mkdirSync(nestedTarget);
            const traversalLink = path.join(realm.home, "traversal-link");
            fs.symlinkSync(nestedTarget, traversalLink, "dir");
            const traversal = `${traversalLink}/../sentinel`;
            let expectedDenials = probes.length;
            for (const operation of [
                () => realm.fencedFs.existsSync(traversal),
                () => realm.fencedFs.lstatSync(traversal),
                () => realm.fencedFs.statSync(traversal),
                () => realm.fencedFs.readFileSync(traversal, "utf8"),
                () => realm.fencedFs.renameSync(traversal, path.join(realm.home, "rename-target")),
                () => realm.fencedFs.renameSync(path.join(realm.home, "rename-source"), traversal),
                () => realm.fencedFs.linkSync(traversal, path.join(realm.home, "link-target")),
                () => realm.fencedFs.linkSync(path.join(realm.home, "link-source"), traversal),
                () => realm.fencedFs.copyFileSync(traversal, path.join(realm.home, "copy-target")),
                () => realm.fencedFs.copyFileSync(path.join(realm.home, "copy-source"), traversal),
                () => realm.fencedFs.symlinkSync(traversal, path.join(realm.home, "symlink-target")),
                () => realm.fencedFs.symlinkSync(path.join(realm.home, "symlink-source"), traversal),
            ]) {
                expect(operation).toThrow("DENIED noncanonical path");
                expect(realm.denied).toBe(++expectedDenials);
            }
            expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("owned outside fixture");
        } finally {
            realm.cleanup();
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it("allows only exact retained Docker probe options through the actual mocked spawn binding", () => {
        const realm = createNativeCleanupRealm();
        const commands = [["--version"], ["info", "--format", "{{.OperatingSystem}}"],
            ["info", "--format", "{{json .SecurityOptions}}"]];
        const valid = { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] };
        try {
            realm.assertZero();
            for (const args of commands) {
                expect(realm.childProcess.spawnSync("docker", args, valid).status).toBe(0);
                realm.assertZero();
            }
            let expectedDenials = 0;
            for (const args of commands) {
                for (const wrong of [
                    { ...valid, shell: true }, { ...valid, extra: true }, { ...valid, timeout: 1 },
                    { ...valid, stdio: "inherit" }, { ...valid, encoding: "utf8" },
                    { encoding: "utf-8" },
                ]) {
                    expect(() => realm.childProcess.spawnSync("docker", args, wrong)).toThrow("DENIED runtime probe options");
                    expect(realm.denied).toBe(++expectedDenials);
                }
            }
            for (const args of commands) {
                const inaccessible = { encoding: "utf-8", get stdio(): never { throw new Error("unallocated options getter"); } };
                expect(() => realm.childProcess.spawnSync("docker", args, inaccessible)).toThrow("DENIED runtime probe options");
                expect(realm.denied).toBe(++expectedDenials);
            }
            let getterCalls = 0;
            const successfulGetter = { encoding: "utf-8", get stdio() { getterCalls++; return ["pipe", "pipe", "pipe"]; } };
            const nonEnumerableEncoding = Object.defineProperty({ stdio: ["pipe", "pipe", "pipe"] }, "encoding", { value: "utf-8" });
            const nonEnumerableStdio = Object.defineProperty({ encoding: "utf-8" }, "stdio", { value: ["pipe", "pipe", "pipe"] });
            const accessorArray = ["pipe", "pipe", "pipe"];
            Object.defineProperty(accessorArray, "0", { enumerable: true, configurable: true, get() { getterCalls++; return "pipe"; } });
            for (const args of commands) {
                for (const wrong of [successfulGetter, nonEnumerableEncoding, nonEnumerableStdio,
                    Object.assign(Object.create({ shell: true }), valid),
                    Object.assign(Object.create({ env: { PATH: "/outside" } }), valid),
                    Object.assign(Object.create({ cwd: "/outside" }), valid),
                    new Proxy(valid, {}), { ...valid, stdio: new Proxy(["pipe", "pipe", "pipe"], {}) },
                    { ...valid, stdio: new Array(3) }, { ...valid, stdio: accessorArray },
                    { ...valid, [Symbol("extra")]: true },
                    Object.defineProperty({ ...valid }, "extra", { value: true }),
                ]) {
                    expect(() => realm.childProcess.spawnSync("docker", args, wrong)).toThrow("DENIED runtime probe options");
                    expect(realm.denied).toBe(++expectedDenials);
                    expect(getterCalls).toBe(0);
                }
            }
            expect(() => realm.childProcess.spawnSync("docker", ["info", "--format", "unallocated"], valid)).toThrow("DENIED unexpected subprocess");
            expect(realm.denied).toBe(++expectedDenials);
        } finally { realm.cleanup(); }
    });

    it("admits literal Docker options from the actual VM adapters", () => {
        {
            const realm = createNativeCleanupRealm();
            try {
                const adapter = realm.load("src/adapters/runtime-capabilities.ts");
                realm.assertZero();
                const observations = adapter.createNativeRuntimeCapabilitiesObservations(() => null);
                expect(observations.observeVersion("docker").status).toBe(0); realm.assertZero();
                expect(observations.observeDockerOperatingSystem().status).toBe(0); realm.assertZero();
                expect(observations.observeDockerSecurityOptions().status).toBe(0); realm.assertZero();
            } finally { realm.cleanup(); }
        }
    });
    it("counts owned VM prototype mutations without invoking inherited accessors", () => {
        const mutations = [
            "Object.prototype.detached = true",
            "Object.prototype.uid = 123",
            "Object.prototype[Symbol('unallocated')] = true",
            "Object.prototype.toString = function () { return 'replacement'; }",
            "Object.defineProperty(Object.prototype, 'getter', { configurable: true, get() { globalThis.getterCalls++; return true; } })",
            "Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, get() { globalThis.getterCalls++; return undefined; } })",
            "Array.prototype.maxBuffer = 123",
            "Array.prototype.map = function () { return []; }",
            "Object.defineProperty(Array.prototype, 'getter', { configurable: true, get() { globalThis.getterCalls++; return true; } })",
        ];
        for (const mutation of mutations) {
            const realm = createNativeCleanupRealm();
            try {
                const adapter = realm.load("src/adapters/runtime-capabilities.ts"); realm.assertZero();
                const observations = adapter.createNativeRuntimeCapabilitiesObservations(() => null);
                vm.runInContext(`globalThis.getterCalls = 0; ${mutation}`, realm.context);
                let expectedDenials = 0;
                for (const observe of [() => observations.observeVersion("docker"),
                    () => observations.observeDockerOperatingSystem(), () => observations.observeDockerSecurityOptions()]) {
                    expect(observe).toThrow("DENIED runtime probe options");
                    expect(realm.denied).toBe(++expectedDenials);
                    expect(vm.runInContext("globalThis.getterCalls", realm.context)).toBe(0);
                }
            } finally { realm.cleanup(); }
        }
    });

});
