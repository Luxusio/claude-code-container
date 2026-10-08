export interface LocalhostProxyVerifierPorts {
    readonly platform: () => string;
    readonly containerHostRemote: () => boolean;
    readonly directReach: (container: string, timeoutMs: 1500) => {reachable: boolean; latencyMs: number};
    readonly proxyListenerObservation: (container: string) => {error?: unknown; status: number | null};
    readonly debugFlag: () => string | undefined;
    readonly runtimeName: () => string;
    readonly reportDebug: (message: string) => undefined;
    readonly reportWarning: (message: string) => undefined;
}
