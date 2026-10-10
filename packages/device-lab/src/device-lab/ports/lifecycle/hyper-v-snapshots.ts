import type {
    SnapshotCheckpointPolicy, SnapshotCheckpointTarget, SnapshotDeleteObservation,
    SnapshotExecution, SnapshotJournal, SnapshotMutationObservation, SnapshotTracked, SnapshotVmObservation,
} from "../../domain/lifecycle/hyper-v-snapshots.js";

export type SnapshotIdentity = { executable: string; ownerId: string; deviceId: string; incarnationId: string; vmName: string; vmId: string };
export type SnapshotPublication = { found: boolean; matched: boolean; device: Record<string, unknown> | null };
export type SnapshotCreateOptions = {
    operationDeadlineAt: number;
    timeoutMilliseconds(): number;
    onCreatedId(id: string): undefined;
    onConfirmationDeadline(deadlineAt: number): undefined;
};
export type SnapshotRepairPatch = {
    snapshots: SnapshotTracked[]; activeSnapshotId: string | null; runtimeState: string; status: string;
};

/** Existing native authorities, scoped to one application invocation. */
export interface BrokerHyperVSnapshotPorts {
    executable(name: string): string | null;
    incarnation(device: Record<string, unknown>): string | null;
    validIncarnation(value: unknown): value is string;
    providerName(ownerId: string, snapshotName: string): string;
    ownershipNotes(ownerId: string, deviceId: string, incarnationId: string): string;
    journalExists(ownerId: string, backend: string, deviceId: string): boolean;
    readJournal(ownerId: string, backend: string, deviceId: string): SnapshotJournal | null;
    writeJournal(ownerId: string, backend: string, deviceId: string, incarnationId: string,
        tool: SnapshotJournal["tool"], snapshotName: string, providerName: string,
        snapshotId: string | undefined, policy: SnapshotCheckpointPolicy): undefined;
    recordCreatedId(ownerId: string, backend: string, deviceId: string, incarnationId: string, providerName: string, snapshotId: string): undefined;
    clearJournal(ownerId: string, backend: string, deviceId: string): undefined;
    removeRepairJournal(ownerId: string, backend: string, deviceId: string): undefined;
    status(identity: SnapshotIdentity, deadlineAt: number, timeoutMs: number): Promise<SnapshotExecution>;
    parseStatus(text: string): SnapshotVmObservation | null;
    observationMismatch(observation: SnapshotVmObservation | null, expected: { vmId: string; vmName: string; diskPath: string }): string | null;
    create(executable: string, target: SnapshotCheckpointTarget, options: SnapshotCreateOptions): Promise<SnapshotMutationObservation>;
    restore(executable: string, target: SnapshotCheckpointTarget, options: { force: boolean; startAfterRestore: boolean }): Promise<SnapshotMutationObservation>;
    delete(executable: string, target: SnapshotCheckpointTarget): Promise<SnapshotDeleteObservation>;
    repairPolicy(executable: string, target: { vmId: string; vmName: string; expectedNotes: string; providerName: string; expectedCheckpointPolicy: SnapshotCheckpointPolicy }): Promise<{ readonly checkpointPolicy: SnapshotCheckpointPolicy; readonly candidateCount: 0 | 1 }>;
    lastExecution(): SnapshotExecution | null;
    isValidationError(error: unknown): boolean;
    providerErrorCode(error: unknown): string | undefined;
    errorCode(error: unknown, fallback: string): string;
    diagnosticCode(execution: { error?: string; stdout?: string; stderr?: string }, fallback: string): string;
    redactExecution(execution: SnapshotExecution, secretInput: boolean, fallback?: string): unknown;
    redactDevice(device: Record<string, unknown> | null): unknown;
    publish(ownerId: string, backend: string, deviceId: string, expected: Record<string, unknown>, replacement: Record<string, unknown>): SnapshotPublication;
    mergeRepair(ownerId: string, backend: string, deviceId: string, original: Record<string, unknown>, patch: SnapshotRepairPatch): Record<string, unknown>;
    forgetConsole(ownerId: string, backend: string, deviceId: string): undefined;
    sshReady(executable: string, target: { deviceRoot: string; privateRoot?: string; sshPrivateKeyPath: string; knownHostsPath: string; guestUsername: string; networkAddress: string }): Promise<SnapshotExecution>;
    remainingTimeout(deadlineAt: number, maximumMs: number): number;
    now(): number;
    timestamp(): string;
    sleep(milliseconds: number): Promise<void>;
}
