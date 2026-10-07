export interface CodexPreparationParent {
    readonly uid: number;
    readonly isDirectory: () => boolean;
}

export interface CodexPreparationConfig {
    readonly nlink: number;
    readonly isFile: () => boolean;
}

export interface CodexPreparationObservation {
    readonly status: number | null;
    readonly error?: unknown;
}

export interface CodexPreparationPorts {
    readonly resolveConfig: (profile?: string) => string;
    readonly hasHostIdentity: () => boolean;
    readonly inspectParent: (config: string) => CodexPreparationParent;
    readonly inspectConfig: (config: string) => CodexPreparationConfig;
    readonly currentHostUid: () => number;
    readonly mappedContainerUid: (target: string) => string;
    readonly probeDirectory: (target: string, configFile: string) => CodexPreparationObservation;
    readonly repairDirectory: (target: string, configFile: string, mappedUid: string) => CodexPreparationObservation;
    readonly verifyDirectory: (target: string, configFile: string) => CodexPreparationObservation;
    readonly probeConfig: (target: string, configFile: string) => CodexPreparationObservation;
    readonly repairConfig: (target: string, configFile: string, mappedUid: string) => CodexPreparationObservation;
    readonly verifyConfig: (target: string, configFile: string) => CodexPreparationObservation;
}
