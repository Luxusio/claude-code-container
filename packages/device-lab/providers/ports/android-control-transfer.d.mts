export type AndroidControlOperation = import("../domain/android-control-transfer.mjs").Operation;
export type AndroidControlArguments = import("../domain/android-control-transfer.mjs").Arguments;
export type AndroidControlVariant = import("../domain/android-control-transfer.mjs").Variant;

export interface CommandReceipt {
    status: number | null;
    stdout?: string; stderr?: string;
    error?: { message: string }; signal?: string | null;
}
export type TargetObservation<Target> =
    | { kind: "unknown" }
    | { kind: "refused"; message: string }
    | { kind: "ready"; target: Target };
export type PathObservation = { ok: false; message: string } | { ok: true; path: string };
export type StageObservation<Stage> =
    | { ok: false; message: string }
    | { ok: true; path: string; stagedPath: string; handle: Stage };
export interface AndroidControlTransferPorts<Target, InputStage, OutputStage> {
    readonly variant: AndroidControlVariant;
    target(deviceId: unknown): TargetObservation<Target>;
    execute(target: Target, args: string[]): CommandReceipt;
    transfer(target: Target, args: string[], timeoutMs: number): CommandReceipt;
    guestPath(value: unknown, label: "upload-remote-path" | "download-remote-path"): PathObservation;
    stageInput(value: unknown): StageObservation<InputStage>;
    stageOutput(value: unknown): StageObservation<OutputStage>;
    commitOutput(stage: OutputStage): PathObservation;
    disposeInput(stage: InputStage): undefined;
    disposeOutput(stage: OutputStage): undefined;
}
export type Point = import("../domain/android-control-transfer.mjs").Point;
export type Swipe = import("../domain/android-control-transfer.mjs").Swipe;
export type ActionPayload = import("../domain/android-control-transfer.mjs").Payload;
export type TransferPayload = { provider: "adb" } & (
    { uploaded: { localPath: string; remotePath: string } }
    | { downloaded: { remotePath: string; localPath: string } }
);
export type AndroidControlPayload = (ActionPayload | TransferPayload) & {
    stdout?: string; stderr?: string; status?: number | null;
};
export type AndroidControlOutcome =
    | { kind: "json"; payload: AndroidControlPayload }
    | { kind: "text"; message: string }
    | { kind: "command-failure"; command: CommandReceipt };
export type AndroidActionPlan = import("../domain/android-control-transfer.mjs").Plan;

export type OrientationPayload = import("../domain/android-control-transfer.mjs").OrientationPayload;
