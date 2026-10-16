import { describe, expect, it, vi } from "vitest";
import { createBrokerHyperVSnapshotApplication } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-snapshots.js";
import { renderHyperVSnapshot } from "../../../packages/device-lab/src/device-lab/broker/hyper-v/lifecycle-outcomes.js";
import type { DeviceLabHyperVCommandResult } from "../../../packages/device-lab/src/device-lab/broker/hyper-v/lifecycle-adapter.js";
import type { SnapshotAllowance, SnapshotExecution, SnapshotJournal, SnapshotOwnerTarget, SnapshotTool, SnapshotTracked, SnapshotVmObservation } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-snapshots.js";
import type { BrokerHyperVSnapshotPorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-snapshots.js";
import { HyperVOperationDeadlineError, hyperVRemainingTimeout } from "../../../packages/device-lab/src/device-lab/broker/hyper-v/deadline.js";

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
    const matchesJournal = (expectedDevice: Record<string, unknown>, expectedJournal: SnapshotJournal) =>
        state.current.incarnationId === expectedDevice.incarnationId && state.current.vmId === expectedDevice.vmId
        && state.current.vmName === expectedDevice.vmName && JSON.stringify(state.journal) === JSON.stringify(expectedJournal);
    const removeJournal: SnapshotPorts["clearJournal"] = (_owner, _backend, _id, expectedDevice, expectedJournal, beforeClear) => {
        if (!matchesJournal(expectedDevice, expectedJournal)) return { found: true, matched: false, device: state.current };
        beforeClear();
        state.journal = null;
        return { found: true, matched: true, device: state.current };
    };
    const ports: SnapshotPorts = {
        connection: provider => provider === "powershell" ? powershell : ssh, incarnation: value => typeof value.incarnationId === "string" ? value.incarnationId : null,
        validIncarnation: (value): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value),
        providerName: (id, name) => `ccc-${id}-${name}`, ownershipNotes: (id, target, generation) => `${id}:${target}:${generation}`,
        journalExists: () => state.journal !== null, readJournal: () => state.journal,
        writeJournal: vi.fn<SnapshotPorts["writeJournal"]>((_owner, _backend, _device, generation, tool, name, nativeName, id, policy) => {
            state.journal = { version: 1, operationId: "operation", ownerId: owner, deviceId, incarnationId: generation,
                tool, snapshotName: name, providerName: nativeName, snapshotId: id, expectedCheckpointPolicy: policy,
                confirmationRequired: tool === "device_snapshot_create", startedAt: "2026-10-11T00:00:00.000Z" };
            return state.journal;
        }),
        recordCreatedId: vi.fn<SnapshotPorts["recordCreatedId"]>((_owner, _backend, _device, expectedDevice, expectedJournal, id) => {
            if (!matchesJournal(expectedDevice, expectedJournal)) return null;
            state.journal = { ...expectedJournal, snapshotId: id }; return state.journal;
        }),
        clearJournal: vi.fn<SnapshotPorts["clearJournal"]>(removeJournal),
        removeRepairJournal: vi.fn<SnapshotPorts["removeRepairJournal"]>(removeJournal),
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
        lastExecution: vi.fn<SnapshotPorts["lastExecution"]>(() => execution), providerErrorKind: () => null,
        isDeadlineError: error => error instanceof HyperVOperationDeadlineError,
        errorCode: (error, fallback) => error instanceof Error ? error.message : fallback,
        providerErrorCode: vi.fn<SnapshotPorts["providerErrorCode"]>(() => undefined),
        diagnosticCode: vi.fn<SnapshotPorts["diagnosticCode"]>((result, fallback, override) => override ?? result?.receipt?.error ?? fallback),
        publish: vi.fn<SnapshotPorts["publish"]>((_owner, _backend, _device, expected, replacement, beforePublish) => {
            if (JSON.stringify(state.current) !== JSON.stringify(expected)) return { found: true, matched: false, device: state.current };
            beforePublish?.();
            state.current = replacement; return { found: true, matched: true, device: replacement };
        }),
        mergeRepair: vi.fn<SnapshotPorts["mergeRepair"]>((_owner, _backend, _device, _original, patch, beforePublish) => {
            beforePublish?.();
            state.current = { ...state.current, ...patch }; return { found: true, matched: true, device: state.current };
        }),
        forgetConsole: () => undefined,
        sshReady: vi.fn<SnapshotPorts["sshReady"]>(async () => ({ ready: false, execution: { ok: false } })),
        remainingTimeout: (deadline, maximum) => hyperVRemainingTimeout(deadline, maximum, () => state.now), now: () => state.now,
        timestamp: () => "2026-10-11T00:00:00.000Z", sleep: async milliseconds => { state.now += milliseconds; },
    };
    const target: SnapshotOwnerTarget = { backend, stateKey: backend, device };
    const app = createBrokerHyperVSnapshotApplication(ports);
    const invoke = (tool: SnapshotTool, params: Record<string, unknown> = {}, allowance?: SnapshotAllowance) => app.invoke(owner,
        { tool, deviceId, params: { confirmDestructive: true, ...params } }, target, allowance);
    const journal = (tool: SnapshotJournal["tool"]): SnapshotJournal => ({ version: 1, operationId: "pending-operation", ownerId: owner,
        deviceId, incarnationId, tool, snapshotName: "baseline", providerName, snapshotId: checkpointId,
        confirmationRequired: tool === "device_snapshot_create", startedAt: "2026-10-11T00:00:00.000Z" });
    const repair = (retry?: string, parentDeadlineAt?: number) => app.repair(owner, { backend, deviceId, device, connection: powershell }, retry, parentDeadlineAt);
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
        vi.mocked(f.ports.publish).mockImplementation(() => {
            expect(f.state.journal?.snapshotId).toBe(checkpointId);
            f.state.current = successor;
            return { found: true, matched: false, device: successor };
        });
        vi.mocked(f.ports.lastExecution).mockReturnValue(null);
        const outcome = await f.invoke("device_snapshot_create", { snapshotName: "baseline" });
        expect(outcome).toMatchObject({ reason: "conflict", journalDisposition: "retain", rollback: { confirmed: true, execution: { ok: false } } });
        const wire = renderHyperVSnapshot(outcome);
        expect(wire).toMatchObject({ status: 409, payload: { ok: false, rollback: { confirmed: true,
            execution: { mode: "exec", provider: "hyper-v", status: null, stdoutPresent: false, stderrPresent: false, outputRedacted: true } } } });
        expect(wire.payload).not.toHaveProperty("rollback.execution.ok");
        expect(wire.payload).not.toHaveProperty("rollback.execution.receipt");
        expect(f.ports.publish).toHaveBeenCalledWith(owner, "windows-vm", deviceId, f.device, expect.objectContaining({ snapshots: [expect.objectContaining({ id: checkpointId })] }), expect.any(Function));
        expect(f.ports.delete).toHaveBeenCalledWith(powershell, { vmId: "owned-vm-id", providerName, snapshotId: checkpointId }, expect.any(Number));
        expect(f.state.current).toBe(successor);
        expect(f.state.journal).not.toBeNull();
    });

    it("retains an unconfirmed rollback journal without changing successor state", async () => {
        const f = fixture();
        const successor = { ...f.device, incarnationId: "b".repeat(32) };
        vi.mocked(f.ports.publish).mockImplementation(() => {
            expect(f.state.journal?.snapshotId).toBe(checkpointId);
            f.state.current = successor;
            return { found: true, matched: false, device: successor };
        });
        vi.mocked(f.ports.delete).mockRejectedValue(new Error("hyper-v-snapshot-delete-unconfirmed"));
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" })).toMatchObject({ reason: "conflict", journalDisposition: "retain",
            rollback: { confirmed: false, error: "hyper-v-snapshot-rollback-unconfirmed" } });
        expect(f.ports.delete).toHaveBeenCalledWith(powershell, { vmId: "owned-vm-id", providerName, snapshotId: checkpointId }, expect.any(Number));
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

    it.each([-1, 1] as const)("uses the parent repair deadline while wall time jumps %s", async direction => {
        const f = fixture();
        f.state.now = 17.25;
        const deadline = f.state.now + 5000;
        const journal = f.journal("device_snapshot_delete");
        f.state.journal = journal;
        let wall = 1_800_000_000_000;
        const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wall);
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target, repairDeadline) => {
            expect(repairDeadline).toBe(deadline);
            f.state.now += 1250.5;
            wall += direction * 86_400_000;
            return { checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 0 };
        });
        vi.mocked(f.ports.status).mockImplementation(async (_connection, _identity, statusDeadline, cap) => {
            expect(statusDeadline).toBe(deadline);
            expect(cap).toBeGreaterThan(0);
            expect(cap).toBeLessThanOrEqual(30000);
            expect(Math.floor(statusDeadline - f.state.now)).toBe(3749);
            return { execution: f.execution, observation: f.observation };
        });
        try {
            expect(await f.repair(undefined, deadline)).toMatchObject({ ok: true, reconciled: true, journalDisposition: "clear" });
            expect(f.ports.repairPolicy).toHaveBeenCalledOnce();
            expect(f.ports.status).toHaveBeenCalledOnce();
            expect(f.ports.mergeRepair).toHaveBeenCalledOnce();
            expect(f.state.journal).toBeNull();
        } finally { wallClock.mockRestore(); }
    });

    it("captures one standalone repair allowance before policy repair consumes it", async () => {
        const f = fixture();
        f.state.now = 17.25;
        const deadline = f.state.now + 60000;
        f.state.journal = f.journal("device_snapshot_delete");
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target, repairDeadline) => {
            expect(repairDeadline).toBe(deadline);
            f.state.now += 45000;
            return { checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 0 };
        });
        expect(await f.repair()).toMatchObject({ ok: true, reconciled: true, journalDisposition: "clear" });
        expect(f.ports.status).toHaveBeenCalledWith(powershell, expect.objectContaining({ vmId: "owned-vm-id" }), deadline, 30000);
        expect(f.state.now).toBe(45017.25);
    });

    it("does not renew standalone repair time when status completes beyond its original sixty seconds", async () => {
        const f = fixture();
        f.state.now = 17.25;
        const deadline = f.state.now + 60000;
        const journal = f.journal("device_snapshot_delete");
        f.state.journal = journal;
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target, repairDeadline) => {
            expect(repairDeadline).toBe(deadline);
            f.state.now += 29000;
            return { checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 0 };
        });
        vi.mocked(f.ports.status).mockImplementation(async (_connection, _identity, statusDeadline) => {
            expect(statusDeadline).toBeLessThanOrEqual(deadline);
            f.state.now = deadline;
            return { execution: f.execution, observation: f.observation };
        });
        await expect(f.repair()).rejects.toBeInstanceOf(HyperVOperationDeadlineError);
        expect(f.state.journal).toBe(journal);
        expect(f.state.current).toBe(f.device);
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
    });

    it("retains the status combination's own cap when a longer parent still has time", async () => {
        const f = fixture();
        f.state.now = 17.25;
        const parentDeadline = f.state.now + 120000;
        f.state.journal = f.journal("device_snapshot_delete");
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target, deadline) => {
            expect(deadline).toBe(parentDeadline);
            f.state.now += 10000.5;
            return { checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 0 };
        });
        vi.mocked(f.ports.status).mockImplementation(async (_connection, _identity, deadline, cap) => {
            expect(deadline).toBe(f.state.now + 30000);
            expect(deadline).toBeLessThan(parentDeadline);
            expect(cap).toBe(30000);
            f.state.now = deadline;
            return { execution: { ok: false, receipt: { nativeEvidence: "status cap", error: "hyper-v-status-timeout" } }, observation: null };
        });
        expect(await f.repair(undefined, parentDeadline)).toMatchObject({ ok: false, reason: "provider-failed",
            error: "hyper-v-snapshot-reconciliation-failed", detail: "hyper-v-status-timeout", journalDisposition: "retain" });
        expect(f.state.now).toBeLessThan(parentDeadline);
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
    });

    it.each(["before-repair", "fractional-before-repair", "after-repair", "fractional-after-repair", "after-status", "inside-publication", "before-clear"] as const)(
        "retains journal and refuses expired parent budget %s", async phase => {
            const f = fixture();
            f.state.now = 17.25;
            const deadline = f.state.now + 5000;
            f.state.journal = f.journal("device_snapshot_delete");
            const journal = structuredClone(f.state.journal);
            vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target) => {
                if (phase === "after-repair") f.state.now = deadline;
                if (phase === "fractional-after-repair") f.state.now = deadline - 0.25;
                return { checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 0 };
            });
            vi.mocked(f.ports.status).mockImplementation(async () => {
                if (phase === "after-status") f.state.now = deadline;
                return { execution: f.execution, observation: f.observation };
            });
            if (phase === "before-repair") f.state.now = deadline;
            if (phase === "fractional-before-repair") f.state.now = deadline - 0.25;
            if (phase === "inside-publication" || phase === "before-clear") {
                vi.mocked(f.ports.mergeRepair).mockImplementation((_owner, _backend, _id, _original, patch, beforePublish) => {
                    if (phase === "inside-publication") f.state.now = deadline;
                    beforePublish?.();
                    f.state.current = { ...f.state.current, ...patch };
                    if (phase === "before-clear") f.state.now = deadline;
                    return { found: true, matched: true, device: f.state.current };
                });
            }
            await expect(f.repair(undefined, deadline)).rejects.toBeInstanceOf(HyperVOperationDeadlineError);
            expect(f.state.journal).toEqual(journal);
            expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
            if (phase === "before-repair" || phase === "fractional-before-repair") expect(f.ports.repairPolicy).not.toHaveBeenCalled();
            if (["before-repair", "fractional-before-repair", "after-repair", "fractional-after-repair"].includes(phase)) expect(f.ports.status).not.toHaveBeenCalled();
            if (["before-repair", "fractional-before-repair", "after-repair", "fractional-after-repair", "after-status"].includes(phase)) expect(f.ports.mergeRepair).not.toHaveBeenCalled();
            if (phase !== "before-clear") expect(f.state.current).toBe(f.device);
        },
    );

    it.each(["repair", "status"] as const)("does not replace the real %s provider failure when its response is late", async phase => {
        const f = fixture();
        const deadline = 5000;
        f.state.journal = f.journal("device_snapshot_delete");
        const nativeFailure = new Error("original-native-failure");
        vi.mocked(f.ports.providerErrorCode).mockReturnValue("hyper-v-native-failure");
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target) => {
            if (phase === "repair") { f.state.now = deadline; throw nativeFailure; }
            return { checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 0 };
        });
        vi.mocked(f.ports.status).mockImplementation(async () => {
            f.state.now = deadline;
            return { execution: { ok: false, receipt: { nativeEvidence: "native failure", error: "hyper-v-native-failure" } }, observation: null };
        });
        expect(await f.repair(undefined, deadline)).toMatchObject({ ok: false, reason: "provider-failed", journalDisposition: "retain",
            error: "hyper-v-snapshot-reconciliation-failed", detail: "hyper-v-native-failure" });
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
        expect(f.state.journal?.snapshotId).toBe(checkpointId);
    });

    it("propagates a typed pre-dispatch repair deadline instead of classifying it as native failure", async () => {
        const f = fixture();
        f.state.journal = f.journal("device_snapshot_delete");
        const expired = new HyperVOperationDeadlineError();
        vi.mocked(f.ports.repairPolicy).mockRejectedValue(expired);
        await expect(f.repair(undefined, 5000)).rejects.toBe(expired);
        expect(f.ports.providerErrorCode).not.toHaveBeenCalled();
        expect(f.ports.status).not.toHaveBeenCalled();
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
    });

    it.each([false, true])("refuses a repair publication when current record found=%s no longer matches", async found => {
        const f = fixture();
        const successor = { ...f.device, incarnationId: "b".repeat(32), snapshots: [{ id: "new-checkpoint" }] };
        f.state.journal = f.journal("device_snapshot_delete");
        const journal = structuredClone(f.state.journal);
        vi.mocked(f.ports.repairPolicy).mockResolvedValue({ checkpointPolicy: "ProductionOnly", candidateCount: 0 });
        vi.mocked(f.ports.mergeRepair).mockReturnValue({ found, matched: false, device: found ? successor : null });
        expect(await f.repair(undefined, 5000)).toMatchObject({ ok: false, reason: "conflict", journalDisposition: "retain",
            error: "hyper-v-snapshot-state-conflict" });
        expect(f.state.current).toBe(f.device);
        expect(f.state.journal).toEqual(journal);
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
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
            { force: false, startAfterRestore: true, deadlineAt: 240000 });
        expect(f.ports.sshReady).toHaveBeenCalledTimes(60);
        expect(f.state.now).toBe(120000);
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.state.journal?.tool).toBe("device_snapshot_restore");
        expect(f.state.current).toBe(f.device);
        expect(execution.receipt).toBe(receipt);
        expect(receipt).toEqual({ nativeEvidence: "successful SSH without a marker", mode: "exec", provider: "hyper-v-ssh", status: 0, stdout: "unqualified native output" });
    });

    it("charges initial journal repair and preflight against the invocation's captured allowance", async () => {
        const f = fixture();
        const allowance = { operationDeadlineAt: 10000, cleanupDeadlineAt: 13000 };
        f.state.journal = f.journal("device_snapshot_delete");
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target, deadline) => {
            expect(deadline).toBe(allowance.operationDeadlineAt);
            f.state.now += 2000;
            return { checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 0 };
        });
        vi.mocked(f.ports.status).mockImplementation(async (_connection, _target, deadline) => {
            expect(deadline).toBe(allowance.operationDeadlineAt);
            f.state.now += 1000;
            return { execution: f.execution, observation: f.observation };
        });
        vi.mocked(f.ports.create).mockImplementation(async (_connection, target, options) => {
            expect(f.state.now).toBe(4000);
            expect(options.timeoutMilliseconds()).toBe(6000);
            expect(options.remainingMilliseconds()).toBe(6000);
            expect(options.monotonicNow()).toBe(4000);
            options.onCreatedId(checkpointId);
            return { ok: true, snapshotId: checkpointId, snapshotName: target.providerName };
        });
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" }, allowance)).toMatchObject({ kind: "created" });
        expect(f.ports.status).toHaveBeenCalledTimes(2);
        expect(f.state.journal).toBeNull();
    });

    it("decreases native create durations on repeated reads of the same invocation allowance", async () => {
        const f = fixture();
        f.state.now = 100.25;
        vi.mocked(f.ports.status).mockImplementation(async () => {
            f.state.now += 29998.5;
            return { execution: f.execution, observation: f.observation };
        });
        vi.mocked(f.ports.create).mockImplementation(async (_connection, target, options) => {
            expect(options.monotonicNow()).toBe(30098.75);
            expect(options.remainingMilliseconds()).toBe(45000);
            expect(options.timeoutMilliseconds()).toBe(45000);
            f.state.now += 20000.5;
            expect(options.remainingMilliseconds()).toBe(24999.5);
            expect(options.timeoutMilliseconds()).toBe(24999);
            options.onCreatedId(checkpointId);
            return { ok: true, snapshotId: checkpointId, snapshotName: target.providerName };
        });
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" })).toMatchObject({ kind: "created" });
        expect(f.state.journal).toBeNull();
        expect(f.state.current.snapshots).toEqual([expect.objectContaining({ id: checkpointId })]);
    });

    it("does not stage a new action when initial repair consumes the supplied operation deadline", async () => {
        const f = fixture();
        const journal = f.journal("device_snapshot_delete");
        f.state.journal = journal;
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target) => {
            f.state.now = 5000;
            return { checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 0 };
        });
        await expect(f.invoke("device_snapshot_create", { snapshotName: "baseline" },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 })).rejects.toBeInstanceOf(HyperVOperationDeadlineError);
        expect(f.state.journal).toBe(journal);
        expect(f.ports.writeJournal).not.toHaveBeenCalled();
        expect(f.ports.create).not.toHaveBeenCalled();
        expect(f.ports.status).not.toHaveBeenCalled();
    });

    it.each(["first-read", "conflict-retry"] as const)("rejects a successful list %s that completes after the operation deadline", async phase => {
        const f = fixture();
        if (phase === "conflict-retry") f.device.snapshots = [tracked];
        let reads = 0;
        vi.mocked(f.ports.status).mockImplementation(async () => {
            reads += 1;
            if (phase === "first-read" || reads === 2) {
                f.state.now = 5000;
                f.observation.snapshots = phase === "conflict-retry" ? [{ snapshotId: checkpointId, snapshotName: providerName }] : [];
            }
            return { execution: f.execution, observation: f.observation };
        });
        await expect(f.invoke("device_snapshot_list", {}, { operationDeadlineAt: 5000, cleanupDeadlineAt: 5000 }))
            .rejects.toBeInstanceOf(HyperVOperationDeadlineError);
        expect(reads).toBe(phase === "first-read" ? 1 : 2);
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
    });

    it.each([5000, 5001] as const)("rejects list retry sleep resuming at %sms against its captured 5000ms deadline", async resumedAt => {
        const f = fixture();
        f.device.snapshots = [tracked];
        const sleep = vi.fn(async (milliseconds: number) => {
            expect(milliseconds).toBe(300);
            f.state.now = resumedAt;
        });
        f.ports.sleep = sleep;
        await expect(f.invoke("device_snapshot_list", {}, { operationDeadlineAt: 5000, cleanupDeadlineAt: 5000 }))
            .rejects.toBeInstanceOf(HyperVOperationDeadlineError);
        expect(sleep).toHaveBeenCalledOnce();
        expect(f.ports.status).toHaveBeenCalledOnce();
        expect(f.state.now).toBe(resumedAt);
        expect(f.state.current).toBe(f.device);
        expect(f.state.journal).toBeNull();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
    });

    it("preserves a real failed list retry read received after the captured deadline", async () => {
        const f = fixture();
        f.device.snapshots = [tracked];
        const receipt: Receipt = { nativeEvidence: "late retry access failure", error: "hyper-v-provider-access-denied", status: 1 };
        const execution: SnapshotExecution<Receipt> = { ok: false, receipt };
        vi.mocked(f.ports.status).mockResolvedValueOnce({ execution: f.execution, observation: f.observation })
            .mockImplementationOnce(async (_connection, _target, deadlineAt) => {
                expect(deadlineAt).toBe(5000);
                f.state.now = 5001;
                return { execution, observation: null };
            });
        const outcome = await f.invoke("device_snapshot_list", {}, { operationDeadlineAt: 5000, cleanupDeadlineAt: 5000 });
        expect(outcome).toMatchObject({ kind: "refused", reason: "provider-failed", error: "hyper-v-snapshot-list-provider-failed",
            detail: "hyper-v-provider-access-denied" });
        expect(outcome.execution).toBe(execution);
        expect(outcome.execution?.receipt).toBe(receipt);
        expect(renderHyperVSnapshot(outcome).status).toBe(502);
        expect(f.ports.status).toHaveBeenCalledTimes(2);
        expect(f.state.current).toBe(f.device);
        expect(f.state.journal).toBeNull();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
    });

    it("preserves a real list failure when its response arrives after the operation deadline", async () => {
        const f = fixture();
        const execution: SnapshotExecution<Receipt> = { ok: false,
            receipt: { nativeEvidence: "late real failure", error: "hyper-v-provider-access-denied" } };
        vi.mocked(f.ports.status).mockImplementation(async () => {
            f.state.now = 5000;
            return { execution, observation: null };
        });
        expect(await f.invoke("device_snapshot_list", {}, { operationDeadlineAt: 5000, cleanupDeadlineAt: 5000 }))
            .toMatchObject({ kind: "refused", reason: "provider-failed", execution, detail: "hyper-v-provider-access-denied" });
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it("records the trustworthy created ID after expiry while retaining the journal and refusing success", async () => {
        const f = fixture();
        let capturedJournal: SnapshotJournal | null = null;
        vi.mocked(f.ports.create).mockImplementation(async (_connection, target, options) => {
            capturedJournal = structuredClone(f.state.journal);
            f.state.now = 5001;
            options.onCreatedId(checkpointId);
            return { ok: true, snapshotId: checkpointId, snapshotName: target.providerName };
        });
        await expect(f.invoke("device_snapshot_create", { snapshotName: "baseline" },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 })).rejects.toBeInstanceOf(HyperVOperationDeadlineError);
        expect(f.ports.recordCreatedId).toHaveBeenCalledWith(owner, "windows-vm", deviceId, f.device, capturedJournal, checkpointId);
        expect(f.state.journal).toMatchObject({ operationId: "operation", snapshotId: checkpointId, confirmationRequired: true });
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
    });

    it("leaves a same-generation replacement journal unchanged when created-ID recording is refused", async () => {
        const f = fixture();
        let replacement: SnapshotJournal | null = null;
        vi.mocked(f.ports.create).mockImplementation(async (_connection, target, options) => {
            if (!f.state.journal) throw new Error("fixture journal missing");
            replacement = { ...f.state.journal, operationId: "replacement-operation", snapshotId: "replacement-checkpoint" };
            f.state.journal = replacement;
            options.onCreatedId(checkpointId);
            return { ok: true, snapshotId: checkpointId, snapshotName: target.providerName };
        });
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 })).toMatchObject({ kind: "uncertain", journalDisposition: "retain",
            detail: "hyper-v-snapshot-created-id-journal-mismatch" });
        expect(f.state.journal).toBe(replacement);
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
        expect(f.ports.delete).not.toHaveBeenCalled();
    });

    it("rechecks time inside action publication after lock wait", async () => {
        const f = fixture();
        vi.mocked(f.ports.publish).mockImplementation((_owner, _backend, _id, _expected, replacement, beforePublish) => {
            f.state.now = 5000;
            beforePublish?.();
            f.state.current = replacement;
            return { found: true, matched: true, device: replacement };
        });
        await expect(f.invoke("device_snapshot_create", { snapshotName: "baseline" },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 })).rejects.toBeInstanceOf(HyperVOperationDeadlineError);
        expect(f.state.current).toBe(f.device);
        expect(f.state.journal?.snapshotId).toBe(checkpointId);
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
    });

    it("retains applied state and its journal when qualified clearing expires after publication", async () => {
        const f = fixture();
        const clear = vi.mocked(f.ports.clearJournal).getMockImplementation();
        vi.mocked(f.ports.clearJournal).mockImplementation((...args) => {
            f.state.now = 5000;
            if (!clear) throw new Error("fixture clear missing");
            return clear(...args);
        });
        await expect(f.invoke("device_snapshot_create", { snapshotName: "baseline" },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 })).rejects.toBeInstanceOf(HyperVOperationDeadlineError);
        expect(f.state.current).not.toBe(f.device);
        expect(f.state.current.snapshots).toEqual([expect.objectContaining({ id: checkpointId })]);
        expect(f.state.journal).toMatchObject({ operationId: "operation", snapshotId: checkpointId });
        expect(f.ports.delete).not.toHaveBeenCalled();
    });

    it("does not remove a same-generation replacement journal after its own action publication", async () => {
        const f = fixture();
        let replacementJournal: SnapshotJournal | null = null;
        vi.mocked(f.ports.publish).mockImplementation((_owner, _backend, _id, _expected, replacement, beforePublish) => {
            beforePublish?.();
            f.state.current = replacement;
            if (!f.state.journal) throw new Error("fixture journal missing");
            replacementJournal = { ...f.state.journal, operationId: "next-operation" };
            f.state.journal = replacementJournal;
            return { found: true, matched: true, device: replacement };
        });
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 })).toMatchObject({ kind: "refused", reason: "conflict",
            error: "hyper-v-snapshot-state-conflict", journalDisposition: "retain" });
        expect(f.state.journal).toBe(replacementJournal);
        expect(f.state.current.snapshots).toEqual([expect.objectContaining({ id: checkpointId })]);
    });

    it("rechecks repair clearing under its authority boundary after lock wait", async () => {
        const f = fixture();
        const journal = f.journal("device_snapshot_delete");
        f.state.journal = journal;
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target) => ({ checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 0 }));
        const clear = vi.mocked(f.ports.removeRepairJournal).getMockImplementation();
        vi.mocked(f.ports.removeRepairJournal).mockImplementation((...args) => {
            f.state.now = 5000;
            if (!clear) throw new Error("fixture repair clear missing");
            return clear(...args);
        });
        await expect(f.repair(undefined, 5000)).rejects.toBeInstanceOf(HyperVOperationDeadlineError);
        expect(f.state.journal).toBe(journal);
        expect(f.state.current).not.toBe(f.device);
        expect(f.ports.removeRepairJournal).toHaveBeenCalledWith(owner, "windows-vm", deviceId, f.device, journal, expect.any(Function));
    });

    it("does not publish repaired metadata over a same-generation journal replacement", async () => {
        const f = fixture();
        f.state.journal = f.journal("device_snapshot_delete");
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target) => ({ checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 0 }));
        const replacement = { ...f.state.journal, operationId: "next-operation" };
        vi.mocked(f.ports.status).mockImplementation(async () => {
            f.state.journal = replacement;
            return { execution: f.execution, observation: f.observation };
        });
        expect(await f.repair(undefined, 5000)).toMatchObject({ ok: false, reason: "conflict",
            error: "hyper-v-snapshot-state-conflict", journalDisposition: "retain" });
        expect(f.state.journal).toBe(replacement);
        expect(f.state.current).toBe(f.device);
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
    });

    it("retains a replacement operation journal introduced after repaired metadata was published", async () => {
        const f = fixture();
        const originalJournal = f.journal("device_snapshot_delete");
        f.state.journal = originalJournal;
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target) => ({ checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 0 }));
        const replacementJournal = { ...originalJournal, operationId: "replacement-after-repair-publication" };
        const merge = vi.mocked(f.ports.mergeRepair).getMockImplementation();
        vi.mocked(f.ports.mergeRepair).mockImplementation((...args) => {
            if (!merge) throw new Error("fixture repair merge missing");
            const publication = merge(...args);
            f.state.journal = replacementJournal;
            return publication;
        });
        expect(await f.repair(undefined, 5000)).toMatchObject({ ok: false, reason: "conflict",
            error: "hyper-v-snapshot-state-conflict", journalDisposition: "retain" });
        expect(f.state.current).not.toBe(f.device);
        expect(f.state.journal).toBe(replacementJournal);
        expect(f.ports.removeRepairJournal).toHaveBeenCalledWith(owner, "windows-vm", deviceId,
            f.device, originalJournal, expect.any(Function));
    });

    it("keeps validation primary when qualified clearing cannot complete before the operation deadline", async () => {
        const f = fixture();
        const failure = new Error("native-options-invalid");
        f.ports.providerErrorKind = error => error === failure ? "validation" : null;
        vi.mocked(f.ports.create).mockRejectedValue(failure);
        const clear = vi.mocked(f.ports.clearJournal).getMockImplementation();
        vi.mocked(f.ports.clearJournal).mockImplementation((...args) => {
            f.state.now = 5000;
            if (!clear) throw new Error("fixture clear missing");
            return clear(...args);
        });
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 })).toMatchObject({ kind: "refused", reason: "invalid",
            error: "invalid-hyper-v-snapshot-options", journalDisposition: "retain" });
        expect(f.state.journal?.tool).toBe("device_snapshot_create");
        expect(f.ports.repairPolicy).not.toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it.each([1000, 4999] as const)("uses the admission-captured cleanup deadline after an action CAS conflict at %sms", async elapsed => {
        const f = fixture();
        const allowance = { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 };
        const successor = { ...f.device, incarnationId: "b".repeat(32) };
        vi.mocked(f.ports.publish).mockImplementation(() => {
            f.state.now = elapsed;
            f.state.current = successor;
            return { found: true, matched: false, device: successor };
        });
        vi.mocked(f.ports.delete).mockImplementation(async (_connection, target, deadlineAt) => {
            expect(deadlineAt).toBe(allowance.cleanupDeadlineAt);
            expect(f.ports.remainingTimeout(deadlineAt, 120000)).toBe(8000 - elapsed);
            return { ok: true, deleted: true, snapshotId: target.snapshotId || "", snapshotName: target.providerName };
        });
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" }, allowance)).toMatchObject({ reason: "conflict",
            rollback: { confirmed: true }, journalDisposition: "retain" });
        expect(f.state.current).toBe(successor);
        expect(f.state.journal?.snapshotId).toBe(checkpointId);
    });

    it.each([1000, 6000] as const)("preserves the primary native failure and fixed cleanup deadline after rejection at %sms", async elapsed => {
        const f = fixture();
        const allowance = { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 };
        const primaryExecution: SnapshotExecution<Receipt> = { ok: false,
            receipt: { nativeEvidence: "actual mutation failure", error: "hyper-v-native-primary" } };
        let lastExecution = primaryExecution;
        vi.mocked(f.ports.lastExecution).mockImplementation(() => lastExecution);
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, _target, deadlineAt) => {
            expect(deadlineAt).toBe(allowance.cleanupDeadlineAt);
            expect(f.ports.remainingTimeout(deadlineAt || 0, 30000)).toBe(8000 - elapsed);
            lastExecution = { ok: false, receipt: { nativeEvidence: "cleanup failure", error: "cleanup-expired" } };
            f.state.now = allowance.cleanupDeadlineAt;
            throw new HyperVOperationDeadlineError();
        });
        f.device.snapshots = [tracked];
        vi.mocked(f.ports.delete).mockImplementation(async () => {
            f.state.now = elapsed;
            throw new Error("hyper-v-native-primary");
        });
        const outcome = await f.invoke("device_snapshot_delete", { snapshotId: checkpointId }, allowance);
        expect(outcome).toMatchObject({ kind: "refused",
            reason: "provider-failed", execution: primaryExecution, executionDiagnostic: "hyper-v-native-primary", journalDisposition: "retain" });
        expect(outcome.execution).toBe(primaryExecution);
        expect(renderHyperVSnapshot(outcome).status).toBe(502);
        expect(f.ports.repairPolicy).toHaveBeenCalledOnce();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.state.journal?.tool).toBe("device_snapshot_delete");
    });

    it.each([
        ["device_snapshot_create", "protocol", "untrusted-response", "hyper-v-snapshot-create-outcome-indeterminate"],
        ["device_snapshot_create", "transport", "untrusted-response", "hyper-v-snapshot-create-outcome-indeterminate"],
        ["device_snapshot_restore", "protocol", "untrusted-response", "hyper-v-snapshot-restore-outcome-indeterminate"],
        ["device_snapshot_restore", "transport", "untrusted-response", "hyper-v-snapshot-restore-outcome-indeterminate"],
        ["device_snapshot_create", "native", null, "hyper-v-snapshot-provider-failed"],
        ["device_snapshot_create", "unknown", null, "hyper-v-snapshot-provider-failed"],
        ["device_snapshot_restore", "native", null, "hyper-v-snapshot-provider-failed"],
        ["device_snapshot_restore", "unknown", null, "hyper-v-snapshot-provider-failed"],
    ] as const)("preserves %s failure classification for a %s response after reconciliation", async (tool, providerKind, errorKind, error) => {
        const f = fixture();
        const allowance = { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 };
        const failure = new Error(`primary-${providerKind}-failure`);
        const primaryExecution: SnapshotExecution<Receipt> = { ok: false,
            receipt: { nativeEvidence: `actual ${providerKind} mutation failure`, error: failure.message } };
        const cleanupExecution: SnapshotExecution<Receipt> = { ok: true,
            receipt: { nativeEvidence: "successful cleanup status", status: 0 } };
        let lastExecution = primaryExecution;
        let journal: SnapshotJournal | null = null;
        vi.mocked(f.ports.lastExecution).mockImplementation(() => lastExecution);
        f.ports.providerErrorKind = vi.fn<SnapshotPorts["providerErrorKind"]>(error => error === failure ? errorKind : null);
        if (tool === "device_snapshot_restore") {
            f.device.snapshots = [tracked];
            f.observation.snapshots = [{ snapshotId: checkpointId, snapshotName: providerName }];
        }
        vi.mocked(f.ports.create).mockImplementation(async (_connection, _target, options) => {
            options.onCreatedId(checkpointId);
            journal = f.state.journal;
            f.state.now = 1000;
            throw failure;
        });
        vi.mocked(f.ports.restore).mockImplementation(async () => {
            journal = f.state.journal;
            f.state.now = 1000;
            throw failure;
        });
        vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, target, deadlineAt) => {
            expect(deadlineAt).toBe(allowance.cleanupDeadlineAt);
            lastExecution = cleanupExecution;
            f.state.now = 2000;
            return { checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: tool === "device_snapshot_create" ? 0 : 1 };
        });
        const outcome = await f.invoke(tool, { snapshotName: "baseline", snapshotId: checkpointId }, allowance);
        expect(outcome).toMatchObject({ kind: "refused", reason: errorKind === "untrusted-response" ? "conflict" : "provider-failed",
            error, executionDiagnostic: failure.message, journalDisposition: "retain" });
        expect(outcome.execution).toBe(primaryExecution);
        expect(f.ports.providerErrorKind).toHaveBeenCalledWith(failure);
        expect(f.ports.repairPolicy).toHaveBeenCalledOnce();
        expect(lastExecution).toBe(cleanupExecution);
        expect(journal).toMatchObject({ operationId: "operation", tool, snapshotId: checkpointId });
        expect(f.state.journal).toBe(journal);
        expect(f.state.current).toBe(f.device);
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
        expect(renderHyperVSnapshot(outcome)).toMatchObject({ status: errorKind === "untrusted-response" ? 409 : 502,
            payload: { ok: false, error } });
    });

    it.each(["device_snapshot_create", "device_snapshot_restore"] as const)(
        "preserves the primary %s untrusted response when cleanup reaches its fixed deadline", async tool => {
            const f = fixture();
            const allowance = { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 };
            const failure = new Error("primary-untrusted-response");
            const primaryExecution: SnapshotExecution<Receipt> = { ok: false,
                receipt: { nativeEvidence: "actual untrusted mutation response", error: failure.message } };
            let lastExecution = primaryExecution;
            let journal: SnapshotJournal | null = null;
            vi.mocked(f.ports.lastExecution).mockImplementation(() => lastExecution);
            f.ports.providerErrorKind = error => error === failure ? "untrusted-response" : null;
            if (tool === "device_snapshot_restore") f.device.snapshots = [tracked];
            vi.mocked(f.ports.create).mockImplementation(async (_connection, _target, options) => {
                options.onCreatedId(checkpointId);
                journal = f.state.journal;
                f.state.now = 1000;
                throw failure;
            });
            vi.mocked(f.ports.restore).mockImplementation(async () => {
                journal = f.state.journal;
                f.state.now = 1000;
                throw failure;
            });
            vi.mocked(f.ports.repairPolicy).mockImplementation(async (_connection, _target, deadlineAt) => {
                expect(deadlineAt).toBe(allowance.cleanupDeadlineAt);
                lastExecution = { ok: false, receipt: { nativeEvidence: "expired cleanup", error: "cleanup-expired" } };
                f.state.now = allowance.cleanupDeadlineAt;
                throw new HyperVOperationDeadlineError();
            });
            const outcome = await f.invoke(tool, { snapshotName: "baseline", snapshotId: checkpointId }, allowance);
            expect(outcome).toMatchObject({ kind: "refused", reason: "provider-failed", error: "hyper-v-snapshot-provider-failed",
                executionDiagnostic: failure.message, journalDisposition: "retain" });
            expect(outcome.execution).toBe(primaryExecution);
            expect(f.ports.repairPolicy).toHaveBeenCalledOnce();
            expect(journal).toMatchObject({ operationId: "operation", tool, snapshotId: checkpointId });
            expect(f.state.journal).toBe(journal);
            expect(f.state.current).toBe(f.device);
            expect(f.ports.publish).not.toHaveBeenCalled();
            expect(f.ports.mergeRepair).not.toHaveBeenCalled();
            expect(f.ports.clearJournal).not.toHaveBeenCalled();
            expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
            expect(renderHyperVSnapshot(outcome).status).toBe(502);
        },
    );

    it("does not start cleanup commands after the fixed cleanup deadline expires", async () => {
        const f = fixture();
        f.device.snapshots = [tracked];
        const execution: SnapshotExecution<Receipt> = { ok: false, receipt: { nativeEvidence: "primary", error: "native-late-failure" } };
        vi.mocked(f.ports.lastExecution).mockReturnValue(execution);
        vi.mocked(f.ports.delete).mockImplementation(async () => {
            f.state.now = 8000;
            throw new Error("native-late-failure");
        });
        expect(await f.invoke("device_snapshot_delete", { snapshotId: checkpointId },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 })).toMatchObject({ kind: "refused", execution,
            executionDiagnostic: "native-late-failure", journalDisposition: "retain" });
        expect(f.ports.repairPolicy).not.toHaveBeenCalled();
        expect(f.ports.status).not.toHaveBeenCalled();
        expect(f.state.journal?.tool).toBe("device_snapshot_delete");
    });

    it("gives restored Linux readiness only the operation remainder and rejects a late ready response", async () => {
        const f = linuxRestoreFixture();
        vi.mocked(f.ports.restore).mockImplementation(async (_connection, target, options) => {
            expect(options.deadlineAt).toBe(5000);
            f.state.now = 4000;
            return { ok: true, snapshotId: checkpointId, snapshotName: target.providerName, state: "Off" };
        });
        vi.mocked(f.ports.sshReady).mockImplementation(async (connection, _target, deadlineAt) => {
            expect(connection).toBe(ssh);
            expect(deadlineAt).toBe(5000);
            expect(f.ports.remainingTimeout(deadlineAt, 30000)).toBe(1000);
            f.state.now = 5000;
            return { ready: true, execution: { ok: true } };
        });
        await expect(f.invoke("device_snapshot_restore", { snapshotId: checkpointId },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 })).rejects.toBeInstanceOf(HyperVOperationDeadlineError);
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
        expect(f.state.journal?.tool).toBe("device_snapshot_restore");
    });

    it("preserves a failed SSH execution returned after the restore operation deadline", async () => {
        const f = linuxRestoreFixture();
        const execution: SnapshotExecution<Receipt> = { ok: false,
            receipt: { nativeEvidence: "late SSH failure", error: "ssh-connection-lost", status: 255 } };
        let journal: SnapshotJournal | null = null;
        vi.mocked(f.ports.sshReady).mockImplementation(async (_connection, _target, deadlineAt) => {
            expect(deadlineAt).toBe(5000);
            journal = f.state.journal;
            f.state.now = deadlineAt + 1;
            return { ready: false, execution };
        });
        const outcome = await f.invoke("device_snapshot_restore", { snapshotId: checkpointId },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 });
        expect(outcome).toMatchObject({ kind: "refused", reason: "provider-failed",
            error: "hyper-v-linux-guest-provider-failed", journalDisposition: "retain" });
        expect(outcome.execution).toBe(execution);
        expect(journal).toMatchObject({ operationId: "operation", tool: "device_snapshot_restore", snapshotId: checkpointId });
        expect(f.state.journal).toBe(journal);
        expect(f.state.current).toBe(f.device);
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
    });

    it("preserves a genuine SSH rejection received after the restore operation deadline", async () => {
        const f = linuxRestoreFixture();
        const failure = new Error("late SSH transport rejection");
        let journal: SnapshotJournal | null = null;
        vi.mocked(f.ports.sshReady).mockImplementation(async (_connection, _target, deadlineAt) => {
            expect(deadlineAt).toBe(5000);
            journal = f.state.journal;
            f.state.now = deadlineAt + 1;
            throw failure;
        });
        await expect(f.invoke("device_snapshot_restore", { snapshotId: checkpointId },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 })).rejects.toBe(failure);
        expect(journal).toMatchObject({ operationId: "operation", tool: "device_snapshot_restore", snapshotId: checkpointId });
        expect(f.state.journal).toBe(journal);
        expect(f.state.current).toBe(f.device);
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.ports.clearJournal).not.toHaveBeenCalled();
        expect(f.ports.mergeRepair).not.toHaveBeenCalled();
        expect(f.ports.removeRepairJournal).not.toHaveBeenCalled();
    });

    it("bounds the final readiness sleep by the remaining operation allowance", async () => {
        const f = linuxRestoreFixture();
        vi.mocked(f.ports.restore).mockImplementation(async (_connection, target) => {
            f.state.now = 4500;
            return { ok: true, snapshotId: checkpointId, snapshotName: target.providerName, state: "Off" };
        });
        const sleeps: number[] = [];
        f.ports.sleep = async milliseconds => { sleeps.push(milliseconds); f.state.now += milliseconds; };
        await expect(f.invoke("device_snapshot_restore", { snapshotId: checkpointId },
            { operationDeadlineAt: 5000, cleanupDeadlineAt: 8000 })).rejects.toBeInstanceOf(HyperVOperationDeadlineError);
        expect(sleeps).toEqual([500]);
        expect(f.state.now).toBe(5000);
        expect(f.ports.sshReady).toHaveBeenCalledOnce();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.state.journal?.tool).toBe("device_snapshot_restore");
    });
});
