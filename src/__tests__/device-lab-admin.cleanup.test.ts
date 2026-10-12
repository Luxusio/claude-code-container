import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { spawn } from "child_process";
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
import { readDeviceRuntimeProcessIdentity } from "@ccc/device-lab/device-lab-process-identity.js";
import { createDeviceLabAdminTestFixture } from "./helpers/device-lab-admin-fixture.js";
import * as nativeFs from "fs";
import { isDeepStrictEqual } from "util";
import * as ownerState from "@ccc/device-lab/device-lab-owner-state.js";
import * as sharedState from "@ccc/device-lab/device-lab-shared-state.js";
import * as session from "../session.js";
import * as nativeCleanup from "../device-lab-cleanup.js";
import { getProjectId } from "../utils.js";
import { createDeviceAdminCleanup, createDeviceAdminAllProjectCleanup } from "../application/device-admin-cleanup.js";
import type { DeviceAdminCleanupPorts, DeviceAdminAllProjectCleanupPorts } from "../ports/device-admin-cleanup.js";
import type { CleanupBackend, CleanupRecord, CleanupCommandResult } from "../domain/device-admin-cleanup.js";
import { createDeviceAdminDelete } from "../application/device-admin-delete.js";
import type { DeviceAdminDeletePorts } from "../ports/device-admin-delete.js";

describe("semantic device deletion authority", () => {
    function deletionTrace(outcome: "success" | "failure" | "no-result" = "success", matched = true) {
        const trace: unknown[][] = [];
        const record: CleanupRecord = {
            id: "owned", status: "stopped", providerResourceManaged: true, provider: "tart", providerInstance: "main",
            snapshots: [{ id: "a", provider: "tart", providerInstance: "repeat" }, { id: "b", provider: "tart", providerInstance: "repeat" }],
            restoreRecovery: { provider: "tart", candidateProviderInstance: "later" },
        };
        const lease = { ownerId: "owner", deviceId: "owned", hardwareId: "hardware" };
        const receipts: { identity: string; attempt: number }[] = [];
        const ports: DeviceAdminDeletePorts<CleanupBackend, (typeof receipts)[number]> = {
            withRecordLock: (_owner, _backend, _id, operation) => { trace.push(["record-lock"]); return operation(); },
            readDevices: () => { trace.push(["fresh-read"]); return [record]; },
            sameRecord: (current, expected) => { trace.push(["compare"]); return isDeepStrictEqual(current, expected); },
            hardwareId: () => "hardware",
            withLeaseLock: (_owner, _backend, _record, _hardware, operation) => {
                trace.push(["lease-lock"]);
                return operation({
                    readLease: () => { trace.push(["lease-read"]); return lease; },
                    readAggregate: () => { trace.push(["aggregate-read"]); return [lease]; },
                    writeAggregate: next => { trace.push(["aggregate-write", next]); return undefined; },
                    writeLease: () => { throw new Error("unexpected compensation"); },
                    removeLease: () => { trace.push(["lease-remove"]); return undefined; },
                });
            },
            sameAggregate: isDeepStrictEqual,
            missingLease: () => false,
            deleteManagedResource: (provider, instance, timeout) => {
                trace.push(["delete", provider, instance, timeout]);
                if (outcome === "no-result") return { state: "no-result" };
                const evidence = { identity: instance, attempt: receipts.length };
                receipts.push(evidence);
                return { state: outcome === "failure" && instance === "repeat" ? "failure" : "success", evidence };
            },
            releaseWindowsClaim: () => { trace.push(["windows-claim"]); return undefined; },
            transitionRecord: () => { trace.push(["cas"]); return { matched }; },
        };
        return { policy: createDeviceAdminDelete(ports), ports, record, trace, receipts };
    }

    it.each([true, false])("releases the matching lease, then Windows claim, then performs final CAS (matched=%s)", matched => {
        const { policy, record, trace, receipts } = deletionTrace("success", matched);
        const result = policy.deleteDevice("owner", { stateKey: "macos", name: "macos-vm" }, "owned", record, 1234);
        expect(trace).toEqual([
            ["record-lock"], ["fresh-read"], ["compare"],
            ["delete", "tart", "repeat", 1234], ["delete", "tart", "repeat", 1234],
            ["delete", "tart", "later", 1234], ["delete", "tart", "main", 1234],
            ["lease-lock"], ["lease-read"], ["aggregate-read"], ["aggregate-write", []], ["lease-remove"], ["windows-claim"], ["cas"],
        ]);
        expect(result).toEqual(matched ? { ok: true, evidence: receipts } : { ok: false, reason: "owner-device-state-conflict", evidence: receipts });
        result.evidence.forEach((evidence, index) => expect(evidence).toBe(receipts[index]));
    });

    it("attempts later and repeated resources after failure, retains evidence, and refuses before authority effects", () => {
        const { policy, record, trace, receipts } = deletionTrace("failure");
        const result = policy.deleteDevice("owner", { stateKey: "macos", name: "macos-vm" }, "owned", record);
        expect(trace).toEqual([
            ["record-lock"], ["fresh-read"], ["compare"], ["delete", "tart", "repeat", undefined],
            ["delete", "tart", "repeat", undefined], ["delete", "tart", "later", undefined], ["delete", "tart", "main", undefined],
        ]);
        expect(result).toEqual({ ok: false, reason: "provider-delete-failed", evidence: receipts });
        expect(receipts.map(receipt => receipt.identity)).toEqual(["repeat", "repeat", "later", "main"]);
    });

    it("continues after native no-result without inventing receipt evidence", () => {
        const { policy, record, trace } = deletionTrace("no-result");
        const result = policy.deleteDevice("owner", { stateKey: "macos", name: "macos-vm" }, "owned", record);
        expect(result).toEqual({ ok: true, evidence: [] });
        expect(trace.filter(event => event[0] === "delete")).toHaveLength(4);
        expect(trace.slice(-3)).toEqual([["lease-remove"], ["windows-claim"], ["cas"]]);
    });

    it("preserves a Windows claim exception after provider deletion and prevents CAS", () => {
        const { ports, record, trace } = deletionTrace();
        const failure = new Error("claim-release");
        ports.releaseWindowsClaim = () => { trace.push(["windows-claim"]); throw failure; };
        let caught: unknown;
        try { createDeviceAdminDelete(ports).deleteDevice("owner", { stateKey: "macos", name: "macos-vm" }, "owned", record); }
        catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(trace.filter(event => event[0] === "delete")).toHaveLength(4);
        expect(trace.at(-1)).toEqual(["windows-claim"]);
        expect(trace.some(event => event[0] === "cas")).toBe(false);
    });
});

vi.mock("fs", async original => ({ ...await original<typeof import("fs")>() }));
vi.mock("../device-lab-cleanup.js", async original => ({ ...await original<typeof import("../device-lab-cleanup.js")>() }));
vi.mock("@ccc/device-lab/device-lab-owner-state.js", async original => ({
    ...await original<typeof import("@ccc/device-lab/device-lab-owner-state.js")>(),
}));
vi.mock("@ccc/device-lab/device-lab-shared-state.js", async original => ({
    ...await original<typeof import("@ccc/device-lab/device-lab-shared-state.js")>(),
}));
type CleanupRows = Record<string, CleanupRecord[]>;
type CleanupTraceOptions = {
    backends?: CleanupBackend[];
    owners?: string[];
    readFault?: { owner: string; backend: string; error: unknown };
    successor?: CleanupRecord | null;
    appiumBlock?: string;
    runtimeBlock?: string;
    exited?: boolean;
    signalOk?: boolean;
    waitOk?: boolean;
    unavailable?: readonly string[];
    commandStatus?: number | null;
    failedTarget?: string;
    commandFault?: unknown;
    commandNull?: boolean;
    hardwareId?: string | null;
    matched?: boolean;
    transitionFault?: unknown;
    releaseFault?: unknown;
};
const cleanupAndroid: CleanupBackend = { stateKey: "android", name: "android-emulator" };
const cleanupWindows: CleanupBackend = { stateKey: "windows", name: "windows-sandbox" };
const cleanupPhysicalIos: CleanupBackend = { stateKey: "ios-device", name: "ios-device" };

