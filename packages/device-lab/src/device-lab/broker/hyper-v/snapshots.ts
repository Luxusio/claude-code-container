import { snapshotInventoryConflict } from "../../domain/lifecycle/hyper-v-snapshots.js";
import { settleSnapshotInventory } from "../../application/lifecycle/hyper-v-snapshots.js";
import { posix, win32 } from "path";
import type { HyperVVmObservation } from "../../../host-control/hyper-v/index.js";
import {
    HyperVWindowsError,
    type HyperVVirtualMachineSnapshot,
    type HyperVWindowsClient,
} from "@ccc/hyper-v/index.js";

// Windows provider paths are case-insensitive; POSIX fixture paths retain their semantics.
// Never equate a relative path or an active checkpoint with the owned terminal disk.
export function hyperVSnapshotObservationMismatch(
    observation: Pick<HyperVVmObservation, "vmId" | "vmName" | "diskPath"> | null,
    expected: { vmId: string; vmName: string; diskPath: string },
): string | null {
    if (!observation) return "hyper-v-snapshot-observation-invalid";
    if (observation.vmId.toLowerCase() !== expected.vmId.toLowerCase() || observation.vmName !== expected.vmName) {
        return "hyper-v-snapshot-vm-identity-mismatch";
    }
    const actual = observation.diskPath || "";
    const windowsAbsolute = (path: string) => win32.isAbsolute(path) && (/^[A-Za-z]:/.test(path) || path.startsWith("\\\\"));
    const sameDisk = windowsAbsolute(actual) && windowsAbsolute(expected.diskPath)
        ? win32.normalize(actual).toLowerCase() === win32.normalize(expected.diskPath).toLowerCase()
        : !windowsAbsolute(actual) && !windowsAbsolute(expected.diskPath)
            && posix.isAbsolute(actual) && posix.isAbsolute(expected.diskPath)
            && posix.normalize(actual) === posix.normalize(expected.diskPath);
    return sameDisk ? null : "hyper-v-snapshot-disk-identity-mismatch";
}

// The observation shape the broker already consumes from the legacy PowerShell snapshot commands.
// Keeping it identical is what lets the provider swap stay invisible at the MCP surface.
export type DeviceLabHyperVSnapshotObservation = {
    readonly ok: true;
    readonly snapshotId: string;
    readonly snapshotName: string;
    readonly snapshotType?: string;
    readonly state?: string;
};

export type DeviceLabHyperVSnapshotDeleteObservation = DeviceLabHyperVSnapshotObservation & {
    readonly deleted: true;
};

export type DeviceLabHyperVSnapshotTarget = {
    readonly vmId: string;
    // The owner-scoped provider name. Device Lab owns this convention; the library never sees it.
    readonly providerName: string;
    // Present once Device Lab has tracked the checkpoint, which tightens the ownership match.
    readonly snapshotId?: string | null;
};

export type DeviceLabHyperVSnapshotRepairTarget = {
    readonly vmId: string;
    readonly vmName: string;
    readonly expectedNotes: string;
    readonly providerName: string;
    readonly expectedCheckpointPolicy: "Production" | "ProductionOnly";
};

type InventoryTrackedSnapshot = { readonly id: string; readonly name: string; readonly providerName: string };
type InventoryLiveSnapshot = { readonly snapshotId: string; readonly snapshotName: string };

export function hyperVSnapshotInventoryConflict(ownerId: string, tracked: readonly InventoryTrackedSnapshot[], live: readonly InventoryLiveSnapshot[]) {
    return snapshotInventoryConflict(ownerId, tracked, live);
}

