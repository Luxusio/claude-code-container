import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createDeviceLabHyperVSnapshot,
    deleteDeviceLabHyperVSnapshot,
    hyperVSnapshotInventoryConflict,
    settleHyperVSnapshotInventory,
    repairDeviceLabHyperVSnapshotState,
    resolveOwnedHyperVSnapshot,
    restoreDeviceLabHyperVSnapshot,
} from "@ccc/device-lab/device-lab/broker/hyper-v/snapshots.js";
import type {
    HyperVVirtualMachine,
    HyperVVirtualMachineSnapshot,
    HyperVWindowsClient,
} from "@ccc/hyper-v/index.js";
import { HyperVWindowsError } from "@ccc/hyper-v/index.js";

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
        repairVMSnapshotState: vi.fn(async () => ({ checkpointPolicy: "ProductionOnly" as const, candidateCount: 1 as const })),
        ...overrides,
    } as HyperVWindowsClient;
}

describe("Device Lab Hyper-V snapshot adapter", () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it("classifies exact owner inventory drift without accepting a changed checkpoint ID", () => {
        const tracked = [{ id: snapshotId, name: "nightly", providerName }];
        expect(hyperVSnapshotInventoryConflict("0123456789abcdef", tracked, [
            { snapshotId: snapshotId.toUpperCase(), snapshotName: providerName },
        ])).toEqual({ untracked: [], missing: [] });
        expect(hyperVSnapshotInventoryConflict("0123456789abcdef", tracked, [
            { snapshotId: foreignSnapshotId, snapshotName: providerName },
        ])).toEqual({
            untracked: [{ id: foreignSnapshotId, providerName }],
            missing: [{ id: snapshotId, name: "nightly" }],
        });
        expect(hyperVSnapshotInventoryConflict("0123456789abcdef", [], [
            { snapshotId: foreignSnapshotId, snapshotName: providerName.toUpperCase() },
        ]).untracked).toHaveLength(1);
    });

    it("re-observes a transient mismatch but keeps a stable conflict and read failures", async () => {
        const tracked = [{ id: snapshotId, name: "nightly", providerName }];
        const wrong = [{ snapshotId: foreignSnapshotId, snapshotName: providerName }];
        const exact = [{ snapshotId, snapshotName: providerName }];
        const readSettled = vi.fn(async () => ({ ok: true as const, snapshots: exact }));
        const limits = { deadlineAt: Number.POSITIVE_INFINITY, timeoutError: "timeout", delayMilliseconds: 0 };
        expect(await settleHyperVSnapshotInventory("0123456789abcdef", tracked, wrong, readSettled, limits))
            .toEqual({ ok: true, conflict: { untracked: [], missing: [] } });
        expect(readSettled).toHaveBeenCalledTimes(1);

        const readStable = vi.fn(async () => ({ ok: true as const, snapshots: wrong }));
        const stable = await settleHyperVSnapshotInventory("0123456789abcdef", tracked, wrong, readStable, limits);
        expect(stable.ok && stable.conflict.untracked).toHaveLength(1);
        expect(stable.ok && stable.conflict.missing).toHaveLength(1);
        expect(readStable).toHaveBeenCalledTimes(2);

        const readFailed = vi.fn(async () => ({ ok: false as const, error: "provider-read-failed" }));
        expect(await settleHyperVSnapshotInventory("0123456789abcdef", tracked, wrong, readFailed, limits))
            .toEqual({ ok: false, error: "provider-read-failed" });
        expect(await settleHyperVSnapshotInventory("0123456789abcdef", tracked, wrong, readSettled,
            { deadlineAt: Date.now() - 1, timeoutError: "timeout", delayMilliseconds: 0 }))
            .toEqual({ ok: false, error: "timeout" });
        expect(readSettled).toHaveBeenCalledTimes(1);
    });

    it("passes owner identity and journal policy to one typed repair transaction", async () => {
        const repairVMSnapshotState = vi.fn(async () => ({ checkpointPolicy: "ProductionOnly" as const, candidateCount: 1 as const }));
        const repaired = await repairDeviceLabHyperVSnapshotState(client({ repairVMSnapshotState }), {
            vmId,
            vmName: "ccc-0123456789abcdef-windows-ci-01",
            expectedNotes: "ccc-device-lab:0123456789abcdef:windows-ci-01:11111111111111111111111111111111",
            providerName,
            expectedCheckpointPolicy: "ProductionOnly",
        });
        expect(repairVMSnapshotState).toHaveBeenCalledTimes(1);
        expect(repairVMSnapshotState).toHaveBeenCalledWith({
            selector: { kind: "id", id: vmId },
            expectedName: "ccc-0123456789abcdef-windows-ci-01",
            expectedNotes: "ccc-device-lab:0123456789abcdef:windows-ci-01:11111111111111111111111111111111",
            snapshotName: providerName,
            expectedCheckpointPolicy: "ProductionOnly",
        });
        expect(repaired).toEqual({ checkpointPolicy: "ProductionOnly", candidateCount: 1 });
    });

    it("keeps owner-scoped naming and ownership fencing out of the library", async () => {
        const created = await createDeviceLabHyperVSnapshot(client(), { vmId, providerName });
        expect(created).toEqual({
            ok: true,
            snapshotId,
            snapshotName: providerName,
            snapshotType: "Production",
        });
    });

    it("waits for the exact created checkpoint before publishing its id", async () => {
        const stages: string[] = [];
        const getVMSnapshots = vi.fn()
            .mockImplementationOnce(async () => { stages.push("read"); return []; })
            .mockImplementationOnce(async () => [snapshot()]);
        const created = await createDeviceLabHyperVSnapshot(client({ getVMSnapshots }),
            { vmId, providerName }, { confirmationTimeoutMilliseconds: 1000, confirmationDelayMilliseconds: 0,
                onCreatedId: (id) => { expect(id).toBe(snapshotId); stages.push("journal"); } });
        expect(created.snapshotId).toBe(snapshotId);
        expect(getVMSnapshots).toHaveBeenCalledTimes(2);
        expect(stages).toEqual(["journal", "read"]);
    });

    it("does not publish a checkpoint that remains absent or reappears with another id", async () => {
        await expect(createDeviceLabHyperVSnapshot(client({ getVMSnapshots: vi.fn(async () => []) }),
            { vmId, providerName }, { confirmationTimeoutMilliseconds: 1, confirmationDelayMilliseconds: 1 }))
            .rejects.toThrow("hyper-v-snapshot-create-unconfirmed");
        await expect(createDeviceLabHyperVSnapshot(client({
            getVMSnapshots: vi.fn(async () => [snapshot({ id: foreignSnapshotId })]),
        }), { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-create-identity-conflict");
        await expect(createDeviceLabHyperVSnapshot(client({
            getVMSnapshots: vi.fn(async () => [snapshot(), snapshot({ id: foreignSnapshotId })]),
        }), { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-create-identity-conflict");
    });

    it.each([
        { clock: "injected", wallDelta: -9_000_000 },
        { clock: "injected", wallDelta: 9_000_000 },
        { clock: "default", wallDelta: -9_000_000 },
        { clock: "default", wallDelta: 9_000_000 },
    ])("uses the $clock local countdown across a $wallDelta ms wall jump and reports a Unix confirmation deadline", async ({ clock, wallDelta }) => {
        let monotonic = 100.25;
        let wall = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => wall);
        if (clock === "default") vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const onConfirmationDeadline = vi.fn();
        const getVMSnapshots = vi.fn(async () => { monotonic += 10; return [snapshot()]; });
        const created = await createDeviceLabHyperVSnapshot(client({
            checkpointVM: vi.fn(async () => { monotonic += 20; wall += wallDelta; return snapshot(); }),
            getVMSnapshots,
        }), { vmId, providerName }, {
            operationDeadlineAt: wall + 75,
            confirmationTimeoutMilliseconds: 80,
            onConfirmationDeadline,
            ...(clock === "injected" ? { monotonicNow: () => monotonic } : {}),
        });
        expect(created.snapshotId).toBe(snapshotId);
        expect(getVMSnapshots).toHaveBeenCalledTimes(1);
        expect(onConfirmationDeadline).toHaveBeenCalledTimes(1);
        // The original 75ms allowance lost 20ms in checkpointVM. Its remaining
        // 55ms is reported in Unix coordinates after either wall-clock jump.
        expect(onConfirmationDeadline).toHaveBeenCalledExactlyOnceWith(wall + 55);
    });

    it("captures the legacy Unix allowance before checkpoint creation and keeps a late exact created ID", async () => {
        let monotonic = 100.25;
        let wall = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => wall);
        vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const onCreatedId = vi.fn();
        const getVMSnapshots = vi.fn(async () => [snapshot()]);
        await expect(createDeviceLabHyperVSnapshot(client({
            checkpointVM: vi.fn(async () => { monotonic += 100; wall -= 9_000_000; return snapshot(); }),
            getVMSnapshots,
        }), { vmId, providerName }, { operationDeadlineAt: wall + 100, onCreatedId }))
            .rejects.toThrow("hyper-v-snapshot-create-unconfirmed");
        expect(onCreatedId).toHaveBeenCalledExactlyOnceWith(snapshotId);
        expect(getVMSnapshots).not.toHaveBeenCalled();
    });

    it.each(["legacy Unix", "internal remaining"])("refuses an expired %s allowance before creating a checkpoint", async (clock) => {
        const wall = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockReturnValue(wall);
        vi.spyOn(performance, "now").mockReturnValue(100);
        const checkpointVM = vi.fn(async () => snapshot());
        const getVMSnapshots = vi.fn(async () => [snapshot()]);
        const onCreatedId = vi.fn();
        await expect(createDeviceLabHyperVSnapshot(client({ checkpointVM, getVMSnapshots }), { vmId, providerName }, {
            ...(clock === "legacy Unix" ? { operationDeadlineAt: wall }
                : { remainingMilliseconds: () => 0, monotonicNow: () => 100 }),
            onCreatedId,
        })).rejects.toThrow("hyper-v-snapshot-create-unconfirmed");
        expect(checkpointVM).not.toHaveBeenCalled();
        expect(onCreatedId).not.toHaveBeenCalled();
        expect(getVMSnapshots).not.toHaveBeenCalled();
    });

    it.each([
        { initialRemaining: 100, refreshedRemaining: 1_000, completedAt: 111 },
        { initialRemaining: 1_000, refreshedRemaining: 5, completedAt: 55 },
    ])("caps refreshed remaining $refreshedRemaining ms by the captured local countdown", async ({ initialRemaining, refreshedRemaining, completedAt }) => {
        let monotonic = 10;
        let remaining = initialRemaining;
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
        const onCreatedId = vi.fn();
        const getVMSnapshots = vi.fn(async () => { monotonic = completedAt; return [snapshot()]; });
        await expect(createDeviceLabHyperVSnapshot(client({
            checkpointVM: vi.fn(async () => { monotonic = 50; remaining = refreshedRemaining; return snapshot(); }),
            getVMSnapshots,
        }), { vmId, providerName }, {
            confirmationTimeoutMilliseconds: 1_000,
            remainingMilliseconds: () => remaining,
            monotonicNow: () => monotonic,
            onCreatedId,
        })).rejects.toThrow("hyper-v-snapshot-create-unconfirmed");
        expect(onCreatedId).toHaveBeenCalledExactlyOnceWith(snapshotId);
        expect(getVMSnapshots).toHaveBeenCalledTimes(1);
    });

    it.each([-9_000_000, 9_000_000])("gives the internal allowance priority over expired Unix time and reports a Unix callback after a %s ms wall jump", async (wallDelta) => {
        let monotonic = 100;
        let wall = 1_700_000_000_000;
        const deadlineAt = 200;
        vi.spyOn(Date, "now").mockImplementation(() => wall);
        const onConfirmationDeadline = vi.fn();
        const getVMSnapshots = vi.fn(async () => [snapshot()]);
        await expect(createDeviceLabHyperVSnapshot(client({
            checkpointVM: vi.fn(async () => { monotonic += 25; wall += wallDelta; return snapshot(); }),
            getVMSnapshots,
        }), { vmId, providerName }, {
            operationDeadlineAt: 1,
            remainingMilliseconds: () => deadlineAt - monotonic,
            monotonicNow: () => monotonic,
            onConfirmationDeadline,
        })).resolves.toMatchObject({ snapshotId });
        expect(getVMSnapshots).toHaveBeenCalledTimes(1);
        expect(onConfirmationDeadline).toHaveBeenCalledExactlyOnceWith(wall + 75);
    });

    it("retains a created ID but refuses inventory after the internal allowance expires during creation", async () => {
        let monotonic = 10;
        const onCreatedId = vi.fn();
        const getVMSnapshots = vi.fn(async () => [snapshot()]);
        await expect(createDeviceLabHyperVSnapshot(client({
            checkpointVM: vi.fn(async () => { monotonic = 110; return snapshot(); }),
            getVMSnapshots,
        }), { vmId, providerName }, {
            remainingMilliseconds: () => 110 - monotonic,
            monotonicNow: () => monotonic,
            onCreatedId,
        })).rejects.toThrow("hyper-v-snapshot-create-unconfirmed");
        expect(onCreatedId).toHaveBeenCalledExactlyOnceWith(snapshotId);
        expect(getVMSnapshots).not.toHaveBeenCalled();
    });

    it("does not confirm exact inventory returned after the local confirmation cap", async () => {
        let monotonic = 10;
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
        const onCreatedId = vi.fn();
        const getVMSnapshots = vi.fn(async () => { monotonic = 111; return [snapshot()]; });
        await expect(createDeviceLabHyperVSnapshot(client({ getVMSnapshots }), { vmId, providerName }, {
            confirmationTimeoutMilliseconds: 100,
            remainingMilliseconds: () => 1_000 - monotonic,
            monotonicNow: () => monotonic,
            onCreatedId,
        })).rejects.toThrow("hyper-v-snapshot-create-unconfirmed");
        expect(onCreatedId).toHaveBeenCalledExactlyOnceWith(snapshotId);
        expect(getVMSnapshots).toHaveBeenCalledTimes(1);
    });

    it("retains the exact created ID without confirming a successful read after its deadline abort", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let monotonic = 0;
        let resolveRead!: (snapshots: HyperVVirtualMachineSnapshot[]) => void;
        let readSignal: AbortSignal | undefined;
        const onCreatedId = vi.fn();
        const getVMSnapshots = vi.fn<HyperVWindowsClient["getVMSnapshots"]>((_selector, options) => {
            readSignal = options?.signal;
            return new Promise<HyperVVirtualMachineSnapshot[]>((resolve) => { resolveRead = resolve; });
        });
        const pending = createDeviceLabHyperVSnapshot(client({ getVMSnapshots }), { vmId, providerName }, {
            confirmationTimeoutMilliseconds: 100,
            remainingMilliseconds: () => 100 - monotonic,
            monotonicNow: () => monotonic,
            onCreatedId,
        });
        const observed = expect(pending).rejects.toThrow("hyper-v-snapshot-create-unconfirmed");
        await vi.advanceTimersByTimeAsync(0);
        expect(onCreatedId).toHaveBeenCalledExactlyOnceWith(snapshotId);
        expect(readSignal?.aborted).toBe(false);
        monotonic = 100;
        await vi.advanceTimersByTimeAsync(100);
        expect(readSignal?.aborted).toBe(true);
        resolveRead([snapshot()]);
        await observed;
        expect(getVMSnapshots).toHaveBeenCalledTimes(1);
        expect(onCreatedId).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["abort-error", "typed-cancelled"])("reports its own deadline cancellation as unconfirmed (%s)", async (kind) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let monotonic = 0;
        let wall = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => wall);
        const cancelled = kind === "abort-error" ? new DOMException("read aborted", "AbortError")
            : new HyperVWindowsError({ category: "transport", operation: "Get-VMSnapshot", code: "cancelled" });
        const getVMSnapshots = vi.fn<HyperVWindowsClient["getVMSnapshots"]>((_selector, options) => new Promise<HyperVVirtualMachineSnapshot[]>((_resolve, reject) => {
            options!.signal!.addEventListener("abort", () => reject(cancelled), { once: true });
        }));
        const pending = createDeviceLabHyperVSnapshot(client({ getVMSnapshots }), { vmId, providerName }, {
            confirmationTimeoutMilliseconds: 100,
            remainingMilliseconds: () => 100 - monotonic,
            monotonicNow: () => monotonic,
        });
        const observed = expect(pending).rejects.toThrow("hyper-v-snapshot-create-unconfirmed");
        await vi.advanceTimersByTimeAsync(0);
        expect(getVMSnapshots).toHaveBeenCalledTimes(1);
        monotonic = 100; wall += 100;
        await vi.advanceTimersByTimeAsync(100);
        await observed;
        expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves a genuine native rejection even when its own read deadline has fired", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let monotonic = 0;
        let wall = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => wall);
        const failure = new HyperVWindowsError({ category: "native", operation: "Get-VMSnapshot", code: "access-denied" });
        const getVMSnapshots = vi.fn<HyperVWindowsClient["getVMSnapshots"]>((_selector, options) => new Promise<HyperVVirtualMachineSnapshot[]>((_resolve, reject) => {
            options!.signal!.addEventListener("abort", () => reject(failure), { once: true });
        }));
        const pending = createDeviceLabHyperVSnapshot(client({ getVMSnapshots }), { vmId, providerName }, {
            confirmationTimeoutMilliseconds: 100,
            remainingMilliseconds: () => 100 - monotonic,
            monotonicNow: () => monotonic,
        });
        const observed = expect(pending).rejects.toBe(failure);
        await vi.advanceTimersByTimeAsync(0);
        expect(getVMSnapshots).toHaveBeenCalledTimes(1);
        monotonic = 100; wall += 100;
        await vi.advanceTimersByTimeAsync(100);
        await observed;
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["plain", "transport"])("preserves a late genuine %s rejection when the read ignores deadline cancellation", async (kind) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let monotonic = 0;
        const failure = kind === "plain" ? new Error("inventory provider failed independently")
            : new HyperVWindowsError({ category: "transport", operation: "Get-VMSnapshot", code: "executor-failed" });
        let rejectRead!: (error: unknown) => void;
        let readSignal: AbortSignal | undefined;
        const getVMSnapshots = vi.fn<HyperVWindowsClient["getVMSnapshots"]>((_selector, options) => {
            readSignal = options?.signal;
            // No abort listener: this outcome comes from the provider, not the helper's controller.
            return new Promise<HyperVVirtualMachineSnapshot[]>((_resolve, reject) => { rejectRead = reject; });
        });
        const pending = createDeviceLabHyperVSnapshot(client({ getVMSnapshots }), { vmId, providerName }, {
            confirmationTimeoutMilliseconds: 100,
            remainingMilliseconds: () => 100 - monotonic,
            monotonicNow: () => monotonic,
        });
        const observed = expect(pending).rejects.toBe(failure);
        await vi.advanceTimersByTimeAsync(0);
        expect(getVMSnapshots).toHaveBeenCalledTimes(1);
        expect(readSignal?.aborted).toBe(false);
        monotonic = 100;
        await vi.advanceTimersByTimeAsync(100);
        expect(readSignal?.aborted).toBe(true);
        rejectRead(failure);
        await observed;
        expect(getVMSnapshots).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves caller cancellation independently of its confirmation deadline", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const controller = new AbortController();
        const failure = new DOMException("caller cancelled", "AbortError");
        const getVMSnapshots = vi.fn<HyperVWindowsClient["getVMSnapshots"]>((_selector, options) => new Promise<HyperVVirtualMachineSnapshot[]>((_resolve, reject) => {
            options!.signal!.addEventListener("abort", () => reject(failure), { once: true });
        }));
        const pending = createDeviceLabHyperVSnapshot(client({ getVMSnapshots }), { vmId, providerName }, {
            signal: controller.signal, remainingMilliseconds: () => 100, monotonicNow: () => 0,
        });
        const observed = expect(pending).rejects.toBe(failure);
        await vi.advanceTimersByTimeAsync(0);
        expect(getVMSnapshots).toHaveBeenCalledTimes(1);
        controller.abort();
        await observed;
        expect(vi.getTimerCount()).toBe(0);
    });

    it("settles inventory across a forward wall jump without renewing the captured Unix allowance", async () => {
        let monotonic = 100;
        let wall = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => wall);
        vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const tracked = [{ id: snapshotId, name: "nightly", providerName }];
        const wrong = [{ snapshotId: foreignSnapshotId, snapshotName: providerName }];
        let reads = 0;
        const readAgain = vi.fn(async () => {
            monotonic += 10; wall += 9_000_000;
            reads += 1;
            return { ok: true as const, snapshots: reads === 1 ? wrong : [{ snapshotId, snapshotName: providerName }] };
        });
        await expect(settleHyperVSnapshotInventory("0123456789abcdef", tracked, wrong, readAgain,
            { deadlineAt: wall + 100, timeoutError: "timeout", delayMilliseconds: 0 }))
            .resolves.toEqual({ ok: true, conflict: { untracked: [], missing: [] } });
        expect(readAgain).toHaveBeenCalledTimes(2);
    });

    it("rejects exact inventory returned after settlement expires despite a backward wall jump", async () => {
        let monotonic = 100;
        let wall = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => wall);
        vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const readAgain = vi.fn(async () => {
            monotonic += 100; wall -= 9_000_000;
            return { ok: true as const, snapshots: [{ snapshotId, snapshotName: providerName }] };
        });
        await expect(settleHyperVSnapshotInventory("0123456789abcdef", [{ id: snapshotId, name: "nightly", providerName }], [], readAgain,
            { deadlineAt: wall + 100, timeoutError: "timeout", delayMilliseconds: 0 }))
            .resolves.toEqual({ ok: false, error: "timeout" });
        expect(readAgain).toHaveBeenCalledTimes(1);
    });

    it("keeps a settlement read failure primary after the captured allowance expires", async () => {
        let monotonic = 100;
        const wall = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockReturnValue(wall);
        vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const failure = { code: "provider-inventory-failed" };
        const readAgain = vi.fn(async () => {
            monotonic = 200;
            return { ok: false as const, error: failure };
        });
        const result = await settleHyperVSnapshotInventory("0123456789abcdef",
            [{ id: snapshotId, name: "nightly", providerName }], [], readAgain,
            { deadlineAt: wall + 100, timeoutError: { code: "timeout" }, delayMilliseconds: 0 });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBe(failure);
        expect(readAgain).toHaveBeenCalledTimes(1);
    });

    it.each([
        { name: "renamed exact ID", live: [snapshot({ name: "someone-elses" })] },
        { name: "other VM with exact ID", live: [snapshot({ vmId: foreignSnapshotId })] },
        { name: "duplicate exact ID", live: [snapshot(), snapshot()] },
    ])("refuses confirmation for $name", async ({ live }) => {
        const getVMSnapshots = vi.fn(async () => live);
        const onCreatedId = vi.fn();
        await expect(createDeviceLabHyperVSnapshot(client({ getVMSnapshots }), { vmId, providerName }, { onCreatedId }))
            .rejects.toThrow("hyper-v-snapshot-create-identity-conflict");
        expect(onCreatedId).toHaveBeenCalledExactlyOnceWith(snapshotId);
        expect(getVMSnapshots).toHaveBeenCalledTimes(1);
    });

    it("accepts case-insensitive VM and checkpoint IDs without changing the exact created-ID evidence", async () => {
        const onCreatedId = vi.fn();
        const created = await createDeviceLabHyperVSnapshot(client({
            checkpointVM: vi.fn(async () => snapshot({ id: snapshotId.toUpperCase(), vmId: vmId.toUpperCase() })),
            getVMSnapshots: vi.fn(async () => [snapshot()]),
        }), { vmId, providerName }, { onCreatedId });
        expect(onCreatedId).toHaveBeenCalledExactlyOnceWith(snapshotId.toUpperCase());
        expect(created.snapshotId).toBe(snapshotId);
    });

    // Distinct from the ownership fence: the checkpoint was already created, so this is an
    // untrustworthy result rather than drift, and the broker answers it without reconciliation.
    it("refuses a checkpoint the host named differently", async () => {
        const renamed = client({ checkpointVM: vi.fn(async () => snapshot({ name: "someone-elses" })) });
        await expect(createDeviceLabHyperVSnapshot(renamed, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-result-mismatch");
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

    it("refuses to report a delete the host did not actually perform", async () => {
        // Remove-VMSnapshot reports success but the checkpoint is still there on the follow-up read.
        const stubborn = client({ getVMSnapshots: vi.fn(async () => [snapshot()]) });
        await expect(deleteDeviceLabHyperVSnapshot(stubborn, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-delete-unconfirmed");
    });

    it("deletes the resolved checkpoint by id and reports it deleted", async () => {
        const removeVMSnapshot = vi.fn(async () => undefined);
        const reads = [[snapshot()], []];
        const deleted = await deleteDeviceLabHyperVSnapshot(
            client({ removeVMSnapshot, getVMSnapshots: vi.fn(async () => reads.shift() ?? []) }),
            { vmId, providerName },
        );
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
