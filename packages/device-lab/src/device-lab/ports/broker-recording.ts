import type {
    BrokerRecordingCommand, BrokerRecordingRequest, BrokerRecordingResponse,
    BrokerRecordingTarget,
} from "../domain/broker-recording.js";

export type BrokerRecordingExecution = {
    status?: number | null;
    error?: string;
    pid?: number;
    processIdentity?: unknown;
    [field: string]: unknown;
};
export type BrokerRecordingTransition = {
    found: boolean;
    matched: boolean;
    currentRecording: unknown;
    device: Record<string, unknown> | null;
};
export type BrokerRecordingSignal = {
    attempted: boolean;
    ok: boolean;
    stale?: boolean;
    [field: string]: unknown;
};

/** Existing native authorities; no capability replaces a complete recording workflow. */
export interface BrokerRecordingPorts {
    findTarget(ownerId: string, request: BrokerRecordingRequest): BrokerRecordingTarget | BrokerRecordingResponse;
    heartbeat(ownerId: string, target: BrokerRecordingTarget, deviceId: string): BrokerRecordingResponse | null;
    observeProcess(identity: unknown, pid: number): { status: "match" | "mismatch" | "exited" | "unavailable" };
    publish(ownerId: string, stateKey: string, deviceId: string, expected: unknown, replacement: Record<string, unknown> | null): BrokerRecordingTransition;
    executable(name: string): string;
    resolveIosTarget(ownerId: string, device: Record<string, unknown>): { ok: true; target: string } | { ok: false; error: string; missing?: unknown };
    localPath(ownerId: string, stateKey: string, deviceId: string, extension: string): string;
    prepareOutput(path: string): undefined;
    launch(command: BrokerRecordingCommand, label: string): Promise<BrokerRecordingExecution>;
    execute(command: BrokerRecordingCommand): BrokerRecordingExecution;
    signal(recording: Record<string, unknown>, signal: "SIGINT"): BrokerRecordingSignal;
    waitForExit(pid: unknown, timeoutMs: number): Promise<boolean>;
    timestamp(): string;
    runtimeId(): string;
}
