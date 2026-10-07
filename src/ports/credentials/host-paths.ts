export interface CredentialDirectoryOptions {
    readonly recursive: true;
    readonly mode?: number;
}

export interface HostCredentialPathPorts {
    readonly readContainerEnvironment: () => string | undefined;
    readonly readVitestEnvironment: () => string | undefined;
    readonly claudeProfilePath: (profile?: string) => string;
    readonly codexProfilePath: (profile?: string) => string;
    readonly homeDirectory: () => string;
    readonly joinHostPath: (base: string, relative: string) => string;
    readonly createDirectory: (path: string, options: CredentialDirectoryOptions) => undefined;
    readonly packageParentPath: (path: string) => string;
    readonly packageBasename: (path: string) => string;
}
