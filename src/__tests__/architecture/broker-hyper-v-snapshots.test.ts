import { describe, expect, it, vi } from "vitest";
import { createBrokerHyperVSnapshotApplication } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-snapshots.js";
import { renderHyperVSnapshot } from "../../../packages/device-lab/src/device-lab/broker/hyper-v/lifecycle-outcomes.js";
import type { DeviceLabHyperVCommandResult } from "../../../packages/device-lab/src/device-lab/broker/hyper-v/lifecycle-adapter.js";
import type { SnapshotExecution, SnapshotJournal, SnapshotOwnerTarget, SnapshotTool, SnapshotTracked, SnapshotVmObservation } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-snapshots.js";
import type { BrokerHyperVSnapshotPorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-snapshots.js";

type Connection = { readonly provider: "powershell" | "ssh" };
type Receipt = DeviceLabHyperVCommandResult & { readonly nativeEvidence: string };
type SnapshotPorts = BrokerHyperVSnapshotPorts<Connection, Receipt>;
const powershell: Connection = { provider: "powershell" };
const ssh: Connection = { provider: "ssh" };

const owner = "0123456789abcdef";
const deviceId = "snapshot-device";
const incarnationId = "a".repeat(32);
const checkpointId = "11111111-2222-3333-4444-555555555555";
const providerName = `ccc-${owner}-baseline`;
const tracked: SnapshotTracked = { id: checkpointId, name: "baseline", providerName };

function fixture(backend = "windows-vm") {
    const device: Record<string, unknown> = { id: deviceId, vmId: "owned-vm-id", vmName: "owned-vm",
        diskPath: "/owned/os.vhdx", incarnationId, snapshots: [] };
    const state = { current: device, journal: null as SnapshotJournal | null, now: 0 };
    const observation: SnapshotVmObservation = { vmId: "owned-vm-id", vmName: "owned-vm", diskPath: "/owned/os.vhdx",
        state: "Off", checkpointPolicy: backend === "linux-vm" ? "Production" : "ProductionOnly", snapshots: [] };
    const execution: SnapshotExecution<Receipt> = { ok: true,
        receipt: { nativeEvidence: "status", mode: "exec", provider: "hyper-v", status: 0, stdout: "status" } };
    const ports: SnapshotPorts = {
        connection: provider => provider === "powershell" ? powershell : ssh, incarnation: value => typeof value.incarnationId === "string" ? value.incarnationId : null,
        validIncarnation: (value): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value),
        providerName: (id, name) => `ccc-${id}-${name}`, ownershipNotes: (id, target, generation) => `${id}:${target}:${generation}`,
        journalExists: () => state.journal !== null, readJournal: () => state.journal,
        writeJournal: (_owner, _backend, _device, generation, tool, name, nativeName, id, policy) => {
            state.journal = { version: 1, operationId: "operation", ownerId: owner, deviceId, incarnationId: generation,
                tool, snapshotName: name, providerName: nativeName, snapshotId: id, expectedCheckpointPolicy: policy,
                confirmationRequired: tool === "device_snapshot_create", startedAt: "2026-10-11T00:00:00.000Z" };
            return undefined;
        },
        recordCreatedId: (_owner, _backend, _device, _generation, _name, id) => {
            if (!state.journal) throw new Error("missing journal");
            state.journal = { ...state.journal, snapshotId: id }; return undefined;
        },
        clearJournal: vi.fn(() => { state.journal = null; return undefined; }),
        removeRepairJournal: vi.fn(() => { state.journal = null; return undefined; }),
        status: vi.fn<SnapshotPorts["status"]>(async () => ({ execution, observation })),
        observationMismatch: vi.fn(() => null),
        create: vi.fn<SnapshotPorts["create"]>(async (_connection, target, options) => {
            options.onCreatedId(checkpointId);
            return { ok: true, snapshotId: checkpointId, snapshotName: target.providerName, snapshotType: "Production" };
        }),
        restore: vi.fn<SnapshotPorts["restore"]>(async (_connection, target) => ({ ok: true,
            snapshotId: target.snapshotId || checkpointId, snapshotName: target.providerName, state: "Off" })),
        delete: vi.fn<SnapshotPorts["delete"]>(async (_connection, target) => ({ ok: true, deleted: true,
            snapshotId: target.snapshotId || checkpointId, snapshotName: target.providerName })),
        repairPolicy: vi.fn<SnapshotPorts["repairPolicy"]>(async (_connection, target) => ({ checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 1 })),
        lastExecution: vi.fn<SnapshotPorts["lastExecution"]>(() => execution), isValidationError: () => false,
        errorCode: (error, fallback) => error instanceof Error ? error.message : fallback,
        providerErrorCode: vi.fn<SnapshotPorts["providerErrorCode"]>(() => undefined),
        diagnosticCode: vi.fn<SnapshotPorts["diagnosticCode"]>((result, fallback, override) => override ?? result?.receipt?.error ?? fallback),
        publish: vi.fn<SnapshotPorts["publish"]>((_owner, _backend, _device, _expected, replacement) => {
            state.current = replacement; return { found: true, matched: true, device: replacement };
        }),
        mergeRepair: vi.fn<SnapshotPorts["mergeRepair"]>((_owner, _backend, _device, _original, patch) => {
            state.current = { ...state.current, ...patch }; return state.current;
        }),
        forgetConsole: () => undefined,
        sshReady: vi.fn<SnapshotPorts["sshReady"]>(async () => ({ ready: false, execution: { ok: false } })),
        remainingTimeout: (deadline, maximum) => Math.min(maximum, deadline - state.now), now: () => state.now,
        timestamp: () => "2026-10-11T00:00:00.000Z", sleep: async milliseconds => { state.now += milliseconds; },
    };
    const target: SnapshotOwnerTarget = { backend, stateKey: backend, device };
    const app = createBrokerHyperVSnapshotApplication(ports);
    const invoke = (tool: SnapshotTool, params: Record<string, unknown> = {}) => app.invoke(owner,
        { tool, deviceId, params: { confirmDestructive: true, ...params } }, target);
    const journal = (tool: SnapshotJournal["tool"]): SnapshotJournal => ({ version: 1, operationId: "pending-operation", ownerId: owner,
        deviceId, incarnationId, tool, snapshotName: "baseline", providerName, snapshotId: checkpointId,
        confirmationRequired: tool === "device_snapshot_create", startedAt: "2026-10-11T00:00:00.000Z" });
    const repair = (retry?: string) => app.repair(owner, { backend, deviceId, device, connection: powershell }, retry);
    return { device, state, observation, execution, ports, invoke, journal, repair };
}