function cleanupTrace( initial: CleanupRows, options: CleanupTraceOptions = {}) {
    const rows = structuredClone(initial), trace: unknown[][] = [];
    let replaced = false;
    const publish = (kind: string, owner: string, backend: CleanupBackend, expected: CleanupRecord, replacement: CleanupRecord) => {
        trace.push([kind, owner, backend.stateKey, structuredClone(expected), structuredClone(replacement)]);
        if (Object.hasOwn(options, "transitionFault")) throw options.transitionFault;
        if (options.matched === false) return false;
        rows[`${owner}/${backend.stateKey}`] = rows[`${owner}/${backend.stateKey}`].map(record => record.id === expected.id ? structuredClone(replacement) : record);
        return true;
    };
    const ports: DeviceAdminAllProjectCleanupPorts<CleanupBackend> = {
        backends: options.backends || [cleanupAndroid],
        resolveOwnerId(cwd, profile) { trace.push(["owner", cwd, profile]); return "owner"; },
        enumerateOwnerIds() { trace.push(["owners"]); return options.owners || ["later", "owner"]; },
        readDevices(owner, backend) {
            trace.push(["read", owner, backend]);
            if (options.readFault?.owner === owner && options.readFault.backend === backend) throw options.readFault.error;
            return structuredClone(rows[`${owner}/${backend}`] || []);
        },
        sameRecord(current, expected) { trace.push(["same", current.id]); return isDeepStrictEqual(current, expected); },
        withRecordLock(owner, backend, id, decide) {
            trace.push(["lock", owner, backend, id]);
            if (!replaced && Object.hasOwn(options, "successor")) {
                replaced = true;
                rows[`${owner}/${backend}`] = rows[`${owner}/${backend}`].flatMap(record =>
                    record.id !== id ? [record] : options.successor === null ? [] : [structuredClone(options.successor!)]
                );
            }
            return decide();
        },
        appiumCleanupBlock(record) { trace.push(["appium-block", record.id]); return options.appiumBlock || null; },
        runtimeCleanupBlock(record) { trace.push(["runtime-block", record.id]); return options.runtimeBlock || null; },
        runtimeExited(runtime) { trace.push(["exited", runtime.label]); return options.exited === true; },
        signalRuntime(runtime, signal) { trace.push(["signal", runtime.runtimeId, signal]); return { ok: options.signalOk !== false }; },
        waitForRuntimeExit(runtime, timeout) { trace.push(["wait", runtime.label, timeout]); return options.waitOk !== false; },
        executeStopEffects(effects, timeout) {
            trace.push(["effects", structuredClone(effects), timeout]);
            if (Object.hasOwn(options, "commandFault")) throw options.commandFault;
            const commands: CleanupCommandResult[] = effects.flatMap(effect => {
                if (options.commandNull) return [];
                const status = options.failedTarget && options.failedTarget === effect.device.serial ? 17
                    : Object.hasOwn(options, "commandStatus") ? options.commandStatus!
                    : options.unavailable?.length ? null : 0;
                return [{ command: effect.kind, status, stdout: "raw stdout", stderr: "raw stderr", absent: undefined } as CleanupCommandResult];
            });
            return { ok: commands.length > 0 && commands.every(command => command.status === 0), commands };
        },
        timestamp() { trace.push(["time"]); return "raw-time"; },
        hardwareId(_backend, record) { trace.push(["hardware", record.id]); return options.hardwareId || null; },
        transitionRecord(owner, backend, expected, replacement) { return { matched: publish("publish", owner, backend, expected, replacement) }; },
        transitionPhysicalRecord(owner, backend, expected, replacement) { return publish("physical-publish", owner, backend, expected, replacement); },
        releaseWindowsClaim(owner, backend, record) {
            trace.push(["release", owner, backend.stateKey, record.id]);
            expect(rows[`${owner}/${backend.stateKey}`].find(candidate => candidate.id === record.id)?.status).toBe("stopped");
            if (Object.hasOwn(options, "releaseFault")) throw options.releaseFault;
            return undefined;
        },
    };
    const policy = { ...createDeviceAdminCleanup(ports), ...createDeviceAdminAllProjectCleanup(ports) };
    return { policy, ports, rows, trace };
}
const cleanupFixtures = (rows: CleanupRows, options?: CleanupTraceOptions) => [cleanupTrace(rows, options)];

// Compile-only required/synchronous contracts. The owned strict draft includes
// both cleanup and prune tests; this function is intentionally never invoked.
function requiredSynchronousCleanupPortTypes(
    valid: DeviceAdminCleanupPorts<CleanupBackend>,
    all: DeviceAdminAllProjectCleanupPorts<CleanupBackend>,
) {
    const without = <Key extends keyof DeviceAdminCleanupPorts<CleanupBackend>>(key: Key) => {
        const { [key]: omitted, ...remaining } = valid;
        void omitted;
        return remaining;
    };
    const accept = (ports: DeviceAdminCleanupPorts<CleanupBackend>) => createDeviceAdminCleanup(ports);
    // @ts-expect-error backends is a required native leaf
    accept(without("backends"));
    // @ts-expect-error resolveOwnerId is a required native leaf
    accept(without("resolveOwnerId"));
    // @ts-expect-error readDevices is a required native leaf
    accept(without("readDevices"));
    // @ts-expect-error sameRecord is a required native leaf
    accept(without("sameRecord"));
    // @ts-expect-error withRecordLock is a required native leaf
    accept(without("withRecordLock"));
    // @ts-expect-error appiumCleanupBlock is a required native leaf
    accept(without("appiumCleanupBlock"));
    // @ts-expect-error runtimeCleanupBlock is a required native leaf
    accept(without("runtimeCleanupBlock"));
    // @ts-expect-error runtimeExited is a required native leaf
    accept(without("runtimeExited"));
    // @ts-expect-error signalRuntime is a required native leaf
    accept(without("signalRuntime"));
    // @ts-expect-error waitForRuntimeExit is a required native leaf
    accept(without("waitForRuntimeExit"));
    // @ts-expect-error finite stop execution is required
    accept(without("executeStopEffects"));
    // @ts-expect-error timestamp is a required native leaf
    accept(without("timestamp"));
    // @ts-expect-error hardwareId is a required native leaf
    accept(without("hardwareId"));
    // @ts-expect-error transitionRecord is a required native leaf
    accept(without("transitionRecord"));
    // @ts-expect-error transitionPhysicalRecord is a required native leaf
    accept(without("transitionPhysicalRecord"));
    // @ts-expect-error releaseWindowsClaim is a required native leaf
    accept(without("releaseWindowsClaim"));
    const { enumerateOwnerIds: omittedOwners, ...withoutOwners } = all;
    void omittedOwners;
    // @ts-expect-error all-project traversal requires enumeration
    createDeviceAdminAllProjectCleanup(withoutOwners);
    // @ts-expect-error backends must remain synchronous
    accept({ ...valid, backends: Promise.resolve(valid.backends) });
    // @ts-expect-error resolveOwnerId must remain synchronous
    accept({ ...valid, resolveOwnerId: async () => "owner" });
    // @ts-expect-error readDevices must remain synchronous
    accept({ ...valid, readDevices: async () => [] });
    // @ts-expect-error sameRecord must remain synchronous
    accept({ ...valid, sameRecord: async () => true });
    // @ts-expect-error withRecordLock must remain synchronous
    accept({ ...valid, withRecordLock: async (_owner, _backend, _id, decide) => decide() });
    // @ts-expect-error appiumCleanupBlock must remain synchronous
    accept({ ...valid, appiumCleanupBlock: async () => null });
    // @ts-expect-error runtimeCleanupBlock must remain synchronous
    accept({ ...valid, runtimeCleanupBlock: async () => null });
    // @ts-expect-error runtimeExited must remain synchronous
    accept({ ...valid, runtimeExited: async () => true });
    // @ts-expect-error signalRuntime must remain synchronous
    accept({ ...valid, signalRuntime: async () => ({ ok: true }) });
    // @ts-expect-error waitForRuntimeExit must remain synchronous
    accept({ ...valid, waitForRuntimeExit: async () => true });
    // @ts-expect-error semantic stop results must settle before lifecycle publication
    accept({ ...valid, executeStopEffects: async () => ({ ok: true, commands: [] }) });
    // @ts-expect-error timestamp must remain synchronous
    accept({ ...valid, timestamp: async () => "raw-time" });
    // @ts-expect-error hardwareId must remain synchronous
    accept({ ...valid, hardwareId: async () => null });
    // @ts-expect-error transitionRecord must remain synchronous
    accept({ ...valid, transitionRecord: async () => ({ matched: true }) });
    // @ts-expect-error transitionPhysicalRecord must remain synchronous
    accept({ ...valid, transitionPhysicalRecord: async () => true });
    // @ts-expect-error releaseWindowsClaim must remain synchronous
    accept({ ...valid, releaseWindowsClaim: async () => undefined });
    // @ts-expect-error all-project owner enumeration is synchronous
    createDeviceAdminAllProjectCleanup({ ...all, enumerateOwnerIds: async () => [] });
}
void requiredSynchronousCleanupPortTypes;


