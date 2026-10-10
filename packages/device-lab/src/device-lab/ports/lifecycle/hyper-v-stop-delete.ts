import type { SnapshotJournal } from "../../domain/lifecycle/hyper-v-snapshots.js";
import type { AuxiliaryOutcome } from "../../domain/broker-owner-cleanup.js";
import type { HyperVStopDeleteRequest, HyperVOperationEvidence, HyperVReplayObservation, HyperVCommandDescriptor, HyperVCommandExecution, HyperVTerminalObservation, HyperVCleanupEvidence, HyperVArtifactEvidence, HyperVPublication, HyperVStopDeleteResponse } from "../../domain/lifecycle/hyper-v-stop-delete.js";
export interface HyperVStopDeletePorts {
    read(owner: string, state: string): unknown[];
    incarnation(device: Record<string, unknown>): string | null;
    validIncarnation(value: unknown): value is string;
    executable(name: string): string | null;
    descriptor(owner: string, request: HyperVStopDeleteRequest, device: Record<string, unknown>): HyperVCommandDescriptor | {
        error: string;
        missing: string[];
    };
    readJournal(owner: string, backend: string, id: string): HyperVOperationEvidence | null;
    writeJournal(owner: string, request: HyperVStopDeleteRequest): {
        ok: true;
        path: string;
    } | {
        ok: false;
        error: string;
    };
    clearJournal(owner: string, backend: string, id: string): undefined;
    readSnapshotJournal(owner: string, backend: string, id: string): SnapshotJournal | null;
    repairSnapshots(owner: string, backend: string, id: string, device: Record<string, unknown>, executable: string): Promise<{
        ok: true;
        device: Record<string, unknown>;
        reconciled: boolean;
    } | {
        ok: false;
        status: number;
        error: string;
        detail?: string;
    }>;
    clearSnapshotJournal(owner: string, backend: string, id: string): undefined;
    replayObservation(executable: string, owner: string, journal: HyperVOperationEvidence, media: string[], deadline: number): Promise<HyperVReplayObservation>;
    replayPower(executable: string, owner: string, journal: HyperVOperationEvidence, action: "start" | "stop", turnOff: boolean, deadline: number): Promise<void>;
    replayRemoveVm(executable: string, owner: string, journal: HyperVOperationEvidence, media: string[], deadline: number): Promise<void>;
    removeHostFiles(executable: string, root: string, paths: string[], checkpointDirectory: string | undefined, deadline: number): Promise<void>;
    deviceRoot(owner: string, backend: string, id: string): string;
    windowsDirectory(path: string): string;
    replayPublish(owner: string, backend: string, id: string, replacement: Record<string, unknown> | null): undefined;
    cleanupAuxiliary(owner: string, request: HyperVStopDeleteRequest, expected: unknown): AuxiliaryOutcome;
    clone(value: unknown): unknown;
    executeStop(owner: string, request: HyperVStopDeleteRequest, device: Record<string, unknown>, executable: string, deadline: number): Promise<HyperVCommandExecution>;
    executeDelete(owner: string, request: HyperVStopDeleteRequest, device: Record<string, unknown>, executable: string, deadline: number): Promise<HyperVCommandExecution>;
    parseObservation(stdout: string, deleting: boolean): HyperVTerminalObservation | null;
    samePath(left: string, right: string): boolean;
    releaseNetwork(owner: string, id: string, incarnation: string | null, deadline: number, preserve: boolean): Promise<HyperVCleanupEvidence>;
    cleanupArtifacts(owner: string, backend: string, id: string): HyperVArtifactEvidence;
    publicNetwork(value: unknown): Record<string, unknown> | null;
    publicArtifacts(value: unknown): Record<string, unknown> | null;
    publish(owner: string, state: string, id: string, expected: unknown, replace: (current: Record<string, unknown>) => unknown): HyperVPublication;
    redactDevice(device: unknown): unknown;
    redactResult(result: unknown): Record<string, unknown>;
    redactExecution(execution: HyperVCommandExecution, fallback?: string): Record<string, unknown>;
    stateErrorCode(error: unknown): string | null;
    stateFailure(error: unknown, request: {
        backend: string;
        stateKey: string;
    }): HyperVStopDeleteResponse;
    errorCode(error: unknown, fallback: string): string;
    diagnosticCode(execution: HyperVCommandExecution, fallback: string): string | undefined;
    assertDeadline(deadline: number): undefined;
    deadlineExpired(deadline: number): boolean;
    timestamp(): string;
}
