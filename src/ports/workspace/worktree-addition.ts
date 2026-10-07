export type WorktreeAdditionAction = "worktree-existing" | "worktree-remote" | "worktree-new";

export interface WorktreeAdditionRequest {
    readonly repositoryPath: string;
    readonly destinationPath: string;
    readonly branch: string;
    readonly failureContext: { readonly kind: "unified" }
        | { readonly kind: "multi-repo"; readonly repositoryName: string };
}

export interface WorktreeAdditionObservation<RegistrationReceipt> {
    readonly status: number | null;
    readonly stderr?: string | null;
    readonly error?: { readonly message: string };
    readonly registrationReceipt: RegistrationReceipt | null;
}

export interface WorktreeAdditionPorts<Prepared, RegistrationReceipt> {
    readonly observeBranch: (request: WorktreeAdditionRequest) => "local" | "remote" | "none";
    readonly prepareAddition: (request: WorktreeAdditionRequest, action: WorktreeAdditionAction) => Prepared;
    readonly addPrepared: (request: WorktreeAdditionRequest, prepared: Prepared) => WorktreeAdditionObservation<RegistrationReceipt>;
    readonly compensateFailedAddition: (
        request: WorktreeAdditionRequest,
        action: WorktreeAdditionAction,
        prepared: Prepared,
        registrationReceipt: RegistrationReceipt | null,
    ) => void;
}

export interface WorktreeAdditionResult<Prepared, RegistrationReceipt> {
    readonly action: WorktreeAdditionAction;
    readonly prepared: Prepared;
    readonly registrationReceipt: RegistrationReceipt | null;
}
