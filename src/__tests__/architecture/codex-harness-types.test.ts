import { describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "child_process";
import { createCodexHarness } from "../../application/codex-harness.js";
import { createNativeCodexHarnessPorts } from "../../adapters/codex-harness.js";
import { CODEX_HARNESS_BOOTSTRAP, ensureCodexHarness } from "../../codex-harness.js";
import type { CodexHarnessPorts } from "../../ports/codex-harness.js";
import type { CodexHarnessObservation } from "../../domain/codex-harness.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function contracts(ports: CodexHarnessPorts, native: SpawnSyncReturns<string>, observation: CodexHarnessObservation) {
    const completed: CodexHarnessObservation = {kind: "completed", output: "installed"};
    const failed: CodexHarnessObservation = {kind: "failed", output: "", failure: undefined};
    const app = createCodexHarness(ports);
    const proof: [Equal<ReturnType<typeof ensureCodexHarness>, void>, Equal<typeof CODEX_HARNESS_BOOTSTRAP, string>, Equal<ReturnType<typeof app.ensure>, void>, Equal<ReturnType<typeof ports.executeBootstrap>, CodexHarnessObservation>, Equal<ReturnType<typeof ports.publishUnavailable>, undefined>, Equal<Parameters<typeof ports.publishUnavailable>[0], unknown>, Equal<ReturnType<typeof createNativeCodexHarnessPorts>, CodexHarnessPorts>] = [true, true, true, true, true, true, true];
    void completed; void failed; void proof;
    app.ensure("container"); app.ensure("container", undefined); app.ensure("container", "profile");
    ensureCodexHarness("container"); ensureCodexHarness("container", "profile");
    ports.publishUnavailable(observation); ports.publishUnavailable(undefined);
    // @ts-expect-error No missing semantic capabilities.
    createCodexHarness({});
    // @ts-expect-error Container identity is required.
    app.ensure();
    // @ts-expect-error Profile remains a string.
    ensureCodexHarness("container", 1);
    // @ts-expect-error The observation is not an asynchronous result.
    createCodexHarness({...ports, executeBootstrap: async () => observation});
    // @ts-expect-error Native process results cannot cross the semantic port.
    createCodexHarness({...ports, executeBootstrap: () => native});
    // @ts-expect-error Publishers deliberately reject async void bindings.
    createCodexHarness({...ports, publishUnavailable: async () => {}});
    // @ts-expect-error Publisher cannot accidentally return a value.
    createCodexHarness({...ports, publishBootstrapOutput: () => 1});
    // @ts-expect-error Lock retains synchronous generic callback results.
    createCodexHarness({...ports, withConfigLock: async operation => operation()});
    // @ts-expect-error Semantic ports are readonly.
    ports.restoreAccess = () => {};
    // @ts-expect-error Semantic observations are readonly.
    observation.output = "changed";
    // @ts-expect-error Native status is unavailable to application decisions.
    const nativeStatus: unknown = observation.status;
    void nativeStatus;
    // @ts-expect-error Every observation carries normalized output.
    const missingOutput: CodexHarnessObservation = {kind: "completed"};
    // @ts-expect-error Failed observations carry an explicit opaque failure.
    const missingFailure: CodexHarnessObservation = {kind: "failed", output: ""};
    // @ts-expect-error Raw process observations are no longer accepted.
    const malformed: CodexHarnessObservation = {status: 0, stdout: "installed"};
    // @ts-expect-error Completed observations cannot expose native status.
    const rawCompleted: CodexHarnessObservation = {kind: "completed", output: "", status: 0};
    void missingOutput; void missingFailure; void malformed; void rawCompleted;
}
void contracts;
describe("Codex Harness public synchronous type contract", () => {
    it("retains a string bootstrap and synchronous facade", () => {
        expect(typeof CODEX_HARNESS_BOOTSTRAP).toBe("string");
        expect(typeof ensureCodexHarness).toBe("function");
    });
});
