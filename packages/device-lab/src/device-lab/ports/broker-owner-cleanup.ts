import type { PhysicalRecord, CleanupRpcResult, CleanupSignal, CleanupPublication, CleanupLeaseGuard, CleanupLeaseResult, CleanupRollback } from '../domain/broker-owner-cleanup.js';
export interface OwnerCleanupCommand {
    mode: 'exec' | 'detached' | 'noop';
    provider: string;
    executable?: string;
    args?: string[];
    sandboxId?: string;
    [key: string]: unknown;
}
export interface OwnerCleanupExecution {
    status?: number | null;
    error?: string;
    timedOut?: boolean;
    [key: string]: unknown;
}
export interface BrokerOwnerCleanupPorts<Handle> {
    stateKeys: readonly string[];
    backendAliases: ReadonlyMap<string, string>;
    stateBackends: ReadonlyMap<string, string>;
    read(ownerId: string, stateKey: string): unknown[];
    equal(left: unknown, right: unknown): boolean;
    publish(ownerId: string, stateKey: string, deviceId: string, expected: unknown, replacement: unknown): CleanupPublication;
    withDeviceOperation<T>(ownerId: string, stateKey: string, deviceId: string, operation: () => T): Promise<Awaited<T>>;
    withLeaseGuard<T>(ownerId: string, stateKey: string, record: PhysicalRecord, operation: (guard: CleanupLeaseGuard<Handle>) => T): T;
    releaseLease(ownerId: string, guard: CleanupLeaseGuard<Handle>): CleanupLeaseResult;
    restoreLease(ownerId: string, guard: CleanupLeaseGuard<Handle>): CleanupRollback;
    terminateAppium(runtime: unknown): CleanupSignal;
    signalRecording(runtime: PhysicalRecord): CleanupSignal;
    cancelWatchdog(ownerId: string, deviceId: string): CleanupSignal;
    planStop(ownerId: string, target: {
        backend: string;
        stateKey: string;
        deviceId: string;
    }, device: PhysicalRecord): OwnerCleanupCommand | {
        error: string;
        missing?: string[];
    };
    execute(command: OwnerCleanupCommand): OwnerCleanupExecution;
    releaseWindows(ownerId: string, device: PhysicalRecord, sandboxId: string | undefined): undefined;
    timestamp(): string;
    stateErrorCode(error: unknown): string | null;
    isDeviceLockTimeout(error: unknown): boolean;
}