function linuxRestoreFixture() {
    const f = fixture("linux-vm");
    Object.assign(f.device, { snapshots: [tracked], deviceRoot: "/owned/device", sshPrivateKeyPath: "/owned/key",
        sshKnownHostsPath: "/owned/known-hosts", guestUsername: "guest", networkAddress: "192.0.2.5" });
    return f;
}

describe("broker Hyper-V snapshot policy", () => {
    it("refuses an unnamed checkpoint without staging or creating it", async () => {
        const f = fixture();
        expect(await f.invoke("device_snapshot_create")).toMatchObject({ kind: "refused", reason: "invalid", error: "missing-snapshot-name" });
        expect(f.state.journal).toBeNull();
        expect(f.ports.create).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it("requires destructive confirmation before restoring a tracked checkpoint", async () => {
        const f = fixture();
        f.device.snapshots = [tracked];
        expect(await f.invoke("device_snapshot_restore", { snapshotId: checkpointId, confirmDestructive: false })).toMatchObject({ kind: "refused", reason: "invalid", error: "destructive-confirmation-required" });
        expect(f.ports.restore).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.state.journal).toBeNull();
    });

    it("lists decoded status without requiring a native receipt", async () => {
        const f = fixture();
        vi.mocked(f.ports.status).mockResolvedValue({ execution: { ok: true }, observation: f.observation });
        expect(await f.invoke("device_snapshot_list")).toMatchObject({ kind: "listed", snapshots: [], journalDisposition: "clear" });
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it("refuses failed status even when decoded inventory is present", async () => {
        const f = fixture();
        const execution: SnapshotExecution<Receipt> = { ok: false };
        vi.mocked(f.ports.status).mockResolvedValue({ execution, observation: f.observation });
        const outcome = await f.invoke("device_snapshot_list");
        expect(outcome).toMatchObject({ kind: "refused", reason: "provider-failed", error: "hyper-v-snapshot-list-provider-failed", execution });
        expect(f.ports.diagnosticCode).toHaveBeenCalledWith(execution, "hyper-v-snapshot-list-provider-failed");
        expect(f.ports.publish).not.toHaveBeenCalled();
        const wire = renderHyperVSnapshot(outcome);
        expect(wire).toMatchObject({ status: 502, payload: { ok: false,
            execution: { mode: "exec", provider: "hyper-v", status: null, stdoutPresent: false, stderrPresent: false, outputRedacted: true } } });
        expect(wire.payload).not.toHaveProperty("execution.ok");
        expect(wire.payload).not.toHaveProperty("execution.receipt");
    });

    it.each([
        ["device_snapshot_list", "hyper-v-snapshot-list-invalid-result"],
        ["device_snapshot_create", "hyper-v-snapshot-preflight-failed"],
    ] as const)("refuses malformed decoded status for %s before staging or mutation", async (tool, error) => {
        const f = fixture();
        vi.mocked(f.ports.status).mockResolvedValue({ execution: { ok: true }, observation: null });
        expect(await f.invoke(tool, { snapshotName: "baseline" })).toMatchObject({ kind: "refused", reason: "provider-failed", error });
        expect(f.state.journal).toBeNull();
        expect(f.ports.create).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it("refuses an identity mismatch in decoded create preflight", async () => {
        const f = fixture();
        vi.mocked(f.ports.observationMismatch).mockReturnValue("hyper-v-vm-identity-mismatch");
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" })).toMatchObject({ kind: "refused",
            error: "hyper-v-snapshot-preflight-failed", detail: "hyper-v-vm-identity-mismatch" });
        expect(f.ports.observationMismatch).toHaveBeenCalledWith(f.observation,
            { vmId: "owned-vm-id", vmName: "owned-vm", diskPath: "/owned/os.vhdx" });
        expect(f.state.journal).toBeNull();
        expect(f.ports.create).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it("refuses a decoded checkpoint policy mismatch before creating", async () => {
        const f = fixture();
        f.observation.checkpointPolicy = "Production";
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" })).toMatchObject({ kind: "refused",
            reason: "conflict", error: "hyper-v-snapshot-policy-invalid" });
        expect(f.state.journal).toBeNull();
        expect(f.ports.create).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it("renders a successful mutation without a native receipt using historical execution fields", async () => {
        const f = fixture();
        vi.mocked(f.ports.lastExecution).mockReturnValue(null);
        const outcome = await f.invoke("device_snapshot_create", { snapshotName: "baseline" });
        expect(outcome).toMatchObject({ kind: "created", execution: { ok: true }, journalDisposition: "clear" });
        expect(f.state.journal).toBeNull();
        const wire = renderHyperVSnapshot(outcome);
        expect(wire).toMatchObject({ status: 200, payload: { ok: true, result: {
            execution: { mode: "exec", provider: "hyper-v", status: 0, stdoutPresent: false, stderrPresent: false, outputRedacted: true } } } });
        expect(wire.payload).not.toHaveProperty("result.execution.ok");
        expect(wire.payload).not.toHaveProperty("result.execution.receipt");
    });

    it("preserves a native receipt's public execution projection", async () => {
        const f = fixture();
        const receipt: Receipt = { nativeEvidence: "native-only", mode: "session", provider: "hyper-v", status: 0,
            stdout: "native output", stderr: "", input: "private command" };
        vi.mocked(f.ports.lastExecution).mockReturnValue({ ok: true, receipt });
        const wire = renderHyperVSnapshot(await f.invoke("device_snapshot_create", { snapshotName: "baseline" }));
        expect(wire).toMatchObject({ status: 200, payload: { ok: true, result: {
            execution: { mode: "session", provider: "hyper-v", status: 0, stdoutPresent: true, stderrPresent: false,
                outputRedacted: true, inputConfigured: true } } } });
        expect(wire.payload).not.toHaveProperty("result.execution.ok");
        expect(wire.payload).not.toHaveProperty("result.execution.receipt");
        expect(wire.payload).not.toHaveProperty("result.execution.nativeEvidence");
        expect(wire.payload).not.toHaveProperty("result.execution.stdout");
        expect(wire.payload).not.toHaveProperty("result.execution.input");
    });

    it("settles a transient list mismatch without publishing tracked state", async () => {
        const f = fixture();
        f.device.snapshots = [tracked];
        vi.mocked(f.ports.status).mockImplementationOnce(async () => ({ execution: f.execution, observation: f.observation }))
            .mockImplementationOnce(async () => {
                f.observation.snapshots = [{ snapshotId: checkpointId, snapshotName: providerName }];
                return { execution: f.execution, observation: f.observation };
            });
        expect(await f.invoke("device_snapshot_list")).toMatchObject({ kind: "listed", journalDisposition: "clear" });
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.device.snapshots).toEqual([tracked]);
        expect(f.state.now).toBe(300);
        expect(f.ports.status).toHaveBeenCalledTimes(2);
        for (const call of vi.mocked(f.ports.status).mock.calls) {
            expect(call).toEqual([powershell, { ownerId: owner, deviceId, incarnationId, vmName: "owned-vm", vmId: "owned-vm-id" }, 45000, 30000]);
        }
    });

    it("reports stable owner inventory conflict after bounded resampling", async () => {
        const f = fixture();
        f.device.snapshots = [tracked];
        f.observation.snapshots = [{ snapshotId: "foreign-checkpoint", snapshotName: `ccc-${owner}-untracked` }];
        expect(await f.invoke("device_snapshot_list")).toMatchObject({ kind: "refused", reason: "conflict",
            error: "hyper-v-snapshot-inventory-conflict", missing: [{ id: checkpointId, name: "baseline" }],
            untracked: [{ id: "foreign-checkpoint", providerName: `ccc-${owner}-untracked` }],
        });
        expect(f.ports.status).toHaveBeenCalledTimes(3);
        expect(f.state.now).toBe(600);
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it("refuses a conflict retry when the remaining list budget cannot cover its delay", async () => {
        const f = fixture();
        f.device.snapshots = [tracked];
        vi.mocked(f.ports.status).mockImplementation(async () => {
            f.state.now = 44900; return { execution: f.execution, observation: f.observation };
        });
        expect(await f.invoke("device_snapshot_list")).toMatchObject({ kind: "refused", reason: "provider-failed", error: "hyper-v-snapshot-list-provider-failed" });
        expect(f.ports.status).toHaveBeenCalledTimes(1);
        expect(f.state.now).toBe(44900);
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it("retains the created ID journal when native confirmation is indeterminate", async () => {
        const f = fixture();
        vi.mocked(f.ports.create).mockImplementation(async (_connection, _target, options) => {
            options.onCreatedId(checkpointId); throw new Error("hyper-v-snapshot-create-unconfirmed");
        });
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" })).toMatchObject({ kind: "uncertain", reason: "conflict", journalDisposition: "retain", error: "hyper-v-snapshot-create-outcome-indeterminate" });
        expect(f.state.journal).toMatchObject({ snapshotId: checkpointId, confirmationRequired: true });
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it("rolls back only the newly created checkpoint after action CAS rejects a successor", async () => {
        const f = fixture();
        const successor = { ...f.device, incarnationId: "b".repeat(32), snapshots: [{ ...tracked, id: "successor-checkpoint" }] };
        f.state.current = successor;
        vi.mocked(f.ports.publish).mockReturnValue({ found: true, matched: false, device: successor });
        vi.mocked(f.ports.lastExecution).mockReturnValue(null);
        const outcome = await f.invoke("device_snapshot_create", { snapshotName: "baseline" });
        expect(outcome).toMatchObject({ reason: "conflict", journalDisposition: "retain", rollback: { confirmed: true, execution: { ok: false } } });
        const wire = renderHyperVSnapshot(outcome);
        expect(wire).toMatchObject({ status: 409, payload: { ok: false, rollback: { confirmed: true,
            execution: { mode: "exec", provider: "hyper-v", status: null, stdoutPresent: false, stderrPresent: false, outputRedacted: true } } } });
        expect(wire.payload).not.toHaveProperty("rollback.execution.ok");
        expect(wire.payload).not.toHaveProperty("rollback.execution.receipt");
        expect(f.ports.publish).toHaveBeenCalledWith(owner, "windows-vm", deviceId, f.device, expect.objectContaining({ snapshots: [expect.objectContaining({ id: checkpointId })] }));
        expect(f.ports.delete).toHaveBeenCalledWith(powershell, { vmId: "owned-vm-id", providerName, snapshotId: checkpointId });
        expect(f.state.current).toBe(successor);
        expect(f.state.journal).not.toBeNull();
    });

    it("retains an unconfirmed rollback journal without changing successor state", async () => {
        const f = fixture();
        const successor = { ...f.device, incarnationId: "b".repeat(32) };
        f.state.current = successor;
        vi.mocked(f.ports.publish).mockReturnValue({ found: true, matched: false, device: successor });
        vi.mocked(f.ports.delete).mockRejectedValue(new Error("hyper-v-snapshot-delete-unconfirmed"));
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" })).toMatchObject({ reason: "conflict", journalDisposition: "retain",
            rollback: { confirmed: false, error: "hyper-v-snapshot-rollback-unconfirmed" } });
        expect(f.state.current).toBe(successor);
        expect(f.state.journal?.snapshotId).toBe(checkpointId);
    });

    it.each([
        [false, "hyper-v-snapshot-reconciliation-failed"],
        [true, "hyper-v-snapshot-reconciliation-invalid-result"],
    ] as const)("retains a repair journal when status completion is %s and decoded evidence is absent", async (ok, error) => {
        const f = fixture();
        f.state.journal = f.journal("device_snapshot_create");
        vi.mocked(f.ports.status).mockResolvedValue({ execution: { ok }, observation: null });
        expect(await f.repair()).toMatchObject({ ok: false, reason: "provider-failed", journalDisposition: "retain", error });
        expect(f.state.journal?.snapshotId).toBe(checkpointId);
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
    });

    it("passes a typed repair error separately from a stale receipt error", async () => {
        const f = fixture();
        f.state.journal = f.journal("device_snapshot_create");
        const failure = new Error("typed provider failure");
        const execution: SnapshotExecution<Receipt> = { ok: false,
            receipt: { nativeEvidence: "stale execution", error: "hyper-v-snapshot-list-provider-failed" } };
        vi.mocked(f.ports.lastExecution).mockReturnValue(execution);
        vi.mocked(f.ports.repairPolicy).mockRejectedValue(failure);
        vi.mocked(f.ports.providerErrorCode).mockReturnValue("hyper-v-snapshot-policy-invalid");
        expect(await f.repair()).toMatchObject({ ok: false, reason: "provider-failed", journalDisposition: "retain",
            error: "hyper-v-snapshot-reconciliation-failed", detail: "hyper-v-snapshot-policy-invalid" });
        expect(f.ports.providerErrorCode).toHaveBeenCalledWith(failure);
        expect(f.ports.diagnosticCode).toHaveBeenCalledWith(execution, "hyper-v-snapshot-reconciliation-failed", "hyper-v-snapshot-policy-invalid");
        expect(execution.receipt?.error).toBe("hyper-v-snapshot-list-provider-failed");
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
    });

    it("uses the repair diagnostic fallback when no execution receipt or typed code exists", async () => {
        const f = fixture();
        f.state.journal = f.journal("device_snapshot_create");
        vi.mocked(f.ports.lastExecution).mockReturnValue(null);
        vi.mocked(f.ports.repairPolicy).mockRejectedValue(new Error("provider disconnected"));
        expect(await f.repair()).toMatchObject({ ok: false, reason: "provider-failed", journalDisposition: "retain",
            error: "hyper-v-snapshot-reconciliation-failed", detail: "hyper-v-snapshot-reconciliation-failed" });
        expect(f.ports.diagnosticCode).toHaveBeenCalledWith(null, "hyper-v-snapshot-reconciliation-failed", undefined);
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
    });

    it("keeps an ambiguous repair journal and publishes no metadata", async () => {
        const f = fixture();
        f.state.journal = f.journal("device_snapshot_create");
        f.observation.snapshots = [{ snapshotId: checkpointId, snapshotName: providerName },
            { snapshotId: "other-checkpoint", snapshotName: providerName }];
        expect(await f.repair()).toMatchObject({ ok: false, reason: "conflict", journalDisposition: "retain", error: "hyper-v-snapshot-reconciliation-ambiguous" });
        expect(f.state.journal).not.toBeNull();
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
    });

    it("permits only the exact restore retry and retains its journal after reconciliation", async () => {
        const f = fixture();
        f.state.journal = f.journal("device_snapshot_restore");
        f.device.snapshots = [tracked];
        f.observation.snapshots = [{ snapshotId: checkpointId, snapshotName: providerName }];
        expect(await f.repair("another-checkpoint")).toMatchObject({ ok: false, reason: "conflict", journalDisposition: "retain", error: "hyper-v-snapshot-restore-outcome-indeterminate" });
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
        expect(await f.repair(checkpointId.toUpperCase())).toMatchObject({ ok: true, reconciled: true });
        expect(f.state.journal?.snapshotId).toBe(checkpointId);
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
        expect(f.state.current.snapshots).toEqual([tracked]);
    });

    it("publishes a restored Linux guest only after readiness changes from false to true", async () => {
        const f = linuxRestoreFixture();
        vi.mocked(f.ports.sshReady).mockResolvedValueOnce({ ready: false, execution: { ok: true } })
            .mockImplementationOnce(async () => {
                expect(f.ports.publish).not.toHaveBeenCalled();
                expect(f.state.journal?.tool).toBe("device_snapshot_restore");
                return { ready: true, execution: { ok: true } };
            });
        expect(await f.invoke("device_snapshot_restore", { snapshotId: checkpointId })).toMatchObject({ kind: "restored",
            journalDisposition: "clear", device: { activeSnapshotId: checkpointId, status: "running", bootReady: true } });
        expect(f.ports.sshReady).toHaveBeenCalledTimes(2);
        expect(f.state.now).toBe(2000);
        expect(f.ports.publish).toHaveBeenCalledTimes(1);
        expect(f.state.journal).toBeNull();
    });

    it("does not publish a restored Linux guest when a successful SSH command has no readiness observation", async () => {
        const f = linuxRestoreFixture();
        const receipt = Object.freeze({ nativeEvidence: "successful SSH without a marker", mode: "exec", provider: "hyper-v-ssh", status: 0, stdout: "unqualified native output" });
        const execution: SnapshotExecution<Receipt> = { ok: true, receipt };
        vi.mocked(f.ports.sshReady).mockResolvedValue({ ready: false, execution });
        expect(await f.invoke("device_snapshot_restore", { snapshotId: checkpointId })).toMatchObject({ kind: "refused", reason: "provider-failed", journalDisposition: "retain", error: "hyper-v-linux-guest-provider-failed" });
        expect(f.ports.restore).toHaveBeenCalledWith(powershell, expect.objectContaining({ snapshotId: checkpointId }),
            { force: false, startAfterRestore: true });
        expect(f.ports.sshReady).toHaveBeenCalledTimes(60);
        expect(f.state.now).toBe(120000);
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.state.journal?.tool).toBe("device_snapshot_restore");
        expect(f.state.current).toBe(f.device);
        expect(execution.receipt).toBe(receipt);
        expect(receipt).toEqual({ nativeEvidence: "successful SSH without a marker", mode: "exec", provider: "hyper-v-ssh", status: 0, stdout: "unqualified native output" });
    });
});
