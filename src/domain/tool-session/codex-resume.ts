export interface CodexResumeRecoveryPlan {
    command: string[];
    retry: string[];
    config: string[];
    selector?: string;
}

export interface CodexResumeRollout { id: string; path: string }
export type CodexResumeMetadataFailureStage =
    | "metadata-support" | "metadata-home" | "metadata-initialize" | "metadata-read" | "metadata-close";
export type CodexResumeMetadataResult = { ok: true } | { ok: false; stage: CodexResumeMetadataFailureStage };
export type CodexResumeFailureStage = CodexResumeMetadataFailureStage | "migration" | "migration-after-metadata";

// The application relays these values to native bindings without inspecting them.
export interface CodexResumeInvocation<Runner, Home, Reporter> {
    readonly runner: Runner;
    readonly home: Home;
    readonly report: Reporter;
}

const VALUE_OPTIONS = new Set([
    "-c", "--config", "--enable", "--disable", "-m", "--model", "-s", "--sandbox",
    "-a", "--ask-for-approval", "--local-provider", "--add-dir",
]);
const CONFIG_OPTIONS = new Set(["-c", "--config", "--enable", "--disable"]);
const BOOLEAN_OPTIONS = new Set([
    "--no-daemon", "--no-alt-screen", "--oss", "--strict-config", "--approve-for-me",
    "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--search",
]);
const SELECTOR_OPTIONS = new Set(["--last", "--all", "--include-non-interactive"]);

export type CodexResumeCommandSelection =
    | { eligible: false; command: string[] }
    | { eligible: true; plan: CodexResumeRecoveryPlan };

/** Select only local prompt-free resume, retaining the original argument reads. */
export function selectCodexResumeRecovery(command: readonly string[]): CodexResumeCommandSelection {
    const unchanged = [...command];
    const excluded = (): CodexResumeCommandSelection => ({ eligible: false, command: unchanged });
    if (command[0] !== "codex") return excluded();
    let resume = false;
    let selector: string | undefined;
    const retry = [command[0]];
    const config: string[] = [];
    for (let index = 1; index < command.length; index += 1) {
        const argument = command[index];
        if (!argument.startsWith("-")) {
            if (!resume) {
                if (argument !== "resume") return excluded();
                resume = true;
                retry.push(argument);
            } else if (selector === undefined) selector = argument;
            else return excluded();
            continue;
        }
        const equals = argument.indexOf("=");
        const flag = equals < 0 ? argument : argument.slice(0, equals);
        if (VALUE_OPTIONS.has(flag)) {
            const values = [argument];
            if (equals < 0) {
                if (++index >= command.length) return excluded();
                values.push(command[index]);
            }
            retry.push(...values);
            if (CONFIG_OPTIONS.has(flag)) config.push(...values);
        } else if (SELECTOR_OPTIONS.has(argument) && resume) {
            // Replace the failed picker selection with its qualified UUID on retry.
        } else if (BOOLEAN_OPTIONS.has(argument)) retry.push(argument);
        else return excluded();
    }
    if (!resume) return excluded();
    return { eligible: true, plan: { command: unchanged, retry, config, selector } };
}

/** Decode the existing transport shape without strengthening its admission rules. */
export function parseCodexResumeRecoveryPlan(input: string | undefined): CodexResumeRecoveryPlan | null {
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
    try {
        const value: unknown = JSON.parse(input ?? "");
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            const plan = value as Record<string, unknown>;
            if (strings(plan.command) && plan.command.length > 0 && strings(plan.retry) && plan.retry.length > 0
                && strings(plan.config) && (plan.selector === undefined || typeof plan.selector === "string")) {
                return { command: plan.command, retry: plan.retry, config: plan.config, selector: plan.selector };
            }
        }
    } catch { /* Malformed payloads can contain private configuration values. */ }
    return null;
}
