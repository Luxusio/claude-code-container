import type { WorkspaceContentRepairAdmissionPorts } from "../../ports/workspace/content-repair-admission.js";

export function createWorkspaceContentRepairAdmission(ports: WorkspaceContentRepairAdmissionPorts) {
    return async function repairBrokenWorktree(
        cwd: string,
        wsPath: string,
        name: string,
        branch: string,
    ): Promise<void> {
        try {
            const fixed = ports.repairConfirmed(cwd, wsPath, name, branch, true);
            ports.selectLog()(fixed
                ? `  ${name}: fixed (content preserved)`
                : `  ${name}: failed to fix (content unchanged)`);
            return;
        } catch (error) {
            if (!ports.isContentConflict(error)) {
                ports.selectLog()(`  ${name}: failed to fix (content unchanged) - ${(error as { message: unknown }).message}`);
                return;
            }
            const relativeConflicts = error.conflicts.map((path) => ports.selectRelative()(error.worktreeRoot, path));
            ports.selectLog()(`  ${name}: cannot merge - these files differ between your copy and branch '${branch}':`);
            for (const conflict of relativeConflicts) ports.selectLog()(`      ${conflict}`);
            ports.selectLog()("      Nothing was changed or lost; the directory is exactly as it was.");
            ports.selectLog()("      ccc can move your versions aside so the branch's versions can be checked out.");
            ports.selectLog()("      Your versions stay on disk and can be moved back or merged by hand.");
            const answer = await ports.prompt("  Move them aside and repair? (y/N) ", true);
            if (answer !== "y" && answer !== "yes") {
                ports.selectLog()(`  ${name}: left unrepaired (content unchanged)`);
                return;
            }
            const preserved = ports.selectSetAside()(error.worktreeRoot, error.conflicts);
            ports.selectLog()(`  ${name}: your versions moved to ${preserved}`);
            try {
                const fixed = ports.repairConfirmed(cwd, wsPath, name, branch, true);
                ports.selectLog()(fixed
                    ? `  ${name}: fixed (remaining content preserved)`
                    : `  ${name}: failed to fix (content unchanged)`);
            } catch (retryError) {
                ports.selectLog()(`  ${name}: failed to fix (content unchanged) - ${(retryError as { message: unknown }).message}`);
                ports.selectLog()(`      Your set-aside versions remain in ${preserved}`);
            }
        }
    };
}
