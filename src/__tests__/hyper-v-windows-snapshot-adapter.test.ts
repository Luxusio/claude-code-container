import { describe, expect, it, vi } from "vitest";

import {
    createDeviceLabHyperVSnapshot,
    deleteDeviceLabHyperVSnapshot,
    resolveOwnedHyperVSnapshot,
    restoreDeviceLabHyperVSnapshot,
} from "../device-lab/broker/hyper-v/snapshots.js";
import type {
    HyperVVirtualMachine,
    HyperVVirtualMachineSnapshot,
    HyperVWindowsClient,
} from "../hyper-v-windows/index.js";

const vmId = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
const snapshotId = "11111111-2222-3333-4444-555555555555";
const foreignSnapshotId = "99999999-8888-7777-6666-555555555555";
const providerName = "ccc-0123456789abcdef-nightly";

function snapshot(overrides: Partial<HyperVVirtualMachineSnapshot> = {}): HyperVVirtualMachineSnapshot {
    return {
        id: snapshotId,
        name: providerName,
        vmId,
        vmName: "ccc-0123456789abcdef-windows-ci-01",
        snapshotType: "Production",
        parentSnapshotId: null,
        parentSnapshotName: null,
        creationTimeMilliseconds: 1_700_000_000_000,
        ...overrides,
    };
}

function machine(state: string): HyperVVirtualMachine {
    return {
        id: vmId,
        name: "ccc-0123456789abcdef-windows-ci-01",
        state,
        status: "Operating normally",
        notes: "ccc-device-lab",
        uptimeMilliseconds: 0,
        generation: 2,
        checkpointType: "ProductionOnly",
    };
}

function client(overrides: Partial<HyperVWindowsClient> = {}): HyperVWindowsClient {
    return {
        getVM: vi.fn(async () => [machine("Off")]),
        getVMHardDiskDrives: vi.fn(async () => []),
        getVMDvdDrives: vi.fn(async () => []),
        startVM: vi.fn(async () => undefined),
        stopVM: vi.fn(async () => undefined),
        removeVM: vi.fn(async () => undefined),
        getVMSnapshots: vi.fn(async () => [snapshot()]),
        checkpointVM: vi.fn(async () => snapshot()),
        removeVMSnapshot: vi.fn(async () => undefined),
        restoreVMSnapshot: vi.fn(async () => undefined),
        ...overrides,
    } as HyperVWindowsClient;
}

describe("Device Lab Hyper-V snapshot adapter", () => {
    it("keeps owner-scoped naming and ownership fencing out of the library", async () => {
        const created = await createDeviceLabHyperVSnapshot(client(), { vmId, providerName });
        expect(created).toEqual({
            ok: true,
            snapshotId,
            snapshotName: providerName,
            snapshotType: "Production",
        });
    });

    it("refuses a checkpoint the host named differently", async () => {
        const renamed = client({ checkpointVM: vi.fn(async () => snapshot({ name: "someone-elses" })) });
        await expect(createDeviceLabHyperVSnapshot(renamed, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-ownership-mismatch");
    });

    it("resolves exactly one owned checkpoint by provider name", async () => {
        const resolved = await resolveOwnedHyperVSnapshot(client(), { vmId, providerName });
        expect(resolved.id).toBe(snapshotId);
    });

    it("refuses when no checkpoint carries the owner-scoped name", async () => {
        const foreign = client({ getVMSnapshots: vi.fn(async () => [snapshot({ name: "unrelated" })]) });
        await expect(resolveOwnedHyperVSnapshot(foreign, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-ownership-mismatch");
    });

    it("refuses when the tracked id does not match the named checkpoint", async () => {
        await expect(resolveOwnedHyperVSnapshot(client(), { vmId, providerName, snapshotId: foreignSnapshotId }))
            .rejects.toThrow("hyper-v-snapshot-ownership-mismatch");
    });

    it("refuses an ambiguous owner-scoped name", async () => {
        const ambiguous = client({
            getVMSnapshots: vi.fn(async () => [snapshot(), snapshot({ id: foreignSnapshotId })]),
        });
        await expect(resolveOwnedHyperVSnapshot(ambiguous, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-ownership-mismatch");
    });

    it("deletes the resolved checkpoint by id and reports it deleted", async () => {
        const removeVMSnapshot = vi.fn(async () => undefined);
        const deleted = await deleteDeviceLabHyperVSnapshot(client({ removeVMSnapshot }), { vmId, providerName });
        expect(removeVMSnapshot).toHaveBeenCalledWith(
            { selector: { kind: "id", id: vmId }, snapshot: { kind: "id", id: snapshotId } },
            undefined,
        );
        expect(deleted).toEqual({
            ok: true,
            snapshotId,
            snapshotName: providerName,
            snapshotType: "Production",
            deleted: true,
        });
    });

    it("refuses to restore a running VM unless forced", async () => {
        const running = client({ getVM: vi.fn(async () => [machine("Running")]) });
        await expect(restoreDeviceLabHyperVSnapshot(running, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-restore-requires-stopped-vm");
        expect(running.restoreVMSnapshot).not.toHaveBeenCalled();
    });

    it("turns off a running VM before a forced restore", async () => {
        const stopVM = vi.fn(async () => undefined);
        const running = client({ getVM: vi.fn(async () => [machine("Running")]), stopVM });
        await restoreDeviceLabHyperVSnapshot(running, { vmId, providerName }, { force: true });
        expect(stopVM).toHaveBeenCalledWith(
            { selector: { kind: "id", id: vmId }, mode: "turn-off", force: true },
            undefined,
        );
        expect(running.restoreVMSnapshot).toHaveBeenCalled();
    });

    it("starts the VM after restore only when asked, and reports the settled state", async () => {
        const states = ["Off", "Off", "Running"];
        const startVM = vi.fn(async () => undefined);
        const started = client({
            getVM: vi.fn(async () => [machine(states.shift() ?? "Running")]),
            startVM,
        });
        const restored = await restoreDeviceLabHyperVSnapshot(
            started,
            { vmId, providerName },
            { startAfterRestore: true },
        );
        expect(startVM).toHaveBeenCalledTimes(1);
        expect(restored.state).toBe("Running");
    });

    it("leaves the VM off when start-after-restore is not requested", async () => {
        const startVM = vi.fn(async () => undefined);
        const restored = await restoreDeviceLabHyperVSnapshot(client({ startVM }), { vmId, providerName });
        expect(startVM).not.toHaveBeenCalled();
        expect(restored.state).toBe("Off");
    });

    it("refuses when the VM selector does not resolve exactly one machine", async () => {
        const missing = client({ getVM: vi.fn(async () => []) });
        await expect(restoreDeviceLabHyperVSnapshot(missing, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-vm-ownership-mismatch");
    });
});
