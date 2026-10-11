import { workspaceConfirmed, workspaceOpenErrorMessage } from "../../domain/workspace/open.js";
import type { WorkspaceOpenPorts } from "../../ports/workspace/open.js";

export function createWorkspaceOpen(ports: WorkspaceOpenPorts) {
    async function attempt(cwd: string, branch: string): Promise<string> {
        try { ports.validateBranch(branch); }
        catch (error) { ports.reportError(`Error: ${workspaceOpenErrorMessage(error)}`); ports.exit(1); }
        const path = ports.path(cwd, branch);
        if (ports.exists(cwd, branch)) {
            if (ports.hasGitMetadata(cwd)) {
                ports.repairRoot(path, cwd, branch);
                try { ports.assertOwner(path, cwd); }
                catch (error) {
                    if (!ports.missingRegistration(error)) throw error;
                    ports.reportError(String(workspaceOpenErrorMessage(error)));
                    ports.reportError("");
                    const preflight = ports.registrationPreflight(path, cwd, branch);
                    if (!preflight) throw error;
                    if (!workspaceConfirmed(await ports.prompt("Recreate the missing Git worktree registration now? (y/N) "))) throw error;
                    const recovery = ports.recoverRegistration(path, cwd, branch, preflight);
                    if (!recovery.repaired) throw new Error(`Could not recreate the missing Git worktree registration for '${path}'. Workspace files were left unchanged.`
                        + (recovery.failure ? ` Reason: ${ports.safeLiteral(recovery.failure.slice(0, 500))}` : " Reason: Git registration conditions changed during recovery."));
                    ports.report(`Recreated Git worktree registration: ${path}`);
                    ports.assertOwner(path, cwd);
                }
            } else { ports.assertBranch(path, branch, cwd, false); }
            const actualBranch = ports.actualBranch(path) ?? "";
            if (actualBranch && actualBranch !== branch) {
                ports.reportError(`Error: Workspace exists for branch '${actualBranch}', not '${branch}'.`);
                ports.reportError("Different branches map to the same directory due to '/' → '-' conversion.");
                ports.exit(1);
            }
            ports.report(`Using existing workspace: ${path}`);
            for (const repo of ports.repairNested(cwd, path, branch)) ports.report(`  ${repo.name}: worktree (repaired)`);
            const broken = ports.broken(cwd, path);
            if (broken.length > 0) {
                ports.report(`Found ${broken.length} broken worktree(s):`);
                for (const entry of broken) ports.report(`  ${entry.name}: has content but is not a valid worktree`);
                if (workspaceConfirmed(await ports.prompt("Stash content and recreate as proper worktrees? (y/N) "))) {
                    for (const entry of broken) await ports.repairContent(cwd, path, entry.name, branch);
                }
            }
        } else {
            const repos = ports.submoduleRepos(cwd);
            if (repos) {
                ports.report("This directory is not a git repository.");
                ports.report(`Found git repos: ${repos.join(", ")}`);
                if (workspaceConfirmed(await ports.prompt("Initialize as git repo and add them as submodules? (y/N) "))) {
                    try { ports.initSubmodules(cwd); ports.report("Initialized git repo with submodules."); }
                    catch (error) { ports.reportError(`Error: ${workspaceOpenErrorMessage(error)}`); ports.exit(1); }
                }
            }
            ports.report(`Creating workspace for branch '${branch}'...`);
            try {
                const result = ports.create(cwd, branch);
                ports.report(`Workspace created: ${result.workspacePath}`);
                for (const repo of result.created) ports.report(`  ${repo.name}: worktree (${repo.action === "worktree-existing" ? "existing branch" : repo.action === "worktree-remote" ? "from remote" : "new branch"})`);
                for (const name of result.copied) ports.report(`  ${name}: copied`);
            } catch (error) { ports.reportError(`Error: ${workspaceOpenErrorMessage(error)}`); ports.exit(1); }
        }
        ports.assertBranch(path, branch, cwd, true);
        return path;
    }
    async function open(cwd: string, branch: string): Promise<string> {
        const projectId = ports.projectId(ports.path(cwd, branch));
        const run = () => ports.family(projectId, () => attempt(cwd, branch));
        try { return await run(); }
        catch (error) {
            const damage = ports.damage(error);
            if (!damage || damage.repairs.length === 0) throw error;
            ports.reportError(damage.message);
            ports.reportError("");
            for (const repair of damage.repairs) {
                ports.reportError(`  git worktree repair ${repair.checkoutPath}`);
                ports.reportError(`    in ${repair.sourcePath}`);
            }
            if (!workspaceConfirmed(await ports.prompt(`Run ${damage.repairs.length === 1 ? "this" : "these"} now? (y/N) `))) throw error;
            let repairedAny = false;
            for (const repair of damage.repairs) {
                const outcome = ports.repairRegistration(repair);
                ports.reportError(outcome.ok ? `  repaired ${repair.checkoutPath}` : `  could not repair ${repair.checkoutPath}${outcome.detail ? `: ${outcome.detail}` : ""}`);
                repairedAny ||= outcome.ok;
            }
            if (!repairedAny) throw error;
            return await run();
        }
    }
    return { open };
}
