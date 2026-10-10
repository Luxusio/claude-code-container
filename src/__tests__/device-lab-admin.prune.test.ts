import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
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
import * as nativeFs from "fs";
import { createHash } from "crypto";
import { isDeepStrictEqual } from "util";
import ts from "typescript";
import * as sharedState from "@ccc/device-lab/device-lab-shared-state.js";
import * as ownerState from "@ccc/device-lab/device-lab-owner-state.js";
import { createDeviceAdminPrune } from "../application/device-admin-prune.js";
import type { DeviceAdminPrunePorts } from "../ports/device-admin-prune.js";
import type { DeviceAdminPruneRecord } from "../domain/device-admin-prune.js";

// Keep real native leaves spyable; each fault below targets one allocated file.
vi.mock("fs", async original => ({ ...await original<typeof import("fs")>() }));
vi.mock("@ccc/device-lab/device-lab-shared-state.js", async original => ({
    ...await original<typeof import("@ccc/device-lab/device-lab-shared-state.js")>(),
}));
vi.mock("@ccc/device-lab/device-lab-owner-state.js", async original => ({
    ...await original<typeof import("@ccc/device-lab/device-lab-owner-state.js")>(),
}));

// Exact reached functions frozen from base2b admin d2dfbda098e4180bceda5ee77b2a8b38a1f35badf432168d01745751c15bf0ad.
// This self-contained baseline requires no task-admission files at test time.
const ORIGINAL_PRUNE = "function pruneOwnerDeviceRecord(ownerId: string, backend: Backend, expected: DeviceRecord): boolean {\n    if (!expected.id) return false;\n    return withAdminOwnerDeviceOperation(ownerId, backend.stateKey, expected.id, () => {\n        const current = readDevices(ownerId, backend.stateKey).find((candidate) => candidate.id === expected.id);\n        if (!current || !isDeepStrictEqual(current, expected)) return false;\n        if ((current.status !== \"stopped\" && current.status !== \"detached\") || hasMacosManagedProviderResources(backend, current)) return false;\n\n        return transitionOwnerDeviceRecordWithPhysicalLease(ownerId, backend, current, null);\n    });\n}\n\nfunction macosManagedProviderResource(device: DeviceRecord): boolean {\n    return Boolean(\n        device.providerResourceManaged ||\n        device.provisioning === \"image-created\" ||\n        device.provisioning === \"image-cloned\" ||\n        device.imageSource ||\n        device.clonedFrom ||\n        device.imageCreatedAt ||\n        device.clonedAt,\n    );\n}\n\nfunction macosSnapshotProviderResources(device: DeviceRecord): Array<{ provider: string; instance: string }> {\n    const snapshots = Array.isArray(device.snapshots) ? device.snapshots : [];\n    return snapshots.flatMap((snapshot) => {\n        if (!snapshot || typeof snapshot !== \"object\") return [];\n        const record = snapshot as Record<string, unknown>;\n        const provider = typeof record.provider === \"string\" ? record.provider : null;\n        const instance = typeof record.providerInstance === \"string\" ? record.providerInstance : null;\n        return provider && instance ? [{ provider, instance }] : [];\n    });\n}\n\nfunction macosRestoreRecoveryProviderResource(device: DeviceRecord): { provider: string; instance: string } | null {\n    const recovery = device.restoreRecovery;\n    if (!recovery || typeof recovery !== \"object\") return null;\n    const record = recovery as Record<string, unknown>;\n    const provider = typeof record.provider === \"string\" ? record.provider : typeof device.provider === \"string\" ? device.provider : null;\n    const instance = typeof record.candidateProviderInstance === \"string\" ? record.candidateProviderInstance : null;\n    return provider && instance ? { provider, instance } : null;\n}\n\nfunction macosManagedProviderResources(device: DeviceRecord): Array<{ provider: string; instance: string }> {\n    const resources = [\n        ...macosSnapshotProviderResources(device),\n        macosRestoreRecoveryProviderResource(device),\n    ].filter((resource): resource is { provider: string; instance: string } => Boolean(resource));\n    const provider = typeof device.provider === \"string\" ? device.provider : null;\n    const instance = typeof device.providerInstance === \"string\" ? device.providerInstance : null;\n    if (provider && instance && macosManagedProviderResource(device)) resources.push({ provider, instance });\n    return resources;\n}\n\nfunction hasMacosManagedProviderResources(backend: Backend, device: DeviceRecord): boolean {\n    return backend.stateKey === \"macos\" && macosManagedProviderResources(device).length > 0;\n}\n\nexport function pruneOwnerDevices(cwd = process.cwd(), profile?: string): { ok: boolean; text: string } {\n    const ownerId = deviceLabOwnerId(cwd, profile);\n    const lines = [`owner: ${ownerId}`];\n    let deleted = 0;\n    for (const backend of DEVICE_BACKENDS) {\n        for (const device of readDevices(ownerId, backend.stateKey)) {\n            if (pruneOwnerDeviceRecord(ownerId, backend, device)) {\n                deleted += 1;\n                lines.push(`pruned: ${device.id || \"(unknown)\"}  backend=${backend.name}`);\n            }\n        }\n    }\n    if (deleted === 0) lines.push(\"pruned: 0\");\n    return { ok: true, text: `${lines.join(\"\\n\")}\\n` };\n}\n\nexport function pruneAllProjectDevices(): { ok: boolean; text: string } {\n    const lines = [\"projects: prune --all-projects\"];\n    let deleted = 0;\n    for (const ownerId of allOwnerIds()) {\n        lines.push(`project: ${ownerId}`);\n        for (const backend of DEVICE_BACKENDS) {\n            for (const device of readDevices(ownerId, backend.stateKey)) {\n                if (pruneOwnerDeviceRecord(ownerId, backend, device)) {\n                    deleted += 1;\n                    lines.push(`pruned: ${device.id || \"(unknown)\"}  backend=${backend.name}`);\n                }\n            }\n        }\n    }\n    if (deleted === 0) lines.push(\"pruned: 0\");\n    return { ok: true, text: `${lines.join(\"\\n\")}\\n` };\n}";
const ORIGINAL_PRUNE_SHA = "1cf838910e3c9bd79ffdd6a363ca0a0c697ce5dd83d55d1c9ebbce1ad589a9a4";
type PruneBackend = { stateKey: string; name: string };
type PruneRows = Record<string, DeviceAdminPruneRecord[]>;
type PruneOptions = {
    readFault?: { owner: string; backend: string; error: unknown };
    successor?: DeviceAdminPruneRecord | null;
    removeResult?: boolean;
    removeFault?: unknown;
};
const pruneBackends: PruneBackend[] = [
    { stateKey: "android", name: "android-emulator" },
    { stateKey: "macos", name: "macos-vm" },
];

