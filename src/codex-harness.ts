import { getRuntimeInvocation, runWithNativeRuntimeInvocation } from "./container-runtime.js";
import { createCodexHarness } from "./application/codex-harness.js";
import { createNativeCodexHarnessPorts } from "./adapters/codex-harness.js";
export { CODEX_HARNESS_BOOTSTRAP } from "./adapters/codex-harness-bootstrap.js";

export function ensureCodexHarness(containerName: string, profile?: string): void {
    runWithNativeRuntimeInvocation(getRuntimeInvocation(), () => createCodexHarness(createNativeCodexHarnessPorts()).ensure(containerName, profile));
}
