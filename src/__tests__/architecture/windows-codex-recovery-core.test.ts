import { describe, expect, it } from "vitest";
import { createWindowsCodexRecovery } from "../../application/credentials/windows-codex-recovery.js";
import type { WindowsCodexRecoveryPorts } from "../../ports/credentials/windows-codex-recovery.js";

const otherUser = "Codex private state is still used by a container with another user; stop that container before retrying";
const runningServer = "A different container may still use this Codex control socket; its running server was preserved";

describe("Windows Codex recovery application", () => {
    it("observes nothing during construction and follows healthy ownership with the socket probe", () => {
        const trace: string[] = [];
        const ports: WindowsCodexRecoveryPorts<never, never> = {
            probePrivateState: () => { trace.push("ownership"); return "healthy"; },
            qualifyPrivateState: () => { throw new Error("unexpected private qualification"); },
            privateStatePeers: () => { throw new Error("unexpected private peers"); },
            privatePeerUser: () => { throw new Error("unexpected user probe"); },
            repairPrivateState: () => { throw new Error("unexpected private repair"); },
            probeControlSocket: () => { trace.push("socket"); return "connected-or-absent"; },
            qualifyControlSocket: () => { throw new Error("unexpected socket qualification"); },
            otherControlSocketPeers: () => { throw new Error("unexpected socket peers"); },
            controlPeerServer: () => { throw new Error("unexpected server probe"); },
            quarantineControlSocket: () => { throw new Error("unexpected quarantine"); },
        };
        const app = createWindowsCodexRecovery(ports);
        expect(trace).toEqual([]);
        expect(app.run()).toBeUndefined();
        expect(trace).toEqual(["ownership", "socket"]);
    });

    it("authorizes every literal private UID before repairing, then qualifies a separate socket context", () => {
        const privateContext = Symbol("private-native-context");
        const socketContext = { nativeSocket: Symbol("socket-native-context") };
        const trace: unknown[] = [];
        const ports: WindowsCodexRecoveryPorts<typeof privateContext, typeof socketContext> = {
            probePrivateState: () => { trace.push("ownership"); return "repair-required"; },
            qualifyPrivateState: () => { trace.push("private qualification"); return { context: privateContext, principal: { uid: "0009007199254740993", gid: "99999999999999999999" } }; },
            privateStatePeers: function* (context) {
                trace.push(["private peers", context]); yield { id: "target" };
                trace.push("private next"); yield { id: "alias-peer" };
            },
            privatePeerUser: (context, peer) => { trace.push(["user", context, peer.id]); return { kind: "known", uid: "0009007199254740993" }; },
            repairPrivateState: context => { trace.push(["repair", context]); return undefined; },
            probeControlSocket: () => { trace.push("socket"); return "recognized-disconnected"; },
            qualifyControlSocket: () => { trace.push("socket qualification"); return socketContext; },
            otherControlSocketPeers: function* (context) {
                trace.push(["socket peers", context]); yield { id: "other-a" };
                trace.push("socket next"); yield { id: "other-b" };
            },
            controlPeerServer: (context, peer) => { trace.push(["server", context, peer.id]); return "absent"; },
            quarantineControlSocket: context => { trace.push(["quarantine", context]); return undefined; },
        };
        expect(createWindowsCodexRecovery(ports).run()).toBeUndefined();
        expect(trace).toEqual([
            "ownership", "private qualification", ["private peers", privateContext],
            ["user", privateContext, "target"], "private next", ["user", privateContext, "alias-peer"], ["repair", privateContext],
            "socket", "socket qualification", ["socket peers", socketContext],
            ["server", socketContext, "other-a"], "socket next", ["server", socketContext, "other-b"], ["quarantine", socketContext],
        ]);
    });

    it.each([
        { name: "unknown user", user: { kind: "unknown" } as const },
        { name: "different user", user: { kind: "known", uid: "1001" } as const },
        { name: "numerically equal UID with different spelling", user: { kind: "known", uid: "1000" } as const },
    ])("refuses the first $name before requesting another private peer or any effect", ({ user }) => {
        const context = Symbol("private"); const trace: string[] = [];
        const ports: WindowsCodexRecoveryPorts<typeof context, never> = {
            probePrivateState: () => "repair-required",
            qualifyPrivateState: () => ({ context, principal: { uid: "001000", gid: "1000" } }),
            privateStatePeers: function* () { trace.push("first"); yield { id: "first" }; throw new Error("trailing peer must stay unread"); },
            privatePeerUser: (actual, peer) => { expect(actual).toBe(context); trace.push(peer.id + ":user"); return user; },
            repairPrivateState: () => { throw new Error("unexpected repair"); },
            probeControlSocket: () => { throw new Error("unexpected socket probe"); },
            qualifyControlSocket: () => { throw new Error("unexpected socket qualification"); },
            otherControlSocketPeers: () => { throw new Error("unexpected socket peers"); },
            controlPeerServer: () => { throw new Error("unexpected server probe"); },
            quarantineControlSocket: () => { throw new Error("unexpected quarantine"); },
        };
        expect(() => createWindowsCodexRecovery(ports).run()).toThrow(otherUser);
        expect(trace).toEqual(["first", "first:user"]);
    });

    it("propagates a trailing private observation failure after probing the first permitted peer", () => {
        const fault = { nativeRecord: "private trailing structure" }; const trace: string[] = [];
        const ports: WindowsCodexRecoveryPorts<string, never> = {
            probePrivateState: () => "repair-required",
            qualifyPrivateState: () => ({ context: "private", principal: { uid: "0", gid: "0" } }),
            privateStatePeers: function* () { yield { id: "allowed" }; trace.push("next record"); throw fault; },
            privatePeerUser: (_context, peer) => { trace.push(peer.id); return { kind: "known", uid: "0" }; },
            repairPrivateState: () => { throw new Error("unexpected repair"); },
            probeControlSocket: () => { throw new Error("unexpected socket probe"); },
            qualifyControlSocket: () => { throw new Error("unexpected socket qualification"); },
            otherControlSocketPeers: () => { throw new Error("unexpected socket peers"); },
            controlPeerServer: () => { throw new Error("unexpected server probe"); },
            quarantineControlSocket: () => { throw new Error("unexpected quarantine"); },
        };
        try { createWindowsCodexRecovery(ports).run(); throw new Error("missing failure"); }
        catch (actual) { expect(actual).toBe(fault); }
        expect(trace).toEqual(["allowed", "next record"]);
    });

    it("refuses the first possible server before advancing socket peers or quarantining", () => {
        const context = Symbol("socket"); const trace: string[] = [];
        const ports: WindowsCodexRecoveryPorts<never, typeof context> = {
            probePrivateState: () => "healthy",
            qualifyPrivateState: () => { throw new Error("unexpected private qualification"); },
            privateStatePeers: () => { throw new Error("unexpected private peers"); },
            privatePeerUser: () => { throw new Error("unexpected user probe"); },
            repairPrivateState: () => { throw new Error("unexpected repair"); },
            probeControlSocket: () => "recognized-disconnected",
            qualifyControlSocket: () => context,
            otherControlSocketPeers: function* () { trace.push("first"); yield { id: "possibly-live" }; throw new Error("trailing peer must stay unread"); },
            controlPeerServer: (actual, peer) => { expect(actual).toBe(context); trace.push(peer.id); return "may-be-serving"; },
            quarantineControlSocket: () => { throw new Error("unexpected quarantine"); },
        };
        expect(() => createWindowsCodexRecovery(ports).run()).toThrow(runningServer);
        expect(trace).toEqual(["first", "possibly-live"]);
    });

    it("propagates a trailing socket observation failure after checking the first absent server", () => {
        const fault = { nativeRecord: "socket trailing structure" }; const trace: string[] = [];
        const ports: WindowsCodexRecoveryPorts<never, string> = {
            probePrivateState: () => "healthy",
            qualifyPrivateState: () => { throw new Error("unexpected private qualification"); },
            privateStatePeers: () => { throw new Error("unexpected private peers"); },
            privatePeerUser: () => { throw new Error("unexpected user probe"); },
            repairPrivateState: () => { throw new Error("unexpected repair"); },
            probeControlSocket: () => "recognized-disconnected",
            qualifyControlSocket: () => "socket",
            otherControlSocketPeers: function* () { yield { id: "absent" }; trace.push("next record"); throw fault; },
            controlPeerServer: (_context, peer) => { trace.push(peer.id); return "absent"; },
            quarantineControlSocket: () => { throw new Error("unexpected quarantine"); },
        };
        try { createWindowsCodexRecovery(ports).run(); throw new Error("missing failure"); }
        catch (actual) { expect(actual).toBe(fault); }
        expect(trace).toEqual(["absent", "next record"]);
    });

    it("retains a partial private effect and its raw failure without starting socket recovery", () => {
        const fault = { partialOwnershipWrite: true }; const written: string[] = [];
        const ports: WindowsCodexRecoveryPorts<string, never> = {
            probePrivateState: () => "repair-required",
            qualifyPrivateState: () => ({ context: "private", principal: { uid: "1000", gid: "1000" } }),
            privateStatePeers: () => [],
            privatePeerUser: () => { throw new Error("unexpected user probe"); },
            repairPrivateState: context => { written.push(context); throw fault; },
            probeControlSocket: () => { throw new Error("unexpected socket probe"); },
            qualifyControlSocket: () => { throw new Error("unexpected socket qualification"); },
            otherControlSocketPeers: () => { throw new Error("unexpected socket peers"); },
            controlPeerServer: () => { throw new Error("unexpected server probe"); },
            quarantineControlSocket: () => { throw new Error("unexpected quarantine"); },
        };
        try { createWindowsCodexRecovery(ports).run(); throw new Error("missing failure"); }
        catch (actual) { expect(actual).toBe(fault); }
        expect(written).toEqual(["private"]);
    });

    it("retains completed private repair when quarantine fails without replay or rollback", () => {
        const fault = { partialQuarantine: true }; const trace: string[] = [];
        const ports: WindowsCodexRecoveryPorts<string, number> = {
            probePrivateState: () => "repair-required",
            qualifyPrivateState: () => ({ context: "private", principal: { uid: "1000", gid: "1000" } }),
            privateStatePeers: () => [],
            privatePeerUser: () => { throw new Error("unexpected user probe"); },
            repairPrivateState: context => { trace.push("repair:" + context); return undefined; },
            probeControlSocket: () => { trace.push("socket probe"); return "recognized-disconnected"; },
            qualifyControlSocket: () => 7,
            otherControlSocketPeers: () => [],
            controlPeerServer: () => { throw new Error("unexpected server probe"); },
            quarantineControlSocket: context => { trace.push("quarantine:" + context); throw fault; },
        };
        try { createWindowsCodexRecovery(ports).run(); throw new Error("missing failure"); }
        catch (actual) { expect(actual).toBe(fault); }
        expect(trace).toEqual(["repair:private", "socket probe", "quarantine:7"]);
    });

    it("stops immediately at an ownership observation failure", () => {
        const fault = Symbol("ownership native failure");
        const ports: WindowsCodexRecoveryPorts<never, never> = {
            probePrivateState: () => { throw fault; },
            qualifyPrivateState: () => { throw new Error("unexpected private qualification"); },
            privateStatePeers: () => { throw new Error("unexpected private peers"); },
            privatePeerUser: () => { throw new Error("unexpected user probe"); },
            repairPrivateState: () => { throw new Error("unexpected repair"); },
            probeControlSocket: () => { throw new Error("unexpected socket probe"); },
            qualifyControlSocket: () => { throw new Error("unexpected socket qualification"); },
            otherControlSocketPeers: () => { throw new Error("unexpected socket peers"); },
            controlPeerServer: () => { throw new Error("unexpected server probe"); },
            quarantineControlSocket: () => { throw new Error("unexpected quarantine"); },
        };
        try { createWindowsCodexRecovery(ports).run(); throw new Error("missing failure"); }
        catch (actual) { expect(actual).toBe(fault); }
    });

    it("reobserves both phases with fresh opaque contexts on every run", () => {
        let generation = 0; const trace: string[] = [];
        const ports: WindowsCodexRecoveryPorts<{ generation: number }, string> = {
            probePrivateState: () => { generation++; trace.push("ownership:" + generation); return "repair-required"; },
            qualifyPrivateState: () => ({ context: { generation }, principal: { uid: "1000", gid: "1000" } }),
            privateStatePeers: () => [],
            privatePeerUser: () => { throw new Error("unexpected user probe"); },
            repairPrivateState: context => { trace.push("repair:" + context.generation); return undefined; },
            probeControlSocket: () => { trace.push("socket:" + generation); return "recognized-disconnected"; },
            qualifyControlSocket: () => "socket:" + generation,
            otherControlSocketPeers: () => [],
            controlPeerServer: () => { throw new Error("unexpected server probe"); },
            quarantineControlSocket: context => { trace.push("quarantine:" + context); return undefined; },
        };
        const app = createWindowsCodexRecovery(ports);
        expect(app.run()).toBeUndefined(); expect(app.run()).toBeUndefined();
        expect(trace).toEqual(["ownership:1", "repair:1", "socket:1", "quarantine:socket:1", "ownership:2", "repair:2", "socket:2", "quarantine:socket:2"]);
    });
});
