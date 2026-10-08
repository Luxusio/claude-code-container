import type { BrokerWindowsSandboxClaim } from "../../domain/lifecycle/windows-sandbox-create.js";

export interface BrokerWindowsSandboxCreatePorts<Input, Device extends {id?: unknown; createdAt?: unknown}, Rollback extends {ok: boolean}> {
    readonly createRecord: (input: Input) => Device;
    readonly claimDefinition: (device: Device) => BrokerWindowsSandboxClaim<Device>;
    readonly rollbackAfterClaimFailure: (device: Device, existing: Device | null) => Promise<Rollback>;
    readonly publishConfig: (input: Input) => string;
    readonly removeMatchingClaim: (id: unknown, createdAt: unknown) => unknown[];
    readonly stateErrorCode: (error: unknown) => string | null;
}
