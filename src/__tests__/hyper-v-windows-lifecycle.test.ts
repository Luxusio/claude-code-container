import { describe, expect, it, vi } from "vitest";

import {
    inspectHyperVVirtualMachine,
    reconcileHyperVVirtualMachine,
    retryHyperVLifecycle,
    type HyperVDvdDrive,
    type HyperVHardDiskDrive,
    type HyperVVirtualMachine,
    type HyperVVirtualMachineExpectation,
    type HyperVVirtualMachineInspection,
    type HyperVVirtualMachineReconciliationOutcome,
    type HyperVWindowsClient,
} from "@ccc/hyper-v/index.js";

const vmId = "12345678-1234-1234-1234-123456789abc";
const foreignVmId = "87654321-4321-4321-4321-cba987654321";

function virtualMachine(state = "Running", overrides: Partial<HyperVVirtualMachine> = {}): HyperVVirtualMachine {
    return {
        id: vmId,
        name: "lifecycle-test",
        state,
        status: "Operating normally",
        notes: "expected-notes",
        uptimeMilliseconds: 100,
        generation: 2,
        checkpointType: "Production",
        ...overrides,
    };
}

function hardDisk(path: string | null, overrides: Partial<HyperVHardDiskDrive> = {}): HyperVHardDiskDrive {
    return {
        vmId,
        vmName: "lifecycle-test",
        path,
        controllerType: "SCSI",
        controllerNumber: 0,
        controllerLocation: 0,
        diskNumber: null,
        ...overrides,
    };
}

function dvd(path: string | null, overrides: Partial<HyperVDvdDrive> = {}): HyperVDvdDrive {
    return {
        vmId,
        vmName: "lifecycle-test",
        path,
        controllerType: "SCSI",
        controllerNumber: 0,
        controllerLocation: 1,
        ...overrides,
    };
}

function inspection(
    state = "Running",
    hardDiskDrives: readonly HyperVHardDiskDrive[] = [],
    dvdDrives: readonly HyperVDvdDrive[] = [],
): HyperVVirtualMachineInspection {
    return { virtualMachines: [virtualMachine(state)], hardDiskDrives, dvdDrives };
}

const expectation: HyperVVirtualMachineExpectation = {
    id: vmId.toUpperCase(),
    name: "lifecycle-test",
    notes: "expected-notes",
    attachments: {
        allowedPaths: ["C:\\Managed\\root.vhdx"],
        allowedDvdRoots: ["C:\\Managed\\media"],
        expectedPaths: ["C:\\Managed\\root.vhdx", "C:\\Managed\\media\\setup.iso"],
    },
};

function fakeClient(values: {
    virtualMachines?: readonly HyperVVirtualMachine[];
    hardDiskDrives?: readonly HyperVHardDiskDrive[];
    dvdDrives?: readonly HyperVDvdDrive[];
} = {}): HyperVWindowsClient {
    return {
        getVM: vi.fn(async () => values.virtualMachines ?? []),
        getVMHardDiskDrives: vi.fn(async () => values.hardDiskDrives ?? []),
        getVMDvdDrives: vi.fn(async () => values.dvdDrives ?? []),
        startVM: vi.fn(async () => undefined),
        stopVM: vi.fn(async () => undefined),
        removeVM: vi.fn(async () => undefined),
    };
}

describe("Hyper-V Windows lifecycle inspection", () => {
    it("preserves exact attachment arrays and selects attachments by the unique VM id", async () => {
        const disks = [hardDisk("C:\\Managed\\root.vhdx"), hardDisk(null)];
        const dvds = [dvd("C:\\Managed\\media\\setup.iso"), dvd(null)];
        const client = fakeClient({ virtualMachines: [virtualMachine()], hardDiskDrives: disks, dvdDrives: dvds });

        await expect(inspectHyperVVirtualMachine(client, { kind: "name", name: "lifecycle-test" })).resolves.toEqual({
            virtualMachines: [virtualMachine()],
            hardDiskDrives: disks,
            dvdDrives: dvds,
        });
        expect(client.getVMHardDiskDrives).toHaveBeenCalledWith({ kind: "id", id: vmId }, undefined);
        expect(client.getVMDvdDrives).toHaveBeenCalledWith({ kind: "id", id: vmId }, undefined);
    });

    it.each([
        ["absent", []],
        ["ambiguous", [virtualMachine(), virtualMachine("Off", { id: foreignVmId })]],
    ] as const)("does not attribute attachments when the VM result is %s", async (_label, virtualMachines) => {
        const client = fakeClient({ virtualMachines });

        await expect(inspectHyperVVirtualMachine(client, { kind: "name", name: "lifecycle-test" })).resolves.toEqual({
            virtualMachines,
            hardDiskDrives: [],
            dvdDrives: [],
        });
        expect(client.getVMHardDiskDrives).not.toHaveBeenCalled();
        expect(client.getVMDvdDrives).not.toHaveBeenCalled();
    });
});

