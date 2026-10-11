import type { BrokerWindowsSandboxClaim } from "../../domain/lifecycle/windows-sandbox-create.js";

export interface BrokerWindowsSandboxCreatePorts<Input, Device extends {id?: unknown; createdAt?: unknown}> {
    readonly createRecord: (input: Input) => Device;
    readonly claimDefinition: (device: Device) => BrokerWindowsSandboxClaim<Device>;
    readonly publishConfig: (input: Input) => string;
    readonly removeMatchingClaim: (id: unknown, createdAt: unknown) => unknown[];
}
