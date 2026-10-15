import type { PhysicalRecord, CleanupSignal, CleanupTermination, CleanupPublication, CleanupLeaseGuard, CleanupLeaseResult, CleanupRollback, CleanupCommandTarget, CleanupStopOutcome } from '../domain/broker-owner-cleanup.js';
export interface BrokerOwnerCleanupPorts<Handle, Receipt> {
    stateKeys: readonly string[];
    backendAliases: ReadonlyMap<string, string>;
    stateBackends: ReadonlyMap<string, string>;
    read(ownerId: string, stateKey: string): unknown[];
    equal(left: unknown, right: unknown): boolean;
    publish(ownerId: string, stateKey: string, deviceId: string, expected: unknown, replacement: unknown): CleanupPublication;
    withDeviceOperation<T>(ownerId: string, stateKey: string, deviceId: string, operation: () => T | Promise<T>): Promise<T>;
    withLeaseGuard<T>(ownerId: string, stateKey: string, record: PhysicalRecord, operation: (guard: CleanupLeaseGuard<Handle>) => T): T;
    releaseLease(ownerId: string, guard: CleanupLeaseGuard<Handle>): CleanupLeaseResult;
    restoreLease(ownerId: string, guard: CleanupLeaseGuard<Handle>): CleanupRollback;
    terminateAppium(runtime: unknown, stillCurrent: () => boolean): CleanupTermination;
    signalRecording(runtime: PhysicalRecord, stillCurrent: () => boolean): CleanupTermination;
    cancelWatchdog(ownerId: string, deviceId: string): CleanupSignal;
    stopLocked(ownerId: string, target: CleanupCommandTarget, current: PhysicalRecord): Promise<CleanupStopOutcome<Receipt>>;
    timestamp(): string;
    stateErrorCode(error: unknown): string | null;
    isDeviceLockTimeout(error: unknown): boolean;
}
