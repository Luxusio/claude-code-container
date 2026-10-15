import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createHyperVStopDeleteApplication } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-stop-delete.js";
import type { AuxiliaryCleanup, AuxiliaryOutcome } from "../../../packages/device-lab/src/device-lab/domain/broker-owner-cleanup.js";
import type { HyperVArtifactEvidence, HyperVCommandExecution, HyperVNetworkCleanupEvidence, HyperVOperationEvidence, HyperVStopDeleteRequest, HyperVTerminalObservation, HyperVTerminalResult } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-stop-delete.js";
import type { HyperVStopDeletePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-stop-delete.js";

type Connection = { providerId: string };
type Receipt = { nativeEvidence: string };
type TerminalCommand = HyperVStopDeleteRequest["command"];

function terminalFixture(command: TerminalCommand) {
    const device = {
        id: "owned", vmId: "12345678-1234-1234-1234-123456789abc", vmName: "owned-vm", incarnationId: "owned-incarnation",
        diskPath: "C:\\owned\\disks\\system.vhdx", status: "running", runtimeState: "Running", revision: 1, appium: { pid: 42 },
    };
    let current: Record<string, unknown> | null = device;
    let journal: HyperVOperationEvidence | null = null;
    const effects: string[] = [];
    const connection: Connection = { providerId: "powershell" };
    const request: HyperVStopDeleteRequest = { ok: true, backend: "windows-vm", stateKey: "windows-vm", command, deviceId: device.id, force: false, dryRun: false };
    const observation: HyperVTerminalObservation = { vmId: device.vmId, vmName: device.vmName, state: "Off", status: "Stopped", diskPath: device.diskPath };
    const execution: HyperVCommandExecution<Receipt> = {
        mode: "exec", provider: "hyper-v", status: 0, stdout: "captured native evidence is deliberately not JSON", stderr: "opaque native diagnostic",
        receipt: { nativeEvidence: "terminal receipt" },
    };
    const result: HyperVTerminalResult<Receipt> = { ok: true, observation, execution };
    const auxiliaryCleanup: AuxiliaryCleanup = { ok: true, changed: false, appium: {}, recording: {}, minimizeWatchdog: {} };
    const network: HyperVNetworkCleanupEvidence = { ok: true, released: true, statePresent: true, remaining: 0, networkCleanup: { nativeEvidence: "network receipt" } };
    const artifacts: HyperVArtifactEvidence = { ok: true, removed: true };
    const ports = {
        read: vi.fn((): unknown[] => current ? [current] : []),
        incarnation: (record: Record<string, unknown>) => typeof record.incarnationId === "string" ? record.incarnationId : null,
        validIncarnation: (value: unknown): value is string => typeof value === "string" && value.length > 0,
        connection: () => connection,
        prepareStopDelete: () => ({ kind: "prepared" as const, connection }),
        readJournal: vi.fn(() => journal),
        writeJournal: vi.fn(() => {
            effects.push("journal-write");
            journal = {
                version: 1, operationId: "terminal-operation", ownerId: "owner", deviceId: device.id, incarnationId: device.incarnationId,
                command, vmId: device.vmId, vmName: device.vmName, diskPath: device.diskPath, startedAt: "2026-10-15T00:00:00.000Z",
            };
            return { ok: true as const, path: "private-operation-journal" };
        }),
        clearJournal: vi.fn((): undefined => { effects.push("journal-clear"); journal = null; }),
        readSnapshotJournal: () => null,
        repairSnapshots: async () => { throw new Error("unexpected snapshot repair"); },
        clearSnapshotJournal: () => { throw new Error("unexpected snapshot journal cleanup"); },
        replayObservation: async () => { throw new Error("unexpected terminal replay observation"); },
        replayPower: async () => { throw new Error("unexpected terminal power replay"); },
        replayRemoveVm: async () => { throw new Error("unexpected terminal deletion replay"); },
        removeHostFiles: async () => { throw new Error("unexpected replay host-file cleanup"); },
        deviceRoot: () => "C:\\owned",
        windowsDirectory: () => "C:\\owned\\disks",
        replayPublish: () => { throw new Error("unexpected replay publication"); },
        cleanupAuxiliary: vi.fn((_owner: string, _request: HyperVStopDeleteRequest, _expected: unknown): AuxiliaryOutcome => ({ result: auxiliaryCleanup, device: current, committed: false })),
        clone: (value: unknown) => structuredClone(value),
        executeStop: vi.fn(async (): Promise<HyperVTerminalResult<Receipt>> => { effects.push("stop"); return result; }),
        executeDelete: vi.fn(async (): Promise<HyperVTerminalResult<Receipt>> => { effects.push("delete"); return result; }),
        samePath: (left: string, right: string) => left === right,
        releaseNetwork: vi.fn(async (): Promise<HyperVNetworkCleanupEvidence> => { effects.push("network"); return network; }),
        cleanupArtifacts: vi.fn((): HyperVArtifactEvidence => { effects.push("artifacts"); return artifacts; }),
        publish: vi.fn((_owner: string, _state: string, _id: string, expected: unknown, replace: (record: Record<string, unknown>) => unknown) => {
            effects.push("publish");
            if (!current || !isDeepStrictEqual(current, expected)) return { found: current !== null, matched: false, device: current };
            current = replace(current) as Record<string, unknown> | null;
            return { found: true, matched: true, device: current };
        }),
        stateErrorCode: () => null,
        stateFailure: (_error: unknown, target: { backend: string; stateKey: string }) => ({ reason: "state-write-failed" as const, error: "state-write-failed", ...target }),
        errorCode: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
        diagnosticCode: vi.fn((evidence: HyperVCommandExecution<Receipt>, fallback: string) => evidence.error || fallback),
        assertDeadline: vi.fn((): undefined => undefined),
        deadlineExpired: vi.fn(() => false),
        timestamp: () => "2026-10-15T00:01:00.000Z",
    } satisfies HyperVStopDeletePorts<Connection, Receipt>;
    return {
        device, request, observation, execution, result, network, artifacts, auxiliaryCleanup, ports, effects,
        application: createHyperVStopDeleteApplication(ports),
        current: () => current,
        journal: () => journal,
        setCurrent: (record: Record<string, unknown>) => { current = record; },
    };
}

describe("Hyper-V inward terminal observations", () => {
    it.each(["device_stop", "device_delete"] as const)("uses captured terminal facts for %s with non-JSON evidence", async (command) => {
        const f = terminalFixture(command);
        const outcome = await f.application.invoke("owner", f.request, 100000, 130000);
        expect(outcome).toMatchObject({ kind: command === "device_stop" ? "stopped" : "deleted", journalDisposition: "clear", invoked: true, dryRun: false });
        expect(outcome.execution).toBe(f.execution);
        expect(outcome.execution?.receipt).toBe(f.execution.receipt);
        expect(f.ports.publish.mock.calls[0]?.[3]).toEqual(f.device);
        expect(f.journal()).toBeNull();
        if (command === "device_stop") {
            expect(outcome.device).toMatchObject({ status: "stopped", runtimeState: "Off", hyperVStatus: "Stopped", vmId: f.observation.vmId, vmName: f.observation.vmName });
            expect(f.effects).toEqual(["journal-write", "stop", "publish", "journal-clear"]);
            expect(f.ports.executeStop).toHaveBeenCalledOnce();
            expect(f.ports.executeDelete).not.toHaveBeenCalled();
        } else {
            expect(outcome.device).toBeNull();
            expect(outcome.networkCleanup).toBe(f.network);
            expect(outcome.artifactCleanup).toBe(f.artifacts);
            expect(f.effects).toEqual(["journal-write", "delete", "network", "artifacts", "publish", "journal-clear"]);
            expect(f.ports.releaseNetwork).toHaveBeenCalledWith("owner", f.device.id, f.device.incarnationId, 130000, false);
            expect(f.ports.executeDelete).toHaveBeenCalledOnce();
            expect(f.ports.executeStop).not.toHaveBeenCalled();
        }
    });

    it.each(["device_stop", "device_delete"] as const)("retains %s semantic failure despite success-looking receipt bytes", async (command) => {
        const f = terminalFixture(command);
        const execution = { ...f.execution, stdout: JSON.stringify(f.observation) };
        const operation = command === "device_stop" ? f.ports.executeStop : f.ports.executeDelete;
        operation.mockResolvedValue({ ok: false, observation: f.observation, execution });
        const outcome = await f.application.invoke("owner", f.request, 100000, 130000);
        expect(outcome).toMatchObject({ kind: "uncertain", reason: "provider-failed", error: "provider-command-failed", journalDisposition: "retain", mutatesHost: false });
        expect(outcome.execution).toBe(execution);
        expect(f.ports.diagnosticCode).toHaveBeenCalledWith(execution, "hyper-v-provider-command-failed");
        expect(f.journal()).toMatchObject({ command, vmId: f.device.vmId });
        expect(f.current()).toBe(f.device);
        expect(operation).toHaveBeenCalledOnce();
        expect(f.ports.releaseNetwork).not.toHaveBeenCalled();
        expect(f.ports.cleanupArtifacts).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
    });

    describe.each(["device_stop", "device_delete"] as const)("%s terminal identity", (command) => {
        it.each([
            { name: "missing observation", observation: null },
            { name: "missing VM id", observation: { vmId: "" } },
            { name: "foreign VM id", observation: { vmId: "87654321-4321-4321-4321-cba987654321" } },
            { name: "missing VM name", observation: { vmName: "" } },
            { name: "foreign VM name", observation: { vmName: "successor-vm" } },
        ])("retains the journal and withholds cleanup for $name", async ({ observation }) => {
            const f = terminalFixture(command);
            const operation = command === "device_stop" ? f.ports.executeStop : f.ports.executeDelete;
            operation.mockResolvedValue({ ...f.result, observation: observation ? { ...f.observation, ...observation } : null });
            const outcome = await f.application.invoke("owner", f.request, 100000, 130000);
            expect(outcome).toMatchObject({ kind: "uncertain", reason: "provider-failed", error: "provider-command-failed", journalDisposition: "retain", mutatesHost: false });
            expect(outcome.execution).toBe(f.execution);
            expect(f.journal()).toMatchObject({ command, vmId: f.device.vmId });
            expect(f.current()).toBe(f.device);
            expect(operation).toHaveBeenCalledOnce();
            expect(f.ports.releaseNetwork).not.toHaveBeenCalled();
            expect(f.ports.cleanupArtifacts).not.toHaveBeenCalled();
            expect(f.ports.publish).not.toHaveBeenCalled();
            expect(f.ports.clearJournal).not.toHaveBeenCalled();
        });
    });

    it.each([undefined, "C:\\foreign\\system.vhdx"])("rejects delete disk %s before network and artifact cleanup", async (diskPath) => {
        const f = terminalFixture("device_delete");
        f.ports.executeDelete.mockResolvedValue({ ...f.result, observation: { ...f.observation, diskPath } });
        const outcome = await f.application.invoke("owner", f.request, 100000, 130000);
        expect(outcome).toMatchObject({ kind: "uncertain", error: "provider-command-failed", journalDisposition: "retain" });
        expect(outcome.execution).toBe(f.execution);
        expect(f.journal()).not.toBeNull();
        expect(f.current()).toBe(f.device);
        expect(f.ports.releaseNetwork).not.toHaveBeenCalled();
        expect(f.ports.cleanupArtifacts).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
    });

    it.each(["device_stop", "device_delete"] as const)("retains %s after its dispatch deadline and preserves execution omission", async (command) => {
        const f = terminalFixture(command);
        f.ports.deadlineExpired.mockReturnValue(true);
        const outcome = await f.application.invoke("owner", f.request, 100000, 130000);
        expect(outcome).toMatchObject({ kind: "uncertain", reason: "deadline", error: "hyper-v-operation-deadline-exceeded", journalDisposition: "retain" });
        expect(outcome).not.toHaveProperty("execution");
        expect(f.effects).toEqual(["journal-write", command === "device_stop" ? "stop" : "delete"]);
        expect(f.journal()).not.toBeNull();
        expect(f.current()).toBe(f.device);
        expect(f.ports.releaseNetwork).not.toHaveBeenCalled();
        expect(f.ports.cleanupArtifacts).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
    });

    it("retains native execution and the journal when network release fails before artifact cleanup", async () => {
        const f = terminalFixture("device_delete");
        const network: HyperVNetworkCleanupEvidence = { ok: false, released: false, statePresent: true, remaining: 1, error: "allocation-busy", networkCleanup: { nativeEvidence: "failed release" } };
        f.ports.releaseNetwork.mockImplementation(async () => { f.effects.push("network"); return network; });
        const outcome = await f.application.invoke("owner", f.request, 100000, 130000);
        expect(outcome).toMatchObject({ kind: "uncertain", error: "hyper-v-device-cleanup-failed", journalDisposition: "retain", mutatesHost: true, artifactCleanup: null });
        expect(outcome.execution).toBe(f.execution);
        expect(outcome.networkCleanup).toBe(network);
        expect(f.effects).toEqual(["journal-write", "delete", "network"]);
        expect(f.journal()).not.toBeNull();
        expect(f.ports.cleanupArtifacts).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
    });

    it("retains native execution and the journal when artifacts fail after network release", async () => {
        const f = terminalFixture("device_delete");
        const artifacts: HyperVArtifactEvidence = { ok: false, removed: false, error: "artifact-busy" };
        f.ports.cleanupArtifacts.mockImplementation(() => { f.effects.push("artifacts"); return artifacts; });
        const outcome = await f.application.invoke("owner", f.request, 100000, 130000);
        expect(outcome).toMatchObject({ kind: "uncertain", error: "hyper-v-device-cleanup-failed", journalDisposition: "retain", mutatesHost: true });
        expect(outcome.execution).toBe(f.execution);
        expect(outcome.networkCleanup).toBe(f.network);
        expect(outcome.artifactCleanup).toBe(artifacts);
        expect(f.effects).toEqual(["journal-write", "delete", "network", "artifacts"]);
        expect(f.journal()).not.toBeNull();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
    });

    it("publishes against the full record committed by auxiliary cleanup", async () => {
        const f = terminalFixture("device_stop");
        const committed = { ...f.device, appium: null, revision: 2 };
        f.ports.cleanupAuxiliary.mockImplementation((_owner, _request, expected) => {
            expect(expected).toEqual(f.device);
            f.setCurrent(committed);
            return { result: { ...f.auxiliaryCleanup, changed: true }, device: committed, committed: true };
        });
        const outcome = await f.application.invoke("owner", f.request, 100000, 130000);
        expect(outcome.kind).toBe("stopped");
        expect(outcome.execution).toBe(f.execution);
        const expected = f.ports.publish.mock.calls[0]?.[3];
        expect(expected).toEqual(committed);
        expect(expected).not.toBe(committed);
        expect(f.current()).toMatchObject({ appium: null, revision: 2, status: "stopped", runtimeState: "Off" });
        expect(f.journal()).toBeNull();
    });

    it.each(["device_stop", "device_delete"] as const)("preserves a same-ID successor through full-record CAS for %s and clears the conflict journal", async (command) => {
        const f = terminalFixture(command);
        const committed = { ...f.device, appium: null, revision: 2 };
        const successor = { ...committed, revision: 3, label: "concurrent replacement" };
        f.ports.cleanupAuxiliary.mockImplementation(() => {
            f.setCurrent(committed);
            return { result: { ...f.auxiliaryCleanup, changed: true }, device: committed, committed: true };
        });
        const operation = command === "device_stop" ? f.ports.executeStop : f.ports.executeDelete;
        operation.mockImplementation(async () => {
            f.effects.push(command === "device_stop" ? "stop" : "delete");
            f.setCurrent(successor);
            return f.result;
        });
        const outcome = await f.application.invoke("owner", f.request, 100000, 130000);
        expect(outcome).toMatchObject({ kind: "refused", reason: "conflict", error: "owner-device-state-conflict", found: true, journalDisposition: "clear" });
        expect(outcome.execution).toBe(f.execution);
        expect(outcome.device).toBe(successor);
        expect(f.ports.publish.mock.calls[0]?.[3]).toEqual(committed);
        expect(f.current()).toBe(successor);
        expect(f.current()).toMatchObject({ id: f.device.id, vmId: f.device.vmId, incarnationId: f.device.incarnationId, revision: 3, label: "concurrent replacement" });
        expect(f.ports.publish).toHaveBeenCalledOnce();
        expect(f.ports.clearJournal).toHaveBeenCalledOnce();
        expect(f.journal()).toBeNull();
    });
});
