import type {BrokerMacosLifecycleRequest, BrokerMacosProviderResult, BrokerMacosIpObservation, BrokerMacosPlannedCommand, BrokerMacosClaim, BrokerMacosPublication, BrokerMacosPublicationChange, BrokerMacosAuxiliaryFacts, BrokerMacosMetadataPurpose} from "../../domain/lifecycle/macos-vm-lifecycle.js";
export interface BrokerMacosAuxiliaryCleanup {result: BrokerMacosAuxiliaryFacts; device: unknown; committed: boolean;}
/** One prepared native effect at a time; eligibility, publication and recovery stay inward. */
export interface BrokerMacosVmLifecyclePorts<Effect> {
    readonly execute: (effect: Effect, options: {timeoutMs: number; outputLimit: number; remainingMs?: () => number}) => BrokerMacosProviderResult | Promise<BrokerMacosProviderResult>;
    readonly executeMetadata: (purpose: BrokerMacosMetadataPurpose, options: {timeoutMs: number; outputLimit: number}) => BrokerMacosProviderResult | Promise<BrokerMacosProviderResult>;
    readonly prepareCreate: (input: {provider: string; image: string; instance: string}) => BrokerMacosPlannedCommand<Effect>;
    readonly prepareExisting: (input: {parsed: BrokerMacosLifecycleRequest; provider: string; instance: string; headless: boolean}) => BrokerMacosPlannedCommand<Effect>;
    readonly prepareDelete: (effect: Effect, target: string) => Effect;
    readonly timestamp: () => string;
    readonly runtimeId: () => string;
    readonly claimDefinition: (ownerId: string, parsed: BrokerMacosLifecycleRequest, device: Record<string,unknown>) => BrokerMacosClaim;
    readonly cleanupAuxiliary: (ownerId: string, parsed: BrokerMacosLifecycleRequest, expected: unknown) => BrokerMacosAuxiliaryCleanup | Promise<BrokerMacosAuxiliaryCleanup>;
    readonly publish: (ownerId: string, stateKey: string, deviceId: string, expected: unknown, change: BrokerMacosPublicationChange) => BrokerMacosPublication;
    readonly stateErrorCode: (error: unknown) => string | null;
    readonly commandTimeoutMs: number;
    readonly createTimeoutMs?: number;
    readonly remainingMs?: () => number;
    readonly outputLimit: number;
    readonly now: () => number;
    readonly sleep: (milliseconds: number) => void | Promise<void>;
    readonly observeIp: (effect: Effect, instance: string, resolver: "default" | "arp", options: {timeoutMs: number; outputLimit: number}) => BrokerMacosIpObservation | Promise<BrokerMacosIpObservation>;
}
