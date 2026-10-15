import { describe, expect, it } from "vitest";
import { createBrokerWindowsSandboxLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/windows-sandbox-lifecycle.js";
import { brokerWindowsSandboxRuntimeChoice } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/windows-sandbox-lifecycle.js";
import type { BrokerWindowsSandboxInput, BrokerWindowsSandboxOutcome } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/windows-sandbox-lifecycle.js";
import type { BrokerWindowsSandboxLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/windows-sandbox-lifecycle.js";

type Prepared = symbol;
type Receipt = { nativeReceipt: string };
function contracts(ports: BrokerWindowsSandboxLifecyclePorts<Prepared, Receipt>, input: BrokerWindowsSandboxInput<Prepared>) {
    const app = createBrokerWindowsSandboxLifecycle(ports);
    const start: Promise<BrokerWindowsSandboxOutcome<Receipt>> = app.start(input);
    const stop: Promise<BrokerWindowsSandboxOutcome<Receipt>> = app.stop(input);
    const deletion: Promise<BrokerWindowsSandboxOutcome<Receipt>> = app.delete(input);
    start.then(outcome => {
        if (outcome.kind === "completed") {
            const success: true = outcome.success;
            const receipt: Receipt | undefined = outcome.facts.execution?.receipt;
            void [success, receipt];
        } else if (outcome.kind === "refused") { const error: string = outcome.error; void error; }
        else { const success: false = outcome.success; void success; }
    });
    const { prepare, ...withoutPreparation } = ports;
    // @ts-expect-error finite native preparation authority is required
    createBrokerWindowsSandboxLifecycle(withoutPreparation);
    const { run, ...withoutExecution } = ports;
    // @ts-expect-error native execution authority is required
    createBrokerWindowsSandboxLifecycle(withoutExecution);
    const { publish, ...withoutPublication } = ports;
    // @ts-expect-error matching-record publication authority is required
    createBrokerWindowsSandboxLifecycle(withoutPublication);
    const { inspectExpectedRecord, ...withoutInspection } = ports;
    // @ts-expect-error successor inspection is required before destructive effects
    createBrokerWindowsSandboxLifecycle(withoutInspection);
    const { cleanupAuxiliary, ...withoutCleanup } = ports;
    // @ts-expect-error auxiliary cleanup and committed expected-record advancement are required
    createBrokerWindowsSandboxLifecycle(withoutCleanup);
    // @ts-expect-error native command results must settle synchronously
    createBrokerWindowsSandboxLifecycle({ ...ports, run: async () => ({ ok: true }) });
    // @ts-expect-error runtime inventory must carry settled IDs rather than native framing
    createBrokerWindowsSandboxLifecycle({ ...ports, listRuntime: () => ({ ok: true, stdout: "[]" }) });
    // @ts-expect-error window inventory must distinguish unavailable handles from an empty baseline
    createBrokerWindowsSandboxLifecycle({ ...ports, snapshotWindows: () => ({ ok: true }) });
    // @ts-expect-error process exit status alone is not a settled command observation
    createBrokerWindowsSandboxLifecycle({ ...ports, run: () => ({ status: 0 }) });
    // @ts-expect-error artifact cleanup must settle before publication
    createBrokerWindowsSandboxLifecycle({ ...ports, cleanArtifacts: async () => ({ ok: true, removed: false, deviceRoot: "scratch" }) });
    // @ts-expect-error lifecycle callers must provide their expected record
    app.stop({ ownerId: input.ownerId, parsed: input.parsed, device: input.device, prepared: input.prepared });
    // @ts-expect-error concrete request IDs retain their checked string contract
    app.start({ ...input, parsed: { ...input.parsed, deviceId: 7 } });
    // @ts-expect-error the broker lifecycle response is asynchronous
    const synchronous: BrokerWindowsSandboxOutcome<Receipt> = app.delete(input);
    void [start, stop, deletion, prepare, run, publish, inspectExpectedRecord, cleanupAuxiliary, synchronous];
}
void contracts;

describe("broker Windows Sandbox lifecycle type contracts", () => {
    it("refuses a preexisting runtime rather than treating it as a new owned launch", () => {
        const id = "11111111-1111-4111-8111-111111111111";
        expect(brokerWindowsSandboxRuntimeChoice([id], [id], id)).toEqual({ kind: "preexisting", error: `Windows Sandbox runtime ${id} existed before launch; no new owned runtime appeared` });
    });
});
