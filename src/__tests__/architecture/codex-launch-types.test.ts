import { expect, it } from "vitest";
import { createCodexLaunchPreparation } from "../../application/tool-session/codex-launch.js";
import { prepareCodexLaunch, isInteractiveCodexCommand, type CodexLaunchPreparation } from "../../codex-launch.js";
import type { CodexLaunchPorts } from "../../ports/tool-session/codex-launch.js";
import type { spawnSync } from "node:child_process";
function contract(ports: CodexLaunchPorts<symbol>) {
    const app = createCodexLaunchPreparation(ports);
    const result: CodexLaunchPreparation = app.prepare(["codex"]);
    const facade: (runtime: string, prefix: readonly string[], command: readonly string[], runner?: typeof spawnSync) => CodexLaunchPreparation = prepareCodexLaunch;
    result.command.push("mutable");
    // @ts-expect-error Every semantic capability is required.
    createCodexLaunchPreparation({});
    // @ts-expect-error Preparation remains synchronous.
    const asyncResult: Promise<CodexLaunchPreparation> = app.prepare(["codex"]);
    // @ts-expect-error Native capabilities are readonly.
    ports.prepareStart = () => Symbol("other");
    // @ts-expect-error Observation is synchronous.
    const invalid: CodexLaunchPorts<symbol>["probeDaemonExecutable"] = async () => ({ status: 0, signal: null, stdout: "", stderr: "" });
    void [facade, asyncResult, invalid];
}
void contract;
it("retains public callable name and default argument arity", () => {
    expect(prepareCodexLaunch.name).toBe("prepareCodexLaunch"); expect(prepareCodexLaunch.length).toBe(3);
    expect(isInteractiveCodexCommand.length).toBe(1);
});
