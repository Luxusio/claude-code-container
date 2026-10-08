import type { BrokerWindowsSandboxClaim, BrokerWindowsSandboxCreateOutcome } from "../../domain/lifecycle/windows-sandbox-create.js";
import type { BrokerWindowsSandboxCreatePorts } from "../../ports/lifecycle/windows-sandbox-create.js";

/** Native exceptions retain their identity and existing catch boundaries. */
export function createBrokerWindowsSandboxCreate<Input, Device extends {id?: unknown; createdAt?: unknown}, Rollback extends {ok: boolean}>(
    ports: BrokerWindowsSandboxCreatePorts<Input, Device, Rollback>,
) {
    for (const name of ["createRecord", "claimDefinition", "rollbackAfterClaimFailure", "publishConfig", "removeMatchingClaim", "stateErrorCode"] as const) {
        if (!ports || typeof ports[name] !== "function") throw new TypeError(`Broker Windows Sandbox create requires ${name}`);
    }
    async function create(input: Input): Promise<BrokerWindowsSandboxCreateOutcome<Device, Rollback>> {
        const device = ports.createRecord(input);
        let claim: BrokerWindowsSandboxClaim<Device>;
        try {
            claim = ports.claimDefinition(device);
        } catch (error) {
            const rollback = await ports.rollbackAfterClaimFailure(device, null);
            return { kind: "claim-exception", error, rollback,
                ...(!rollback.ok ? {stateCode: ports.stateErrorCode(error) || "owner-state-write-failed"} : {}),
            };
        }
        if (!claim.ok) {
            const rollback = await ports.rollbackAfterClaimFailure(device, claim.existing);
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
