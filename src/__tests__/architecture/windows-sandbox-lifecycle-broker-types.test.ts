import { describe, expect, it } from "vitest";
import { createBrokerWindowsSandboxLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/windows-sandbox-lifecycle.js";
import { brokerWindowsSandboxRuntimeChoice } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/windows-sandbox-lifecycle.js";
import type { BrokerWindowsSandboxInput, BrokerWindowsSandboxResponse } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/windows-sandbox-lifecycle.js";
import type { BrokerWindowsSandboxLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/windows-sandbox-lifecycle.js";

function contracts(ports: BrokerWindowsSandboxLifecyclePorts, input: BrokerWindowsSandboxInput) {
    const app = createBrokerWindowsSandboxLifecycle(ports);
    const start: Promise<BrokerWindowsSandboxResponse> = app.start(input);
    const stop: Promise<BrokerWindowsSandboxResponse> = app.stop(input);
    const deletion: Promise<BrokerWindowsSandboxResponse> = app.delete(input);
    start.then(response => { const status: number = response.status; const payload: unknown = response.payload; void [status, payload]; });
    const { execute, ...withoutExecution } = ports;
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
    createBrokerWindowsSandboxLifecycle({ ...ports, execute: async command => ({ mode: command.mode, provider: command.provider, status: 0 }) });
    // @ts-expect-error artifact cleanup must settle before publication
    createBrokerWindowsSandboxLifecycle({ ...ports, cleanArtifacts: async () => ({ ok: true, removed: false, deviceRoot: "scratch" }) });
    // @ts-expect-error lifecycle callers must provide their expected record
    app.stop({ ownerId: input.ownerId, parsed: input.parsed, plan: input.plan });
    // @ts-expect-error concrete request IDs retain their checked string contract
    app.start({ ...input, parsed: { ...input.parsed, deviceId: 7 } });
    // @ts-expect-error the broker lifecycle response is asynchronous
    const synchronous: BrokerWindowsSandboxResponse = app.delete(input);
    void [start, stop, deletion, execute, publish, inspectExpectedRecord, cleanupAuxiliary, synchronous];
}
void contracts;

describe("broker Windows Sandbox lifecycle type contracts", () => {
    it("refuses a preexisting runtime rather than treating it as a new owned launch", () => {
        const id = "11111111-1111-4111-8111-111111111111";
        expect(brokerWindowsSandboxRuntimeChoice([id], [id], id)).toEqual({ kind: "preexisting", error: `Windows Sandbox runtime ${id} existed before launch; no new owned runtime appeared` });
    });
});
