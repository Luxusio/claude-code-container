import type { BrokerAndroidClaim, BrokerAndroidLifecycleRequest, BrokerAndroidProviderResult, BrokerAndroidPublication, BrokerAndroidAuxiliaryCleanup, BrokerAndroidFailureReason, BrokerAndroidPreparation } from "../../domain/lifecycle/android-emulator-lifecycle.js";

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
    readonly livePorts: () => BrokerAndroidLivePorts;
}

export type {BrokerAndroidAuxiliaryCleanup} from "../../domain/lifecycle/android-emulator-lifecycle.js";

/** Each port performs a native step; lifecycle ordering belongs to the application. */
export interface BrokerAndroidEmulatorLifecyclePorts<Effect, Receipt> {
    readonly executePrepared: (effect: Effect, options: {timeoutMs: number; outputLimit: number}) => BrokerAndroidProviderResult<Receipt>;
    readonly metadataObservation: (purpose: "create" | "delete-artifacts" | "delete-metadata", options: {timeoutMs: number; outputLimit: number}) => BrokerAndroidProviderResult<Receipt>;
    readonly prepareStopInventory: () => {kind: "ready"; effect: Effect} | {kind: "unavailable"};
    readonly prepareBootProbe: (serial: string | null) => {kind: "ready"; effect: Effect} | {kind: "unavailable"; observation: BrokerAndroidProviderResult<Receipt>};
    readonly now: () => number;
    readonly sleep: (milliseconds: number) => undefined;
    readonly timestamp: () => string;
    readonly avdHome: () => string;
    readonly validPort: (port: unknown) => boolean;
    readonly livePorts: () => BrokerAndroidLivePorts;
    readonly liveAvds: () => BrokerAndroidLiveAvds;
    readonly avdProcesses: (name: string, timeoutMs?: number, registeredName?: boolean) => BrokerAndroidAvdProcesses;
    readonly ownedAvdName: (name: string, ownerId: string) => boolean;
    readonly approvedAvdRoot: (recordedRoot: unknown) => string | null;
    readonly avdArtifacts: (ownerId: string, root: string) => { name: string }[];
    readonly removeAvdArtifacts: (name: string, ownerId: string, root: string, verifyInactive: () => boolean) => { removed: unknown };
    readonly claimDefinition: (ownerId: string, parsed: BrokerAndroidLifecycleRequest, device: Record<string, unknown>) => BrokerAndroidClaim;
    readonly cleanupAuxiliary: (ownerId: string, parsed: BrokerAndroidLifecycleRequest, expectedDevice: unknown) => BrokerAndroidAuxiliaryCleanup;
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
