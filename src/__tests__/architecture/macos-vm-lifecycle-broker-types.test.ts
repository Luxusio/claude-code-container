import { expect, it } from "vitest";
import { createBrokerMacosVmLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/macos-vm-lifecycle.js";
import { brokerMacosReplacement, type BrokerMacosLifecycleInput, type BrokerMacosLifecycleResponse, type BrokerMacosProviderResult, type BrokerMacosIpObservation, type BrokerMacosPlannedCommand, type BrokerMacosClaim, type BrokerMacosPublication, type BrokerMacosPublicationChange } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/macos-vm-lifecycle.js";
import type { BrokerMacosVmLifecyclePorts, BrokerMacosAuxiliaryCleanup } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/macos-vm-lifecycle.js";

type Effect = { readonly token: unique symbol };

// Consumed by the normal strict compiler; this function is never invoked.
async function contracts(ports: BrokerMacosVmLifecyclePorts<Effect>, input: BrokerMacosLifecycleInput<Effect>, effect: Effect, outcome: BrokerMacosLifecycleResponse<Effect>) {
    const app = createBrokerMacosVmLifecycle(ports);
    const outcomes: Promise<BrokerMacosLifecycleResponse<Effect>>[] = [app.create(input), app.start(input), app.stop(input), app.delete(input)];
    const plan = app.planExisting(input.ownerId, input.parsed, input.expectedDevice);
    if (plan.kind === "ready") {
        const prepared: Effect = plan.effect;
        const result: BrokerMacosProviderResult = await ports.execute(prepared, { timeoutMs: 5000, outputLimit: 32768 });
        void result;
        // @ts-expect-error opaque native effects expose no process arguments
        prepared.args;
    }
    const deletion: Effect = ports.prepareDelete(effect, "owned");
    const { prepareCreate, ...withoutPreparation } = ports;
    // @ts-expect-error finite native preparation is required
    createBrokerMacosVmLifecycle(withoutPreparation);
    // @ts-expect-error preparation settles synchronously before execution
    createBrokerMacosVmLifecycle({ ...ports, prepareExisting: async () => ({ kind: "metadata-only", purpose: "definition-only" }) });
    // Finite native leaves can return immediate facts or await their own settlement.
    createBrokerMacosVmLifecycle({ ...ports, execute: async () => ({ ok: true, mode: "exec", provider: "tart", resourceMissing: false, receipt: null }) });
    createBrokerMacosVmLifecycle({ ...ports, executeMetadata: async () => ({ ok: true, mode: "noop", provider: "host-broker-state", resourceMissing: false, receipt: null }) });
    createBrokerMacosVmLifecycle({ ...ports, cleanupAuxiliary: async () => ({ committed: false, device: input.expectedDevice, result: { ok: true, changed: false, appium: {}, recording: {}, minimizeWatchdog: {} } }) });
    // @ts-expect-error publication reports found and matched independently
    createBrokerMacosVmLifecycle({ ...ports, publish: () => ({ matched: true, device: null }) });
    // @ts-expect-error complete-record publication is synchronous
    createBrokerMacosVmLifecycle({ ...ports, publish: async () => ({ found: true, matched: true, device: null }) });
    // @ts-expect-error cleanup identifies committed expected-record advancement
    createBrokerMacosVmLifecycle({ ...ports, cleanupAuxiliary: () => ({ committed: true }) });
    // @ts-expect-error semantic outcomes have no HTTP status
    outcome.status;
    // @ts-expect-error semantic outcomes have no HTTP payload
    outcome.payload;
    const ip: BrokerMacosIpObservation = await ports.observeIp(effect, "owned", "arp", { timeoutMs: 1500, outputLimit: 8192 });
    const { observeIp, ...withoutIp } = ports;
    // @ts-expect-error bounded native IP observation is required
    createBrokerMacosVmLifecycle(withoutIp);
    createBrokerMacosVmLifecycle({ ...ports, observeIp: async () => ({ ok: true, mode: "exec", provider: "tart", resourceMissing: false, address: "192.0.2.4", receipt: null }) });
    createBrokerMacosVmLifecycle({ ...ports, sleep: async () => undefined });
    const immediate: BrokerMacosVmLifecyclePorts<Effect> = { ...ports,
        execute: () => ({ ok: true, mode: "exec", provider: "tart", resourceMissing: false, receipt: null }),
        executeMetadata: () => ({ ok: true, mode: "noop", provider: "host-broker-state", resourceMissing: false, receipt: null }),
        observeIp: () => ({ ok: true, mode: "exec", provider: "tart", resourceMissing: false, receipt: null, address: null }),
        sleep: () => undefined,
        cleanupAuxiliary: () => ({ committed: false, device: null, result: { ok: true, changed: false, appium: {}, recording: {}, minimizeWatchdog: {} } }),
    };
    const metadata: BrokerMacosProviderResult = await ports.executeMetadata("definition-only", { timeoutMs: 1500, outputLimit: 8192 });
    const auxiliary: BrokerMacosAuxiliaryCleanup = await ports.cleanupAuxiliary(input.ownerId, input.parsed, input.expectedDevice);
    await ports.sleep(1);
    const operationId: string = ports.runtimeId();
    const planned: BrokerMacosPlannedCommand<Effect> = ports.prepareCreate({ provider: "tart", image: "base", instance: "owned" });
    const claim: BrokerMacosClaim = ports.claimDefinition(input.ownerId, input.parsed, {});
    const reserving: BrokerMacosPublicationChange = { kind: "reserve-start", lifecycle: { runtimeId: operationId, operation: "start", claimedAt: ports.timestamp() }, boot: null };
    const published: BrokerMacosPublication = ports.publish(input.ownerId, input.parsed.stateKey, input.parsed.deviceId, input.expectedDevice, reserving);
    const { runtimeId, ...withoutIdentity } = ports;
    // @ts-expect-error each start requires a fresh injected identity
    createBrokerMacosVmLifecycle(withoutIdentity);
    // @ts-expect-error operation identity is available before synchronous reservation
    createBrokerMacosVmLifecycle({ ...ports, runtimeId: async () => "pending" });
    // @ts-expect-error create preparation settles synchronously before dispatch
    createBrokerMacosVmLifecycle({ ...ports, prepareCreate: async () => ({ kind: "metadata-only", purpose: "definition-only" }) });
    // @ts-expect-error compensation preparation settles synchronously before dispatch
    createBrokerMacosVmLifecycle({ ...ports, prepareDelete: async () => effect });
    // @ts-expect-error definition claiming remains synchronous
    createBrokerMacosVmLifecycle({ ...ports, claimDefinition: async () => ({ ok: true, device: {} }) });
    // @ts-expect-error lifecycle metadata consists of finite scalar identities
    const invalidReservation: BrokerMacosPublicationChange = { kind: "reserve-start", lifecycle: { runtimeId: Promise.resolve("pending"), operation: "start", claimedAt: "now" }, boot: null };
    void [ip, observeIp];
    void [outcomes, deletion, prepareCreate, immediate, metadata, auxiliary, planned, claim, published, runtimeId, invalidReservation];
}
void contracts;

it("publishes a ready macOS SSH host while retaining its credentials", () => {
    const device = { id: "owned", status: "stopped", ssh: { user: "guest", keyPath: "/owned/key" } };
    expect(brokerMacosReplacement(device, { kind: "start", boot: { ok: true, ready: true, sshHost: "192.0.2.4" } })).toMatchObject({
        status: "running", bootReady: true, ssh: { host: "192.0.2.4", user: "guest", keyPath: "/owned/key" },
        lastBootCheck: { ready: true, provider: "tart", ip: "192.0.2.4" },
    });
    expect(device.status).toBe("stopped");
});

