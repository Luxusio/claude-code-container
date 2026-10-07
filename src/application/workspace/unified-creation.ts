import { createWorktreeAddition } from "./worktree-addition.js";
import type { WorktreeRepoResult, WorktreeResult } from "../../domain/workspace/creation-result.js";
import type { UnifiedCreationPorts, UnifiedCreationRequest } from "../../ports/workspace/unified-creation.js";

export type { WorktreeCreationAction, WorktreeRepoResult, WorktreeResult } from "../../domain/workspace/creation-result.js";
export type { UnifiedCreationPorts, UnifiedCreationRequest } from "../../ports/workspace/unified-creation.js";

export function createUnifiedWorkspaceCreation<Prepared, RegistrationReceipt>(
    ports: UnifiedCreationPorts<Prepared, RegistrationReceipt>,
): (request: UnifiedCreationRequest) => WorktreeResult {
    for (const name of [
        "requireRootRegistration", "sourceWorkspaceName", "repairNestedWorktrees",
        "rootWorktreeMatches", "removeRegisteredRoot", "rollbackCreatedRootBranch",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Unified workspace creation requires a callable ${name} port.`);
        }
    }
    const addWorktree = createWorktreeAddition(ports);

    return (request) => {
        const { action, prepared, registrationReceipt } = addWorktree({
            ...request,
            failureContext: { kind: "unified" },
        });
        const rootRegistration = ports.requireRootRegistration(registrationReceipt, request);
        const dirName = ports.sourceWorkspaceName(request);
        let nestedCreated: WorktreeRepoResult[];
        try {
            nestedCreated = ports.repairNestedWorktrees(request);
        } catch (error) {
            const rollbackErrors: string[] = [];
            try {
                if (!ports.rootWorktreeMatches(request)) {
                    throw new Error("root worktree ownership changed during rollback");
                }
                ports.removeRegisteredRoot(request, rootRegistration);
                ports.rollbackCreatedRootBranch(request, action, prepared);
            } catch (rollbackError) {
                rollbackErrors.push((rollbackError as Error).message);
            }
            if (rollbackErrors.length > 0) {
                throw new Error(
                    `${(error as Error).message}; workspace rollback failed: ${rollbackErrors.join("; ")}`,
                    { cause: error },
                );
            }
            throw error;
        }

        return {
            workspacePath: request.destinationPath,
            created: [{ name: dirName, branch: request.branch, action }, ...nestedCreated],
            copied: [],
        };
    };
}
