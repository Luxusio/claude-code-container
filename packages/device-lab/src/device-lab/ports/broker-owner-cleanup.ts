import type { PhysicalRecord, CleanupSignal, CleanupPublication, CleanupLeaseGuard, CleanupLeaseResult, CleanupRollback, CleanupPreparedStop, CleanupStopObservation } from '../domain/broker-owner-cleanup.js';
export interface BrokerOwnerCleanupPorts<Handle, Prepared, Receipt> {
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
    terminateAppium(runtime: unknown): CleanupSignal;
    signalRecording(runtime: PhysicalRecord): CleanupSignal;
    cancelWatchdog(ownerId: string, deviceId: string): CleanupSignal;
    prepareStop(ownerId:string,target:{backend:string;stateKey:string;deviceId:string},device:PhysicalRecord):CleanupPreparedStop<Prepared>;
    runPreparedStop(handle:Prepared):CleanupStopObservation<Receipt>;
    releaseWindows(ownerId:string,device:PhysicalRecord,observation:CleanupStopObservation<Receipt>):undefined;
    timestamp(): string;
    stateErrorCode(error: unknown): string | null;
    isDeviceLockTimeout(error: unknown): boolean;
}
