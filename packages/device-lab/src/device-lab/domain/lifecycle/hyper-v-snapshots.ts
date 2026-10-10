export type SnapshotTool = "device_snapshot_list" | "device_snapshot_create" | "device_snapshot_restore" | "device_snapshot_delete";
export type SnapshotRpcResponse = { status: number; payload: unknown };
export type SnapshotRequest = { tool: SnapshotTool; deviceId: string | null; params: Record<string, unknown> };
export type SnapshotOwnerTarget = { backend: string | null; stateKey: string; device: Record<string, unknown> };
export type SnapshotRepairTarget = { backend: string; deviceId: string; device: Record<string, unknown>; executable: string };
export type SnapshotRepairResult = { ok: true; device: Record<string, unknown>; reconciled: boolean }
    | { ok: false; status: number; error: string; detail?: string };
export type SnapshotCheckpointPolicy = "Production" | "ProductionOnly";
export type SnapshotJournal = {
    version: 1; operationId: string; ownerId: string; deviceId: string; incarnationId: string;
    tool: Exclude<SnapshotTool, "device_snapshot_list">;
    snapshotName: string; providerName: string; snapshotId?: string; confirmationRequired?: boolean;
    expectedCheckpointPolicy?: SnapshotCheckpointPolicy; startedAt: string;
};
export type SnapshotTracked = { id: string; name: string; providerName: string; snapshotType?: string; createdAt?: string };
export type SnapshotLive = { readonly snapshotId: string; readonly snapshotName: string; readonly snapshotType?: string };
export type SnapshotVmObservation = {
    vmId: string; vmName: string; state: string; diskPath?: string; checkpointPolicy?: string;
    snapshots?: readonly SnapshotLive[];
};
export type SnapshotCheckpointTarget = { readonly vmId: string; readonly providerName: string; readonly snapshotId?: string | null };
export type SnapshotMutationObservation = {
    readonly ok: true; readonly snapshotId: string; readonly snapshotName: string;
    readonly snapshotType?: string; readonly state?: string;
};
export type SnapshotDeleteObservation = SnapshotMutationObservation & { readonly deleted: true };
export type SnapshotExecution = {
    mode?: string; provider?: string; status?: number | null; error?: string;
    stdout?: string; stderr?: string; input?: string; [field: string]: unknown;
};

export function isSnapshotTool(tool: string): tool is SnapshotTool {
    return ["device_snapshot_list", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete"].includes(tool);
}
export function snapshotRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function snapshotField(record: Record<string, unknown>, name: string): string | null {
    const value = record[name];
    return typeof value === "string" && value ? value : null;
}
export function snapshotCheckpointPolicy(backend: string | null): SnapshotCheckpointPolicy {
    return backend === "linux-vm" ? "Production" : "ProductionOnly";
}
export function snapshotInventoryConflict(
    ownerId: string,
    tracked: readonly Pick<SnapshotTracked, "id" | "name" | "providerName">[],
    live: readonly SnapshotLive[],
) {
    const liveById = new Map(live.map(snapshot => [snapshot.snapshotId.toLowerCase(), snapshot]));
    const trackedIds = new Set(tracked.map(snapshot => snapshot.id.toLowerCase()));
    const ownerPrefix = `ccc-${ownerId}-`;
    return {
        untracked: live.filter(snapshot => snapshot.snapshotName.toLowerCase().startsWith(ownerPrefix)
            && !trackedIds.has(snapshot.snapshotId.toLowerCase()))
            .map(snapshot => ({ id: snapshot.snapshotId, providerName: snapshot.snapshotName })),
        missing: tracked.filter(snapshot => {
            const candidate = liveById.get(snapshot.id.toLowerCase());
            return !candidate || candidate.snapshotName !== snapshot.providerName;
        }).map(snapshot => ({ id: snapshot.id, name: snapshot.name })),
    };
}

export function trackedHyperVSnapshots(device: Record<string, unknown>): SnapshotTracked[] {
    if (!Array.isArray(device.snapshots)) return [];
    return device.snapshots.flatMap((snapshot) => {
        if (!snapshotRecord(snapshot)) return [];
        const record = snapshot;
        if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.providerName !== "string") return [];
        return [{
            id: record.id,
            name: record.name,
            providerName: record.providerName,
            ...(typeof record.snapshotType === "string" ? { snapshotType: record.snapshotType } : {}),
            ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
        }];
    });
}

export function snapshotActionReplacement(device: Record<string, unknown>, tool: Exclude<SnapshotTool, "device_snapshot_list">, backend: string | null, snapshots: SnapshotTracked[], snapshot: SnapshotTracked, state: string | undefined, updatedAt: string): Record<string, unknown> {
    const nextSnapshots = tool === "device_snapshot_create" ? [...snapshots, snapshot]
        : tool === "device_snapshot_delete" ? snapshots.filter(candidate => candidate.id.toLowerCase() !== snapshot.id.toLowerCase()) : snapshots;
    return { ...device, snapshots: nextSnapshots,
        ...(tool === "device_snapshot_restore" ? (backend === "linux-vm"
            ? { activeSnapshotId: snapshot.id, status: "running", runtimeState: state || "Running", bootReady: true }
            : { activeSnapshotId: snapshot.id, status: "stopped", runtimeState: state || "Off" }) : {}),
        ...(tool === "device_snapshot_delete" && device.activeSnapshotId === snapshot.id ? { activeSnapshotId: null } : {}), updatedAt };
}
