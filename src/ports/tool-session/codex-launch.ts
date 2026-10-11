export type CodexDaemonExecutableObservation =
    | { kind: "missing" | "available-or-inconclusive" }
    | { kind: "engine-unavailable"; cause: unknown };
export type CodexDaemonStartObservation =
    | { kind: "supported" | "unsupported-or-inconclusive" }
    | { kind: "engine-unavailable"; cause: unknown };
export interface CodexInitializationFailure {
    status: number;
    cause: unknown;
}
export type CodexDaemonInitializationObservation =
    | { kind: "success" }
    | ({ kind: "installation-incomplete" | "failure" } & CodexInitializationFailure);

export interface CodexLaunchPorts<Start> {
    readonly probeDaemonExecutable: () => CodexDaemonExecutableObservation;
    readonly prepareStart: () => Start;
    readonly probeDaemonStartHelp: (start: Start) => CodexDaemonStartObservation;
    readonly initializeDaemon: (start: Start, configuration: string[]) => CodexDaemonInitializationObservation;
    readonly probeDaemonFallbackHelp: () => { kind: "supported" | "unsupported" };
    readonly describeInitializationFailure: (error: unknown) => CodexInitializationFailure;
}
