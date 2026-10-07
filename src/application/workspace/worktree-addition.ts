import type {
    WorktreeAdditionAction,
    WorktreeAdditionPorts,
    WorktreeAdditionRequest,
    WorktreeAdditionResult,
} from "../../ports/workspace/worktree-addition.js";

export type {
    WorktreeAdditionAction,
    WorktreeAdditionRequest,
    WorktreeAdditionObservation,
    WorktreeAdditionPorts,
    WorktreeAdditionResult,
} from "../../ports/workspace/worktree-addition.js";

export function createWorktreeAddition<Prepared, RegistrationReceipt>(
    ports: WorktreeAdditionPorts<Prepared, RegistrationReceipt>,
): (request: WorktreeAdditionRequest) => WorktreeAdditionResult<Prepared, RegistrationReceipt> {
    for (const name of ["observeBranch", "prepareAddition", "addPrepared", "compensateFailedAddition"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Worktree addition requires a callable ${name} port.`);
        }
    }

    return (request) => {
        const existence = ports.observeBranch(request);
        let action: WorktreeAdditionAction;
        switch (existence) {
            case "local":
                action = "worktree-existing";
                break;
            case "remote":
                action = "worktree-remote";
                break;
            case "none":
                action = "worktree-new";
                break;
        }
        const prepared = ports.prepareAddition(request, action);
        const observation = ports.addPrepared(request, prepared);
        if (observation.status !== 0) {
            const stderr = (observation.stderr ?? "").trim() || observation.error?.message || "";
            const prefix = request.failureContext.kind === "unified"
                ? "Failed to create worktree"
                : `Failed to create worktree for ${request.failureContext.repositoryName}`;
            try {
                ports.compensateFailedAddition(request, action, prepared, observation.registrationReceipt);
            } catch (rollbackError) {
                throw new Error(
                    `${prefix}: ${stderr}; rollback failed: ${(rollbackError as Error).message}`,
                    { cause: rollbackError },
                );
            }
            throw new Error(`${prefix}: ${stderr}`);
        }
        return { action, prepared, registrationReceipt: observation.registrationReceipt };
    };
}
