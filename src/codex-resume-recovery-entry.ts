import { homedir } from "node:os";
import { join } from "node:path";
import { createResumeProcessRunner } from "./codex-resume-process.js";
import { runCodexResumeRecovery, type CodexResumeRecoveryPlan } from "./codex-resume-recovery-runtime.js";
import { parseCodexResumeRecoveryPlan } from "./domain/tool-session/codex-resume.js";

function parsePlan(input: string | undefined): CodexResumeRecoveryPlan {
    const plan = parseCodexResumeRecoveryPlan(input);
    if (plan) return plan;
    throw new Error("Invalid Codex resume recovery invocation.");
}

function reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : "Unexpected runtime error";
    process.stderr.write(`[ccc] Resume recovery failed: ${message.slice(0, 2000)}\n`);
}

async function main(): Promise<number> {
    const plan = parsePlan(process.argv[1]);
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const runner = createResumeProcessRunner();
    try {
        return await runCodexResumeRecovery(plan, runner, home, message => { process.stderr.write(message); });
    } catch (error) {
        reportError(error);
        return runner.interrupted || 1;
    }
}

void main().then(code => { process.exitCode = code; }, error => {
    reportError(error);
    process.exitCode = 1;
});
