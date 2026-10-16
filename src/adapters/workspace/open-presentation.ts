import type { WorkspaceOpenConfirmation, WorkspaceOpenEvent, WorkspaceOpenOutcome } from "../../domain/workspace/open.js";

interface WorkspaceOpenPresentationPorts {
    prompt(question: string): Promise<string>;
    report(message: string): undefined;
    reportError(message: string): undefined;
    safeLiteral(text: string): string;
}
function errorMessage(error: unknown): unknown {
    return error !== null && (typeof error === "object" || typeof error === "function") && "message" in error ? error.message : undefined;
}
export function createWorkspaceOpenPresentation(ports: WorkspaceOpenPresentationPorts) {
    async function confirm(request: WorkspaceOpenConfirmation): Promise<boolean> {
        let question: string;
        switch (request.purpose) {
            case "missing-registration": question = "Recreate the missing Git worktree registration now? (y/N) "; break;
            case "broken-content": question = "Stash content and recreate as proper worktrees? (y/N) "; break;
            case "initialize-submodules": question = "Initialize as git repo and add them as submodules? (y/N) "; break;
            case "damaged-registration": question = `Run ${request.repairCount === 1 ? "this" : "these"} now? (y/N) `; break;
        }
        const answer = await ports.prompt(question);
        return answer === "y" || answer === "yes";
    }
    function report(event: WorkspaceOpenEvent): undefined {
        switch (event.kind) {
            case "missing-registration": ports.reportError(String(errorMessage(event.error))); ports.reportError(""); break;
            case "registration-recreated": ports.report(`Recreated Git worktree registration: ${event.path}`); break;
            case "existing": ports.report(`Using existing workspace: ${event.path}`); break;
            case "nested-repaired": ports.report(`  ${event.repo.name}: worktree (repaired)`); break;
            case "broken-content":
                ports.report(`Found ${event.entries.length} broken worktree(s):`);
                for (const entry of event.entries) ports.report(`  ${entry.name}: has content but is not a valid worktree`);
                break;
            case "submodule-candidates": ports.report("This directory is not a git repository."); ports.report(`Found git repos: ${event.repos.join(", ")}`); break;
            case "submodules-initialized": ports.report("Initialized git repo with submodules."); break;
            case "creating": ports.report(`Creating workspace for branch '${event.branch}'...`); break;
            case "created":
                ports.report(`Workspace created: ${event.result.workspacePath}`);
                for (const repo of event.result.created) ports.report(`  ${repo.name}: worktree (${repo.action === "worktree-existing" ? "existing branch" : repo.action === "worktree-remote" ? "from remote" : "new branch"})`);
                for (const name of event.result.copied) ports.report(`  ${name}: copied`);
                break;
            case "damaged-registration":
                ports.reportError(event.damage.message); ports.reportError("");
                for (const repair of event.damage.repairs) { ports.reportError(`  git worktree repair ${repair.checkoutPath}`); ports.reportError(`    in ${repair.sourcePath}`); }
                break;
            case "registration-repair": ports.reportError(event.outcome.ok ? `  repaired ${event.repair.checkoutPath}` : `  could not repair ${event.repair.checkoutPath}${event.outcome.detail ? `: ${event.outcome.detail}` : ""}`); break;
        }
        return undefined;
    }
    function recoveryError(path: string, failure?: string): Error {
        return new Error(`Could not recreate the missing Git worktree registration for '${path}'. Workspace files were left unchanged.`
            + (failure ? ` Reason: ${ports.safeLiteral(failure.slice(0, 500))}` : " Reason: Git registration conditions changed during recovery."));
    }
    function refusal(outcome: Extract<WorkspaceOpenOutcome, { kind: "refused" }>): undefined {
        ports.reportError(`Error: ${errorMessage(outcome.error)}`);
        return undefined;
    }
    return { confirm, report, recoveryError, refusal };
}
