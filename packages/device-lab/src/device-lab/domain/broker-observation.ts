export type OwnerInventoryEntry<Device> =
    | { stateKey: string; devices: Device[]; exists: false }
    | { stateKey: string; devices: Device[]; exists: true; truncated: true; error: string; maxBytes: number; bytes: number }
    | { stateKey: string; devices: Device[]; exists: true; truncated: boolean; totalDevices: number; maxDevices: number }
    | { stateKey: string; devices: Device[]; exists: true; error: string };

export interface OwnerInventory<Device> {
    ownerId: string;
    root: string;
    ownerRoot: string;
    backends: OwnerInventoryEntry<Device>[];
}

export interface FocusedInventoryRequest { stateKey?: string | null; backend: string | null; tool: string }
export interface MetadataDeviceRequest { stateKey: string; backend: string; deviceId: string }

export interface LeaseDirectoryEntry { name: string; isFile(): boolean }
export interface LeaseDirectoryReader<Entry extends LeaseDirectoryEntry> { readSync(): Entry | null; closeSync(): void }
export type LeaseDirectoryInspection = { ok: true; exists: boolean } | { ok: false };
export type LeaseDirectoryScan<File, Inspection extends LeaseDirectoryInspection> =
    | { kind: "entries"; entries: Array<{ file: File; hardwareId: string }> }
    | { kind: "native-refusal"; evidence: Inspection }
    | { kind: "entry-cap"; backend: string; limit: number }
    | { kind: "directory-failed"; backend: string; detail: string };

export function observedLeaseTtlMs(lease: Record<string, unknown> | null | undefined, fallback: number): number {
    return typeof lease?.ttlMs === "number" && Number.isInteger(lease.ttlMs) && lease.ttlMs > 0
        ? lease.ttlMs : fallback;
}
