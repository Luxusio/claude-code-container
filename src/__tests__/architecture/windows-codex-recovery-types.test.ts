import { expect, it } from "vitest";
import { createWindowsCodexRecovery } from "../../application/credentials/windows-codex-recovery.js";
import type { WindowsCodexRecoveryPeer, WindowsCodexRecoveryPorts, WindowsCodexRecoveryUser } from "../../ports/credentials/windows-codex-recovery.js";
import type * as Native from "../../adapters/windows-credential-access.js";

type PrivateContext = { readonly privateContext: unique symbol };
type SocketContext = { readonly socketContext: unique symbol };

function contracts(ports: WindowsCodexRecoveryPorts<PrivateContext, SocketContext>,
    privateContext: PrivateContext, socketContext: SocketContext, peer: WindowsCodexRecoveryPeer, native: typeof Native) {
    const app = createWindowsCodexRecovery(ports);
    const done: undefined = app.run();
    const publicDone: void = native.repairWindowsCodexPrivateState("runtime", "target");
    const qualified: { readonly context: PrivateContext; readonly principal: { readonly uid: string; readonly gid: string } } = ports.qualifyPrivateState();
    const privatePeers: Iterable<WindowsCodexRecoveryPeer> = ports.privateStatePeers(privateContext);
    const socketPeers: Iterable<WindowsCodexRecoveryPeer> = ports.otherControlSocketPeers(socketContext);
    const user: WindowsCodexRecoveryUser = ports.privatePeerUser(privateContext, peer);
    const repaired: undefined = ports.repairPrivateState(privateContext);
    const quarantined: undefined = ports.quarantineControlSocket(socketContext);
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, privateStatePeers: function* () { yield { id: "lazy" }; }, otherControlSocketPeers: () => new Set([{ id: "finite" }]) });
    // @ts-expect-error Factory requires explicit capabilities.
    createWindowsCodexRecovery();
    // @ts-expect-error Private ownership probe is required.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, probePrivateState: undefined });
    // @ts-expect-error Private qualification is required.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, qualifyPrivateState: undefined });
    // @ts-expect-error Ordered private peer facts are required.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, privateStatePeers: undefined });
    // @ts-expect-error Private peer user observation is required.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, privatePeerUser: undefined });
    // @ts-expect-error Private repair effect is required.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, repairPrivateState: undefined });
    // @ts-expect-error Socket probe is required.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, probeControlSocket: undefined });
    // @ts-expect-error Socket qualification is required.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, qualifyControlSocket: undefined });
    // @ts-expect-error Ordered socket peer facts are required.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, otherControlSocketPeers: undefined });
    // @ts-expect-error Server observation is required.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, controlPeerServer: undefined });
    // @ts-expect-error Socket quarantine effect is required.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, quarantineControlSocket: undefined });
    // @ts-expect-error Facts are callable, not encoded status values.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, probePrivateState: "healthy" });
    // @ts-expect-error Effects are callable.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, repairPrivateState: 0 });
    // @ts-expect-error Ownership facts complete synchronously.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, probePrivateState: async () => "healthy" });
    // @ts-expect-error Private qualification completes synchronously.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, qualifyPrivateState: async () => qualified });
    // @ts-expect-error Private peers are synchronous iterables.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, privateStatePeers: async function* () { yield peer; } });
    // @ts-expect-error User observation completes synchronously.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, privatePeerUser: async () => ({ kind: "unknown" }) });
    // @ts-expect-error Private effect must complete synchronously.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, repairPrivateState: async () => undefined });
    // @ts-expect-error Permissive void does not prove private effect completion.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, repairPrivateState: (): void => {} });
    // @ts-expect-error Private effect cannot return an outcome.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, repairPrivateState: () => true });
    // @ts-expect-error Socket probe completes synchronously.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, probeControlSocket: async () => "connected-or-absent" });
    // @ts-expect-error Socket qualification completes synchronously.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, qualifyControlSocket: async () => socketContext });
    // @ts-expect-error Socket peers are synchronous iterables.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, otherControlSocketPeers: async () => [peer] });
    // @ts-expect-error Server observation completes synchronously.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, controlPeerServer: async () => "absent" });
    // @ts-expect-error Socket effect must complete synchronously.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, quarantineControlSocket: async () => undefined });
    // @ts-expect-error Permissive void does not prove socket effect completion.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, quarantineControlSocket: (): void => {} });
    // @ts-expect-error Socket effect cannot return an outcome.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, quarantineControlSocket: () => "done" });
    // @ts-expect-error Literal UID strings must not be coerced to numbers.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, qualifyPrivateState: () => ({ context: privateContext, principal: { uid: 1000, gid: "1000" } }) });
    // @ts-expect-error Both principal identities are required strings.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, qualifyPrivateState: () => ({ context: privateContext, principal: { uid: "1000" } }) });
    // @ts-expect-error Known users require a literal UID string.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, privatePeerUser: () => ({ kind: "known", uid: 1000 }) });
    // @ts-expect-error JSON text is not an iterable of semantic peer facts.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, privateStatePeers: () => "[]" });
    // @ts-expect-error A peer identity is mandatory.
    createWindowsCodexRecovery<PrivateContext, SocketContext>({ ...ports, otherControlSocketPeers: () => [{}] });
    // @ts-expect-error Socket contexts cannot qualify private effects.
    ports.repairPrivateState(socketContext);
    // @ts-expect-error Private contexts cannot qualify socket effects.
    ports.quarantineControlSocket(privateContext);
    // @ts-expect-error Private peer observations retain their own opaque context.
    ports.privatePeerUser(socketContext, peer);
    // @ts-expect-error Socket peer observations retain their own opaque context.
    ports.controlPeerServer(privateContext, peer);
    // @ts-expect-error Native context internals do not become a principal fact.
    qualified.context.uid;
    // @ts-expect-error Native process results do not enter inward ports.
    ports.spawnSync("runtime", ["inspect"]);
    // @ts-expect-error Platform gating stays outside the application contract.
    ports.platform();
    // @ts-expect-error Ports are readonly capabilities.
    ports.probePrivateState = () => "healthy";
    // @ts-expect-error Peer facts are readonly.
    peer.id = "replacement";
    // @ts-expect-error Public facade remains void, not strict undefined.
    const stricter: undefined = native.repairWindowsCodexPrivateState("runtime", "target");
    // @ts-expect-error Application completion is synchronous.
    const pending: Promise<void> = app.run();
    // @ts-expect-error A run has no native target input or defaults to configure.
    app.run("target");
    // @ts-expect-error A public facade still requires both string arguments.
    native.repairWindowsCodexPrivateState("runtime");
    void [done, publicDone, qualified, privatePeers, socketPeers, user, repaired, quarantined, stricter, pending];
}
void contracts;

it("accepts a finite synchronous capability set without ambient defaults", () => {
    const app = createWindowsCodexRecovery<never, never>({
        probePrivateState: () => "healthy",
        qualifyPrivateState: () => { throw new Error("unexpected private qualification"); },
        privateStatePeers: () => { throw new Error("unexpected private peers"); },
        privatePeerUser: () => { throw new Error("unexpected user probe"); },
        repairPrivateState: () => { throw new Error("unexpected private repair"); },
        probeControlSocket: () => "connected-or-absent",
        qualifyControlSocket: () => { throw new Error("unexpected socket qualification"); },
        otherControlSocketPeers: () => { throw new Error("unexpected socket peers"); },
        controlPeerServer: () => { throw new Error("unexpected server probe"); },
        quarantineControlSocket: () => { throw new Error("unexpected quarantine"); },
    });
    expect(app.run()).toBeUndefined();
});
