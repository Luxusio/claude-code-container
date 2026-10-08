import { observedLeaseTtlMs, type LeaseDirectoryEntry, type LeaseDirectoryInspection, type LeaseDirectoryScan } from "../domain/broker-observation.js";
import type { LeaseDatePorts, LeaseDirectoryPorts, LeaseListPorts } from "../ports/broker-observation.js";

export function createLeaseDatePolicy(ports: LeaseDatePorts, defaultTtlMs: number) {
    function ttlMs(lease: Record<string, unknown> | null | undefined) { return observedLeaseTtlMs(lease, defaultTtlMs); }
    function expiresAt(lease: Record<string, unknown>): string {
        if (typeof lease.expiresAt === "string" && !Number.isNaN(ports.parse(() => lease.expiresAt as string))) return lease.expiresAt;
        const updatedAt = typeof lease.updatedAt === "string" && !Number.isNaN(ports.parse(() => lease.updatedAt as string))
            ? lease.updatedAt : ports.epoch();
        return ports.expiryFrom(updatedAt, ttlMs(lease));
    }
    function expired(lease: Record<string, unknown>, nowMs: number) { return ports.parse(() => expiresAt(lease)) <= nowMs; }
    return { ttlMs, expiresAt, expired };
}

export function createLeaseDirectoryScan<Root, File, Entry extends LeaseDirectoryEntry, Inspection extends LeaseDirectoryInspection>(
    ports: LeaseDirectoryPorts<Root, File, Entry, Inspection>, limit: number,
) {
    return function scan(backend: string): LeaseDirectoryScan<File, Inspection> {
        const root = ports.root(backend);
        const inspection = ports.inspect(backend);
        if (!inspection.ok) return { kind: "native-refusal", evidence: inspection };
        if (!inspection.exists) return { kind: "entries", entries: [] };
        try {
            ports.assertRoot(root);
            const directory = ports.open(root);
            const entries: Array<{ file: File; hardwareId: string }> = [];
            let entryCount = 0;
            try {
                while (true) {
                    const entry = directory.readSync();
                    if (!entry) break;
                    entryCount += 1;
                    if (entryCount > limit) return { kind: "entry-cap", backend, limit };
                    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
                    const encodedHardwareId = entry.name.slice(0, -".json".length);
                    let hardwareId: string;
                    try { hardwareId = decodeURIComponent(encodedHardwareId); } catch { continue; }
                    if (!hardwareId || hardwareId.length > 256 || /[\u0000-\u001f]/.test(hardwareId)) continue;
                    if (encodeURIComponent(hardwareId) !== encodedHardwareId) continue;
                    entries.push({ file: ports.entryFile(root, entry), hardwareId });
                }
            } finally { directory.closeSync(); }
            return { kind: "entries", entries };
        } catch (error) {
            return { kind: "directory-failed", backend, detail: ports.errorCode(error) || "physical-lease-directory-read-failed" };
        }
    };
}

export function createLeaseList<File, Scan extends { ok: true; entries: Array<{ file: File; hardwareId: string }> } | { ok: false }>(
    scan: (backend: string) => Scan, ports: LeaseListPorts<File>,
) {
    return function list(ownerId: string, backend: string): Extract<Scan, { ok: false }> | { ok: true; leases: Array<{ expiresAt: string; ttlMs: number }> } {
        const inspected = scan(backend);
        if (!inspected.ok) return inspected as Extract<Scan, { ok: false }>;
        const leases = [];
        for (const { file, hardwareId } of inspected.entries) {
            const lease = ports.read(file, backend, hardwareId);
            if (!lease || lease.ownerId !== ownerId) continue;
            if (ports.expired(lease)) continue;
            leases.push({ ...lease, expiresAt: ports.expiresAt(lease), ttlMs: ports.ttlMs(lease) });
        }
        return { ok: true as const, leases };
    };
}

export function createPhysicalComposite<Listed extends { ok: true; leases: unknown } | { ok: false }, Context, Host extends { devices: unknown }, Devices>(ports: {
    readonly leases: (ownerId: string, backend: string) => Listed;
    readonly androidHost: (context: Context) => Host;
    readonly devices: (ownerId: string, backend: string) => Devices;
}) {
    return function observe(ownerId: string, backend: string, context: Context) {
        const listed = ports.leases(ownerId, backend);
        if (!listed.ok) return { kind: "lease-refused" as const, evidence: listed as Extract<Listed, { ok: false }> };
        const hostInventory = backend === "android-device" ? ports.androidHost(context) : null;
        return { kind: "observed" as const, value: {
            ownerId, backend, devices: ports.devices(ownerId, backend), leases: listed.leases,
            ...(hostInventory ? { hostDevices: hostInventory.devices, hostInventory } : {}),
        } };
    };
}
