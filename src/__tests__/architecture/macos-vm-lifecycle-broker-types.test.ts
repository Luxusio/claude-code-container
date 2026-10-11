import { expect, it } from "vitest";
import { createBrokerMacosVmLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/macos-vm-lifecycle.js";
import { brokerMacosReplacement, type BrokerMacosLifecycleInput, type BrokerMacosLifecycleResponse, type BrokerMacosProviderResult } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/macos-vm-lifecycle.js";
import type { BrokerMacosVmLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/macos-vm-lifecycle.js";

type Effect = { readonly token: unique symbol };

// Consumed by the normal strict compiler; this function is never invoked.
function contracts(ports: BrokerMacosVmLifecyclePorts<Effect>, input: BrokerMacosLifecycleInput<Effect>, effect: Effect, outcome: BrokerMacosLifecycleResponse<Effect>) {
    const app = createBrokerMacosVmLifecycle(ports);
    const outcomes: Promise<BrokerMacosLifecycleResponse<Effect>>[] = [app.create(input), app.start(input), app.stop(input), app.delete(input)];
    const plan = app.planExisting(input.ownerId, input.parsed, input.expectedDevice);
    if (plan.kind === "ready") {
        const prepared: Effect = plan.effect;
        const result: BrokerMacosProviderResult = ports.execute(prepared, { timeoutMs: 5000, outputLimit: 32768 });
        void result;
        // @ts-expect-error opaque native effects expose no process arguments
        prepared.args;
    }
    const deletion: Effect = ports.prepareDelete(effect, "owned");
    const { prepareCreate, ...withoutPreparation } = ports;
    // @ts-expect-error finite native preparation is required
    createBrokerMacosVmLifecycle(withoutPreparation);
    // @ts-expect-error preparation settles synchronously before execution
    createBrokerMacosVmLifecycle({ ...ports, prepareExisting: async () => ({ kind: "metadata-only", reason: "unavailable" }) });
    // @ts-expect-error native effect observations are synchronous
    createBrokerMacosVmLifecycle({ ...ports, execute: async () => ({ mode: "exec", provider: "tart", status: 0, receipt: null }) });
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
    const ip: BrokerMacosProviderResult = ports.observeIp(effect, "owned", "arp", { timeoutMs: 1500, outputLimit: 8192 });
    const { observeIp, ...withoutIp } = ports;
    // @ts-expect-error bounded native IP observation is required
    createBrokerMacosVmLifecycle(withoutIp);
    // @ts-expect-error IP probes finish synchronously before the boot decision
    createBrokerMacosVmLifecycle({ ...ports, observeIp: async () => ({ mode: "exec", provider: "tart", status: 0, receipt: null }) });
    // @ts-expect-error pacing cannot defer synchronous polling
    createBrokerMacosVmLifecycle({ ...ports, sleep: async () => undefined });
    void [ip, observeIp];
    void [outcomes, deletion, prepareCreate];
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

