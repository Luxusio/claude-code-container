import { expect, it } from "vitest";
import { createCodexLaunchPreparation } from "../../application/tool-session/codex-launch.js";
import { prepareCodexLaunch, presentCodexLaunchPreparation, type CodexLaunchPreparation } from "../../codex-launch.js";
import type { CodexLaunchSemanticPreparation } from "../../domain/tool-session/codex-launch.js";
import type { CodexLaunchPorts } from "../../ports/tool-session/codex-launch.js";
import type { spawnSync } from "node:child_process";

function contract(ports: CodexLaunchPorts<symbol>) {
    const app = createCodexLaunchPreparation(ports);
    const semantic: CodexLaunchSemanticPreparation = app.prepare(["codex"]);
    const result: CodexLaunchPreparation = presentCodexLaunchPreparation(semantic);
    const facade: (runtime: string, prefix: readonly string[], command: readonly string[], runner?: typeof spawnSync) => CodexLaunchPreparation = prepareCodexLaunch;
    result.command.push("mutable");
    // @ts-expect-error Every semantic capability is required.
    createCodexLaunchPreparation({});
    // @ts-expect-error Preparation remains synchronous.
    const asyncResult: Promise<CodexLaunchSemanticPreparation> = app.prepare(["codex"]);
    // @ts-expect-error Native capabilities are readonly.
    ports.prepareStart = () => Symbol("other");
    // @ts-expect-error Raw native process observations cannot enter the application.
    const raw: CodexLaunchPorts<symbol>["probeDaemonExecutable"] = () => ({ status: 0, signal: null, stdout: "", stderr: "" });
    // @ts-expect-error Public diagnostic text is an outward presentation.
    const diagnostic: string = semantic.error;
    void [facade, asyncResult, raw, diagnostic];
}
void contract;
it("returns fresh mutable public commands without changing the caller's arguments", () => {
    const command = ["codex", "exec", "request"];
    const first = prepareCodexLaunch("docker", ["exec", "fixture"], command);
    const second = prepareCodexLaunch("docker", ["exec", "fixture"], command);
    first.command.push("mutable");
    expect(second.command).toEqual(command); expect(command).toEqual(["codex", "exec", "request"]);
});