const cleanupOutcome = (backend: string, previousStatus: string, status: "stopped" | "failed" | "skipped", reason?: string) => ({
    id: "unit", backend, previousStatus, status, commands: [], ...(reason ? { reason } : {}),
});


// Keep the subprocess namespace spyable while preserving actual process execution.
vi.mock("child_process", async (importOriginal) => ({
    ...await importOriginal<typeof import("child_process")>(),
}));


describe("device-admin cleanup current policy traces", () => {
    it("returns empty semantic owner and all-project reports", () => {
        const f = cleanupTrace({}, { owners: [], backends: [] });
        expect(f.policy.owner("/chosen", 17, "profile")).toEqual({ ownerId: "owner", results: [] });
        expect(f.policy.allProjects()).toEqual({ ok: true, projects: [] });
    });

    it.each([{ commands: [] }, { commands: [{ command: "opaque successful diagnostic", status: 0 }] }])("refuses active lifecycle publication when the semantic aggregate fails (%j)", ({ commands }) => {
        const record = { id: "unit", status: "running", serial: "owned" };
        const f = cleanupTrace({ "owner/android": [record] });
        f.ports.executeStopEffects = () => ({ ok: false, commands });
        const result = f.policy.owner("/chosen").results[0];
        expect(result).toEqual({
            id: "unit", backend: "android-emulator", previousStatus: "running", status: "failed",
            reason: "provider-stop-failed", commands,
        });
        expect(f.rows["owner/android"]).toEqual([record]);
        expect(f.trace.filter(event => ["publish", "physical-publish", "release"].includes(String(event[0])))).toEqual([]);
    });

    it("accepts semantic stop success while carrying opaque diagnostic status unchanged", () => {
        const record = { id: "unit", status: "running", serial: "owned" };
        const f = cleanupTrace({ "owner/android": [record] });
        const commands = [{ command: "opaque native receipt", status: null, stderr: "native diagnostic" }];
        f.ports.executeStopEffects = () => ({ ok: true, commands });
        expect(f.policy.owner("/chosen").results[0]).toEqual({
            id: "unit", backend: "android-emulator", previousStatus: "running", status: "stopped", commands,
        });
        expect(f.rows["owner/android"][0].status).toBe("stopped");
    });

    it("cleans inactive auxiliary metadata even when no lifecycle command succeeds", () => {
        const record = { id: "unit", status: "stopped", pid: 99 };
        const f = cleanupTrace({ "owner/android": [record] }, { commandNull: true });
        expect(f.policy.owner("/chosen").results).toEqual([cleanupOutcome("android-emulator", "stopped", "stopped")]);
        expect(f.rows["owner/android"][0].pid).toBeNull();
    });

    it("cleans stopped auxiliary metadata in signal/provider/wait/publication order while preserving open carriers", () => {
        const recording = { runtimeId: "recording", pid: 41, processIdentity: { raw: "birth" }, active: true };
        const appium = { processOwner: "device-lab-mcp", startedBy: "direct-provider", runtimeId: "appium", serverPid: 42, processIdentity: { raw: "birth" } };
        const runtime = { runtimeId: "runtime", pid: 43, processIdentity: { raw: "birth" } };
        const record = { id: "unit", status: "stopped", serial: "emulator-7", pid: 99, recording, appium, runtime, absent: undefined, nested: new Map([["raw", new Set([1])]]) };
        const replacement = { ...record, status: "stopped", pid: null, recording: null, appium: null, updatedAt: "raw-time" };
        const command = { command: "android-recording-stop", status: 0, stdout: "raw stdout", stderr: "raw stderr", absent: undefined };
        const pair = cleanupFixtures({ "owner/android": [record] });
        for (const f of pair) {
            expect(f.policy.owner("/chosen", 37, "profile")).toEqual({
                ownerId: "owner", results: [{ id: "unit", backend: "android-emulator", previousStatus: "stopped", status: "stopped", commands: [command] }],
            });
            expect(f.trace.filter(event => event[0] === "signal")).toEqual([["signal", "recording", "SIGINT"], ["signal", "appium", "SIGTERM"]]);
            expect(f.trace.filter(event => event[0] === "effects")).toEqual([["effects", [{ kind: "android-recording-stop", device: record }], 37]]);
            expect(f.trace.filter(event => event[0] === "wait")).toEqual([["wait", "recording", 37], ["wait", "appium", 37], ["wait", "runtime", 37]]);
            expect(f.trace.findIndex(event => event[0] === "effects")).toBeLessThan(f.trace.findIndex(event => event[0] === "wait"));
            expect(f.trace.findIndex(event => event[0] === "wait")).toBeLessThan(f.trace.findIndex(event => event[0] === "publish"));
            expect(f.rows["owner/android"]).toEqual([replacement]);
            expect(Object.hasOwn(f.rows["owner/android"][0], "absent")).toBe(true);
            expect(f.rows["owner/android"][0].nested).toBeInstanceOf(Map);
            expect((f.rows["owner/android"][0].nested as Map<string, unknown>).get("raw")).toBeInstanceOf(Set);
            expect(f.rows["owner/android"][0].runtime).toEqual(runtime);
        }
    });

    it("completes earlier backend effects before a later raw read error", () => {
        const record = { id: "unit", status: "stopped", pid: 9 }, fault = { raw: "later read", absent: undefined };
        const pair = cleanupFixtures({ "owner/android": [record], "owner/ios-device": [{ id: "later", status: "attached" }] }, {
            backends: [cleanupAndroid, cleanupPhysicalIos], readFault: { owner: "owner", backend: "ios-device", error: fault },
        });
        for (const f of pair) {
            let caught: unknown;
            try { f.policy.owner("/chosen"); } catch (error) { caught = error; }
            expect(caught).toBe(fault);
            expect(f.rows).toEqual({
                "owner/android": [{ ...record, pid: null, appium: null, recording: null, updatedAt: "raw-time" }],
                "owner/ios-device": [{ id: "later", status: "attached" }],
            });
            expect(f.trace.at(-1)).toEqual(["read", "owner", "ios-device"]);
        }
    });

    it("completes an earlier owner's effects before a later owner read error without eager inventory", () => {
        const fault = new Error("later owner failed"), record = { id: "unit", status: "stopped", pid: 9 };
        const pair = cleanupFixtures({ "later/android": [record], "owner/android": [{ id: "untouched", status: "running" }] }, {
            readFault: { owner: "owner", backend: "android", error: fault },
        });
        for (const f of pair) {
            let caught: unknown;
            try { f.policy.allProjects(37); } catch (error) { caught = error; }
            expect(caught).toBe(fault);
            expect(f.rows["later/android"]).toEqual([{ ...record, pid: null, appium: null, recording: null, updatedAt: "raw-time" }]);
            expect(f.rows["owner/android"]).toEqual([{ id: "untouched", status: "running" }]);
            expect(f.trace[0]).toEqual(["owners"]);
            expect(f.trace.at(-1)).toEqual(["read", "owner", "android"]);
            expect(f.trace.filter(row => row[0] === "release")).toEqual([]);
            expect(f.trace.findIndex(row => row[0] === "publish")).toBeLessThan(f.trace.length - 1);
        }
    });

    it.each([
        ["changed field", { id: "unit", status: "running", serial: "successor" }],
        ["lost own undefined", { id: "unit", status: "running", serial: "old" }],
        ["disappearance", null],
    ] as const)("refuses %s after acquiring the per-record lock before native effects", (_name, successor) => {
        const record = { id: "unit", status: "running", serial: "old", absent: undefined };
        const pair = cleanupFixtures({ "owner/android": [record] }, { successor });
        for (const f of pair) {
            expect(f.policy.owner("/chosen").results).toEqual([cleanupOutcome("android-emulator", "running", "failed", "owner-device-state-conflict")]);
            expect(f.trace.filter(row => ["effects", "signal", "wait", "publish", "physical-publish", "release"].includes(String(row[0])))).toEqual([]);
            expect(f.rows["owner/android"]).toEqual(successor === null ? [] : [successor]);
        }
    });

    it.each([
        ["appium-runtime-active", "appium"], ["appium-runtime-identity-unavailable", "appium"],
        ["recording-runtime-active", "runtime"], ["recording-runtime-identity-unavailable", "runtime"],
    ])("preserves native %s refusal without invoking provider or publication leaves", (reason, leaf) => {
        const record = { id: "unit", status: "running", serial: "owned" };
        const pair = cleanupFixtures({ "owner/android": [record] }, leaf === "appium" ? { appiumBlock: reason } : { runtimeBlock: reason });
        for (const f of pair) {
            expect(f.policy.owner("/chosen").results).toEqual([cleanupOutcome("android-emulator", "running", "failed", reason)]);
            expect(f.rows["owner/android"]).toEqual([record]);
            expect(f.trace.filter(row => ["effects", "exited", "signal", "wait", "hardware", "publish", "release"].includes(String(row[0])))).toEqual([]);
            expect(f.trace.some(row => row[0] === "runtime-block")).toBe(leaf !== "appium");
        }
    });

    it.each([
        ["recording signal refusal", { signalOk: false }, "recording-process-signal-failed"],
        ["recording wait refusal", { waitOk: false }, "recording-process-still-active"],
        ["provider failure", { commandStatus: 17 }, "provider-stop-failed"],
        ["missing executable", { unavailable: ["adb"] }, "provider-stop-failed"],
        ["null command result", { commandNull: true }, "provider-stop-failed"],
    ] as const)("preserves %s with the original record available for retry", (_name, options, reason) => {
        const record = { id: "unit", status: "running", serial: "owned", recording: { runtimeId: "recording", pid: 41, processIdentity: { raw: "birth" } } };
        const pair = cleanupFixtures({ "owner/android": [record] }, options);
        for (const f of pair) {
            const result = f.policy.owner("/chosen", 37).results[0];
            expect(result.status).toBe("failed");
            expect(result.reason).toBe(reason);
            expect(f.rows["owner/android"]).toEqual([record]);
            expect(f.trace.filter(row => ["publish", "physical-publish", "release", "time"].includes(String(row[0])))).toEqual([]);
            if (reason === "recording-process-signal-failed") expect(f.trace.filter(row => ["effects", "wait"].includes(String(row[0])))).toEqual([]);
            if (reason === "recording-process-still-active") expect(result.commands).toHaveLength(2);
            if (reason === "provider-stop-failed") expect(f.trace.at(-1)).toEqual(["wait", "recording", 37]);
        }
    });

    it("does not signal already exited runtimes or foreign Appium metadata and retains direct wait order", () => {
        const record = {
            id: "unit", status: "stopped", pid: 9,
            appium: { processOwner: "foreign", startedBy: "foreign", runtimeId: "foreign", serverPid: 42, processIdentity: { raw: "birth" } },
            recording: { runtimeId: "recording", pid: 41, processIdentity: { raw: "birth" } },
        };
        const pair = cleanupFixtures({ "owner/android": [record] }, { exited: true });
        for (const f of pair) {
            expect(f.policy.owner("/chosen", 37).results[0].status).toBe("stopped");
            expect(f.trace.filter(row => row[0] === "signal")).toEqual([]);
            expect(f.trace.filter(row => row[0] === "exited")).toEqual([["exited", "recording"]]);
            expect(f.trace.filter(row => row[0] === "wait")).toEqual([["wait", "recording", 37]]);
        }
    });

    it.each([
        ["android", { id: "unit", status: "running", port: 5554 }, "android-emulator-stop"],
        ["android-device", { id: "unit", status: "attached", serial: "physical", recording: { active: true } }, "android-recording-stop"],
        ["ios", { id: "unit", status: "booted", simulatorName: "fallback" }, "ios-simulator-stop"],
        ["windows", { id: "unit", status: "starting", sandboxId: "12345678-1234-4234-9234-1234567890ab" }, "windows-sandbox-stop"],
        ["macos", { id: "unit", status: "running", provider: "tart", providerInstance: "owned" }, "macos-instance-stop"],
    ] as const)("selects the finite %s stop intent with the owned record", (stateKey, record, kind) => {
        const f = cleanupTrace({ [`owner/${stateKey}`]: [record] }, {
            backends: [{ stateKey, name: stateKey }], ...(stateKey === "android-device" ? { hardwareId: "physical" } : {}),
        });
        expect(f.policy.owner("/chosen", 37).results[0].status).toBe("stopped");
        expect(f.trace.filter(event => event[0] === "effects")).toEqual([["effects", [{ kind, device: record }], 37]]);
        expect(f.rows[`owner/${stateKey}`][0].status).toBe(stateKey === "android-device" ? "detached" : "stopped");
    });

    it("uses the physical transition for iOS without executable lookup or power-off commands", () => {
        const record = { id: "unit", status: "attached", udid: "owned" };
        const pair = cleanupFixtures({ "owner/ios-device": [record] }, { backends: [cleanupPhysicalIos], hardwareId: "owned" });
        for (const f of pair) {
            expect(f.policy.owner("/chosen", 37).results).toEqual([cleanupOutcome("ios-device", "attached", "stopped")]);
            expect(f.trace.filter(row => ["publish", "release"].includes(String(row[0])))).toEqual([]);
            expect(f.trace.filter(row => row[0] === "effects")).toEqual([["effects", [], 37]]);
            expect(f.trace.filter(row => row[0] === "physical-publish")).toEqual([
                ["physical-publish", "owner", "ios-device", record, { ...record, status: "detached", pid: null, appium: null, recording: null, updatedAt: "raw-time" }],
            ]);
        }
    });

    it("keeps the current-owner Windows release flag after matching publication while all-project stop omits it", () => {
        const record = { id: "unit", status: "running", sandboxId: "12345678-1234-4234-9234-1234567890ab" };
        {
            const currentOwner = cleanupTrace({ "owner/windows": [record] }, { backends: [cleanupWindows] });
            expect(currentOwner.policy.owner("/chosen").results[0].status).toBe("stopped");
            expect(currentOwner.trace.slice(-2).map(row => row[0])).toEqual(["publish", "release"]);
            const all = cleanupTrace({ "owner/windows": [record] }, { backends: [cleanupWindows], owners: ["owner"] });
            expect(all.policy.allProjects().ok).toBe(true);
            expect(all.trace.filter(row => row[0] === "release")).toEqual([]);
            const refused = cleanupTrace({ "owner/windows": [record] }, { backends: [cleanupWindows], matched: false });
            expect(refused.policy.owner("/chosen").results[0].reason).toBe("owner-device-state-conflict");
            expect(refused.trace.filter(row => row[0] === "release")).toEqual([]);
            expect(refused.rows["owner/windows"]).toEqual([record]);
        }
    });

    it("preserves command and native publication errors by identity without extra wait/publication/rollback", () => {
        const commandFault = { raw: "command" }, publication = { raw: "publication" }, rollback = { raw: "rollback" };
        const aggregate = new AggregateError([publication, rollback], "physical-lease-owner-state-rollback-failed");
        const record = { id: "unit", status: "attached", udid: "owned" };
        for (const f of cleanupFixtures({ "owner/android": [{ id: "unit", status: "running", serial: "owned" }] }, { commandFault })) {
            let caught: unknown;
            try { f.policy.owner("/chosen"); } catch (error) { caught = error; }
            expect(caught).toBe(commandFault);
            expect(f.trace.filter(row => ["wait", "hardware", "publish", "physical-publish", "release"].includes(String(row[0])))).toEqual([]);
        }
        for (const f of cleanupFixtures({ "owner/ios-device": [record] }, { backends: [cleanupPhysicalIos], hardwareId: "owned", transitionFault: aggregate })) {
            let caught: unknown;
            try { f.policy.owner("/chosen"); } catch (error) { caught = error; }
            expect(caught).toBe(aggregate);
            expect((caught as AggregateError).errors[0]).toBe(publication);
            expect((caught as AggregateError).errors[1]).toBe(rollback);
            expect(f.rows["owner/ios-device"]).toEqual([record]);
            expect(f.trace.at(-1)?.[0]).toBe("physical-publish");
        }
    });

    it("returns ordered all-project owner and record outcomes with opaque diagnostics", () => {
        const pair = cleanupFixtures({
            "later/android": [{ id: "unit", status: "stopped", pid: 9 }, { status: "running" }],
            "owner/android": [{ id: "bad", status: "running", serial: "bad" }, { id: "good", status: "running", serial: "good" }, { id: "skip", status: "stopped" }],
        }, { failedTarget: "bad" });
        for (const f of pair) {
            const result = f.policy.allProjects(37);
            expect(result.ok).toBe(false);
            expect(result.projects.map(project => [project.ownerId, project.results.map(row => [row.id, row.status])])).toEqual([
                ["later", [["unit", "stopped"], ["(unknown)", "skipped"]]],
                ["owner", [["bad", "failed"], ["good", "stopped"], ["skip", "skipped"]]],
            ]);
            expect(result.projects[1].results[0]).toEqual({
                id: "bad", backend: "android-emulator", previousStatus: "running", status: "failed", reason: "provider-stop-failed",
                commands: [{ command: "android-emulator-stop", status: 17, stdout: "raw stdout", stderr: "raw stderr", absent: undefined }],
            });
            expect(result.projects[1].results[1].commands[0].status).toBe(0);
            expect(f.rows["owner/android"]).toEqual([
                { id: "bad", status: "running", serial: "bad" },
                { id: "good", status: "stopped", serial: "good", pid: null, appium: null, recording: null, updatedAt: "raw-time" },
                { id: "skip", status: "stopped" },
            ]);
            expect(f.trace.filter(row => row[0] === "release")).toEqual([]);
        }
    });


    it("preserves the stop default timeout for semantic effects and recorder waits", () => {
        const recording = { runtimeId: "recording", pid: 41, processIdentity: { raw: "birth" } };
        for (const f of cleanupFixtures({ "owner/android": [{ id: "unit", status: "running", serial: "owned", recording }] })) {
            expect(f.policy.stopRecord("owner", cleanupAndroid, { id: "unit", status: "running", serial: "owned", recording }).status).toBe("stopped");
            expect(f.trace.filter(row => row[0] === "effects").map(row => row[2])).toEqual([5000]);
            expect(f.trace.filter(row => row[0] === "wait")).toEqual([["wait", "recording", 5000]]);
        }
    });

    it("skips inactive unknown and malformed facts without locks or native cleanup effects", () => {
        const rows = [{ status: "running" }, { id: "upper", status: "RUNNING" }, { id: "stopped", status: "stopped" }, { id: "unknown" }, { id: "array", appium: [], recording: null, pid: 0 }];
        const pair = cleanupFixtures({ "owner/android": rows });
        for (const f of pair) {
            const results = f.policy.owner("/chosen").results;
            expect(results.map(result => [result.id, result.status])).toEqual([["(unknown)", "skipped"], ["upper", "skipped"], ["stopped", "skipped"], ["unknown", "skipped"], ["array", "stopped"]]);
            // A truthy empty appium array is existing volatile metadata, not inventory authority.
            expect(f.rows["owner/android"].slice(0, 4)).toEqual(rows.slice(0, 4));
            expect(f.trace.filter(row => row[0] === "lock").map(row => row[3])).toEqual(["array"]);
        }
    });
});

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


    function cleanupOnly(cwd: string, profile?: string) {
        const files = fixture.setupFixture(cwd, profile);
        for (const file of [files.androidFile, files.androidDeviceFile, files.iosFile, files.iosDeviceFile, files.windowsFile, files.macosFile, files.otherOwnerFile]) {
            writeFileSync(file, JSON.stringify({ devices: [] }));
        }
        return files;
    }

    it.each([
        ["androidFile", { id: "unit", status: "running", port: 5554 }, "adb", ["-s", "emulator-5554", "emu", "kill"]],
        ["iosFile", { id: "unit", status: "booted", simulatorName: "fallback simulator" }, "xcrun", ["simctl", "shutdown", "fallback simulator"]],
        ["macosFile", { id: "unit", status: "running", provider: "tart", providerInstance: "owned instance" }, "tart", ["stop", "owned instance"]],
        ["macosFile", { id: "unit", status: "running", provider: "vz", providerInstance: "owned instance" }, "vz", ["stop", "owned instance"]],
        ["macosFile", { id: "unit", status: "running", provider: "utmctl", providerInstance: "owned instance" }, "utmctl", ["stop", "owned instance"]],
    ] as const)("actual cleanup frames %s stops with intact argv", (fileKey, record, tool, args) => {
        const cwd = "/project/admin-cleanup-native-argv";
        const files = cleanupOnly(cwd);
        writeFileSync(files[fileKey], JSON.stringify({ devices: [record] }));
        const binDir = join(fixture.homeDir, "bin"), logPath = join(fixture.homeDir, "argv.json");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, tool, `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args));`);

        const result = cleanupOwnerDevices(cwd, 5_000);

        expect(result.results[0].status).toBe("stopped");
        expect(JSON.parse(readFileSync(logPath, "utf8"))).toEqual(args);
        expect(result.results[0].commands).toEqual([expect.objectContaining({ status: 0 })]);
        expect(fixture.readDevices(files[fileKey])[0].status).toBe("stopped");
    });

    it.each([
        ["androidFile", { id: "unit", status: "running" }],
        ["iosFile", { id: "unit", status: "booted" }],
        ["windowsFile", { id: "unit", status: "running" }],
        ["macosFile", { id: "unit", status: "running", provider: "tart" }],
        ["macosFile", { id: "unit", status: "running", provider: "unsupported-provider", providerInstance: "owned" }],
    ] as const)("actual cleanup refuses missing or unsupported lifecycle identity in %s", (fileKey, record) => {
        const cwd = "/project/admin-cleanup-native-target-refusal";
        const files = cleanupOnly(cwd);
        writeFileSync(files[fileKey], JSON.stringify({ devices: [record] }));
        const before = readFileSync(files[fileKey], "utf8");
        const binDir = join(fixture.homeDir, "bin"), effects = join(fixture.homeDir, "unexpected-stop");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        for (const tool of ["adb", "xcrun", "wsb", "tart", "unsupported-provider"]) {
            fixture.writeNodeTool(binDir, tool, `writeFileSync(${JSON.stringify(effects)}, JSON.stringify(args));`);
        }

        const result = cleanupOwnerDevices(cwd, 37);

        expect(result.results[0]).toEqual(expect.objectContaining({ status: "failed", reason: "provider-stop-failed" }));
        expect(readFileSync(files[fileKey], "utf8")).toBe(before);
        expect(existsSync(effects)).toBe(false);
    });

    it.each(["owner", "all-projects", "sync-cli", "async-cli"])("actual %s cleanup propagates a later native read fault after an earlier committed cleanup", async action => {
        const cwd = "/project/admin-cleanup-partial-native";
        const { owner, androidFile, iosFile } = cleanupOnly(cwd);
        const earlier = { id: "early", status: "stopped", pid: 999999, nested: { raw: "kept" } };
        writeFileSync(androidFile, JSON.stringify({ devices: [earlier] }));
        writeFileSync(iosFile, JSON.stringify({ devices: [{ id: "later", status: "booted", udid: "later" }] }));
        const laterBefore = readFileSync(iosFile, "utf8"), fault = { native: "later owner state read" };
        const actualRead = ownerState.readOwnerDeviceStateFile;
        vi.spyOn(ownerState, "readOwnerDeviceStateFile").mockImplementation((file, limit) => {
            if (file === iosFile) throw fault;
            return actualRead(file, limit);
        });
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined), error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        let caught: unknown;
        try {
            if (action === "owner") cleanupOwnerDevices(cwd, 37);
            else if (action === "all-projects") stopAllProjectDevices(37);
            else if (action === "sync-cli") devicesCli(["stop", "--all-projects"], cwd);
            else await devicesCliAsync(["stop", "--all-projects"], cwd);
        } catch (err) { caught = err; }
        expect(caught).toBe(fault);
        expect(fixture.readDevices(androidFile)).toEqual([{ ...earlier, pid: null, appium: null, recording: null, updatedAt: expect.any(String) }]);
        expect(readFileSync(iosFile, "utf8")).toBe(laterBefore);
        expect(log).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(owner).not.toBe("other-owner");
    });

    it("actual cleanup rereads under the native per-record lock before physical lease effects", () => {
        const cwd = "/project/admin-cleanup-locked-native";
        const { iosDeviceFile } = cleanupOnly(cwd);
        const current = { id: "ios-real", status: "attached", udid: "REAL-IOS-UDID", nested: { generation: "original" } };
        const successor = { ...current, nested: { generation: "successor" } };
        writeFileSync(iosDeviceFile, JSON.stringify({ devices: [current] }));
        const leaseFile = fixture.physicalLeaseLockPath("ios-device", "REAL-IOS-UDID"), leaseBefore = readFileSync(leaseFile, "utf8");
        const operationLock = join(dirname(iosDeviceFile), "operations", createHash("sha256").update(current.id).digest("hex").slice(0, 32) + ".lock");
        const actualLock = sharedState.withSharedMutationLock;
        let replaced = false;
        vi.spyOn(sharedState, "withSharedMutationLock").mockImplementation((file, decide, options) =>
            actualLock(file, () => {
                if (file === operationLock && !replaced) {
                    replaced = true;
                    expect(existsSync(file)).toBe(true);
                    writeFileSync(iosDeviceFile, JSON.stringify({ devices: [successor] }));
                }
                return decide();
            }, options)
        );
        const result = cleanupOwnerDevices(cwd, 37);
        expect(result.results).toEqual([{ id: "ios-real", backend: "ios-device", previousStatus: "attached", status: "failed", reason: "owner-device-state-conflict", commands: [] }]);
        expect(replaced).toBe(true);
        expect(fixture.readDevices(iosDeviceFile)).toEqual([successor]);
        expect(readFileSync(leaseFile, "utf8")).toBe(leaseBefore);
        expect(existsSync(operationLock)).toBe(false);
    });

    it.each(["owner", "all-projects"])("actual %s cleanup retains the Windows claim release-flag distinction after publication", action => {
        const cwd = "/project/admin-cleanup-windows-release-flag";
        const { owner, windowsFile } = cleanupOnly(cwd);
        const current = { id: "windows-owned", status: "stopped", pid: 999999, sandboxId: "12345678-1234-4234-9234-1234567890ab" };
        writeFileSync(windowsFile, JSON.stringify({ devices: [current] }));
        const claimFile = join(fixture.homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
        mkdirSync(dirname(claimFile), { recursive: true });
        const claim = { provider: "windows-sandbox", ownerId: owner, deviceId: current.id, sandboxId: current.sandboxId };
        writeFileSync(claimFile, JSON.stringify(claim));
        const actualUnlink = nativeFs.unlinkSync, releases: string[] = [];
        vi.spyOn(nativeFs, "unlinkSync").mockImplementation(file => {
            if (file === claimFile) {
                releases.push("windows-claim");
                expect(fixture.readDevices(windowsFile)).toEqual([{ ...current, pid: null, appium: null, recording: null, updatedAt: expect.any(String) }]);
            }
            return actualUnlink(file);
        });
        if (action === "owner") expect(cleanupOwnerDevices(cwd, 37).results[0].status).toBe("stopped");
        else expect(stopAllProjectDevices(37).ok).toBe(true);
        expect(releases).toEqual(action === "owner" ? ["windows-claim"] : []);
        expect(existsSync(claimFile)).toBe(action !== "owner");
        if (action === "all-projects") expect(JSON.parse(readFileSync(claimFile, "utf8"))).toEqual(claim);
    });

    it("actual cleanup preserves the Windows claim when matching publication loses its generation", () => {
        const cwd = "/project/admin-cleanup-windows-publication-conflict";
        const { owner, windowsFile } = cleanupOnly(cwd);
        const current = { id: "windows-owned", status: "stopped", pid: 999999, sandboxId: "12345678-1234-4234-9234-1234567890ab" };
        const successor = { ...current, marker: "successor" };
        writeFileSync(windowsFile, JSON.stringify({ devices: [current] }));
        const claimFile = join(fixture.homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
        mkdirSync(dirname(claimFile), { recursive: true });
        writeFileSync(claimFile, JSON.stringify({ provider: "windows-sandbox", ownerId: owner, deviceId: current.id, sandboxId: current.sandboxId }));
        const claimBefore = readFileSync(claimFile, "utf8"), mutationFile = join(dirname(windowsFile), "devices.mutation.lock");
        const actualLock = sharedState.withSharedMutationLock;
        let replaced = false;
        vi.spyOn(sharedState, "withSharedMutationLock").mockImplementation((file, decide, options) =>
            actualLock(file, () => {
                if (file === mutationFile && !replaced) {
                    replaced = true;
                    writeFileSync(windowsFile, JSON.stringify({ devices: [successor] }));
                }
                return decide();
            }, options)
        );
        expect(cleanupOwnerDevices(cwd, 37).results[0]).toEqual({
            id: "windows-owned", backend: "windows-sandbox", previousStatus: "stopped", status: "failed", commands: [], reason: "owner-device-state-conflict",
        });
        expect(replaced).toBe(true);
        expect(fixture.readDevices(windowsFile)).toEqual([successor]);
        expect(readFileSync(claimFile, "utf8")).toBe(claimBefore);
    });

    it("actual cleanup leaves the committed Windows record when claim release throws a raw native fault", () => {
        const cwd = "/project/admin-cleanup-windows-release-fault";
        const { owner, windowsFile } = cleanupOnly(cwd);
        const current = { id: "windows-owned", status: "stopped", pid: 999999, sandboxId: "12345678-1234-4234-9234-1234567890ab" };
        writeFileSync(windowsFile, JSON.stringify({ devices: [current] }));
        const claimFile = join(fixture.homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
        mkdirSync(dirname(claimFile), { recursive: true });
        writeFileSync(claimFile, JSON.stringify({ provider: "windows-sandbox", ownerId: owner, deviceId: current.id, sandboxId: current.sandboxId }));
        const claimBefore = readFileSync(claimFile, "utf8"), fault = { native: "windows unlink" }, actualUnlink = nativeFs.unlinkSync;
        vi.spyOn(nativeFs, "unlinkSync").mockImplementation(file => {
            if (file === claimFile) throw fault;
            return actualUnlink(file);
        });
        let caught: unknown;
        try { cleanupOwnerDevices(cwd, 37); } catch (err) { caught = err; }
        expect(caught).toBe(fault);
        expect(fixture.readDevices(windowsFile)).toEqual([{ ...current, pid: null, appium: null, recording: null, updatedAt: expect.any(String) }]);
        expect(readFileSync(claimFile, "utf8")).toBe(claimBefore);
    });

    it("actual public session cleanup completes native physical iOS cleanup synchronously before removing its claim", () => {
        const cwd = "/project/admin-cleanup-session-binding", profile = "chosen";
        const { iosDeviceFile } = cleanupOnly(cwd, profile);
        const current = { id: "ios-real", status: "attached", udid: "REAL-IOS-UDID", nested: { raw: "kept" } };
        writeFileSync(iosDeviceFile, JSON.stringify({ devices: [current] }));
        const leaseFile = fixture.physicalLeaseLockPath("ios-device", "REAL-IOS-UDID");
        const claimFile = join(fixture.homeDir, ".ccc/run/locks", getProjectId(cwd) + "--p--" + profile + "--cleanup-test.lock");
        mkdirSync(dirname(claimFile), { recursive: true, mode: 0o700 });
        writeFileSync(claimFile, String(process.pid));
        const actualUnlink = nativeFs.unlinkSync, order: string[] = [];
        vi.spyOn(nativeFs, "unlinkSync").mockImplementation(file => {
            if (file === leaseFile) order.push("physical-lease");
            if (file === claimFile) {
                order.push("session-claim");
                expect(fixture.readDevices(iosDeviceFile)).toEqual([{ ...current, status: "detached", pid: null, appium: null, recording: null, updatedAt: expect.any(String) }]);
                expect(existsSync(leaseFile)).toBe(false);
            }
            return actualUnlink(file);
        });
        session.clearSession();
        try {
            session.setSession(claimFile, cwd, profile);
            expect(session.cleanupSession()).toBeUndefined();
            expect(order).toEqual(["physical-lease", "session-claim"]);
            expect(existsSync(claimFile)).toBe(false);
            expect(session.getCurrentSession().lockFile).toBe(null);
        } finally { session.clearSession(); }
    });

    it("actual public session reports the precise native cleanup fault after earlier effects and removes only its own claim", () => {
        const cwd = "/project/admin-cleanup-session-raw-failure", profile = "chosen";
        const { androidFile, iosFile } = cleanupOnly(cwd, profile);
        const earlier = { id: "early", status: "stopped", pid: 999999 };
        writeFileSync(androidFile, JSON.stringify({ devices: [earlier] }));
        const fault = new Error("exact later native read fault"), actualRead = ownerState.readOwnerDeviceStateFile;
        vi.spyOn(ownerState, "readOwnerDeviceStateFile").mockImplementation((file, limit) => {
            if (file === iosFile) throw fault;
            return actualRead(file, limit);
        });
        const claimFile = join(fixture.homeDir, ".ccc/run/locks", getProjectId(cwd) + "--p--" + profile + "--cleanup-test.lock");
        mkdirSync(dirname(claimFile), { recursive: true, mode: 0o700 });
        writeFileSync(claimFile, String(process.pid));
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        session.clearSession();
        try {
            session.setSession(claimFile, cwd, profile);
            expect(session.cleanupSession()).toBeUndefined();
            expect(error).toHaveBeenCalledExactlyOnceWith("[ccc] device cleanup failed during session cleanup: exact later native read fault");
            expect(fixture.readDevices(androidFile)).toEqual([{ ...earlier, pid: null, appium: null, recording: null, updatedAt: expect.any(String) }]);
            expect(existsSync(claimFile)).toBe(false);
            expect(fixture.readDevices(iosFile)).toEqual([]);
        } finally { session.clearSession(); }
    });


    it("stops an owned device without mutating other owner devices", () => {
        const cwd = "/project/admin-stop-test";
        const { androidFile, otherOwnerFile } = fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "adb", "process.exit(0)");

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
        fixture.writeNodeTool(binDir, "adb", `appendFileSync(${JSON.stringify(commandLog)}, "invoked\\n");`);

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
        fixture.writeNodeTool(binDir, "adb", `writeFileSync(${JSON.stringify(androidFile)}, ${JSON.stringify(JSON.stringify(successorState))});`);

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
        fixture.writeNodeTool(binDir, "tart", `writeFileSync(${JSON.stringify(macosFile)}, ${JSON.stringify(JSON.stringify(successorState))});`);

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
        fixture.writeNodeTool(binDir, "adb", `appendFileSync(${JSON.stringify(commandLog)}, '' + args.join(' ') + '\\n');`);

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
        fixture.writeNodeTool(binDir, "adb", "process.exit(0)");
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
        fixture.writeNodeTool(binDir, "adb", [
            `writeFileSync(${JSON.stringify(androidDeviceFile)}, ${JSON.stringify(JSON.stringify(successorState))});`,
            `writeFileSync(${JSON.stringify(leaseFile)}, ${JSON.stringify(JSON.stringify(successorLease))});`,
            "process.exit(0)",
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
        fixture.writeNodeTool(binDir, "adb", "process.stderr.write('stop-failed'); process.exit(9)");

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
        fixture.writeNodeTool(binDir, "adb", `appendFileSync(${JSON.stringify(logPath)}, 'adb ' + args.join(' ') + '\\n');`);
        fixture.writeNodeTool(binDir, "xcrun", `appendFileSync(${JSON.stringify(logPath)}, 'xcrun ' + args.join(' ') + '\\n');`);
        fixture.writeNodeTool(binDir, "wsb", `appendFileSync(${JSON.stringify(logPath)}, 'wsb ' + args.join(' ') + '\\n');`);
        fixture.writeNodeTool(binDir, "tart", `appendFileSync(${JSON.stringify(logPath)}, 'tart ' + args.join(' ') + '\\n');`);

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
        fixture.writeNodeTool(binDir, "adb", "process.exit(0)");

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

    it("deletes detached metadata without reading an invalid aggregate belonging to a foreign authoritative lease", () => {
        const cwd = "/project/admin-delete-foreign-lease-invalid-aggregate-test";
        const { androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        devices[0].status = "detached";
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        const foreignLease = JSON.stringify({ backend: "android-device", hardwareId: "R5CREAL123", ownerId: "other-owner", deviceId: "foreign-real" });
        writeFileSync(leaseFile, foreignLease);
        const aggregateFile = join(fixture.homeDir, ".ccc/devices/physical-leases/android-device.json");
        writeFileSync(aggregateFile, "{invalid-foreign-aggregate");

        const result = deleteOwnerDevice("android-real", cwd);

        expect(result.ok, result.text).toBe(true);
        expect(result.text).toContain("deleted: android-real");
        expect(fixture.readDevices(androidDeviceFile)).toEqual(devices.filter(device => device.id !== "android-real"));
        expect(readFileSync(leaseFile, "utf-8")).toBe(foreignLease);
        expect(readFileSync(aggregateFile, "utf-8")).toBe("{invalid-foreign-aggregate");
    });

    it("preserves a same-owner lease with the same claim id and a different operation nonce during deletion", () => {
        const cwd = "/project/admin-delete-physical-lease-nonce-mismatch-test";
        const { owner, androidDeviceFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(androidDeviceFile);
        Object.assign(devices[0], { status: "detached", leaseClaimId: "same-claim", leaseClaimNonce: "previous-nonce" });
        writeFileSync(androidDeviceFile, JSON.stringify({ devices }));
        const leaseFile = fixture.physicalLeaseLockPath("android-device", "R5CREAL123");
        const successor = { backend: "android-device", hardwareId: "R5CREAL123", ownerId: owner, deviceId: "android-real", claimId: "same-claim", claimNonce: "successor-nonce" };
        const leaseBytes = JSON.stringify(successor);
        const aggregateFile = join(fixture.homeDir, ".ccc/devices/physical-leases/android-device.json");
        const aggregateBytes = JSON.stringify({ leases: [successor] });
        writeFileSync(leaseFile, leaseBytes);
        writeFileSync(aggregateFile, aggregateBytes);

        const result = deleteOwnerDevice("android-real", cwd);

        expect(result.ok, result.text).toBe(true);
        expect(fixture.readDevices(androidDeviceFile)).toEqual(devices.filter(device => device.id !== "android-real"));
        expect(readFileSync(leaseFile, "utf-8")).toBe(leaseBytes);
        expect(readFileSync(aggregateFile, "utf-8")).toBe(aggregateBytes);
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
        fixture.writeNodeTool(binDir, "adb", `appendFileSync(${JSON.stringify(logPath)}, 'adb ' + args.join(' ') + '\\n');`);
        fixture.writeNodeTool(binDir, "xcrun", `appendFileSync(${JSON.stringify(logPath)}, 'xcrun ' + args.join(' ') + '\\n');`);
        fixture.writeNodeTool(binDir, "wsb", `appendFileSync(${JSON.stringify(logPath)}, 'wsb ' + args.join(' ') + '\\n');`);
        fixture.writeNodeTool(binDir, "tart", `appendFileSync(${JSON.stringify(logPath)}, 'tart ' + args.join(' ') + '\\n');`);
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
        fixture.writeNodeTool(binDir, "adb", `appendFileSync(${JSON.stringify(logPath)}, 'adb ' + args.join(' ') + '\\n');`);
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
        fixture.writeNodeTool(binDir, "adb", "process.stderr.write('adb-failed'); process.exit(9)");
        fixture.writeNodeTool(binDir, "wsb", "process.stderr.write('wsb-failed'); process.exit(8)");

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
        fixture.writeNodeTool(binDir, "adb", `appendFileSync(${JSON.stringify(logPath)}, 'adb ' + args.join(' ') + '\\n');`);
        fixture.writeNodeTool(binDir, "xcrun", `appendFileSync(${JSON.stringify(logPath)}, 'xcrun ' + args.join(' ') + '\\n');`);
        fixture.writeNodeTool(binDir, "wsb", `appendFileSync(${JSON.stringify(logPath)}, 'wsb ' + args.join(' ') + '\\n');`);
        fixture.writeNodeTool(binDir, "tart", `appendFileSync(${JSON.stringify(logPath)}, 'tart ' + args.join(' ') + '\\n');`);

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
        fixture.writeNodeTool(binDir, "adb", "process.stderr.write('adb-failed'); process.exit(9)");
        fixture.writeNodeTool(binDir, "wsb", "process.stderr.write('wsb-failed'); process.exit(8)");

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
        fixture.writeNodeTool(binDir, "adb", "process.exit(0)");
        fixture.writeNodeTool(binDir, "xcrun", "process.exit(0)");
        fixture.writeNodeTool(binDir, "wsb", "process.exit(0)");
        fixture.writeNodeTool(binDir, "tart", "process.exit(0)");
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
        fixture.writeNodeTool(binDir, "adb", "process.exit(0)");
        fixture.writeNodeTool(binDir, "xcrun", "process.exit(0)");
        fixture.writeNodeTool(binDir, "wsb", "process.exit(0)");
        fixture.writeNodeTool(binDir, "tart", "process.exit(0)");
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
        fixture.writeNodeTool(binDir, "adb", "setTimeout(() => {}, 1000)");

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
        fixture.writeNodeTool(binDir, "tart", `appendFileSync(${JSON.stringify(logPath)}, 'tart ' + args.join(' ') + '\\n');`);

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
        fixture.writeNodeTool(binDir, "tart", "if (args[1] === 'ccc-mac-stopped') { process.stderr.write('tart-delete-failed'); process.exit(7); }");

        const result = deleteOwnerDevice("macos-stopped", cwd);

        expect(result.ok).toBe(false);
        expect(result.text).toContain("failed: macos-stopped");
        expect(result.text).toContain("-> 7");
        expect(fixture.readDeviceIds(macosFile)).toEqual(["macos-owned:running", "macos-stopped:stopped"]);
    });

    it("omits a native null deletion result without fabricating a command receipt", () => {
        const cwd = "/project/admin-delete-macos-null-result-test";
        const { macosFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(macosFile);
        Object.assign(devices.find(device => device.id === "macos-stopped")!, { providerResourceManaged: true });
        writeFileSync(macosFile, JSON.stringify({ devices }));
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "tart", "throw new Error('native result replaced at the leaf');");
        const deletion = vi.spyOn(nativeCleanup, "runCommand").mockReturnValue(null);

        const result = deleteOwnerDevice("macos-stopped", cwd);

        expect(deletion).toHaveBeenCalledWith(join(binDir, "tart.mjs"), ["delete", "ccc-mac-stopped"], undefined);
        expect(result.ok).toBe(true);
        expect(result.text).not.toContain("command:");
        expect(result.text).not.toContain("-> 0");
        expect(result.text).not.toContain("-> unknown");
        expect(fixture.readDeviceIds(macosFile)).toEqual(["macos-owned:running"]);
    });

    it("attempts every managed macOS resource in order, including repeats after a failure, and retains every receipt", () => {
        const cwd = "/project/admin-delete-macos-all-attempts-test";
        const { macosFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(macosFile);
        Object.assign(devices.find(device => device.id === "macos-stopped")!, {
            providerResourceManaged: true,
            snapshots: [
                { id: "first", provider: "tart", providerInstance: "repeated" },
                { id: "second", provider: "tart", providerInstance: "repeated" },
            ],
            restoreRecovery: { provider: "tart", candidateProviderInstance: "later" },
        });
        const original = JSON.stringify({ devices });
        writeFileSync(macosFile, original);
        const binDir = join(fixture.homeDir, "bin");
        const logPath = join(fixture.homeDir, "all-attempts.log");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "tart", `appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n'); if (args[1] === 'repeated') process.exit(7);`);

        const result = deleteOwnerDevice("macos-stopped", cwd);

        expect(result.ok).toBe(false);
        expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
            "delete repeated", "delete repeated", "delete later", "delete ccc-mac-stopped",
        ]);
        expect(result.text.match(/command: .*delete repeated -> 7/g)).toHaveLength(2);
        expect(result.text).toContain("delete later -> 0");
        expect(result.text).toContain("delete ccc-mac-stopped -> 0");
        expect(result.text).toContain("reason: provider-delete-failed");
        expect(readFileSync(macosFile, "utf8")).toBe(original);
    });

    it.each(["unsupported-provider", "tart"])("retains managed macOS metadata when %s cannot delete its resource", provider => {
        const cwd = `/project/admin-delete-macos-unavailable-${provider}-test`;
        const { owner, macosFile } = fixture.setupFixture(cwd);
        const devices = fixture.readDevices(macosFile);
        Object.assign(devices.find(device => device.id === "macos-stopped")!, { provider, providerResourceManaged: true });
        const original = JSON.stringify({ devices });
        writeFileSync(macosFile, original);
        const binDir = join(fixture.homeDir, "bin");
        const commandEffects = join(fixture.homeDir, "unexpected-provider-delete.log");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "unsupported-provider", `appendFileSync(${JSON.stringify(commandEffects)}, 'deleted');`);

        const result = deleteOwnerDevice("macos-stopped", cwd);

        expect(result).toEqual({ ok: false, text: [
            "failed: macos-stopped",
            "backend: macos-vm",
            `owner: ${owner}`,
            "reason: provider-delete-failed",
            `command: ${provider} delete ccc-mac-stopped -> unknown`,
            "",
        ].join("\n") });
        expect(readFileSync(macosFile, "utf-8")).toBe(original);
        expect(existsSync(commandEffects)).toBe(false);
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