describe("Hyper-V Windows lifecycle reconciliation", () => {
    it.each([
        ["start", "Running"],
        ["restart", "Running"],
        ["stop", "Off"],
    ] as const)("settles %s in %s with zero attachments and reports expected-missing drift", (intent, state) => {
        const outcome = reconcileHyperVVirtualMachine(inspection(state), expectation, intent);

        expect(outcome).toMatchObject({
            kind: "settled",
            intent,
            drift: {
                missingExpectedPaths: ["C:\\Managed\\root.vhdx", "C:\\Managed\\media\\setup.iso"],
            },
        });
    });

    it("accepts exact and root-contained paths case-insensitively without requiring every expected path", () => {
        const outcome = reconcileHyperVVirtualMachine(inspection(
            "Running",
            [hardDisk("c:\\managed\\ROOT.VHDX")],
            [dvd("C:\\Managed\\media\\nested\\other.iso"), dvd(null)],
        ), expectation, "start");

        expect(outcome).toMatchObject({
            kind: "settled",
            drift: { missingExpectedPaths: ["C:\\Managed\\media\\setup.iso"] },
        });
    });

    it("rejects every foreign disk and mounted DVD without a path-prefix escape", () => {
        const outcome = reconcileHyperVVirtualMachine(inspection(
            "Off",
            [hardDisk("C:\\Foreign\\root.vhdx")],
            [dvd("C:\\Managed\\media-foreign\\setup.iso")],
        ), expectation, "remove");

        expect(outcome).toEqual(expect.objectContaining({
            kind: "attachment-conflict",
            unexpectedAttachments: [
                { kind: "hard-disk", path: "C:\\Foreign\\root.vhdx" },
                { kind: "dvd", path: "C:\\Managed\\media-foreign\\setup.iso" },
            ],
        }));
        expect(outcome.kind === "pending" ? outcome.action : null).toBeNull();
    });

    it("rejects a pathless pass-through hard disk while allowing an empty DVD drive", () => {
        const outcome = reconcileHyperVVirtualMachine(inspection(
            "Off",
            [hardDisk(null, { diskNumber: 7 })],
            [dvd(null)],
        ), expectation, "remove");

        expect(outcome).toMatchObject({
            kind: "attachment-conflict",
            unexpectedAttachments: [{ kind: "hard-disk", path: null, diskNumber: 7 }],
        });
        expect(outcome.kind === "pending" ? outcome.action : null).toBeNull();
    });

    it("does not apply hard-disk roots to DVD media", () => {
        const outcome = reconcileHyperVVirtualMachine(inspection(
            "Off",
            [hardDisk("C:\\Managed\\snapshots\\current.avhdx")],
            [dvd("C:\\Managed\\snapshots\\foreign.iso")],
        ), {
            ...expectation,
            attachments: {
                ...expectation.attachments,
                allowedHardDiskRoots: ["C:\\Managed\\snapshots"],
                allowedDvdRoots: [],
            },
        }, "remove");

        expect(outcome).toMatchObject({
            kind: "attachment-conflict",
            unexpectedAttachments: [{ kind: "dvd", path: "C:\\Managed\\snapshots\\foreign.iso" }],
        });
    });

    it.each([
        ["id mismatch", inspection("Running"), { ...expectation, id: foreignVmId }, "id-mismatch"],
        ["name mismatch", inspection("Running"), { ...expectation, name: "other" }, "name-mismatch"],
        ["notes mismatch", inspection("Running"), { ...expectation, notes: "other" }, "notes-mismatch"],
        ["attachment identity mismatch", inspection("Running", [hardDisk(null, { vmId: foreignVmId })]), expectation, "attachment-identity-mismatch"],
    ] as const)("returns identity conflict for %s", (_label, observed, expected, reason) => {
        expect(reconcileHyperVVirtualMachine(observed, expected, "remove")).toMatchObject({
            kind: "identity-conflict",
            reason,
        });
    });

    it("returns identity conflict for an ambiguous native result", () => {
        const observed: HyperVVirtualMachineInspection = {
            virtualMachines: [virtualMachine(), virtualMachine("Off", { id: foreignVmId })],
            hardDiskDrives: [],
            dvdDrives: [],
        };

        expect(reconcileHyperVVirtualMachine(observed, expectation, "start")).toMatchObject({
            kind: "identity-conflict",
            reason: "ambiguous",
        });
    });

    it("keeps unknown and transitional native state pending with the raw observation", () => {
        const observed = inspection("FutureTransitionState");
        const outcome = reconcileHyperVVirtualMachine(observed, expectation, "start");

        expect(outcome).toMatchObject({
            kind: "pending",
            reason: "transitioning-or-unknown",
            action: "wait",
            virtualMachine: { state: "FutureTransitionState" },
        });
    });

    it.each([
        ["start", "Off", "start"],
        ["restart", "Off", "start"],
        ["stop", "Running", "stop"],
    ] as const)("makes a stable mismatch explicit for %s", (intent, state, action) => {
        expect(reconcileHyperVVirtualMachine(inspection(state), expectation, intent)).toMatchObject({
            kind: "pending",
            reason: "terminal-state-mismatch",
            action,
        });
    });

    it.each(["Saved", "saved", "SAVED", "sAvEd"])("offers the existing ordinary start action for normalized %s", state => {
        const observed = inspection(state, [hardDisk("C:\\Managed\\root.vhdx")]);
        const outcome = reconcileHyperVVirtualMachine(observed, expectation, "start");
        expect(outcome).toMatchObject({ kind: "pending", intent: "start", reason: "terminal-state-mismatch", action: "start", virtualMachine: { state } });
        expect(outcome.inspection).toBe(observed);
        if (outcome.kind === "pending") {
            expect(outcome.virtualMachine).toBe(observed.virtualMachines[0]);
            expect(outcome.drift).toEqual({ missingExpectedPaths: ["C:\\Managed\\media\\setup.iso"] });
        }
    });

    it.each([
        ["ambiguous VM", { ...inspection("Saved"), virtualMachines: [virtualMachine("Saved"), virtualMachine("Saved", { id: foreignVmId })] }, expectation, "ambiguous"],
        ["VM id before name and Notes", inspection("Saved"), { ...expectation, id: foreignVmId, name: "foreign", notes: "foreign" }, "id-mismatch"],
        ["VM name before Notes", inspection("Saved"), { ...expectation, name: "foreign", notes: "foreign" }, "name-mismatch"],
        ["Notes before attachment identity", inspection("Saved", [hardDisk("C:\\Foreign\\root.vhdx", { vmId: foreignVmId })]), { ...expectation, notes: "foreign" }, "notes-mismatch"],
        ["disk identity before path allowance", inspection("Saved", [hardDisk("C:\\Foreign\\root.vhdx", { vmId: foreignVmId })]), expectation, "attachment-identity-mismatch"],
        ["disk VM name", inspection("Saved", [hardDisk("C:\\Managed\\root.vhdx", { vmName: "foreign" })]), expectation, "attachment-identity-mismatch"],
        ["DVD identity", inspection("Saved", [], [dvd("C:\\Managed\\media\\setup.iso", { vmId: foreignVmId })]), expectation, "attachment-identity-mismatch"],
    ] as const)("checks %s before offering Saved start recovery", (_label, observed, expected, reason) => {
        expect(reconcileHyperVVirtualMachine(observed, expected, "start")).toMatchObject({ kind: "identity-conflict", reason });
    });

    it.each([
        ["foreign disk", [hardDisk("C:\\Foreign\\root.vhdx")], []],
        ["foreign DVD", [], [dvd("C:\\Managed\\media-foreign\\setup.iso")]],
        ["pass-through disk", [hardDisk(null, { diskNumber: 7 })], []],
    ] as const)("checks %s attachment authority before offering Saved start recovery", (_label, disks, dvds) => {
        const outcome = reconcileHyperVVirtualMachine(inspection("Saved", disks, dvds), expectation, "start");
        expect(outcome.kind).toBe("attachment-conflict");
        expect(outcome).not.toHaveProperty("action");
    });

    it.each(["stop", "restart"] as const)("keeps Saved pending without a replay action for %s", intent => {
        expect(reconcileHyperVVirtualMachine(inspection("Saved"), expectation, intent)).toMatchObject({
            kind: "pending", intent, reason: "transitioning-or-unknown", action: "wait", virtualMachine: { state: "Saved" },
        });
    });

    it.each(["Starting", "Stopping", "Saving", "Restoring", "Paused", "SavedCritical", "FutureTransitionState", " Saved "])("does not widen %s into Saved start authority", state => {
        expect(reconcileHyperVVirtualMachine(inspection(state), expectation, "start")).toMatchObject({
            kind: "pending", reason: "transitioning-or-unknown", action: "wait", virtualMachine: { state },
        });
    });

    it.each(["Saved", "Saving", "FutureTransitionState"])("preserves existing removal classification for %s", state => {
        expect(reconcileHyperVVirtualMachine(inspection(state), expectation, "remove")).toMatchObject({
            kind: "pending", intent: "remove", reason: "removal-required", action: "remove",
        });
    });

    it("requires removal only after identity and attachment checks pass", () => {
        expect(reconcileHyperVVirtualMachine(
            inspection("Off", [hardDisk("C:\\Managed\\root.vhdx")]),
            expectation,
            "remove",
        )).toMatchObject({ kind: "pending", reason: "removal-required", action: "remove" });
    });

    it.each([
        ["remove", true],
        ["start", false],
        ["stop", false],
        ["restart", false],
    ] as const)("represents absent %s explicitly", (intent, satisfiesIntent) => {
        const observed: HyperVVirtualMachineInspection = {
            virtualMachines: [], hardDiskDrives: [], dvdDrives: [],
        };
        expect(reconcileHyperVVirtualMachine(observed, expectation, intent)).toEqual({
            kind: "absent",
            intent,
            inspection: observed,
            satisfiesIntent,
        });
    });
});

