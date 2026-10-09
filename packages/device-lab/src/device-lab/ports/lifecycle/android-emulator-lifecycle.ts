import type { BrokerAndroidClaim, BrokerAndroidLifecycleRequest, BrokerAndroidProviderCommand, BrokerAndroidProviderResult, BrokerAndroidPublication } from "../../domain/lifecycle/android-emulator-lifecycle.js";

export type BrokerAndroidLivePorts =
    | { ok: true; ports: Set<number> }
    | { ok: false; status: number; error: string; detail: string };
export type BrokerAndroidLiveAvds =
    | { ok: true; names: Set<string> }
    | { ok: false; status: number; detail: string };
export type BrokerAndroidAvdProcesses =
    | { ok: true; active: boolean }
    | { ok: false; status: number; error: string; detail: string };

export type BrokerAndroidCreatePortAllocation =
    | { ok: true; port: number }
    | { ok: false; status: number; error: string; allowed?: string; detail?: string };

export interface BrokerAndroidCreatePortAllocationPorts {
    readonly previewAllocation: (ownerId: string, parsed: BrokerAndroidLifecycleRequest, additionalUsedPorts?: Iterable<number>) => BrokerAndroidCreatePortAllocation;
    readonly livePorts: () => BrokerAndroidLivePorts;
}

export interface BrokerAndroidAuxiliaryCleanup {
    result: {
        ok: boolean;
        changed: boolean;
        stateConflict?: boolean;
        appium: Record<string, unknown>;
        recording: Record<string, unknown>;
        minimizeWatchdog: Record<string, unknown>;
    };
    device: unknown;
    committed: boolean;
}

/** Each port performs a native step; lifecycle ordering belongs to the application. */
export interface BrokerAndroidEmulatorLifecyclePorts {
    readonly execute: (command: BrokerAndroidProviderCommand, options: { timeoutMs: number; outputLimit: number }) => BrokerAndroidProviderResult;
    readonly executable: (name: string) => string | null;
    readonly now: () => number;
    readonly sleep: (milliseconds: number) => void;
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
    readonly redactDevice: (device: unknown) => unknown;
    readonly stateErrorCode: (error: unknown) => string | null;
    readonly stateFailure: (error: unknown, parsed: BrokerAndroidLifecycleRequest) => { status: number; payload: unknown };
    readonly failureDetail: (result: BrokerAndroidProviderResult) => string;
    readonly commandTimeoutMs: number;
    readonly outputLimit: number;
}
