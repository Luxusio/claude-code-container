/** Mutable record facts retain raw native fields without normalization. */
export type DeviceAdminPruneRecord = Record<string, unknown> & { id?: string; status?: string };
export interface DeviceAdminPruneBackend { stateKey: string; name: string }
export function deviceAdminPruneEligible(backend: DeviceAdminPruneBackend, device: DeviceAdminPruneRecord): boolean {
    return (device.status === "stopped" || device.status === "detached") && !hasMacosManagedProviderResources(backend, device);
}
export function deviceAdminPrunedLine(device: DeviceAdminPruneRecord, backend: DeviceAdminPruneBackend): string {
    return `pruned: ${device.id || "(unknown)"}  backend=${backend.name}`;
}
function macosManagedProviderResource(device: DeviceAdminPruneRecord): boolean {
    return Boolean(
        device.providerResourceManaged ||
        device.provisioning === "image-created" ||
        device.provisioning === "image-cloned" ||
        device.imageSource ||
        device.clonedFrom ||
        device.imageCreatedAt ||
        device.clonedAt,
    );
}

function macosSnapshotProviderResources(device: DeviceAdminPruneRecord): Array<{ provider: string; instance: string }> {
    const snapshots = Array.isArray(device.snapshots) ? device.snapshots : [];
    return snapshots.flatMap((snapshot) => {
        if (!snapshot || typeof snapshot !== "object") return [];
        const record = snapshot as Record<string, unknown>;
        const provider = typeof record.provider === "string" ? record.provider : null;
        const instance = typeof record.providerInstance === "string" ? record.providerInstance : null;
        return provider && instance ? [{ provider, instance }] : [];
    });
}

function macosRestoreRecoveryProviderResource(device: DeviceAdminPruneRecord): { provider: string; instance: string } | null {
    const recovery = device.restoreRecovery;
    if (!recovery || typeof recovery !== "object") return null;
    const record = recovery as Record<string, unknown>;
    const provider = typeof record.provider === "string" ? record.provider : typeof device.provider === "string" ? device.provider : null;
    const instance = typeof record.candidateProviderInstance === "string" ? record.candidateProviderInstance : null;
    return provider && instance ? { provider, instance } : null;
}

export function macosManagedProviderResources(device: DeviceAdminPruneRecord): Array<{ provider: string; instance: string }> {
    const resources = [
        ...macosSnapshotProviderResources(device),
        macosRestoreRecoveryProviderResource(device),
    ].filter((resource): resource is { provider: string; instance: string } => Boolean(resource));
    const provider = typeof device.provider === "string" ? device.provider : null;
    const instance = typeof device.providerInstance === "string" ? device.providerInstance : null;
    if (provider && instance && macosManagedProviderResource(device)) resources.push({ provider, instance });
    return resources;
}

function hasMacosManagedProviderResources(backend: DeviceAdminPruneBackend, device: DeviceAdminPruneRecord): boolean {
    return backend.stateKey === "macos" && macosManagedProviderResources(device).length > 0;
}

