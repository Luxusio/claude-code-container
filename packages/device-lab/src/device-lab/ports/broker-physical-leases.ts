import type { LeaseDatePorts } from "./broker-observation.js";
import type { PhysicalLeaseRecord, LeaseDirectoryInspection, LeaseDirectoryScan, LeaseWaitBudget } from "../domain/broker-physical-leases.js";
export interface BrokerPhysicalLeasePorts extends LeaseDatePorts {
    prepareDirectory(backend: string): LeaseDirectoryInspection;
    inspectDirectory(backend: string): LeaseDirectoryInspection;
    scan(backend: string): LeaseDirectoryScan;
    leaseFile(backend: string, hardwareId: string): string;
    withHardwareLock<Result>(backend: string, hardwareId: string, operation: () => Result, budget?: LeaseWaitBudget): Result;
    read(file: string, backend: string, hardwareId: string): PhysicalLeaseRecord | null;
    write(file: string, lease: PhysicalLeaseRecord): undefined;
    remove(file: string): undefined;
    fileExists(file: string): boolean;
    timestamp(): string;
    nowMs(): number;
    newClaimId(): string;
    stopHeartbeat(ownerId: string, backend: string, hardwareId: string, deviceId?: string): boolean;
    startHeartbeat(ownerId: string, backend: string, hardwareId: string, deviceId: string, options: {ttlMs: number; claimId?: string; claimNonce?: string}): {intervalMs: number; ttlMs: number};
}
