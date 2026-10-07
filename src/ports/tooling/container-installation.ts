export interface ContainerToolObservation {
    readonly status: number | null;
    readonly error?: unknown;
}
export interface ContainerToolProbeObservation extends ContainerToolObservation {
    readonly stdout?: string;
    readonly stderr?: string;
}
export interface CachedNpmObservation extends ContainerToolObservation {
    readonly stdout: string;
}
export interface NpmInstallationDefinition {
    readonly cmd: string;
    readonly pkg: string;
}
export interface BubblewrapSession {
    readonly probe: () => ContainerToolObservation;
    readonly updatePackageIndex: () => ContainerToolObservation;
    readonly install: () => ContainerToolObservation;
}
export interface ContainerToolInstallationPorts<ProbeHandle> {
    readonly prepareClaudeProbe: () => ProbeHandle;
    readonly captureClaudeProbe: () => (target: string, probe: ProbeHandle) => ContainerToolProbeObservation;
    readonly captureClaudeInstall: () => (target: string) => ContainerToolObservation;
    readonly getNpmTools: () => Array<NpmInstallationDefinition>;
    readonly captureNpmProbe: () => (target: string, tool: NpmInstallationDefinition) => ContainerToolProbeObservation;
    readonly captureNpmCachedProbe: () => (target: string, tool: NpmInstallationDefinition) => CachedNpmObservation;
    readonly captureNpmCleanup: () => (target: string, cleanupPattern: string) => ContainerToolObservation;
    readonly captureNpmShimCleanup: () => (target: string, tool: NpmInstallationDefinition) => ContainerToolObservation;
    readonly captureNpmInstall: () => (target: string, tool: NpmInstallationDefinition) => ContainerToolObservation;
    readonly captureNpmReshim: () => (target: string) => ContainerToolObservation;
    readonly captureNpmWrapper: () => (target: string, tool: NpmInstallationDefinition) => ContainerToolObservation;
    readonly createBubblewrapSession: (target: string) => BubblewrapSession;
    readonly captureUvProbe: () => (target: string) => ContainerToolObservation;
    readonly captureUvInstall: () => (target: string) => ContainerToolObservation;
    readonly reportProbeNotes: (stderr: string | undefined, seen: Set<string>) => undefined;
    readonly probeDiagnostic: (stderr: string | undefined) => string;
    readonly sanitizeForTerminal: (text: string) => string;
    readonly captureLog: () => (message: string) => undefined;
    readonly reportUvProgress: () => undefined;
}
