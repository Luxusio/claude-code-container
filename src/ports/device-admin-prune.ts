import type { DeviceAdminPruneBackend, DeviceAdminPruneRecord } from "../domain/device-admin-prune.js";
/** Required synchronous native leaves; the critical section protects one record decision. */
export interface DeviceAdminPrunePorts<Backend extends DeviceAdminPruneBackend> {
    readonly backends: readonly Backend[];
    resolveOwnerId(cwd: string, profile?: string): string;
    enumerateOwnerIds(): string[];
    readDevices(ownerId: string, stateKey: string): DeviceAdminPruneRecord[];
    sameRecord(current: DeviceAdminPruneRecord, expected: DeviceAdminPruneRecord): boolean;
    withRecordLock(ownerId: string, stateKey: string, deviceId: string, decide: () => boolean): boolean;
    removeRecord(ownerId: string, backend: Backend, expected: DeviceAdminPruneRecord): boolean;
}
