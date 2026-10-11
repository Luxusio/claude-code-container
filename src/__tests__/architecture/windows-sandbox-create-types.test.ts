import { describe, expect, it } from "vitest";
import { createWindowsSandboxCreate } from "../../../packages/device-lab/providers/application/lifecycle/windows-sandbox-create.mjs";
import type { WindowsSandboxCreatePorts } from "../../../packages/device-lab/providers/ports/lifecycle/windows-sandbox-create.mjs";
import { createBrokerWindowsSandboxCreate } from "../../../packages/device-lab/src/device-lab/application/lifecycle/windows-sandbox-create.js";
import type { BrokerWindowsSandboxCreatePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/windows-sandbox-create.js";

function contracts(direct: WindowsSandboxCreatePorts<{ scratch: string }>, broker: BrokerWindowsSandboxCreatePorts<{ name: string }, { id: string; createdAt: string }>) {
    const sync = createWindowsSandboxCreate(direct).create({ backend: "windows-sandbox" });
    if (sync.kind === "created") { const scratch: string = sync.device.helper.scratch; const stopped: "stopped" = sync.device.status; void [scratch, stopped]; }
    // @ts-expect-error Direct create is synchronous.
    const promise: Promise<unknown> = sync;
    // @ts-expect-error Semantic ports are required.
    createWindowsSandboxCreate({ readDefinitions: () => [] });
    // @ts-expect-error Definitions read must be synchronous.
    createWindowsSandboxCreate({ ...direct, readDefinitions: async () => [] });
    // @ts-expect-error Owner read must be synchronous.
    createWindowsSandboxCreate({ ...direct, readOwnerId: async () => "owner" });
    // @ts-expect-error Derived IDs are synchronous strings.
    createWindowsSandboxCreate({ ...direct, deriveDeviceId: async () => "id" });
    // @ts-expect-error Helper metadata cannot be a thenable.
    createWindowsSandboxCreate({ ...direct, ensureHelperWorkspace: async () => ({ scratch: "private" }) });
    // @ts-expect-error Claim must be synchronous.
    createWindowsSandboxCreate({ ...direct, claimDefinition: async () => ({ ok: true as const }) });
    const asyncResult = createBrokerWindowsSandboxCreate(broker).create({ name: "Sandbox" });
    const requiredPromise: Promise<unknown> = asyncResult; void requiredPromise;
    asyncResult.then(result => { if (result.kind === "claim-exception" || result.kind === "claim-conflict") {
        const attempted: false = result.rollback.attempted;
        const reason: "no-provider-resource-created" = result.rollback.reason;
        void [attempted, reason];
    } });
    // @ts-expect-error Parsed input retains the consumer's type.
    createBrokerWindowsSandboxCreate(broker).create({ name: 7 });
    // @ts-expect-error Broker create is asynchronous.
    const synchronous: { kind: string } = asyncResult;
    // @ts-expect-error Native record construction must return a typed record.
    createBrokerWindowsSandboxCreate({ ...broker, createRecord: (): unknown => ({}) });
    // @ts-expect-error No ambient port defaults.
    createBrokerWindowsSandboxCreate();
    // @ts-expect-error Native config publication is synchronous.
    createBrokerWindowsSandboxCreate({ ...broker, publishConfig: async () => "/config" });
    // @ts-expect-error Native compensation mutation is synchronous.
    createBrokerWindowsSandboxCreate({ ...broker, removeMatchingClaim: async () => [] });
    const { removeMatchingClaim, ...withoutCompensation } = broker;
    // @ts-expect-error Exact-generation config failure compensation is required.
    createBrokerWindowsSandboxCreate(withoutCompensation);
    void removeMatchingClaim;
    void [promise, synchronous];
}
describe("Sandbox create static public contracts", () => {
    it("makes the positive and negative strict type consumer reachable to architecture typecheck", () => { expect(contracts).toBeTypeOf("function"); });
});
