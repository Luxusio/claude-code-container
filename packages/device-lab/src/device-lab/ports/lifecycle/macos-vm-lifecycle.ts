import type { BrokerMacosLifecycleRequest, BrokerMacosLifecycleResponse, BrokerMacosProviderCommand, BrokerMacosProviderResult, BrokerMacosClaim, BrokerMacosPublication, BrokerMacosPublicationChange } from "../../domain/lifecycle/macos-vm-lifecycle.js";
export interface BrokerMacosAuxiliaryCleanup {
    result: { ok: boolean; changed: boolean; stateConflict?: boolean; appium: Record<string, unknown>; recording: Record<string, unknown>; minimizeWatchdog: Record<string, unknown> };
    device: unknown; committed: boolean;
}
/** Fixed native leaves; operation and compensation ordering belong to the application. */
export interface BrokerMacosVmLifecyclePorts {
    readonly execute: (command: BrokerMacosProviderCommand, options: { timeoutMs: number; outputLimit: number }) => BrokerMacosProviderResult;
    readonly executable: (name: string) => string | null;
    readonly timestamp: () => string;
    readonly claimDefinition: (ownerId: string, parsed: BrokerMacosLifecycleRequest, device: Record<string, unknown>) => BrokerMacosClaim;
    readonly cleanupAuxiliary: (ownerId: string, parsed: BrokerMacosLifecycleRequest, expected: unknown) => BrokerMacosAuxiliaryCleanup;
    readonly publish: (ownerId: string, stateKey: string, deviceId: string, expected: unknown, change: BrokerMacosPublicationChange) => BrokerMacosPublication;
    readonly redactDevice: (device: unknown) => unknown;
    readonly stateErrorCode: (error: unknown) => string | null;
    readonly stateFailure: (error: unknown, parsed: BrokerMacosLifecycleRequest) => BrokerMacosLifecycleResponse;
    readonly failureDetail: (result: BrokerMacosProviderResult) => string;
    readonly commandTimeoutMs: number;
    readonly outputLimit: number;
    readonly now: () => number;
    readonly sleep: (milliseconds: number) => undefined;
}
