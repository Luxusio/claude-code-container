import type { WindowsCodexRecoveryPorts } from "../../ports/credentials/windows-codex-recovery.js";

export function createWindowsCodexRecovery<P, S>(ports: WindowsCodexRecoveryPorts<P, S>): { readonly run: () => undefined } {
    function run(): undefined {
        if (ports.probePrivateState() === "repair-required") {
            const { context, principal } = ports.qualifyPrivateState();
            for (const peer of ports.privateStatePeers(context)) {
                const user = ports.privatePeerUser(context, peer);
                if (user.kind === "unknown" || user.uid !== principal.uid) {
                    throw new Error("Codex private state is still used by a container with another user; stop that container before retrying");
                }
            }
            ports.repairPrivateState(context);
        }
        if (ports.probeControlSocket() === "recognized-disconnected") {
            const context = ports.qualifyControlSocket();
            for (const peer of ports.otherControlSocketPeers(context)) {
                if (ports.controlPeerServer(context, peer) === "may-be-serving") {
                    throw new Error("A different container may still use this Codex control socket; its running server was preserved");
                }
            }
            ports.quarantineControlSocket(context);
        }
        return undefined;
    }
    return { run };
}