// Re-observe a conflicting inventory twice without changing tracked checkpoint state.
// A read error stays an error; a stable mismatch stays a conflict.
export async function settleHyperVSnapshotInventory<T>(
    ownerId: string, tracked: readonly InventoryTrackedSnapshot[], first: readonly InventoryLiveSnapshot[],
    readAgain: () => Promise<{ readonly ok: true; readonly snapshots: readonly InventoryLiveSnapshot[] } | { readonly ok: false; readonly error: T }>,
    limits: { readonly deadlineAt: number; readonly timeoutError: T; readonly delayMilliseconds?: number },
): Promise<{ readonly ok: true; readonly conflict: ReturnType<typeof hyperVSnapshotInventoryConflict> } | { readonly ok: false; readonly error: T }> {
    // The exported deadline is Unix time. Capture its remaining duration once so a
    // wall-clock adjustment during a read or sleep cannot extend this invocation.
    const startedAt = performance.now();
    const deadlineAt = startedAt + (limits.deadlineAt - Date.now());
    return settleSnapshotInventory(ownerId, tracked, first, async () => {
        const observed = await readAgain();
        if (!observed.ok) return observed;
        if (performance.now() >= deadlineAt) return { ok: false, error: limits.timeoutError };
        return observed;
    }, { ...limits, deadlineAt }, {
        now: () => performance.now(),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    });
}

export async function repairDeviceLabHyperVSnapshotState(
    client: HyperVWindowsClient,
    target: DeviceLabHyperVSnapshotRepairTarget,
): Promise<{ readonly checkpointPolicy: "Production" | "ProductionOnly"; readonly candidateCount: 0 | 1 }> {
    return client.repairVMSnapshotState({
        selector: { kind: "id", id: target.vmId },
        expectedName: target.vmName,
        expectedNotes: target.expectedNotes,
        snapshotName: target.providerName,
        expectedCheckpointPolicy: target.expectedCheckpointPolicy,
    });
}

function observation(snapshot: HyperVVirtualMachineSnapshot, state?: string): DeviceLabHyperVSnapshotObservation {
    return {
        ok: true,
        snapshotId: snapshot.id,
        snapshotName: snapshot.name,
        ...(snapshot.snapshotType ? { snapshotType: snapshot.snapshotType } : {}),
        ...(state ? { state } : {}),
    };
}

// Ownership fencing, previously enforced inside ownedSnapshotPrelude's PowerShell. Exactly one
// checkpoint must carry the expected owner-scoped name, and the tracked id when Device Lab has one.
//
// This throw keeps the prelude's failure semantics: it fired before the mutation, the script exited
// non-zero, and the broker treated it as a provider failure and ran journal reconciliation. A
// tracked checkpoint that is missing or duplicated on the host is exactly the out-of-band drift
// reconciliation exists to repair, so it must not be confused with an untrustworthy result.
export async function resolveOwnedHyperVSnapshot(
    client: HyperVWindowsClient,
    target: DeviceLabHyperVSnapshotTarget,
    options?: { readonly signal?: AbortSignal },
): Promise<HyperVVirtualMachineSnapshot> {
    const selector = { kind: "id", id: target.vmId } as const;
    const snapshots = await client.getVMSnapshots(selector, options);
    const expectedId = target.snapshotId ? target.snapshotId.toLowerCase() : null;
    const matched = snapshots.filter((snapshot) => snapshot.name === target.providerName
        && (!expectedId || snapshot.id.toLowerCase() === expectedId));
    if (matched.length !== 1) throw new Error("hyper-v-snapshot-ownership-mismatch");
    return matched[0] as HyperVVirtualMachineSnapshot;
}

async function requireVirtualMachineState(
    client: HyperVWindowsClient,
    vmId: string,
    options?: { readonly signal?: AbortSignal },
): Promise<string> {
    const machines = await client.getVM({ kind: "id", id: vmId }, options);
    if (machines.length !== 1) throw new Error("hyper-v-snapshot-vm-ownership-mismatch");
    return (machines[0] as { state: string }).state;
}

