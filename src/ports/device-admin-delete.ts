import type { CleanupBackend, CleanupCommandResult, CleanupRecord } from "../domain/device-admin-cleanup.js";
import type { PhysicalDeleteLease, DeviceAdminDeleteResult } from "../domain/device-admin-delete.js";

/** Lazy observations and individual effects inside native hardware then aggregate locks. */
export interface DeviceAdminLeaseScope {
    readLease(): PhysicalDeleteLease | null;
    readAggregate(): PhysicalDeleteLease[];
    writeAggregate(leases: PhysicalDeleteLease[]): undefined;
    writeLease(lease: PhysicalDeleteLease | null): undefined;
    removeLease(): undefined;
}
export interface DeviceAdminPhysicalTransitionPorts<Backend extends CleanupBackend> {
    hardwareId(backend: Backend, device: CleanupRecord): string | null;
    withLeaseLock<T>(ownerId: string, backend: Backend, device: CleanupRecord, hardwareId: string, operation: (scope: DeviceAdminLeaseScope) => T): T;
    sameAggregate(left: PhysicalDeleteLease[], right: PhysicalDeleteLease[]): boolean;
    missingLease(error: unknown): boolean;
    transitionRecord(ownerId: string, backend: Backend, expected: CleanupRecord, replacement: CleanupRecord | null): { matched: boolean };
}
export interface DeviceAdminDeletePorts<Backend extends CleanupBackend> extends DeviceAdminPhysicalTransitionPorts<Backend> {
    withRecordLock(ownerId: string, stateKey: string, deviceId: string, operation: () => DeviceAdminDeleteResult): DeviceAdminDeleteResult;
    readDevices(ownerId: string, stateKey: string): CleanupRecord[];
    sameRecord(current: CleanupRecord, expected: CleanupRecord): boolean;
    commandPath(command: string): string | null;
    runCommand(command: string, args: string[], timeoutMs?: number): CleanupCommandResult | null;
    releaseWindowsClaim(ownerId: string, backend: Backend, device: CleanupRecord): undefined;
}
