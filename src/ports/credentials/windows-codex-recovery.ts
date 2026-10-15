export type WindowsCodexRecoveryPeer = Readonly<{ id: string }>;

export type WindowsCodexRecoveryUser = { readonly kind: "known"; readonly uid: string }
    | { readonly kind: "unknown" };

/** Synchronous native facts and fixed effects over separate opaque contexts. */
export interface WindowsCodexRecoveryPorts<P, S> {
    readonly probePrivateState: () => "healthy" | "repair-required";
    readonly qualifyPrivateState: () => {
        readonly context: P;
        readonly principal: Readonly<{ uid: string; gid: string }>;
    };
    readonly privateStatePeers: (context: P) => Iterable<WindowsCodexRecoveryPeer>;
    readonly privatePeerUser: (context: P, peer: WindowsCodexRecoveryPeer) => WindowsCodexRecoveryUser;
    readonly repairPrivateState: (context: P) => undefined;
    readonly probeControlSocket: () => "connected-or-absent" | "recognized-disconnected";
    readonly qualifyControlSocket: () => S;
    readonly otherControlSocketPeers: (context: S) => Iterable<WindowsCodexRecoveryPeer>;
    readonly controlPeerServer: (context: S, peer: WindowsCodexRecoveryPeer) => "absent" | "may-be-serving";
    readonly quarantineControlSocket: (context: S) => undefined;
}
