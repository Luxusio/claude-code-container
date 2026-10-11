export interface WorkspaceRegistrationRepair {
    readonly checkoutPath: string;
    readonly sourcePath: string;
}
export interface WorkspaceDamage {
    message: string;
    repairs: readonly WorkspaceRegistrationRepair[];
}
export interface WorkspaceRegistrationPreflight {
    assertUnchanged: (() => undefined) | undefined;
}
export function workspaceConfirmed(answer: string): boolean {
    return answer === "y" || answer === "yes";
}
export function workspaceOpenErrorMessage(error: unknown): unknown {
    return error !== null && (typeof error === "object" || typeof error === "function") && "message" in error
        ? error.message : undefined;
}
