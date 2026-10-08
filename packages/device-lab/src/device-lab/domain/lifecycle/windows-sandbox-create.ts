export type BrokerWindowsSandboxRecord = Record<string, unknown>;
export type BrokerWindowsSandboxClaim<Device> = { ok: true } | {
    ok: false; error: string; field: string; value: unknown; existing: Device;
};
export type BrokerWindowsSandboxCreateOutcome<Device, Rollback> =
    | { kind: "created"; device: Device }
    | { kind: "claim-exception"; error: unknown; rollback: Rollback; stateCode?: string }
    | { kind: "claim-conflict"; claim: Extract<BrokerWindowsSandboxClaim<Device>, {ok: false}>; rollback: Rollback }
    | { kind: "config-failure"; error: unknown };

/** Native composition supplies the single clock and fenced config path. */
export function brokerWindowsSandboxRecord(
    ownerId: string, deviceId: string, name: string, create: Record<string, unknown>,
    configPath: string, now: string,
): BrokerWindowsSandboxRecord {
    return {
        id: deviceId, name, backend: "windows-sandbox", kind: "desktop", platform: "windows", ownerId,
        networking: create.networking === true, clipboard: create.clipboard === true, vgpu: create.vgpu === true,
        memoryMb: typeof create.memoryMb === "number" ? create.memoryMb : 4096,
        minimized: create.minimized !== false, configPath, recording: null, status: "stopped", creatable: true,
        createdAt: now, updatedAt: now, authority: "host-broker",
    };
}

/** Preserve the existing id AND createdAt compensation, including malformed entries. */
export function retainAfterWindowsConfigFailure(candidate: unknown, id: unknown, createdAt: unknown): boolean {
    if (!candidate || typeof candidate !== "object") return true;
    const record = candidate as Record<string, unknown>;
    return record.id !== id || record.createdAt !== createdAt;
}
