export interface LocalhostProxyVerifierPorts {
    readonly platform: () => string;
    readonly containerHostRemote: () => boolean;
    readonly directReach: (container: string, timeoutMs: 1500) => {reachable: boolean; latencyMs: number};
    readonly proxyListenerPresent: (container: string) => boolean;
    readonly debugFlag: () => string | undefined;
    readonly reportDirectReachable: (latencyMs: number) => undefined;
    readonly reportUnavailable: (container: string) => undefined;
}