describe("Hyper-V Windows lifecycle bounded retry", () => {
    const pendingOutcome = reconcileHyperVVirtualMachine(inspection("Starting"), expectation, "start");
    const settledOutcome = reconcileHyperVVirtualMachine(inspection("Running"), expectation, "start");
    const conflictOutcome = reconcileHyperVVirtualMachine(
        inspection("Running", [hardDisk("C:\\Foreign\\root.vhdx")]),
        expectation,
        "start",
    );

    it("retries pending outcomes with the injected sleeper and stops on settlement", async () => {
        const operation = vi.fn(async ({ attempt }: { attempt: number }) => attempt < 3 ? pendingOutcome : settledOutcome);
        const sleeper = vi.fn(async () => undefined);

        await expect(retryHyperVLifecycle(operation, {
            maxAttempts: 4,
            delayMilliseconds: (completedAttempts) => completedAttempts * 10,
            sleeper,
        })).resolves.toBe(settledOutcome);
        expect(operation).toHaveBeenCalledTimes(3);
        expect(sleeper.mock.calls).toEqual([[10, undefined], [20, undefined]]);
    });

    it("returns the last pending outcome at the explicit attempt limit", async () => {
        const operation = vi.fn(async () => pendingOutcome);

        await expect(retryHyperVLifecycle(operation, { maxAttempts: 2 })).resolves.toBe(pendingOutcome);
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it("stops immediately on terminal conflicts", async () => {
        const operation = vi.fn(async () => conflictOutcome);

        await expect(retryHyperVLifecycle(operation, { maxAttempts: 5 })).resolves.toBe(conflictOutcome);
        expect(operation).toHaveBeenCalledOnce();
    });

    it("retries thrown failures only under the explicit predicate", async () => {
        const failure = new Error("transient");
        const operation = vi.fn<() => Promise<HyperVVirtualMachineReconciliationOutcome>>()
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce(settledOutcome);

        await expect(retryHyperVLifecycle(operation, {
            maxAttempts: 2,
            shouldRetryError: (error) => error === failure,
        })).resolves.toBe(settledOutcome);
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it("honors cancellation before an attempt and after an injected sleep", async () => {
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        const never = vi.fn(async () => settledOutcome);
        await expect(retryHyperVLifecycle(never, {
            maxAttempts: 2,
            signal: alreadyAborted.signal,
        })).rejects.toMatchObject({ name: "AbortError" });
        expect(never).not.toHaveBeenCalled();

        const duringSleep = new AbortController();
        const operation = vi.fn(async () => pendingOutcome);
        await expect(retryHyperVLifecycle(operation, {
            maxAttempts: 2,
            signal: duringSleep.signal,
            sleeper: () => duringSleep.abort(),
        })).rejects.toMatchObject({ name: "AbortError" });
        expect(operation).toHaveBeenCalledOnce();
    });
});
