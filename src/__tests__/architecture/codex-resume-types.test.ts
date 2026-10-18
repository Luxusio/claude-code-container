import { describe, expect, it } from "vitest";
import { createCodexResumeRecovery } from "../../application/tool-session/codex-resume-recovery.js";
import type { CodexResumeRecoveryPlan } from "../../domain/tool-session/codex-resume.js";
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

function opaqueObservationContracts(ports: CodexResumeRecoveryPorts<object, string, undefined, symbol>, native: ResumeProcessResult) {
    const run = createCodexResumeRecovery(ports);
    const result: Promise<number> = run({ command: ["codex"], retry: ["codex"], config: [] }, {}, "opaque-home", undefined);
    void result;
    const value = Symbol("opaque observation");
    const supported: boolean = ports.terminalSupported(value);
    const recoverable: boolean = ports.recoverableOriginal(value);
    const migrated: boolean = ports.migrationSucceeded(value);
    const code: number = ports.exitCode(value);
    void [supported, recoverable, migrated, code];
    // @ts-expect-error Opaque symbol evidence does not accept a native process result.
    ports.exitCode(native);
    const { terminalSupported: terminal, ...withoutTerminal } = ports; void terminal;
    // @ts-expect-error Terminal support is a required semantic capability.
    createCodexResumeRecovery(withoutTerminal);
    const { recoverableOriginal: original, ...withoutOriginal } = ports; void original;
    // @ts-expect-error Original failure qualification is a required semantic capability.
    createCodexResumeRecovery(withoutOriginal);
    const { migrationSucceeded: migration, ...withoutMigration } = ports; void migration;
    // @ts-expect-error Migration success is a required semantic capability.
    createCodexResumeRecovery(withoutMigration);
    const { exitCode: exit, ...withoutExit } = ports; void exit;
    // @ts-expect-error Exit extraction is a required semantic capability.
    createCodexResumeRecovery(withoutExit);
    // @ts-expect-error Terminal qualification must be synchronous.
    createCodexResumeRecovery({ ...ports, terminalSupported: async (_value: symbol) => true });
    // @ts-expect-error Original qualification must be synchronous.
    createCodexResumeRecovery({ ...ports, recoverableOriginal: async (_value: symbol) => true });
    // @ts-expect-error Migration qualification must be synchronous.
    createCodexResumeRecovery({ ...ports, migrationSucceeded: async (_value: symbol) => true });
    // @ts-expect-error Exit extraction must be synchronous.
    createCodexResumeRecovery({ ...ports, exitCode: async (_value: symbol) => 0 });
}
void opaqueObservationContracts;

async function defaultUnknownContracts(ports: CodexResumeRecoveryPorts<object, string, undefined>) {
    const defaultObservation: Promise<unknown> = ports.probeTerminal({ runner: {}, home: "opaque-home", report: undefined });
    void defaultObservation;
    const query: (observation: unknown) => boolean = ports.terminalSupported;
    void query;
    const observed = await defaultObservation;
    // @ts-expect-error Default evidence exposes no native fields inward.
    observed.code;
    // @ts-expect-error Default observations cannot be assigned a native process shape.
    const native: Promise<ResumeProcessResult> = ports.probeTerminal({ runner: {}, home: "opaque-home", report: undefined });
    void native;
}
void defaultUnknownContracts;

describe("Codex resume required contracts", () => {
    it("retains a named four-argument async operation without ambient services", () => {
        const run = createCodexResumeRecovery({} as CodexResumeRecoveryPorts<object, string, undefined>);
        expect([run.name, run.length, run.constructor.name]).toEqual(["runCodexResumeRecovery", 4, "AsyncFunction"]);
    });
});