function originalPrune(ports: DeviceAdminPrunePorts<PruneBackend>) {
    expect(Buffer.byteLength(ORIGINAL_PRUNE)).toBe(4488);
    expect(createHash("sha256").update(ORIGINAL_PRUNE).digest("hex")).toBe(ORIGINAL_PRUNE_SHA);
    const code = ts.transpileModule(ORIGINAL_PRUNE, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    // Only the frozen prune/predicate bodies execute; native leaves are the same
    // required test ports used by the current application.
    return new Function("ports", "isDeepStrictEqual", `
        const exports = {};
        const DEVICE_BACKENDS = ports.backends;
        const deviceLabOwnerId = ports.resolveOwnerId;
        const allOwnerIds = ports.enumerateOwnerIds;
        const readDevices = ports.readDevices;
        const withAdminOwnerDeviceOperation = ports.withRecordLock;
        const transitionOwnerDeviceRecordWithPhysicalLease = (owner, backend, expected, replacement) => {
            if (replacement !== null) throw new Error("unallocated baseline replacement");
            return ports.removeRecord(owner, backend, expected);
        };
        ${code}
        return { owner: pruneOwnerDevices, allProjects: pruneAllProjectDevices };
    `)(ports, ports.sameRecord) as ReturnType<typeof createDeviceAdminPrune<PruneBackend>>;
}

function pruneTrace(original: boolean, initial: PruneRows, options: PruneOptions = {}) {
    const rows = structuredClone(initial), trace: unknown[][] = [];
    let changed = false;
    const ports: DeviceAdminPrunePorts<PruneBackend> = {
        backends: pruneBackends,
        resolveOwnerId(cwd, profile) { trace.push(["owner", cwd, profile]); return "first"; },
        enumerateOwnerIds() { trace.push(["owners"]); return ["second", "first"]; },
        readDevices(owner, backend) {
            trace.push(["read", owner, backend]);
            if (options.readFault?.owner === owner && options.readFault.backend === backend) throw options.readFault.error;
            return structuredClone(rows[`${owner}/${backend}`] || []);
        },
        sameRecord(current, expected) { trace.push(["same", current.id]); return isDeepStrictEqual(current, expected); },
        withRecordLock(owner, backend, id, decide) {
            trace.push(["lock", owner, backend, id]);
            if (!changed && Object.hasOwn(options, "successor")) {
                changed = true;
                rows[`${owner}/${backend}`] = (rows[`${owner}/${backend}`] || []).flatMap(record =>
                    record.id !== id ? [record] : options.successor === null ? [] : [structuredClone(options.successor!)]
                );
            }
            return decide();
        },
        removeRecord(owner, backend, expected) {
            trace.push(["remove", owner, backend.stateKey, structuredClone(expected)]);
            if (Object.hasOwn(options, "removeFault")) throw options.removeFault;
            if (options.removeResult === false) return false;
            rows[`${owner}/${backend.stateKey}`] = rows[`${owner}/${backend.stateKey}`].filter(record => record.id !== expected.id);
            return true;
        },
    };
    return { prune: original ? originalPrune(ports) : createDeviceAdminPrune(ports), trace, rows };
}
const pairedPrune = (rows: PruneRows, options?: PruneOptions) => [pruneTrace(true, rows, options), pruneTrace(false, rows, options)];

// Compile-only negative controls: the focused strict QA includes this file.
// This function is never invoked, so invalid effects cannot enter a fixture.
function requiredSynchronousPrunePortTypes(valid: DeviceAdminPrunePorts<PruneBackend>) {
    const without = <Key extends keyof DeviceAdminPrunePorts<PruneBackend>>(key: Key) => {
        const { [key]: omitted, ...remaining } = valid;
        void omitted;
        return remaining;
    };
    const accept = (ports: DeviceAdminPrunePorts<PruneBackend>) => createDeviceAdminPrune(ports);
    // @ts-expect-error ordered backends are required
    accept(without("backends"));
    // @ts-expect-error owner identity is required
    accept(without("resolveOwnerId"));
    // @ts-expect-error owner enumeration is required
    accept(without("enumerateOwnerIds"));
    // @ts-expect-error state reads are required
    accept(without("readDevices"));
    // @ts-expect-error native record equality is required
    accept(without("sameRecord"));
    // @ts-expect-error native record locking is required
    accept(without("withRecordLock"));
    // @ts-expect-error native record removal is required
    accept(without("removeRecord"));
    // @ts-expect-error backends cannot resolve asynchronously
    accept({ ...valid, backends: Promise.resolve(valid.backends) });
    // @ts-expect-error owner identity must be synchronous
    accept({ ...valid, resolveOwnerId: async () => "owner" });
    // @ts-expect-error enumeration must be synchronous
    accept({ ...valid, enumerateOwnerIds: async () => [] });
    // @ts-expect-error state reads must be synchronous
    accept({ ...valid, readDevices: async () => [] });
    // @ts-expect-error native equality must be synchronous
    accept({ ...valid, sameRecord: async () => true });
    // @ts-expect-error record locks must return the synchronous decision
    accept({ ...valid, withRecordLock: async () => true });
    // @ts-expect-error removal must return the synchronous commit result
    accept({ ...valid, removeRecord: async () => true });
}
void requiredSynchronousPrunePortTypes;




describe("device-lab admin delete, prune, and CLI commands", () => {
    const fixture = createDeviceLabAdminTestFixture();

    afterEach(() => {
        vi.restoreAllMocks();
        fixture.cleanup();
    });


    function matchingDetachedLease(cwd: string) {
        const files = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(files.androidDeviceFile);
        const current = devices.find(device => device.id === "android-real")!;
        Object.assign(current, { status: "detached", leaseClaimId: "prune-claim", leaseClaimNonce: "prune-nonce" });
        writeFileSync(files.androidDeviceFile, JSON.stringify({ devices }));
        const lease = {
            backend: "android-device", hardwareId: "R5CREAL123", ownerId: files.owner,
            deviceId: "android-real", claimId: "prune-claim", claimNonce: "prune-nonce",
        };
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        const aggregateFile = join(fixture.homeDir, ".ccc/devices/physical-leases/android-device.json");
        writeFileSync(leaseFile, JSON.stringify(lease));
        writeFileSync(aggregateFile, JSON.stringify({ leases: [lease] }));
        return { ...files, devices, current, lease, leaseFile, aggregateFile };
    }

    it.each([false, true])("actual %s async CLI preserves owner/profile output and argument refusals without effects", async asynchronous => {
        const cwd = "/project/admin-prune-cli-contract", profile = "chosen-profile";
        const { owner, androidFile, iosFile, macosFile, otherOwnerFile } = fixture.setupFixture(cwd, profile);
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const invoke = (args: string[]) => asynchronous ? devicesCliAsync(args, cwd, profile) : devicesCli(args, cwd, profile);
        const before = [androidFile, iosFile, macosFile, otherOwnerFile].map(file => readFileSync(file, "utf8"));
        for (const args of [["prune", "--all"], ["prune", "--all-projects", "extra"], ["prune", "unit"]]) {
            expect(await invoke(args)).toBe(1);
            expect(error).toHaveBeenLastCalledWith("Usage: ccc devices prune [--all-projects]");
            expect([androidFile, iosFile, macosFile, otherOwnerFile].map(file => readFileSync(file, "utf8"))).toEqual(before);
        }
        expect(log).not.toHaveBeenCalled();
        expect(await invoke(["prune"])).toBe(0);
        expect(log).toHaveBeenLastCalledWith(`owner: ${owner}\npruned: android-owned  backend=android-emulator\npruned: ios-stopped  backend=ios-simulator\npruned: macos-stopped  backend=macos-vm\n`);
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-running:running"]);
        expect(fixture.readDeviceIds(iosFile)).toEqual(["ios-owned:booted"]);
        expect(fixture.readDeviceIds(macosFile)).toEqual(["macos-owned:running"]);
        expect(fixture.readDeviceIds(otherOwnerFile)).toEqual(["android-foreign:running"]);
    });

    it.each([false, true])("actual %s async all-projects CLI publishes ordered project/removal lines", async asynchronous => {
        const cwd = "/project/admin-prune-all-cli-contract";
        const { owner, otherOwnerFile } = fixture.setupFixture(cwd);
        writeFileSync(otherOwnerFile, JSON.stringify({ devices: [{ id: "other-stopped", status: "stopped" }] }));
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const code = asynchronous ? await devicesCliAsync(["prune", "--all-projects"], cwd) : devicesCli(["prune", "--all-projects"], cwd);
        expect(code).toBe(0);
        expect(log).toHaveBeenCalledExactlyOnceWith(`projects: prune --all-projects\nproject: ${owner}\npruned: android-owned  backend=android-emulator\npruned: ios-stopped  backend=ios-simulator\npruned: macos-stopped  backend=macos-vm\nproject: other-owner\npruned: other-stopped  backend=android-emulator\n`);
        expect(fixture.readDevices(otherOwnerFile)).toEqual([]);
    });

    it.each([false, true])("actual %s async CLI propagates a later native read fault after earlier pruning without publishing success", async asynchronous => {
        const cwd = "/project/admin-prune-cli-partial-failure";
        const { androidFile, iosFile, macosFile } = fixture.setupFixture(cwd);
        const fault = { raw: "ios owner read failed", absent: undefined };
        const originalRead = ownerState.readOwnerDeviceStateFile;
        vi.spyOn(ownerState, "readOwnerDeviceStateFile").mockImplementation((file, limit) => {
            if (file === iosFile) throw fault;
            return originalRead(file, limit);
        });
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const laterBefore = [iosFile, macosFile].map(file => readFileSync(file, "utf8"));
        let caught: unknown;
        try {
            if (asynchronous) await devicesCliAsync(["prune"], cwd);
            else devicesCli(["prune"], cwd);
        } catch (err) { caught = err; }
        expect(caught).toBe(fault);
        expect(fixture.readDeviceIds(androidFile)).toEqual(["android-running:running"]);
        expect([iosFile, macosFile].map(file => readFileSync(file, "utf8"))).toEqual(laterBefore);
        expect(log).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it("resolves default cwd at invocation and retains every managed macOS refusal through the native facade", () => {
        const cwd = "/project/admin-prune-managed-native";
        const { owner, macosFile } = fixture.setupFixture(cwd);
        const resources = [
            { providerResourceManaged: true }, { provisioning: "image-created" }, { provisioning: "image-cloned" },
            { imageSource: "base" }, { clonedFrom: "base" }, { imageCreatedAt: "raw-time" }, { clonedAt: "raw-time" },
            { snapshots: [{ provider: "vz", providerInstance: "snapshot" }] },
            { restoreRecovery: { provider: "utmctl", candidateProviderInstance: "candidate" } },
            { restoreRecovery: { candidateProviderInstance: "fallback" } },
        ];
        const managed = resources.map((resource, index) => ({
            id: `managed-${index}`, status: "stopped", provider: "tart", providerInstance: "owned", ...resource,
        }));
        writeFileSync(macosFile, JSON.stringify({ devices: [...managed, { id: "unmanaged", status: "stopped", provider: "tart", providerInstance: "external" }] }));
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
        const result = pruneOwnerDevices();
        expect(cwdSpy).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ ok: true, text: `owner: ${owner}\npruned: android-owned  backend=android-emulator\npruned: ios-stopped  backend=ios-simulator\npruned: unmanaged  backend=macos-vm\n` });
        expect(fixture.readDevices(macosFile)).toEqual(managed);
    });

    it("rereads under the real operation lock and preserves a stopped successor's full record", () => {
        const cwd = "/project/admin-prune-locked-successor";
        const { androidFile } = fixture.setupFixture(cwd);
        const rows = fixture.readDevices(androidFile), expected = rows[0];
        const successor = { ...expected, nested: { generation: "successor" } };
        const operationLock = join(dirname(androidFile), "operations", createHash("sha256").update(String(expected.id)).digest("hex").slice(0, 32) + ".lock");
        const actualLock = sharedState.withSharedMutationLock;
        let changed = false;
        vi.spyOn(sharedState, "withSharedMutationLock").mockImplementation((file, decide, options) =>
            actualLock(file, () => {
                if (file === operationLock && !changed) {
                    changed = true;
                    expect(nativeFs.existsSync(file)).toBe(true);
                    writeFileSync(androidFile, JSON.stringify({ devices: [successor, ...rows.slice(1)] }));
                }
                return decide();
            }, options)
        );
        const result = pruneOwnerDevices(cwd);
        expect(changed).toBe(true);
        expect(result.text).not.toContain("pruned: android-owned ");
        expect(fixture.readDevices(androidFile)).toEqual([successor, ...rows.slice(1)]);
        expect(nativeFs.existsSync(operationLock)).toBe(false);
    });

    it("publishes physical removal only after releasing the matching lock and aggregate lease", () => {
        const cwd = "/project/admin-prune-native-release";
        const f = matchingDetachedLease(cwd);
        const actualWrite = sharedState.writeJsonFileAtomically, trace: string[] = [];
        vi.spyOn(sharedState, "writeJsonFileAtomically").mockImplementation((file, value) => {
            if (file === f.aggregateFile) trace.push("aggregate");
            if (file === f.androidDeviceFile) {
                trace.push("owner");
                expect(nativeFs.existsSync(f.leaseFile)).toBe(false);
                expect(JSON.parse(readFileSync(f.aggregateFile, "utf8"))).toEqual({ leases: [] });
            }
            return actualWrite(file, value);
        });
        const result = pruneOwnerDevices(cwd);
        expect(result.text).toContain("pruned: android-real  backend=android-device");
        expect(trace).toEqual(["aggregate", "owner"]);
        expect(nativeFs.existsSync(f.leaseFile)).toBe(false);
        expect(fixture.readDeviceIds(f.androidDeviceFile)).toEqual(["android-real-recording:attached"]);
    });

    it("refuses an invalid aggregate without deleting the device or its matching lease", () => {
        const cwd = "/project/admin-prune-native-invalid-lease";
        const f = matchingDetachedLease(cwd);
        writeFileSync(f.aggregateFile, "{invalid");
        const stateBefore = readFileSync(f.androidDeviceFile, "utf8"), lockBefore = readFileSync(f.leaseFile, "utf8");
        expect(() => pruneOwnerDevices(cwd)).toThrow("physical-lease-aggregate-state-invalid");
        expect(readFileSync(f.androidDeviceFile, "utf8")).toBe(stateBefore);
        expect(readFileSync(f.leaseFile, "utf8")).toBe(lockBefore);
        expect(readFileSync(f.aggregateFile, "utf8")).toBe("{invalid");
    });

    it("compensates both lease stores on a raw owner publication failure and rethrows the identical fault", () => {
        const cwd = "/project/admin-prune-native-publication-failure";
        const f = matchingDetachedLease(cwd), fault = { native: "owner publication" };
        const stateBefore = readFileSync(f.androidDeviceFile, "utf8");
        const actualWrite = sharedState.writeJsonFileAtomically, trace: string[] = [];
        vi.spyOn(sharedState, "writeJsonFileAtomically").mockImplementation((file, value) => {
            if (file === f.aggregateFile) trace.push("aggregate");
            if (file === f.leaseFile) trace.push("lease");
            if (file === f.androidDeviceFile) { trace.push("owner"); throw fault; }
            return actualWrite(file, value);
        });
        let caught: unknown;
        try { pruneOwnerDevices(cwd); } catch (error) { caught = error; }
        expect(caught).toBe(fault);
        expect(trace).toEqual(["aggregate", "owner", "lease", "aggregate"]);
        expect(readFileSync(f.androidDeviceFile, "utf8")).toBe(stateBefore);
        expect(JSON.parse(readFileSync(f.leaseFile, "utf8"))).toEqual(f.lease);
        expect(JSON.parse(readFileSync(f.aggregateFile, "utf8"))).toEqual({ leases: [f.lease] });
    });


    it("restores both matching lease stores when locked owner publication sees a concurrent successor", () => {
        const cwd = "/project/admin-prune-native-cas-compensation";
        const f = matchingDetachedLease(cwd);
        const successor = { ...f.current, marker: "successor", status: "attached" };
        const mutationFile = join(dirname(f.androidDeviceFile), "devices.mutation.lock");
        const actualLock = sharedState.withSharedMutationLock;
        let replaced = false;
        vi.spyOn(sharedState, "withSharedMutationLock").mockImplementation((file, decide, options) =>
            actualLock(file, () => {
                if (file === mutationFile && !replaced) {
                    replaced = true;
                    expect(nativeFs.existsSync(f.leaseFile)).toBe(false);
                    expect(JSON.parse(readFileSync(f.aggregateFile, "utf8"))).toEqual({ leases: [] });
                    writeFileSync(f.androidDeviceFile, JSON.stringify({
                        devices: f.devices.map(record => record.id === f.current.id ? successor : record),
                    }));
                }
                return decide();
            }, options)
        );
        const result = pruneOwnerDevices(cwd);
        expect(replaced).toBe(true);
        expect(result.text).not.toContain("pruned: android-real  backend=android-device");
        expect(fixture.readDevices(f.androidDeviceFile)).toEqual(f.devices.map(record => record.id === f.current.id ? successor : record));
        expect(JSON.parse(readFileSync(f.leaseFile, "utf8"))).toEqual(f.lease);
        expect(JSON.parse(readFileSync(f.aggregateFile, "utf8"))).toEqual({ leases: [f.lease] });
    });

    it("retains raw unlink/aggregate-rollback error identities when physical lease release cannot be compensated", () => {
        const cwd = "/project/admin-prune-native-release-rollback";
        const f = matchingDetachedLease(cwd);
        const release = { native: "unlink refused" }, rollback = { native: "aggregate rollback refused" };
        const actualUnlink = nativeFs.unlinkSync, actualWrite = sharedState.writeJsonFileAtomically;
        let aggregateWrites = 0;
        vi.spyOn(nativeFs, "unlinkSync").mockImplementation(file => {
            if (file === f.leaseFile) throw release;
            return actualUnlink(file);
        });
        vi.spyOn(sharedState, "writeJsonFileAtomically").mockImplementation((file, value) => {
            if (file === f.aggregateFile && ++aggregateWrites === 2) throw rollback;
            return actualWrite(file, value);
        });
        let caught: unknown;
        try { pruneOwnerDevices(cwd); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(AggregateError);
        expect((caught as AggregateError).message).toBe("physical-lease-aggregate-rollback-failed");
        expect((caught as AggregateError).errors).toHaveLength(2);
        expect((caught as AggregateError).errors[0]).toBe(release);
        expect((caught as AggregateError).errors[1]).toBe(rollback);
        expect(fixture.readDevices(f.androidDeviceFile)).toEqual(f.devices);
        expect(JSON.parse(readFileSync(f.leaseFile, "utf8"))).toEqual(f.lease);
        expect(JSON.parse(readFileSync(f.aggregateFile, "utf8"))).toEqual({ leases: [] });
    });


    it("preserves raw ordered AggregateError members when both native compensation writes fail", () => {
        const cwd = "/project/admin-prune-native-rollback-failure";
        const f = matchingDetachedLease(cwd);
        const publication = { native: "publication" }, leaseRollback = { native: "lease rollback" }, aggregateRollback = { native: "aggregate rollback" };
        const actualWrite = sharedState.writeJsonFileAtomically, trace: string[] = [];
        let aggregateWrites = 0;
        vi.spyOn(sharedState, "writeJsonFileAtomically").mockImplementation((file, value) => {
            if (file === f.androidDeviceFile) { trace.push("owner"); throw publication; }
            if (file === f.leaseFile) { trace.push("lease"); throw leaseRollback; }
            if (file === f.aggregateFile) {
                trace.push("aggregate");
                if (++aggregateWrites === 2) throw aggregateRollback;
            }
            return actualWrite(file, value);
        });
        let caught: unknown;
        try { pruneOwnerDevices(cwd); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(AggregateError);
        expect((caught as AggregateError).message).toBe("physical-lease-owner-state-rollback-failed");
        expect((caught as AggregateError).errors).toEqual([publication, leaseRollback, aggregateRollback]);
        expect((caught as AggregateError).errors[0]).toBe(publication);
        expect((caught as AggregateError).errors[1]).toBe(leaseRollback);
        expect((caught as AggregateError).errors[2]).toBe(aggregateRollback);
        expect(trace).toEqual(["aggregate", "owner", "lease", "aggregate"]);
        expect(fixture.readDevices(f.androidDeviceFile)).toEqual(f.devices);
        expect(nativeFs.existsSync(f.leaseFile)).toBe(false);
        expect(JSON.parse(readFileSync(f.aggregateFile, "utf8"))).toEqual({ leases: [] });
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

describe("device-admin prune original/current ordered policy", () => {
    it("constructs without observations and resolves the owner before looking at backends", () => {
        const trace: string[] = [];
        const ports: DeviceAdminPrunePorts<PruneBackend> = {
            get backends() { trace.push("backends"); return []; },
            resolveOwnerId(cwd, profile) { trace.push(`owner:${cwd}:${profile}`); return "resolved"; },
            enumerateOwnerIds() { trace.push("owners"); return []; },
            readDevices: () => { throw new Error("unexpected read"); },
            sameRecord: () => { throw new Error("unexpected comparison"); },
            withRecordLock: () => { throw new Error("unexpected lock"); },
            removeRecord: () => { throw new Error("unexpected removal"); },
        };
        const prune = createDeviceAdminPrune(ports);
        expect(trace).toEqual([]);
        expect(prune.owner("/chosen", "profile")).toEqual({ ok: true, text: "owner: resolved\npruned: 0\n" });
        expect(trace).toEqual(["owner:/chosen:profile", "backends"]);
        trace.length = 0;
        expect(prune.allProjects()).toEqual({ ok: true, text: "projects: prune --all-projects\npruned: 0\n" });
        expect(trace).toEqual(["owners"]);
    });

    it("finishes an earlier backend before a later raw read failure, retaining its partial effect", () => {
        const error = { raw: "later backend failed", absent: undefined };
        const stopped = { id: "early", status: "stopped", absent: undefined, nested: new Map([["raw", new Set([1])]]) };
        const pair = pairedPrune({ "first/android": [stopped], "first/macos": [{ id: "later", status: "stopped" }] }, {
            readFault: { owner: "first", backend: "macos", error },
        });
        for (const f of pair) {
            let caught: unknown;
            try { f.prune.owner("/chosen", "profile"); } catch (fault) { caught = fault; }
            expect(caught).toBe(error);
            expect(f.trace).toEqual([
                ["owner", "/chosen", "profile"], ["read", "first", "android"], ["lock", "first", "android", "early"],
                ["read", "first", "android"], ["same", "early"], ["remove", "first", "android", stopped],
                ["read", "first", "macos"],
            ]);
            expect(f.rows).toEqual({ "first/android": [], "first/macos": [{ id: "later", status: "stopped" }] });
            const removed = f.trace.find(row => row[0] === "remove")![3] as typeof stopped;
            expect(Object.hasOwn(removed, "absent")).toBe(true);
            expect(removed.nested).toBeInstanceOf(Map);
            expect(removed.nested.get("raw")).toBeInstanceOf(Set);
        }
        expect(pair[1].trace).toEqual(pair[0].trace);
    });

    it("enumerates once and completes owners in supplied order before a later owner's read fault", () => {
        const error = new Error("second owner read fault");
        const stopped = { id: "early-owner", status: "detached" };
        const pair = pairedPrune({ "second/android": [stopped], "first/android": [{ id: "untouched", status: "stopped" }] }, {
            readFault: { owner: "first", backend: "android", error },
        });
        for (const f of pair) {
            let caught: unknown;
            try { f.prune.allProjects(); } catch (fault) { caught = fault; }
            expect(caught).toBe(error);
            expect(f.trace).toEqual([
                ["owners"], ["read", "second", "android"], ["lock", "second", "android", "early-owner"],
                ["read", "second", "android"], ["same", "early-owner"], ["remove", "second", "android", stopped],
                ["read", "second", "macos"], ["read", "first", "android"],
            ]);
            expect(f.rows["second/android"]).toEqual([]);
            expect(f.rows["first/android"]).toEqual([{ id: "untouched", status: "stopped" }]);
        }
        expect(pair[1].trace).toEqual(pair[0].trace);
    });

    it.each([
        ["replacement", { id: "unit", status: "stopped", nested: { generation: "successor" } }],
        ["running replacement", { id: "unit", status: "running", nested: { generation: "old" } }],
        ["same fields except own undefined", { id: "unit", status: "stopped", nested: { generation: "old" } }],
        ["removed record", null],
    ] as const)("refuses %s between initial read and locked reread", (_name, successor) => {
        const expected = { id: "unit", status: "stopped", absent: undefined, nested: { generation: "old" } };
        const pair = pairedPrune({ "first/android": [expected] }, { successor });
        for (const f of pair) {
            expect(f.prune.owner("/chosen")).toEqual({ ok: true, text: "owner: first\npruned: 0\n" });
            expect(f.trace.slice(0, 4)).toEqual([
                ["owner", "/chosen", undefined], ["read", "first", "android"], ["lock", "first", "android", "unit"], ["read", "first", "android"],
            ]);
            expect(f.trace.filter(row => row[0] === "remove")).toEqual([]);
            expect(f.rows["first/android"]).toEqual(successor === null ? [] : [successor]);
        }
        expect(pair[1].trace).toEqual(pair[0].trace);
    });

    it("locks each identified record but only prunes exact stopped/detached values, retaining order and zero formatting", () => {
        const rows = [
            { status: "stopped" }, { id: "stopped", status: "stopped" }, { id: "detached", status: "detached" },
            { id: "running", status: "running" }, { id: "attached", status: "attached" },
            { id: "upper", status: "STOPPED" }, { id: "unknown" },
        ];
        const pair = pairedPrune({ "first/android": rows });
        for (const f of pair) {
            expect(f.prune.owner("/chosen")).toEqual({ ok: true, text: "owner: first\npruned: stopped  backend=android-emulator\npruned: detached  backend=android-emulator\n" });
            expect(f.rows["first/android"]).toEqual([rows[0], ...rows.slice(3)]);
            expect(f.trace.filter(row => row[0] === "lock").map(row => row[3])).toEqual(["stopped", "detached", "running", "attached", "upper", "unknown"]);
            expect(f.trace.filter(row => row[0] === "remove").map(row => (row[3] as DeviceAdminPruneRecord).id)).toEqual(["stopped", "detached"]);
            expect(f.prune.owner("/chosen").text).toBe("owner: first\npruned: 0\n");
        }
        expect(pair[1].trace).toEqual(pair[0].trace);
    });

    it.each([
        ["managed flag", { providerResourceManaged: true }],
        ["created image", { provisioning: "image-created" }],
        ["cloned image", { provisioning: "image-cloned" }],
        ["image source", { imageSource: "base" }],
        ["clone source", { clonedFrom: "base" }],
        ["created timestamp", { imageCreatedAt: "raw-time" }],
        ["cloned timestamp", { clonedAt: "raw-time" }],
        ["snapshot", { snapshots: [{ provider: "vz", providerInstance: "snapshot" }] }],
        ["recovery provider", { restoreRecovery: { provider: "utmctl", candidateProviderInstance: "candidate" } }],
        ["recovery fallback", { restoreRecovery: { candidateProviderInstance: "candidate" } }],
    ])("refuses managed macOS %s while permitting the same raw fields on another backend", (_name, resource) => {
        const record = { id: "unit", status: "stopped", provider: "tart", providerInstance: "owned", ...resource };
        const pair = pairedPrune({ "first/android": [record], "first/macos": [record] });
        for (const f of pair) {
            expect(f.prune.owner("/chosen")).toEqual({ ok: true, text: "owner: first\npruned: unit  backend=android-emulator\n" });
            expect(f.rows["first/android"]).toEqual([]);
            expect(f.rows["first/macos"]).toEqual([record]);
            expect(f.trace.filter(row => row[0] === "remove").map(row => row[2])).toEqual(["android"]);
        }
        expect(pair[1].trace).toEqual(pair[0].trace);
    });

    it("preserves original raw metadata coercion and ignores incomplete provider resource descriptions", () => {
        const records = [
            { id: "false-flags", status: "stopped", provider: "tart", providerInstance: "owned", providerResourceManaged: false, imageSource: "", clonedAt: 0 },
            { id: "missing-instance", status: "detached", provider: "tart", providerResourceManaged: true },
            { id: "malformed-snapshot", status: "stopped", snapshots: [null, "raw", { provider: 4, providerInstance: "x" }, { provider: "tart" }] },
            { id: "empty-recovery", status: "stopped", provider: "tart", restoreRecovery: { provider: "", candidateProviderInstance: "x" } },
        ];
        const pair = pairedPrune({ "first/macos": records });
        for (const f of pair) {
            expect(f.prune.owner("/chosen").text).toBe("owner: first\npruned: false-flags  backend=macos-vm\npruned: missing-instance  backend=macos-vm\npruned: malformed-snapshot  backend=macos-vm\npruned: empty-recovery  backend=macos-vm\n");
            expect(f.rows["first/macos"]).toEqual([]);
        }
        expect(pair[1].trace).toEqual(pair[0].trace);
    });

    it("prints only committed removals in supplied owner/backend/record order", () => {
        const pair = pairedPrune({
            "second/android": [{ id: "z", status: "stopped" }, { id: "a", status: "detached" }],
            "second/macos": [{ id: "m", status: "stopped" }],
            "first/android": [{ id: "f", status: "detached" }],
        });
        for (const f of pair) expect(f.prune.allProjects()).toEqual({
            ok: true,
            text: "projects: prune --all-projects\nproject: second\npruned: z  backend=android-emulator\npruned: a  backend=android-emulator\npruned: m  backend=macos-vm\nproject: first\npruned: f  backend=android-emulator\n",
        });
        expect(pair[1].trace).toEqual(pair[0].trace);
        for (const f of pairedPrune({ "first/android": [{ id: "unit", status: "stopped" }] }, { removeResult: false })) {
            expect(f.prune.owner("/chosen")).toEqual({ ok: true, text: "owner: first\npruned: 0\n" });
            expect(f.rows["first/android"]).toEqual([{ id: "unit", status: "stopped" }]);
        }
    });

    it("propagates a raw native AggregateError unchanged and stops subsequent reads", () => {
        const publication = { native: "publish" }, rollback = { native: "rollback" };
        const fault = new AggregateError([publication, rollback], "physical-lease-owner-state-rollback-failed");
        const pair = pairedPrune({ "first/android": [{ id: "unit", status: "detached" }] }, { removeFault: fault });
        for (const f of pair) {
            let caught: unknown;
            try { f.prune.owner("/chosen"); } catch (error) { caught = error; }
            expect(caught).toBe(fault);
            expect((caught as AggregateError).errors[0]).toBe(publication);
            expect((caught as AggregateError).errors[1]).toBe(rollback);
            expect(f.trace.filter(row => row[0] === "read").map(row => row[2])).toEqual(["android", "android"]);
            expect(f.rows["first/android"]).toEqual([{ id: "unit", status: "detached" }]);
        }
        expect(pair[1].trace).toEqual(pair[0].trace);
    });
});

