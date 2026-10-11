import type {BrokerIosLifecycleRequest, BrokerIosProviderResult, BrokerIosPlannedCommand, BrokerIosClaim, BrokerIosPublication, BrokerIosPublicationChange, BrokerIosAuxiliaryFacts} from "../../domain/lifecycle/ios-simulator-lifecycle.js";
export interface BrokerIosAuxiliaryCleanup {result: BrokerIosAuxiliaryFacts; device: unknown; committed: boolean;}
/** One prepared native effect at a time; eligibility, publication and recovery stay inward. */
export interface BrokerIosSimulatorLifecyclePorts<Effect> {
    readonly execute: (effect: Effect, options: {timeoutMs: number; outputLimit: number}) => BrokerIosProviderResult;
    readonly prepareCreate: (input: {simulatorName: string; ownerPrefix: string; deviceType: unknown; runtime: unknown}) => BrokerIosPlannedCommand<Effect>;
    readonly prepareExisting: (input: {parsed: BrokerIosLifecycleRequest; target: string}) => BrokerIosPlannedCommand<Effect>;
    readonly prepareDelete: (effect: Effect, target: string) => Effect;
    readonly timestamp: () => string;
    readonly claimDefinition: (ownerId: string, parsed: BrokerIosLifecycleRequest, device: Record<string,unknown>) => BrokerIosClaim;
    readonly cleanupAuxiliary: (ownerId: string, parsed: BrokerIosLifecycleRequest, expected: unknown) => BrokerIosAuxiliaryCleanup;
    readonly publish: (ownerId: string, stateKey: string, deviceId: string, expected: unknown, change: BrokerIosPublicationChange) => BrokerIosPublication;
    readonly stateErrorCode: (error: unknown) => string | null;
    readonly commandTimeoutMs: number;
    readonly outputLimit: number;
    readonly createdUdid: (stdout: unknown) => string | null;
    readonly verifyOwnedTarget: (ownerId: string, device: unknown) => {ok: true; target: string} | {ok: false; error: string; missing: string[]};
}
