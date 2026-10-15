import type { SnapshotJournal } from "../../domain/lifecycle/hyper-v-snapshots.js";
import type { SnapshotPublication } from "./hyper-v-snapshots.js";
import type { AuxiliaryOutcome } from "../../domain/broker-owner-cleanup.js";
import type { HyperVStopDeleteRequest, HyperVOperationEvidence, HyperVReplayObservation, HyperVCommandExecution, HyperVTerminalResult, HyperVNetworkCleanupEvidence, HyperVArtifactEvidence, HyperVPublication, HyperVStateFailure, HyperVStopDeletePreparation } from "../../domain/lifecycle/hyper-v-stop-delete.js";
export interface HyperVStopDeletePorts<Connection,Receipt> {
    read(owner: string, state: string): unknown[];
    incarnation(device: Record<string, unknown>): string | null;
    validIncarnation(value: unknown): value is string;
    connection(provider:'powershell'):Connection|null;
    prepareStopDelete(owner:string,request:HyperVStopDeleteRequest,device:Record<string,unknown>):HyperVStopDeletePreparation<Connection>;
    readJournal(owner: string, backend: string, id: string): HyperVOperationEvidence | null;
    writeJournal(owner: string, request: HyperVStopDeleteRequest, capturedTarget?: Record<string, unknown>, deadline?: number): {
        ok: true;
        path: string;
    } | {
        ok: false;
        error: string;
    };
    clearJournal(owner: string, backend: string, id: string): undefined;
    readSnapshotJournal(owner: string, backend: string, id: string): SnapshotJournal | null;
    repairSnapshots(owner:string,backend:string,id:string,device:Record<string,unknown>,connection:Connection,parentDeadlineAt?:number):Promise<import('../../domain/lifecycle/hyper-v-snapshots.js').SnapshotRepairResult>;
    clearSnapshotJournal(owner: string, backend: string, id: string, capturedTarget: Record<string, unknown>, capturedJournal: SnapshotJournal, deadline: number): SnapshotPublication;
    replayObservation(connection:Connection, owner: string, journal: HyperVOperationEvidence, media: string[], deadline: number): Promise<HyperVReplayObservation>;
    replayPower(connection:Connection, owner: string, journal: HyperVOperationEvidence, action: "start" | "stop", turnOff: boolean, deadline: number): Promise<void>;
    replayRemoveVm(connection:Connection, owner: string, journal: HyperVOperationEvidence, media: string[], deadline: number): Promise<void>;
    removeHostFiles(connection:Connection, root: string, paths: string[], checkpointDirectory: string | undefined, deadline: number): Promise<void>;
    deviceRoot(owner: string, backend: string, id: string): string;
    windowsDirectory(path: string): string;
    replayPublish(owner: string, backend: string, id: string, replacement: Record<string, unknown> | null): undefined;
    cleanupAuxiliary(owner: string, request: HyperVStopDeleteRequest, expected: unknown): AuxiliaryOutcome;
    clone(value: unknown): unknown;
    executeStop(owner: string, request: HyperVStopDeleteRequest, device: Record<string, unknown>, connection:Connection, deadline: number): Promise<HyperVTerminalResult<Receipt>>;
    executeDelete(owner: string, request: HyperVStopDeleteRequest, device: Record<string, unknown>, connection:Connection, deadline: number): Promise<HyperVTerminalResult<Receipt>>;
    samePath(left: string, right: string): boolean;
    releaseNetwork(owner: string, id: string, incarnation: string | null, deadline: number, preserve: boolean): Promise<HyperVNetworkCleanupEvidence>;
    cleanupArtifacts(owner: string, backend: string, id: string): HyperVArtifactEvidence;
    publish(owner: string, state: string, id: string, expected: unknown, replace: (current: Record<string, unknown>) => unknown): HyperVPublication;
    stateErrorCode(error: unknown): string | null;
    stateFailure(error: unknown, request: {
        backend: string;
        stateKey: string;
    }): HyperVStateFailure;
    errorCode(error: unknown, fallback: string): string;
    diagnosticCode(execution: HyperVCommandExecution<Receipt>, fallback: string): string | undefined;
    assertDeadline(deadline: number): undefined;
    deadlineExpired(deadline: number): boolean;
    timestamp(): string;
}
