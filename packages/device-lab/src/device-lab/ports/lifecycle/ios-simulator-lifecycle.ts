import type { BrokerIosLifecycleRequest, BrokerIosProviderCommand, BrokerIosProviderResult, BrokerIosPlannedCommand, BrokerIosClaim, BrokerIosPublication, BrokerIosPublicationChange } from "../../domain/lifecycle/ios-simulator-lifecycle.js";
export interface BrokerIosAuxiliaryCleanup {
    result: { ok: boolean; changed: boolean; stateConflict?: boolean; appium: Record<string, unknown>; recording: Record<string, unknown>; minimizeWatchdog: Record<string, unknown> };
    device: unknown; committed: boolean;
}
/** Fixed native leaves; operation and compensation ordering belong to the application. */
export interface BrokerIosSimulatorLifecyclePorts {
    readonly execute: (command: BrokerIosProviderCommand, options: { timeoutMs: number; outputLimit: number }) => BrokerIosProviderResult;
    readonly executable: (name: "xcrun") => string | null;
    readonly timestamp: () => string;
    readonly claimDefinition: (ownerId: string, parsed: BrokerIosLifecycleRequest, device: Record<string, unknown>) => BrokerIosClaim;
    readonly cleanupAuxiliary: (ownerId: string, parsed: BrokerIosLifecycleRequest, expected: unknown) => BrokerIosAuxiliaryCleanup;
    readonly publish: (ownerId: string, stateKey: string, deviceId: string, expected: unknown, change: BrokerIosPublicationChange) => BrokerIosPublication;
    readonly redactDevice: (device: unknown) => unknown;
    readonly stateErrorCode: (error: unknown) => string | null;
    readonly stateFailure: (error: unknown, parsed: BrokerIosLifecycleRequest) => { status: number; payload: Record<string, unknown> };
    readonly failureDetail: (result: BrokerIosProviderResult) => string;
    readonly commandTimeoutMs: number;
    readonly outputLimit: number;
    readonly createCommand: (input: { simulatorName: string; ownerPrefix: string; deviceType: unknown; runtime: unknown; executable: string | null }) => BrokerIosPlannedCommand;
    readonly createdUdid: (stdout: unknown) => string | null;
    readonly deleteCommand: (executable: string, udid: string) => BrokerIosProviderCommand;
    readonly verifyOwnedTarget: (ownerId: string, device: unknown) => { ok: true; target: string } | { ok: false; error: string; missing: string[] };
}
