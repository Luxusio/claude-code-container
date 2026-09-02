import type {
    HyperVVirtualMachineSnapshot,
    HyperVWindowsClient,
} from "../../../hyper-v-windows/index.js";

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
    options?: { readonly signal?: AbortSignal },
): Promise<DeviceLabHyperVSnapshotObservation> {
    const created = await client.checkpointVM({
        selector: { kind: "id", id: target.vmId },
        snapshotName: target.providerName,
    }, options);
    // Checkpoint-VM -Passthru already returns the created checkpoint, so no name re-read is needed.
    if (created.name !== target.providerName) throw new Error("hyper-v-snapshot-ownership-mismatch");
    return observation(created);
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
