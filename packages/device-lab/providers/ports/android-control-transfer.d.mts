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
export type AndroidControlObservation = { ok: boolean; evidence: unknown };
export interface AndroidControlTransferPorts<Target, InputStage, OutputStage> {
    target(deviceId: unknown): TargetObservation<Target>;
    tap(target: Target, point: Point): AndroidControlObservation;
    swipe(target: Target, swipe: Swipe): AndroidControlObservation;
    typeText(target: Target, text: unknown): AndroidControlObservation;
    key(target: Target, key: unknown): AndroidControlObservation;
    navigate(target: Target, navigation: AndroidNavigation): AndroidControlObservation;
    disableAutoRotation(target: Target): AndroidControlObservation;
    setOrientation(target: Target, orientation: AndroidOrientation): AndroidControlObservation;
    upload(target: Target, localPath: string, remotePath: string, timeoutMs: number): AndroidControlObservation;
    download(target: Target, remotePath: string, localPath: string, timeoutMs: number): AndroidControlObservation;
    guestPath(value: unknown, label: "upload-remote-path" | "download-remote-path"): PathObservation;
    stageInput(value: unknown): StageObservation<InputStage>;
    stageOutput(value: unknown): StageObservation<OutputStage>;
    commitOutput(stage: OutputStage): PathObservation;
    disposeInput(stage: InputStage): undefined;
    disposeOutput(stage: OutputStage): undefined;
}
export type Point = import("../domain/android-control-transfer.mjs").Point;
export type Swipe = import("../domain/android-control-transfer.mjs").Swipe;
export type AndroidNavigation = import("../domain/android-control-transfer.mjs").Navigation;
export type AndroidOrientation = import("../domain/android-control-transfer.mjs").Orientation;
export type AndroidControlCompletion = import("../domain/android-control-transfer.mjs").Completion;
export type AndroidControlOutcome =
    | { kind: "completed"; completion: AndroidControlCompletion; evidence: unknown }
    | { kind: "text"; message: string }
    | { kind: "command-failure"; evidence: unknown };
export type AndroidActionPlan = import("../domain/android-control-transfer.mjs").Plan;
