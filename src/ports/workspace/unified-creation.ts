import type { WorktreeCreationAction, WorktreeRepoResult } from "../../domain/workspace/creation-result.js";
import type { WorktreeAdditionPorts } from "./worktree-addition.js";

export interface UnifiedCreationRequest {
    readonly repositoryPath: string;
    readonly destinationPath: string;
    readonly branch: string;
}

export interface UnifiedCreationPorts<Prepared, RegistrationReceipt>
    extends WorktreeAdditionPorts<Prepared, RegistrationReceipt> {
    readonly requireRootRegistration: (
        receipt: RegistrationReceipt | null,
        request: UnifiedCreationRequest,
    ) => RegistrationReceipt;
    readonly sourceWorkspaceName: (request: UnifiedCreationRequest) => string;
    readonly repairNestedWorktrees: (request: UnifiedCreationRequest) => WorktreeRepoResult[];
    readonly rootWorktreeMatches: (request: UnifiedCreationRequest) => boolean;
    readonly removeRegisteredRoot: (request: UnifiedCreationRequest, registration: RegistrationReceipt) => void;
    readonly rollbackCreatedRootBranch: (
        request: UnifiedCreationRequest,
        action: WorktreeCreationAction,
        prepared: Prepared,
    ) => void;
}
