import { readFileSync } from "node:fs";
import { selectCodexResumeRecovery } from "./domain/tool-session/codex-resume.js";

/** Wrap only local resume without a prompt; the container retains its existing identity and environment. */
export function buildCodexResumeRecoveryCommand(command: readonly string[]): string[] {
    const selected = selectCodexResumeRecovery(command);
    if (!selected.eligible) return selected.command;
    const plan = selected.plan;
    const unchanged = plan.command;
    try {
        const runtime = readFileSync(new URL("../dist/codex-resume-runtime.cjs", import.meta.url), "utf8");
        return ["node", "-e", runtime, "--", JSON.stringify(plan)];
    } catch {
        console.error("[ccc] Automatic resume recovery is unavailable; rebuild or reinstall CCC.");
        return unchanged;
    }
}
