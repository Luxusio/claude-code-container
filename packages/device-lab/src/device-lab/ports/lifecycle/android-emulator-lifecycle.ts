import type { BrokerAndroidClaim, BrokerAndroidLifecycleRequest, BrokerAndroidProviderResult, BrokerAndroidPublication, BrokerAndroidAuxiliaryCleanup, BrokerAndroidFailureReason, BrokerAndroidPreparation, BrokerAndroidStopInventoryObservation, BrokerAndroidBootProbeObservation } from "../../domain/lifecycle/android-emulator-lifecycle.js";

export type BrokerAndroidLivePorts =
    | { ok: true; ports: Set<number> }
    | { ok: false; reason: BrokerAndroidFailureReason; error: string; detail: string };
export type BrokerAndroidLiveAvds =
    | { ok: true; names: Set<string> }
    | { ok: false; reason: BrokerAndroidFailureReason; detail: string };
export type BrokerAndroidAvdProcesses =
    | { ok: true; active: boolean }
    | { ok: false; reason: BrokerAndroidFailureReason; error: string; detail: string };

export type BrokerAndroidCreatePortAllocation =
    | { ok: true; port: number }
    | { ok: false; reason: BrokerAndroidFailureReason; error: string; allowed?: string; detail?: string };

export interface BrokerAndroidCreatePortAllocationPorts {
    readonly previewAllocation: (ownerId: string, parsed: BrokerAndroidLifecycleRequest, additionalUsedPorts?: Iterable<number>) => BrokerAndroidCreatePortAllocation;
    readonly livePorts: () => BrokerAndroidLivePorts | PromiseLike<BrokerAndroidLivePorts>;
}

export type {BrokerAndroidAuxiliaryCleanup} from "../../domain/lifecycle/android-emulator-lifecycle.js";

/** Native effects settle before the next lifecycle step; preparation and publication stay synchronous. */
export interface BrokerAndroidEmulatorLifecyclePorts<Effect, Receipt> {
    readonly executePrepared: (effect: Effect, options: {timeoutMs: number; outputLimit: number}) => BrokerAndroidProviderResult<Receipt> | PromiseLike<BrokerAndroidProviderResult<Receipt>>;
    readonly observeStopInventory: (effect: Effect, serial: string, options: {timeoutMs: number; outputLimit: number}) => BrokerAndroidStopInventoryObservation<Receipt> | PromiseLike<BrokerAndroidStopInventoryObservation<Receipt>>;
    readonly observeBootProbe: (effect: Effect, options: {timeoutMs: number; outputLimit: number}) => BrokerAndroidBootProbeObservation<Receipt> | PromiseLike<BrokerAndroidBootProbeObservation<Receipt>>;
    readonly metadataObservation: (purpose: "create" | "delete-artifacts" | "delete-metadata", options: {timeoutMs: number; outputLimit: number}) => BrokerAndroidProviderResult<Receipt> | PromiseLike<BrokerAndroidProviderResult<Receipt>>;
    readonly prepareStopInventory: () => {kind: "ready"; effect: Effect} | {kind: "unavailable"};
    readonly prepareBootProbe: (serial: string | null) => {kind: "ready"; effect: Effect} | {kind: "unavailable"; observation: BrokerAndroidProviderResult<Receipt>};
    readonly now: () => number;
    readonly sleep: (milliseconds: number) => undefined | PromiseLike<void>;
    readonly timestamp: () => string;
    readonly runtimeId: () => string;
    readonly avdHome: () => string;
    readonly validPort: (port: unknown) => boolean;
    readonly livePorts: () => BrokerAndroidLivePorts | PromiseLike<BrokerAndroidLivePorts>;
    readonly liveAvds: () => BrokerAndroidLiveAvds | PromiseLike<BrokerAndroidLiveAvds>;
    readonly avdProcesses: (name: string, timeoutMs?: number, registeredName?: boolean) => BrokerAndroidAvdProcesses | PromiseLike<BrokerAndroidAvdProcesses>;
    readonly ownedAvdName: (name: string, ownerId: string) => boolean;
    readonly approvedAvdRoot: (recordedRoot: unknown) => string | null;
    readonly avdArtifacts: (ownerId: string, root: string) => { name: string }[] | PromiseLike<{ name: string }[]>;
    readonly removeAvdArtifacts: (name: string, ownerId: string, root: string, verifyInactive: () => boolean | PromiseLike<boolean>) => { removed: unknown } | PromiseLike<{ removed: unknown }>;
    readonly claimDefinition: (ownerId: string, parsed: BrokerAndroidLifecycleRequest, device: Record<string, unknown>) => BrokerAndroidClaim;
    readonly cleanupAuxiliary: (ownerId: string, parsed: BrokerAndroidLifecycleRequest, expectedDevice: unknown) => BrokerAndroidAuxiliaryCleanup | PromiseLike<BrokerAndroidAuxiliaryCleanup>;
    readonly transition: (ownerId: string, parsed: BrokerAndroidLifecycleRequest, expectedDevice: unknown, replace: (current: Record<string, unknown>) => unknown) => BrokerAndroidPublication;
    readonly stateErrorCode: (error: unknown) => string | null;
    readonly commandTimeoutMs: number;
    readonly outputLimit: number;
}

/** Discovery is captured before existing-target validation, matching native exception order. */
export interface BrokerAndroidPreparationPorts<Runtime, Effect> {
    captureRuntime(): Runtime;
    ownedAvdName(name: string, ownerId: string): boolean;
    prepareCreate(request: {avdName: string; systemImage: string; deviceProfile?: string}): BrokerAndroidPreparation<Effect>;
    prepareStatus(runtime: Runtime, serial: string): BrokerAndroidPreparation<Effect>;
    prepareStop(runtime: Runtime, serial: string): BrokerAndroidPreparation<Effect>;
    prepareStart(runtime: Runtime, request: {avdName: string; port: number | null; headless: boolean}): BrokerAndroidPreparation<Effect>;
}
