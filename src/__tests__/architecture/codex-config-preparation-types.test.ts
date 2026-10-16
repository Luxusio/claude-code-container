import { describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { createCodexConfigPreparation } from "../../application/codex-config-preparation.js";
import type { CodexConfigPreparationObservation, CodexConfigPreparationPorts, CodexConfigPreparationResult } from "../../ports/codex-config-preparation.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type ProbeKinds = Assert<Equal<CodexConfigPreparationObservation["kind"], "ready" | "repair-required" | "timed-out" | "failed">>;
type CompletionKinds = Assert<Equal<CodexConfigPreparationResult["kind"], "ready" | "timed-out" | "failed">>;
// Rejected capabilities are checked by TypeScript, never executed.
function compileContracts(ports: CodexConfigPreparationPorts, native: SpawnSyncReturns<Buffer>, observation: CodexConfigPreparationObservation) {
    const app = createCodexConfigPreparation(ports);
    const ran: undefined = app.run("target");
    const probe: CodexConfigPreparationObservation = ports.probe("target");
    const repair: CodexConfigPreparationResult = ports.repair("target");
    createCodexConfigPreparation({ probe: () => ({ kind: "repair-required" }), repair: () => ({ kind: "ready" }), finalize: () => ({ kind: "failed", failure: new Error("detail") }) });
    // @ts-expect-error Raw native process results cannot supply semantic ports.
    createCodexConfigPreparation({ probe: () => native, repair: () => native, finalize: () => native });
    // @ts-expect-error Native status is absent from semantic observations.
    observation.status;
    // @ts-expect-error Native error is absent from semantic observations.
    observation.error;
    // @ts-expect-error Semantic observations are readonly.
    observation.kind = "ready";
    // @ts-expect-error Repair-required is a probe fact, not a completed repair.
    createCodexConfigPreparation({ ...ports, repair: () => ({ kind: "repair-required" }) });
    // @ts-expect-error Repair-required is not a verification result.
    createCodexConfigPreparation({ ...ports, finalize: () => ({ kind: "repair-required" }) });
    // @ts-expect-error Raw status/error observations cannot supply a probe.
    createCodexConfigPreparation({ ...ports, probe: () => ({ status: null, error: Symbol("opaque") }) });
    // @ts-expect-error Native timeout details do not supply a semantic kind.
    createCodexConfigPreparation({ ...ports, repair: () => ({ status: 124 }) });
    // @ts-expect-error The finite semantic kind is required.
    createCodexConfigPreparation({ ...ports, finalize: () => ({ failure: new Error("detail") }) });
    // @ts-expect-error Unknown semantic states cannot enter the policy.
    createCodexConfigPreparation({ ...ports, probe: () => ({ kind: "unknown" }) });
    // @ts-expect-error Required ports cannot be omitted.
    createCodexConfigPreparation();
    // @ts-expect-error Undefined cannot supply ports.
    createCodexConfigPreparation(undefined);
    // @ts-expect-error Probe is required.
    createCodexConfigPreparation({ repair: ports.repair, finalize: ports.finalize });
    // @ts-expect-error Repair is required.
    createCodexConfigPreparation({ probe: ports.probe, finalize: ports.finalize });
    // @ts-expect-error Finalize is required.
    createCodexConfigPreparation({ probe: ports.probe, repair: ports.repair });
    // @ts-expect-error Probe must be callable.
    createCodexConfigPreparation({ ...ports, probe: false });
    // @ts-expect-error Repair must be callable.
    createCodexConfigPreparation({ ...ports, repair: {} });
    // @ts-expect-error Finalize must be callable.
    createCodexConfigPreparation({ ...ports, finalize: undefined });
    // @ts-expect-error Probe observations must be synchronous.
    createCodexConfigPreparation({ ...ports, probe: async () => ({ kind: "ready" }) });
    // @ts-expect-error Repair observations must be synchronous.
    createCodexConfigPreparation({ ...ports, repair: async () => ({ kind: "ready" }) });
    // @ts-expect-error Finalize observations must be synchronous.
    createCodexConfigPreparation({ ...ports, finalize: async () => ({ kind: "ready" }) });
    // @ts-expect-error Void is not an observation.
    createCodexConfigPreparation({ ...ports, repair: (): void => {} });
    // @ts-expect-error Run requires a target.
    app.run();
    // @ts-expect-error Run requires a string target.
    app.run(1);
    // @ts-expect-error Probe requires a string target.
    ports.probe(1);
    // @ts-expect-error Repair requires a target.
    ports.repair();
    // @ts-expect-error Finalize requires a string target.
    ports.finalize(null);
    // @ts-expect-error Run completes synchronously.
    const promise: Promise<undefined> = app.run("target");
    // @ts-expect-error Run does not return a success flag.
    const success: boolean = app.run("target");
    void [ran, probe, repair, promise, success];
}
void compileContracts;
const proof: [ProbeKinds, CompletionKinds] = [true, true];

describe("Codex config preparation compile contracts", () => {
    it("returns synchronous undefined from finite semantic ports", () => {
        const app = createCodexConfigPreparation({ probe: () => ({ kind: "ready" }), repair: () => ({ kind: "ready" }), finalize: () => ({ kind: "ready" }) });
        expect(app.run("target")).toBeUndefined();
        expect(proof.every(Boolean)).toBe(true);
    });
});
