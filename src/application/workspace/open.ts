import type { WorkspaceOpenOutcome } from "../../domain/workspace/open.js";
import type { WorkspaceOpenPorts } from "../../ports/workspace/open.js";

export function createWorkspaceOpen(ports: WorkspaceOpenPorts) {
    async function attempt(cwd: string, branch: string): Promise<WorkspaceOpenOutcome> {
        try { ports.validateBranch(branch); }
        catch (error) { return { kind: "refused", reason: "invalid-branch", error }; }
        const path = ports.path(cwd, branch);
        if (ports.exists(cwd, branch)) {
            if (ports.hasGitMetadata(cwd)) {
                ports.repairRoot(path, cwd, branch);
                try { ports.assertOwner(path, cwd); }
                catch (error) {
                    if (!ports.missingRegistration(error)) throw error;
                    ports.report({ kind: "missing-registration", error });
                    const preflight = ports.registrationPreflight(path, cwd, branch);
                    if (!preflight) throw error;
                    if (!await ports.confirm({ purpose: "missing-registration" })) throw error;
                    const recovery = ports.recoverRegistration(path, cwd, branch, preflight);
                    if (!recovery.repaired) throw ports.recoveryError(path, recovery.failure);
                    ports.report({ kind: "registration-recreated", path });
                    ports.assertOwner(path, cwd);
                }
            } else { ports.assertWorkspace(path, cwd, false); }
            ports.inspectWorkspace(path);
            ports.report({ kind: "existing", path });
            for (const repo of ports.repairNested(cwd, path, branch)) ports.report({ kind: "nested-repaired", repo });
            const broken = ports.broken(cwd, path);
            if (broken.length > 0) {
                ports.report({ kind: "broken-content", entries: broken });
                if (await ports.confirm({ purpose: "broken-content" })) {
                    for (const entry of broken) await ports.repairContent(cwd, path, entry.name, branch);
                }
            }
        } else {
            const repos = ports.submoduleRepos(cwd);
            if (repos) {
                ports.report({ kind: "submodule-candidates", repos });
                if (await ports.confirm({ purpose: "initialize-submodules" })) {
                    try { ports.initSubmodules(cwd); ports.report({ kind: "submodules-initialized" }); }
                    catch (error) { return { kind: "refused", reason: "submodule-initialization-failed", error }; }
                }
            }
            ports.report({ kind: "creating", branch });
            try {
                const result = ports.create(cwd, branch);
                ports.report({ kind: "created", result });
            } catch (error) { return { kind: "refused", reason: "creation-failed", error }; }
        }
        ports.assertWorkspace(path, cwd, true);
        return { kind: "opened", path };
    }
    async function open(cwd: string, branch: string): Promise<WorkspaceOpenOutcome> {
        const projectId = ports.projectId(ports.path(cwd, branch));
        const run = () => ports.family(projectId, () => attempt(cwd, branch));
        try { return await run(); }
        catch (error) {
            const damage = ports.damage(error);
            if (!damage || damage.repairs.length === 0) throw error;
            ports.report({ kind: "damaged-registration", damage });
            if (!await ports.confirm({ purpose: "damaged-registration", repairCount: damage.repairs.length })) throw error;
            let repairedAny = false;
            for (const repair of damage.repairs) {
                const outcome = ports.repairRegistration(repair);
                ports.report({ kind: "registration-repair", repair, outcome });
                repairedAny ||= outcome.ok;
            }
            if (!repairedAny) throw error;
            return await run();
        }
    }
    return { open };
}
