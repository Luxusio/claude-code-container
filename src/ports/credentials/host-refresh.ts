export interface CredentialCommandObservation {
    readonly status: number | null;
}

export interface HostCredentialRefreshPorts {
    readonly refreshSsh: (target: string) => CredentialCommandObservation;
    readonly hostSshSourceExists: () => boolean;
    readonly hostGitConfigExists: () => boolean;
    readonly stageHostGitConfig: (target: string) => CredentialCommandObservation;
    readonly installHostGitConfig: (target: string) => CredentialCommandObservation;
    readonly reportSshRefreshFailure: () => undefined;
    readonly reportGitCopyFailure: () => undefined;
    readonly reportGitInstallFailure: () => undefined;
}
