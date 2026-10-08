export interface CodexDaemonObservation {
    readonly error?: { readonly message?: string };
    readonly signal: string | null;
    readonly status: number | null;
    readonly stdout: unknown;
    readonly stderr: unknown;
}

export interface CodexLaunchPorts<Start> {
    readonly probeDaemonExecutable: () => CodexDaemonObservation;
    readonly prepareStart: () => Start;
    readonly probeDaemonStartHelp: (start: Start) => CodexDaemonObservation;
    readonly initializeDaemon: (start: Start, configuration: string[]) => CodexDaemonObservation;
    readonly probeDaemonFallbackHelp: () => CodexDaemonObservation;
}
