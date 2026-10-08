import { describe, expect, it } from "vitest";
import { createCodexResumeRecovery } from "../../application/tool-session/codex-resume-recovery.js";
import type { CodexResumeObservation, CodexResumeRecoveryPlan } from "../../domain/tool-session/codex-resume.js";
import type { CodexResumeRecoveryPorts } from "../../ports/tool-session/codex-resume-recovery.js";
import type { CodexResumeRecoveryPlan as PublicPlan } from "../../codex-resume-recovery-runtime.js";
import type { ResumeProcessResult } from "../../codex-resume-process.js";

function compileContracts(ports: CodexResumeRecoveryPorts<object, string, (message: string) => void>) {
    const run = createCodexResumeRecovery(ports);
    const plan: PublicPlan = { command: ["codex"], retry: ["codex"], config: [] };
    plan.command.push("resume"); plan.retry[0] = "codex"; plan.config = ["-c=x"];
    const inward: CodexResumeRecoveryPlan = plan;
    const result: Promise<number> = run(inward, {}, "opaque-home", () => {});
    void result;
    const { dispose: omitted, ...incomplete } = ports; void omitted;
    // @ts-expect-error Disposal is a required operation capability.
    createCodexResumeRecovery(incomplete);
    // @ts-expect-error Operation ports cannot acquire native default services through mutation.
    ports.probeTerminal = async () => ({ code: 0, output: "", stderr: "", overflow: false, signal: null });
    // @ts-expect-error There is no arbitrary native process executor port.
    ports.run(["codex"], { timeoutMs: 1 });
    // @ts-expect-error Public plans retain string array element types.
    plan.command.push(1);
}
void compileContracts;

function nativeObservationCompatibility(result: ResumeProcessResult): CodexResumeObservation { return result; }
void nativeObservationCompatibility;

describe("Codex resume required contracts", () => {
    it("retains a named four-argument async operation without ambient services", () => {
        const run = createCodexResumeRecovery({} as CodexResumeRecoveryPorts<object, string, undefined>);
        expect([run.name, run.length, run.constructor.name]).toEqual(["runCodexResumeRecovery", 4, "AsyncFunction"]);
    });
});
