import { describe, expect, it, vi } from "vitest";
import { createBrokerHyperVSnapshotApplication } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-snapshots.js";
import type { SnapshotJournal, SnapshotOwnerTarget, SnapshotTool, SnapshotTracked, SnapshotVmObservation } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-snapshots.js";
import type { BrokerHyperVSnapshotPorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-snapshots.js";

type Connection = { readonly provider: "powershell" | "ssh" };
type Receipt = { readonly nativeEvidence: string };
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
    const execution = { mode: "exec", provider: "hyper-v", status: 0, stdout: "status" };
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
        status: vi.fn(async () => execution), parseStatus: () => observation, observationMismatch: () => null,
        create: vi.fn<SnapshotPorts["create"]>(async (_connection, target, options) => {
            options.onCreatedId(checkpointId);
            return { ok: true, snapshotId: checkpointId, snapshotName: target.providerName, snapshotType: "Production" };
        }),
        restore: vi.fn<SnapshotPorts["restore"]>(async (_connection, target) => ({ ok: true,
            snapshotId: target.snapshotId || checkpointId, snapshotName: target.providerName, state: "Off" })),
        delete: vi.fn<SnapshotPorts["delete"]>(async (_connection, target) => ({ ok: true, deleted: true,
            snapshotId: target.snapshotId || checkpointId, snapshotName: target.providerName })),
        repairPolicy: async (_connection, target) => ({ checkpointPolicy: target.expectedCheckpointPolicy, candidateCount: 1 }),
        lastExecution: () => execution, isValidationError: () => false,
        errorCode: (error, fallback) => error instanceof Error ? error.message : fallback,
        providerErrorCode: () => undefined,
        diagnosticCode: (result, fallback) => result.error || fallback,
        publish: vi.fn<SnapshotPorts["publish"]>((_owner, _backend, _device, _expected, replacement) => {
            state.current = replacement; return { found: true, matched: true, device: replacement };
        }),
        mergeRepair: vi.fn<SnapshotPorts["mergeRepair"]>((_owner, _backend, _device, _original, patch) => {
            state.current = { ...state.current, ...patch }; return state.current;
        }),
        forgetConsole: () => undefined, sshReady: vi.fn(async () => ({ ...execution, status: 1, stdout: "not ready" })),
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
    return { device, state, observation, ports, invoke, journal, repair };
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

    it("settles a transient list mismatch without publishing tracked state", async () => {
        const f = fixture();
        f.device.snapshots = [tracked];
        vi.mocked(f.ports.status).mockImplementationOnce(async () => ({ mode: "exec", provider: "hyper-v", status: 0 }))
            .mockImplementationOnce(async () => {
                f.observation.snapshots = [{ snapshotId: checkpointId, snapshotName: providerName }];
                return { mode: "exec", provider: "hyper-v", status: 0 };
            });
        expect(await f.invoke("device_snapshot_list")).toMatchObject({ kind: "listed", journalDisposition: "clear" });
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.device.snapshots).toEqual([tracked]);
    });

    it("reports stable owner inventory conflict after bounded resampling", async () => {
        const f = fixture();
        f.device.snapshots = [tracked];
        f.observation.snapshots = [{ snapshotId: "foreign-checkpoint", snapshotName: `ccc-${owner}-untracked` }];
        expect(await f.invoke("device_snapshot_list")).toMatchObject({ kind: "refused", reason: "conflict",
            error: "hyper-v-snapshot-inventory-conflict", missing: [{ id: checkpointId, name: "baseline" }],
            untracked: [{ id: "foreign-checkpoint", providerName: `ccc-${owner}-untracked` }],
        });
        expect(vi.mocked(f.ports.status).mock.calls.length).toBeLessThanOrEqual(3);
        expect(f.ports.publish).not.toHaveBeenCalled();
    });

    it("refuses a conflict retry when the remaining list budget cannot cover its delay", async () => {
        const f = fixture();
        f.device.snapshots = [tracked];
        vi.mocked(f.ports.status).mockImplementation(async () => {
            f.state.now = 44900; return { mode: "exec", provider: "hyper-v", status: 0 };
        });
        expect(await f.invoke("device_snapshot_list")).toMatchObject({ kind: "refused", reason: "provider-failed", error: "hyper-v-snapshot-list-provider-failed" });
        expect(f.ports.status).toHaveBeenCalledTimes(1);
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
        expect(await f.invoke("device_snapshot_create", { snapshotName: "baseline" })).toMatchObject({ reason: "conflict", journalDisposition: "retain" });
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

    it("does not publish a restored Linux guest before SSH becomes ready", async () => {
        const f = fixture("linux-vm");
        Object.assign(f.device, { snapshots: [tracked], deviceRoot: "/owned/device", sshPrivateKeyPath: "/owned/key",
            sshKnownHostsPath: "/owned/known-hosts", guestUsername: "guest", networkAddress: "192.0.2.5" });
        expect(await f.invoke("device_snapshot_restore", { snapshotId: checkpointId })).toMatchObject({ kind: "refused", reason: "provider-failed", journalDisposition: "retain", error: "hyper-v-linux-guest-provider-failed" });
        expect(f.ports.restore).toHaveBeenCalledWith(powershell, expect.objectContaining({ snapshotId: checkpointId }),
            { force: false, startAfterRestore: true });
        expect(f.ports.sshReady).toHaveBeenCalled();
        expect(f.ports.publish).not.toHaveBeenCalled();
        expect(f.state.journal?.tool).toBe("device_snapshot_restore");
        expect(f.state.current).toBe(f.device);
    });
});
