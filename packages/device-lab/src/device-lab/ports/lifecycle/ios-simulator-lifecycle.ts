import type {BrokerIosLifecycleRequest, BrokerIosProviderResult, BrokerIosCreateResult, BrokerIosPlannedCommand, BrokerIosClaim, BrokerIosPublication, BrokerIosPublicationChange, BrokerIosAuxiliaryFacts, BrokerIosShutdownObservation, BrokerIosConditionalShutdownExecution} from "../../domain/lifecycle/ios-simulator-lifecycle.js";
export interface BrokerIosAuxiliaryCleanup {result: BrokerIosAuxiliaryFacts; device: unknown; committed: boolean;}
/** One prepared native effect at a time; eligibility, publication and recovery stay inward. */
export interface BrokerIosSimulatorLifecyclePorts<Effect> {
    readonly execute: (effect: Effect, options: {timeoutMs: number; outputLimit: number}) => BrokerIosProviderResult;
    readonly executeCreate: (effect: Effect, options: {timeoutMs: number; outputLimit: number}) => BrokerIosCreateResult;
    readonly executeShutdownIfCurrent: (ownerId: string, parsed: BrokerIosLifecycleRequest, expected: unknown, effect: Effect, options: {remainingMs: () => number; outputLimit: number}) => BrokerIosConditionalShutdownExecution;
    readonly observeShutdown: (effect: Effect, ownerId: string, device: unknown, options: {timeoutMs: number; outputLimit: number}) => BrokerIosShutdownObservation;
    readonly prepareCreate: (input: {simulatorName: string; ownerPrefix: string; deviceType: unknown; runtime: unknown}) => BrokerIosPlannedCommand<Effect>;
    readonly prepareExisting: (input: {parsed: BrokerIosLifecycleRequest; target: string}) => BrokerIosPlannedCommand<Effect>;
    readonly prepareDelete: (effect: Effect, target: string) => Effect;
    readonly timestamp: () => string;
    readonly claimDefinition: (ownerId: string, parsed: BrokerIosLifecycleRequest, device: Record<string,unknown>) => BrokerIosClaim;
    readonly cleanupAuxiliary: (ownerId: string, parsed: BrokerIosLifecycleRequest, expected: unknown) => BrokerIosAuxiliaryCleanup;
    readonly publish: (ownerId: string, stateKey: string, deviceId: string, expected: unknown, change: BrokerIosPublicationChange, options?: {remainingMs: () => number}) => BrokerIosPublication;
    readonly stateErrorCode: (error: unknown) => string | null;
    readonly commandTimeoutMs: number;
    readonly outputLimit: number;
    readonly now: () => number;
    readonly sleep: (milliseconds: number) => Promise<void>;
    readonly verifyOwnedTarget: (ownerId: string, device: unknown) => {ok: true; target: string} | {ok: false; error: string; missing: string[]};
}
