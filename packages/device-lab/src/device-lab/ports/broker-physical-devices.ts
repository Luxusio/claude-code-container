import type {ClaimOutcome, ReleaseOutcome, LeaseFailure} from '../domain/broker-physical-leases.js';
import type { PhysicalRecord, CleanupLeaseGuard, CleanupLeaseResult, CleanupRollback, AuxiliaryOutcome, CleanupPublication } from '../domain/broker-owner-cleanup.js';
import type { AttachParams, AppleHostDevice, AndroidInventory, PhysicalExecution, PhysicalStopRequest } from '../domain/broker-physical-devices.js';
export type {AndroidHostDevice, AndroidInventory} from '../domain/broker-physical-devices.js';
export interface BrokerPhysicalDevicesPorts<Handle, Receipt> {
    deriveDeviceId(backend: string, identity: string): string;
    read(ownerId: string, stateKey: string): unknown[];
    androidInventory(): AndroidInventory;
    connectAndroid(target: string): PhysicalExecution<Receipt>;
    appleInventory(): PhysicalExecution<Receipt>;
    appleDevices(text: string): AppleHostDevice[];
    nonce(): string;
    timestamp(): string;
    claimLease(ownerId: string, request: PhysicalRecord): ClaimOutcome;
    releaseClaim(ownerId: string, request: PhysicalRecord): ReleaseOutcome;
    claimDevice(ownerId: string, stateKey: string, device: PhysicalRecord, hardwareField: 'serial' | 'udid'): {
        ok: true;
        device: PhysicalRecord;
        reattached: boolean;
    } | {
        ok: false;
        error: string;
        existing: PhysicalRecord | null;
    };
    heartbeat(ownerId: string, backend: string, hardwareId: string, deviceId: string, lease: PhysicalRecord | undefined, nonce: string): unknown;
    withDetachLease<T>(ownerId: string, parsed: AttachParams, device: PhysicalRecord, operation: (guard: CleanupLeaseGuard<Handle>) => T): T | {kind:'scope-refused';failure:LeaseFailure};
    withLeaseGuard<T>(ownerId: string, stateKey: string, record: PhysicalRecord, operation: (guard: CleanupLeaseGuard<Handle>) => T): T;
    releaseLease(ownerId: string, guard: CleanupLeaseGuard<Handle>): CleanupLeaseResult;
    restoreLease(ownerId: string, guard: CleanupLeaseGuard<Handle>): CleanupRollback;
    removeDevice(ownerId: string, stateKey: string, deviceId: string): undefined;
    auxiliary(ownerId: string, request: PhysicalStopRequest, expected: unknown): AuxiliaryOutcome;
    publish(ownerId: string, stateKey: string, deviceId: string, expected: unknown, replacement: unknown): CleanupPublication;
    observePhysicalStop(backend:string):PhysicalExecution<Receipt>;
    clone<T>(value: T): T;
}