export async function createDeviceLabHyperVSnapshot(
    client: HyperVWindowsClient,
    target: DeviceLabHyperVSnapshotTarget,
    options?: {
        readonly signal?: AbortSignal;
        readonly operationDeadlineAt?: number;
        readonly remainingMilliseconds?: () => number;
        readonly monotonicNow?: () => number;
        readonly confirmationTimeoutMilliseconds?: number;
        readonly confirmationDelayMilliseconds?: number;
        readonly onCreatedId?: (id: string) => void | Promise<void>;
        readonly onConfirmationDeadline?: (deadlineAt: number) => void;
    },
): Promise<DeviceLabHyperVSnapshotObservation> {
    const now = options?.monotonicNow ?? (() => performance.now());
    const startedAt = now();
    // Capture the allowance before mutation; later callback values may tighten it but
    // cannot renew it. The internal callback takes precedence over a legacy Unix deadline.
    const initialRemainingMilliseconds = options?.remainingMilliseconds
        ? options.remainingMilliseconds()
        : options?.operationDeadlineAt === undefined ? Number.POSITIVE_INFINITY : options.operationDeadlineAt - Date.now();
    const operationDeadlineAt = startedAt + initialRemainingMilliseconds;
    const operationRemaining = () => Math.min(operationDeadlineAt - now(), options?.remainingMilliseconds?.() ?? Number.POSITIVE_INFINITY);
    options?.signal?.throwIfAborted();
    if (!(operationRemaining() > 0)) throw new Error("hyper-v-snapshot-create-unconfirmed");
    const created = await client.checkpointVM({
        selector: { kind: "id", id: target.vmId },
        snapshotName: target.providerName,
    }, options);
    await options?.onCreatedId?.(created.id);
    // -Passthru identifies the checkpoint requested by the mutation, but the VM inventory is
    // read separately. Do not publish its ID as tracked state until the exact object is visible.
    if (created.name !== target.providerName || created.vmId.toLowerCase() !== target.vmId.toLowerCase()) {
        throw new Error("hyper-v-snapshot-result-mismatch");
    }
    options?.signal?.throwIfAborted();
    const timeoutMilliseconds = Math.min(10000, options?.confirmationTimeoutMilliseconds ?? 10000);
    const delayMilliseconds = options?.confirmationDelayMilliseconds ?? 500;
    const confirmationMilliseconds = Math.min(timeoutMilliseconds, operationRemaining());
    if (!Number.isFinite(confirmationMilliseconds) || confirmationMilliseconds <= 0
        || !Number.isFinite(delayMilliseconds) || delayMilliseconds < 0) {
        throw new Error("hyper-v-snapshot-create-unconfirmed");
    }
    const deadlineAt = now() + confirmationMilliseconds;
    // This compatibility callback still receives Unix time, never the local clock coordinate.
    options?.onConfirmationDeadline?.(Date.now() + confirmationMilliseconds);
    const remaining = () => Math.min(deadlineAt - now(), operationRemaining());
    for (;;) {
        options?.signal?.throwIfAborted();
        const readMilliseconds = remaining();
        if (!Number.isFinite(readMilliseconds) || readMilliseconds <= 0) {
            throw new Error("hyper-v-snapshot-create-unconfirmed");
        }
        const controller = new AbortController();
        const confirmationAbort = new Error("hyper-v-snapshot-confirmation-deadline");
        const relayAbort = () => controller.abort(options?.signal?.reason);
        options?.signal?.addEventListener("abort", relayAbort, { once: true });
        if (options?.signal?.aborted) relayAbort();
        const readTimer = setTimeout(() => controller.abort(confirmationAbort), Math.max(1, Math.floor(readMilliseconds)));
        let live: readonly HyperVVirtualMachineSnapshot[];
        try {
            live = await client.getVMSnapshots({ kind: "id", id: target.vmId }, { signal: controller.signal });
        } catch (error) {
            const abortedRead = error === confirmationAbort
                || error instanceof Error && error.name === "AbortError"
                || error instanceof HyperVWindowsError && error.category === "transport"
                    && error.operation === "Get-VMSnapshot" && error.code === "cancelled";
            if (!options?.signal?.aborted && controller.signal.reason === confirmationAbort && abortedRead) {
                throw new Error("hyper-v-snapshot-create-unconfirmed");
            }
            throw error;
        } finally {
            clearTimeout(readTimer);
            options?.signal?.removeEventListener("abort", relayAbort);
        }
        options?.signal?.throwIfAborted();
        const afterReadMilliseconds = remaining();
        if (controller.signal.reason === confirmationAbort
            || !Number.isFinite(afterReadMilliseconds) || afterReadMilliseconds <= 0) {
            throw new Error("hyper-v-snapshot-create-unconfirmed");
        }
        const sameId = live.filter((candidate) => candidate.id.toLowerCase() === created.id.toLowerCase());
        if (live.some((candidate) => candidate.name.toLowerCase() === target.providerName.toLowerCase()
            && candidate.id.toLowerCase() !== created.id.toLowerCase())) {
            throw new Error("hyper-v-snapshot-create-identity-conflict");
        }
        if (sameId.length > 1 || sameId.some((candidate) => candidate.name !== target.providerName
            || candidate.vmId.toLowerCase() !== target.vmId.toLowerCase())) {
            throw new Error("hyper-v-snapshot-create-identity-conflict");
        }
        if (sameId.length === 1) return observation(sameId[0] as HyperVVirtualMachineSnapshot);
        if (delayMilliseconds >= remaining()) throw new Error("hyper-v-snapshot-create-unconfirmed");
        await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    }
}

