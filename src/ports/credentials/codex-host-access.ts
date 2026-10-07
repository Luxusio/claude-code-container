export interface HostDirectoryObservation {
    readonly uid: number;
    readonly isDirectory: () => boolean;
}

export interface HostConfigObservation {
    readonly isFile: () => boolean;
}

export interface CodexHostAccessPorts {
    readonly resolveConfig: (profile?: string) => string;
    readonly accessConfig: (config: string) => undefined;
    readonly hasHostIdentity: () => boolean;
    readonly inspectParent: (config: string) => HostDirectoryObservation;
    readonly inspectConfig: (config: string) => HostConfigObservation;
    readonly currentHostUid: () => number;
    readonly repairConfig: (target: string, config: string) => undefined;
    readonly warn: (config: string, reason: unknown) => undefined;
}
