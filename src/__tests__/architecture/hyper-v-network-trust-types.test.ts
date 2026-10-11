import { describe, expect, it } from "vitest";
import { createHyperVNetworkTrust } from "../../../packages/device-lab/src/device-lab/application/hyper-v-network-trust.js";
import type { HyperVNetworkRelease, HyperVNetworkAllocationResult, HyperVNetworkFabricResult } from "../../../packages/device-lab/src/device-lab/domain/hyper-v-network-trust.js";
import type { HyperVNetworkStatePorts, HyperVHostNetworkPorts, HyperVHostEnsureRequest, HyperVNetworkPorts, HyperVFabricEffects } from "../../../packages/device-lab/src/device-lab/ports/hyper-v-network-trust.js";

function stateContracts(ports: HyperVNetworkStatePorts) {
    const result: HyperVNetworkRelease = createHyperVNetworkTrust(ports).release("owner", "guest", "incarnation");
    const { writeState, ...withoutPublication } = ports;
    // @ts-expect-error allocation publication is a required consumed capability
    createHyperVNetworkTrust(withoutPublication);
    const { assertTrustPath, ...withoutTrustFence } = ports;
    // @ts-expect-error trust mutation requires native path authority
    createHyperVNetworkTrust(withoutTrustFence);
    const { ed25519Identity, ...withoutIdentity } = ports;
    // @ts-expect-error native key decoding and fingerprint evidence are required
    createHyperVNetworkTrust(withoutIdentity);
    // @ts-expect-error state reads must complete synchronously
    createHyperVNetworkTrust({ ...ports, readState: async () => null });
    // @ts-expect-error allocation publication must complete synchronously
    createHyperVNetworkTrust({ ...ports, writeState: async () => undefined });
    // @ts-expect-error trust file publication must complete synchronously
    createHyperVNetworkTrust({ ...ports, writeTrustText: async () => undefined });
    // @ts-expect-error guarded trust observations are synchronous
    createHyperVNetworkTrust({ ...ports, readTrustText: async () => null });
    void [result, writeState, assertTrustPath, ed25519Identity];
}

function hostContracts(ports: HyperVHostNetworkPorts, request: HyperVHostEnsureRequest) {
    const pending = createHyperVNetworkTrust(ports).ensureHost(request);
    const { withAdministrator, ...withoutAdministrator } = ports;
    // @ts-expect-error native elevation must remain an explicit required resource scope
    createHyperVNetworkTrust(withoutAdministrator);
    const { execute, ...withoutExecution } = ports.standard;
    // @ts-expect-error prepared native action execution is required
    createHyperVNetworkTrust({ ...ports, standard: withoutExecution });
    // @ts-expect-error deadline clock observations cannot be deferred
    createHyperVNetworkTrust({ ...ports, now: async () => 0 });
    void [pending, withAdministrator, execute];
}
void [stateContracts, hostContracts];

function allocationContracts(ports: HyperVNetworkPorts, effects: Extract<HyperVFabricEffects, { kind: "legacy-compatibility" }>): void {
    const application = createHyperVNetworkTrust(ports);
    const allocated: Promise<HyperVNetworkAllocationResult> = application.allocate("owner", "guest", "incarnation", 100000);
    const fabric: Promise<HyperVNetworkFabricResult> = application.ensureFabric(100000);
    const { cleanup, ...withoutCleanup } = effects;
    // @ts-expect-error Final allocation release requires its individual native cleanup effect.
    createHyperVNetworkTrust({ ...ports, hostFabric: withoutCleanup });
    const { inspectAllocation, ...withoutInspection } = effects;
    // @ts-expect-error Orphan reconciliation requires native allocation identity observations.
    createHyperVNetworkTrust({ ...ports, hostFabric: withoutInspection });
    // @ts-expect-error A native ensure effect returns its settled asynchronous observation.
    createHyperVNetworkTrust({ ...ports, hostFabric: { ...effects, ensure: () => ({ kind: "completed", observation: null, receipt: {} }) } });
    // @ts-expect-error Provider admission must be decided before effects, not remain pending.
    createHyperVNetworkTrust({ ...ports, available: async () => true });
    void [allocated, fabric, cleanup, inspectAllocation];
}
void allocationContracts;


describe("Hyper-V network trust typed state consumer", () => {
    it("reports an absent allocation state without publishing or removing storage", () => {
        const unexpected = (): never => { throw new Error("absent-state-must-not-mutate"); };
        const ports: HyperVNetworkStatePorts = {
            kind: "state", readState: () => null, readIntent: () => null,
            writeState: unexpected, writeIntent: unexpected, removeState: unexpected, removeIntent: unexpected,
            ensureStateRoot: unexpected, assertStateRoot: unexpected,
            revision: unexpected, boundedError: (_error, fallback) => fallback,
            assertTrustPath: unexpected, readTrustText: unexpected, writeTrustText: unexpected, ed25519Identity: unexpected,
        };
        const result: HyperVNetworkRelease = createHyperVNetworkTrust(ports).release("owner", "guest");
        expect(result).toEqual({ ok: true, released: false, statePresent: false, remaining: 0 });
    });
});