export async function deleteDeviceLabHyperVSnapshot(
    client: HyperVWindowsClient,
    target: DeviceLabHyperVSnapshotTarget,
    options?: { readonly signal?: AbortSignal },
): Promise<DeviceLabHyperVSnapshotDeleteObservation> {
    const selector = { kind: "id", id: target.vmId } as const;
    const snapshot = await resolveOwnedHyperVSnapshot(client, target, options);
    await client.removeVMSnapshot({ selector, snapshot: { kind: "id", id: snapshot.id } }, options);
    // The legacy provider self-reported a `deleted` flag, which the broker had to distrust. The
    // typed protocol has no such field, so confirm by observation instead: the checkpoint must be
    // gone. A host that reports success while leaving it behind is still unconfirmed.
    const remaining = await client.getVMSnapshots(selector, options);
    if (remaining.some((candidate) => candidate.id.toLowerCase() === snapshot.id.toLowerCase())) {
        throw new Error("hyper-v-snapshot-delete-unconfirmed");
    }
    return { ...observation(snapshot), deleted: true };
}

export type DeviceLabHyperVSnapshotRestoreOptions = {
    // Legacy behavior: a running VM refuses restore unless the caller forces a turn-off first.
    readonly force?: boolean;
    // Linux devices are started again after restore so the device is immediately usable.
    readonly startAfterRestore?: boolean;
    readonly signal?: AbortSignal;
};

export async function restoreDeviceLabHyperVSnapshot(
    client: HyperVWindowsClient,
    target: DeviceLabHyperVSnapshotTarget,
    restoreOptions?: DeviceLabHyperVSnapshotRestoreOptions,
): Promise<DeviceLabHyperVSnapshotObservation> {
    const signalOptions = restoreOptions?.signal ? { signal: restoreOptions.signal } : undefined;
    const selector = { kind: "id", id: target.vmId } as const;
    const snapshot = await resolveOwnedHyperVSnapshot(client, target, signalOptions);
    const state = await requireVirtualMachineState(client, target.vmId, signalOptions);
    if (state !== "Off") {
        if (!restoreOptions?.force) throw new Error("hyper-v-snapshot-restore-requires-stopped-vm");
        await client.stopVM({ selector, mode: "turn-off", force: true }, signalOptions);
    }
    await client.restoreVMSnapshot({ selector, snapshot: { kind: "id", id: snapshot.id } }, signalOptions);
    let restoredState = await requireVirtualMachineState(client, target.vmId, signalOptions);
    if (restoreOptions?.startAfterRestore && restoredState !== "Running") {
        await client.startVM({ selector }, signalOptions);
        restoredState = await requireVirtualMachineState(client, target.vmId, signalOptions);
    }
    return observation(snapshot, restoredState);
}
