import type { CleanupRpcResult, PhysicalRecord, CleanupLeaseGuard, CleanupLeaseResult, CleanupRollback, AuxiliaryOutcome, CleanupPublication } from '../domain/broker-owner-cleanup.js';
import type { AttachParams, AppleHostDevice, PhysicalCommand, PhysicalExecution, PhysicalStopRequest } from '../domain/broker-physical-devices.js';
export interface AndroidHostDevice {
    serial: string;
    state: string;
    details: PhysicalRecord;
    connection: string;
    attachable: boolean;
    [key: string]: unknown;
}
export interface AndroidInventory {
    ok: boolean;
    devices: AndroidHostDevice[];
    [key: string]: unknown;
}
export interface BrokerPhysicalDevicesPorts<Handle> {
    deriveDeviceId(backend: string, identity: string): string;
    read(ownerId: string, stateKey: string): unknown[];
    androidInventory(): AndroidInventory;
    connectAndroid(target: string): PhysicalExecution;
    appleInventory(): PhysicalExecution;
    appleDevices(text: string): AppleHostDevice[];
    nonce(): string;
    timestamp(): string;
    claimLease(ownerId: string, request: PhysicalRecord): CleanupRpcResult;
    releaseClaim(ownerId: string, request: PhysicalRecord): CleanupRpcResult;
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
    withDetachLease<T>(ownerId: string, parsed: AttachParams, device: PhysicalRecord, operation: (guard: CleanupLeaseGuard<Handle>) => T): T | CleanupRpcResult;
    withLeaseGuard<T>(ownerId: string, stateKey: string, record: PhysicalRecord, operation: (guard: CleanupLeaseGuard<Handle>) => T): T;
    releaseLease(ownerId: string, guard: CleanupLeaseGuard<Handle>): CleanupLeaseResult;
    restoreLease(ownerId: string, guard: CleanupLeaseGuard<Handle>): CleanupRollback;
    removeDevice(ownerId: string, stateKey: string, deviceId: string): undefined;
    auxiliary(ownerId: string, request: PhysicalStopRequest, expected: unknown): AuxiliaryOutcome;
    publish(ownerId: string, stateKey: string, deviceId: string, expected: unknown, replacement: unknown): CleanupPublication;
    execute(command: PhysicalCommand): PhysicalExecution;
    clone(value: unknown): unknown;
    redact(value: unknown): unknown;
}
