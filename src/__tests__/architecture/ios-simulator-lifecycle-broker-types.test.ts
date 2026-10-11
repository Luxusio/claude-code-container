import { expect, it } from "vitest";
import { createBrokerIosSimulatorLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/ios-simulator-lifecycle.js";
import { brokerIosReplacement, type BrokerIosLifecycleInput, type BrokerIosLifecycleResponse, type BrokerIosProviderResult } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/ios-simulator-lifecycle.js";
import type { BrokerIosSimulatorLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/ios-simulator-lifecycle.js";

type Effect = { readonly token: unique symbol };

// Consumed by the normal strict compiler; this function is never invoked.
function contracts(ports: BrokerIosSimulatorLifecyclePorts<Effect>, input: BrokerIosLifecycleInput<Effect>, effect: Effect, outcome: BrokerIosLifecycleResponse<Effect>) {
    const app = createBrokerIosSimulatorLifecycle(ports);
    const outcomes: Promise<BrokerIosLifecycleResponse<Effect>>[] = [app.create(input), app.start(input), app.stop(input), app.delete(input)];
    const plan = app.planExisting(input.ownerId, input.parsed, input.expectedDevice);
    if (plan.kind === "ready") {
        const prepared: Effect = plan.effect;
        const result: BrokerIosProviderResult = ports.execute(prepared, { timeoutMs: 5000, outputLimit: 32768 });
        void result;
        // @ts-expect-error opaque native effects expose no process arguments
        prepared.args;
    }
    const deletion: Effect = ports.prepareDelete(effect, "owned");
    const { prepareCreate, ...withoutPreparation } = ports;
    // @ts-expect-error finite native preparation is required
    createBrokerIosSimulatorLifecycle(withoutPreparation);
    // @ts-expect-error preparation settles synchronously before execution
    createBrokerIosSimulatorLifecycle({ ...ports, prepareExisting: async () => ({ kind: "metadata-only" }) });
    // @ts-expect-error native effect observations are synchronous
    createBrokerIosSimulatorLifecycle({ ...ports, execute: async () => ({ mode: "exec", provider: "simctl", status: 0, receipt: null }) });
    // @ts-expect-error publication reports found and matched independently
    createBrokerIosSimulatorLifecycle({ ...ports, publish: () => ({ matched: true, device: null }) });
    // @ts-expect-error complete-record publication is synchronous
    createBrokerIosSimulatorLifecycle({ ...ports, publish: async () => ({ found: true, matched: true, device: null }) });
    // @ts-expect-error cleanup identifies committed expected-record advancement
    createBrokerIosSimulatorLifecycle({ ...ports, cleanupAuxiliary: () => ({ committed: true }) });
    // @ts-expect-error semantic outcomes have no HTTP status
    outcome.status;
    // @ts-expect-error semantic outcomes have no HTTP payload
    outcome.payload;
    // @ts-expect-error owned target verification is synchronous
    createBrokerIosSimulatorLifecycle({ ...ports, verifyOwnedTarget: async () => ({ ok: true, target: "udid" }) });
    void [outcomes, deletion, prepareCreate];
}
void contracts;

it("stops an iOS record without removing unrelated ownership metadata", () => {
    const device = { id: "owned", status: "running", udid: "owned-udid", ownerId: "owner", extra: { retained: true } };
    expect(brokerIosReplacement(device, { kind: "stop" })).toEqual({ ...device, status: "stopped" });
    expect(device.status).toBe("running");
});
