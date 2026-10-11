import type { BrokerWindowsSandboxClaim, BrokerWindowsSandboxCreateOutcome, BrokerWindowsSandboxCreateRollback } from "../../domain/lifecycle/windows-sandbox-create.js";
import type { BrokerWindowsSandboxCreatePorts } from "../../ports/lifecycle/windows-sandbox-create.js";

/** Native exceptions retain their identity and existing catch boundaries. */
export function createBrokerWindowsSandboxCreate<Input, Device extends {id?: unknown; createdAt?: unknown}>(
    ports: BrokerWindowsSandboxCreatePorts<Input, Device>,
) {
    for (const name of ["createRecord", "claimDefinition", "publishConfig", "removeMatchingClaim"] as const) {
        if (!ports || typeof ports[name] !== "function") throw new TypeError(`Broker Windows Sandbox create requires ${name}`);
    }
    async function create(input: Input): Promise<BrokerWindowsSandboxCreateOutcome<Device>> {
        const device = ports.createRecord(input);
        let claim: BrokerWindowsSandboxClaim<Device>;
        try {
            claim = ports.claimDefinition(device);
        } catch (error) {
            const rollback: BrokerWindowsSandboxCreateRollback = { attempted: false, ok: true, reason: "no-provider-resource-created" };
            return { kind: "claim-exception", error, rollback };
        }
        if (!claim.ok) {
            const rollback: BrokerWindowsSandboxCreateRollback = { attempted: false, ok: true, reason: "no-provider-resource-created" };
            return { kind: "claim-conflict", claim, rollback };
        }
        try {
            ports.publishConfig(input);
        } catch (error) {
            ports.removeMatchingClaim(device.id, device.createdAt);
            return { kind: "config-failure", error };
        }
        return { kind: "created", device };
    }
    return { create };
}
