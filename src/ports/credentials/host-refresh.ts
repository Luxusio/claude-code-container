export interface CredentialCommandObservation {
    readonly status: number | null;
}

export type SshCredentialCopyFailureStage = "staging" | "archive-create" | "archive-read" | "extract"
    | "permissions" | "known-hosts" | "completion" | "publication";

export interface SshCredentialCopyObservation extends CredentialCommandObservation {
    readonly failureStage?: SshCredentialCopyFailureStage;
}

export interface HostCredentialRefreshPorts {
    readonly refreshSsh: (target: string) => SshCredentialCopyObservation;
    readonly hostSshSourceExists: () => boolean;
    readonly hostGitConfigExists: () => boolean;
    readonly stageHostGitConfig: (target: string) => CredentialCommandObservation;
    readonly installHostGitConfig: (target: string) => CredentialCommandObservation;
    readonly reportSshRefreshFailure: (stage?: SshCredentialCopyFailureStage) => undefined;
    readonly reportGitCopyFailure: () => undefined;
    readonly reportGitInstallFailure: () => undefined;
}
