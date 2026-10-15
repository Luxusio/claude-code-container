import type {BrokerRecordingRequest, BrokerRecordingTarget, BrokerRecordingRefusal, BrokerRecordingExecution, BrokerRecordingSignal} from "../domain/broker-recording.js";
export type {BrokerRecordingExecution, BrokerRecordingSignal} from "../domain/broker-recording.js";
export type BrokerRecordingTransition = {found: boolean; matched: boolean; currentRecording: unknown; device: Record<string, unknown> | null};
export type BrokerRecordingArtifactContext = {ownerId: string; target: BrokerRecordingTarget; recording: Record<string, unknown>};
/** Individual guarded native effects return settled success/refusal facts and opaque receipts. */
export interface BrokerRecordingPorts {
    findTarget(ownerId: string, request: BrokerRecordingRequest): BrokerRecordingTarget | BrokerRecordingRefusal;
    heartbeat(ownerId: string, target: BrokerRecordingTarget, deviceId: string): BrokerRecordingRefusal | null;
    observeProcess(identity: unknown, pid: number): {status: "match" | "mismatch" | "exited" | "unavailable"};
    publish(ownerId: string, stateKey: string, deviceId: string, expected: unknown, replacement: Record<string, unknown> | null, target: BrokerRecordingTarget): BrokerRecordingTransition;
    resolveIosTarget(ownerId: string, device: Record<string, unknown>): {ok: true; target: string} | {ok: false; error: string; missing?: unknown};
    localPath(ownerId: string, stateKey: string, deviceId: string, extension: string): string;
    prepareOutput(path: string): undefined;
    launchAndroidRecording(serial: string, remotePath: string, timeLimitSec: number, localPath: string, label: string): Promise<BrokerRecordingExecution>;
    launchIosRecording(udid: string, localPath: string, label: string): Promise<BrokerRecordingExecution>;
    stopAndroidRecording(context: BrokerRecordingArtifactContext, serial: string): BrokerRecordingExecution;
    pullAndroidRecording(context: BrokerRecordingArtifactContext, serial: string, remotePath: string, localPath: string): BrokerRecordingExecution;
    removeAndroidRecording(context: BrokerRecordingArtifactContext, serial: string, remotePath: string): BrokerRecordingExecution;
    signal(recording: Record<string, unknown>, signal: "SIGINT", context?: BrokerRecordingArtifactContext): BrokerRecordingSignal;
    waitForExit(pid: unknown, timeoutMs: number): Promise<boolean>;
    timestamp(): string;
    runtimeId(): string;
}
