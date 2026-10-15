import { describe, expect, it } from "vitest";
import { createContainerMountVerification } from "../../application/container-mount-verification.js";
import type { LiveSourceProof, MountVerification, ObservedMountContract, RequiredMountContract } from "../../bind-mount-verification.js";
import type { ContainerMountSourceFacts, ContainerMountVerificationPorts, CreatedMountObservation } from "../../ports/container-mount-verification.js";

const filesystem: RequiredMountContract = { containerPath: "/project", type: "bind", readonly: false, presence: "core", sourceKind: "filesystem" };
const daemon: RequiredMountContract = { containerPath: "/manager", type: "bind", readonly: false, presence: "core", sourceKind: "daemon" };
const verifiedIdentity: LiveSourceProof = { kind: "verified", via: "identity" };
const verifiedDaemon: LiveSourceProof = { kind: "verified", via: "daemon" };
function daemonFacts(overrides: Partial<{ generalPathMatch: "match" | "mismatch" | "unavailable"; literalSourceMatch: boolean; requireLiteralSource: boolean; requireDaemonProofOnMatch: boolean }> = {}): ContainerMountSourceFacts {
    return { kind: "daemon", generalPathMatch: "match", literalSourceMatch: true, requireLiteralSource: false, requireDaemonProofOnMatch: false, ...overrides };
}
function fixture(required: RequiredMountContract[] = [filesystem]) {
    const trace: string[] = [];
    const observed: ObservedMountContract[] = required.map(mount => ({ containerPath: mount.containerPath, type: mount.type ?? "bind", writable: !mount.readonly, sourceState: mount.sourceKind === "none" ? "empty" : "present" }));
    const source = new Map<string, ContainerMountSourceFacts>(required.map(mount => [mount.containerPath,
        mount.sourceKind === "filesystem" ? { kind: "filesystem", pathMatch: "match" } : mount.sourceKind === "volume" ? { kind: "volume", matches: true } : mount.sourceKind === "none" ? { kind: "none" } : { ...daemonFacts(), kind: mount.sourceKind } as ContainerMountSourceFacts]));
    const state = {
        host: verifiedIdentity as LiveSourceProof,
        proof: verifiedIdentity as LiveSourceProof,
        daemonProof: verifiedDaemon as LiveSourceProof,
        created: { kind: "observed", containerId: "captured-id", projectMountIdentity: "project-identity", mounts: observed } as CreatedMountObservation,
        inspections: [] as CreatedMountObservation[],
        finalDaemon: false,
        runFinalRetry: false,
        cleanupFailure: undefined as unknown,
    };
    const retryDecisions: boolean[] = [];
    const ports: ContainerMountVerificationPorts = {
        observeHostIdentity: path => { trace.push("host:" + path); return state.host; },
        observeSource: path => { trace.push("source:" + path); const facts = source.get(path); if (!facts) throw new Error("missing fixture facts"); return facts; },
        proveFilesystem: (path, final) => { trace.push("proof:" + path + ":" + final); return state.proof; },
        proveDaemon: () => { trace.push("daemon"); return state.daemonProof; },
        resetAttempt: () => { trace.push("reset"); },
        cleanup: () => { trace.push("cleanup"); if (state.cleanupFailure) throw state.cleanupFailure; },
        inspectCreated: () => { trace.push("inspect"); return state.inspections.shift() ?? state.created; },
        requiresFinalDaemonProof: () => state.finalDaemon,
        withRetry: (operation, isRetryable) => {
            const result = operation(false);
            const retry = isRetryable(result); retryDecisions.push(retry);
            return retry && state.runFinalRetry ? operation(true) : result;
        },
    };
    return { state, source, observed, trace, retryDecisions, ports, app: createContainerMountVerification(required, ports) };
}
const mismatch = (reason: string, path = filesystem.containerPath): MountVerification => ({ kind: "mismatch", reason, containerPath: path });

describe("container mount semantic admission", () => {
    it("constructs lazily and verifies a matching filesystem only after current identity and live proof", () => {
        const f = fixture();
        expect(f.trace).toEqual([]);
        expect(f.app.verifyExisting(f.observed, "strict")).toEqual(verifiedIdentity);
        expect(f.trace).toEqual(["reset", "host:/project", "source:/project", "proof:/project:false", "cleanup"]);
        expect(f.retryDecisions).toEqual([false]);
    });

    it.each(["malformed destination", "invalid source", "duplicate", "unexpected"])("refuses %s before observing host or proving sources", fault => {
        const f = fixture();
        if (fault === "malformed destination") f.observed[0].containerPath = null;
        if (fault === "invalid source") f.observed[0].sourceState = "invalid";
        if (fault === "duplicate") f.observed.push({ ...f.observed[0] });
        if (fault === "unexpected") f.observed.push({ ...f.observed[0], containerPath: "/foreign" });
        expect(f.app.verifyExisting(f.observed, "strict").kind).toBe("mismatch");
        expect(f.trace).toEqual(["reset", "cleanup"]);
    });

    it("changed host identity prevents alias or challenge observations", () => {
        const f = fixture(); f.state.host = { kind: "mismatch", reason: "host was replaced" };
        expect(f.app.verifyExisting(f.observed, "strict")).toEqual(mismatch("bind source identity changed for /project"));
        expect(f.trace).toEqual(["reset", "host:/project", "cleanup"]);
    });

    it.each(["match", "unavailable"] as const)("unknown host with %s alias never performs live challenge", alias => {
        const f = fixture(); f.state.host = { kind: "retryable", reason: "host identity pending" };
        f.source.set("/project", { kind: "filesystem", pathMatch: alias });
        expect(f.app.verifyExisting(f.observed, "strict")).toEqual({
            kind: "retryable", reason: alias === "unavailable" ? "bind source unreadable for /project" : "host identity pending", containerPath: "/project",
        });
        expect(f.trace).toEqual(["reset", "host:/project", "source:/project", "cleanup"]);
        expect(f.retryDecisions).toEqual([true]);
    });

    it("a foreign filesystem source cannot be rescued by available matching content", () => {
        const f = fixture(); f.source.set("/project", { kind: "filesystem", pathMatch: "mismatch" });
        expect(f.app.verifyExisting(f.observed, "safe-defer")).toEqual(mismatch("bind source changed for /project"));
        expect(f.trace).toEqual(["reset", "host:/project", "source:/project", "cleanup"]);
    });

    it("a missing additive mount cannot hide a later authoritative mismatch", () => {
        const absent = { ...filesystem, containerPath: "/optional", presence: "additive" as const };
        const f = fixture([absent, filesystem]); f.state.host = { kind: "mismatch", reason: "changed" };
        expect(f.app.verifyExisting([f.observed[1]], "safe-defer")).toEqual(mismatch("bind source identity changed for /project"));
        expect(f.trace).not.toContain("host:/optional");
    });

    it.each(["strict", "safe-defer"] as const)("requires a literal live custom daemon source under %s without accepting an equivalent path", policy => {
        const f = fixture([daemon]); f.source.set("/manager", daemonFacts({ literalSourceMatch: false, requireLiteralSource: true }));
        expect(f.app.verifyExisting(f.observed, policy)).toEqual(mismatch("bind source changed for /manager", "/manager"));
        expect(f.trace).toEqual(["reset", "source:/manager", "cleanup"]);
    });

    it.each(["verified", "foreign", "unavailable"])("matching custom and proxy sources retain mandatory %s daemon proof", outcome => {
        const f = fixture([daemon]); f.source.set("/manager", daemonFacts({ requireDaemonProofOnMatch: true }));
        f.state.daemonProof = outcome === "verified" ? verifiedDaemon : { kind: outcome === "foreign" ? "mismatch" : "retryable", reason: "daemon observation" };
        expect(f.app.verifyExisting(f.observed, "strict")).toEqual(outcome === "verified" ? verifiedDaemon : { ...f.state.daemonProof, containerPath: "/manager" });
        expect(f.trace).toEqual(["reset", "source:/manager", "daemon", "cleanup"]);
    });

    it.each(["strict", "safe-defer"] as const)("unknown default daemon source selects %s admission policy", policy => {
        const f = fixture([daemon]); f.source.set("/manager", daemonFacts({ generalPathMatch: "mismatch", literalSourceMatch: false }));
        expect(f.app.verifyExisting(f.observed, policy)).toEqual(policy === "strict" ? mismatch("bind source changed for /manager", "/manager") : verifiedDaemon);
        expect(f.trace).toEqual(["reset", "source:/manager", ...(policy === "safe-defer" ? ["daemon"] : []), "cleanup"]);
    });

    it("matching default source needs no live daemon probe during ordinary reuse", () => {
        const f = fixture([daemon]);
        expect(f.app.verifyExisting(f.observed, "strict")).toEqual({ kind: "verified", via: "source" });
        expect(f.trace).toEqual(["reset", "source:/manager", "cleanup"]);
    });

    it("forwards final-attempt authority only through the selected retry and cleans once", () => {
        const f = fixture(); f.state.runFinalRetry = true;
        f.ports.proveFilesystem = (path, final) => { f.trace.push("proof:" + path + ":" + final); return final ? { kind: "mismatch", reason: "final marker absent" } : { kind: "retryable", reason: "marker pending" }; };
        expect(f.app.verifyExisting(f.observed, "strict")).toEqual(mismatch("final marker absent"));
        expect(f.trace).toEqual(["reset", "host:/project", "source:/project", "proof:/project:false", "reset", "host:/project", "source:/project", "proof:/project:true", "cleanup"]);
        expect(f.retryDecisions).toEqual([true]);
    });

    it("propagates observation and cleanup failures without replay", () => {
        const f = fixture(); const unavailable = new Error("engine unavailable");
        f.ports.proveFilesystem = () => { f.trace.push("proof"); throw unavailable; };
        expect(() => f.app.verifyExisting(f.observed, "strict")).toThrow(unavailable);
        expect(f.trace).toEqual(["reset", "host:/project", "source:/project", "proof", "cleanup"]);
        const g = fixture(); const cleanupFailure = new Error("challenge cleanup failed"); g.state.cleanupFailure = cleanupFailure;
        expect(() => g.app.verifyExisting(g.observed, "strict")).toThrow(cleanupFailure);
        expect(g.trace.filter(event => event === "cleanup")).toHaveLength(1);
    });
});

describe("stopped mount preflight", () => {
    it("allows general custom source equivalence to authorize start, never live proof", () => {
        const f = fixture([daemon]); f.source.set("/manager", daemonFacts({ literalSourceMatch: false, requireLiteralSource: true, requireDaemonProofOnMatch: true }));
        expect(f.app.preflightStopped(f.observed)).toEqual({ kind: "preflight-verified" });
        expect(f.trace).toEqual(["source:/manager"]);
        expect(f.app.verifyExisting(f.observed, "strict")).toEqual(mismatch("bind source changed for /manager", "/manager"));
        expect(f.trace).not.toContain("daemon");
    });

    it.each(["mismatch", "retryable"] as const)("stopped %s host identity refuses before alias or live proof", kind => {
        const f = fixture(); f.state.host = { kind, reason: "native identity observation" };
        expect(f.app.preflightStopped(f.observed)).toEqual({ kind, reason: "bind source identity " + (kind === "mismatch" ? "changed" : "unavailable") + " for /project" });
        expect(f.trace).toEqual(["host:/project"]);
    });

    it("requires every nonoptional mount while permitting an absent optional volume without observations", () => {
        const volume: RequiredMountContract = { containerPath: "/retained", type: "volume", readonly: false, presence: "optional", sourceKind: "volume" };
        const f = fixture([volume]);
        expect(f.app.preflightStopped([])).toEqual({ kind: "preflight-verified" });
        expect(f.trace).toEqual([]);
        const g = fixture([{ ...filesystem, presence: "additive" }]);
        expect(g.app.preflightStopped([])).toEqual({ kind: "mismatch", reason: "missing mount /project" });
        expect(g.trace).toEqual([]);
    });
});

describe("fresh mount admission", () => {
    it.each(["id", "label"])("refuses a changed created %s before observing or proving sources", changed => {
        const f = fixture();
        f.state.created = { kind: "observed", containerId: changed === "id" ? "successor" : "captured-id", projectMountIdentity: changed === "label" ? "foreign" : "project-identity", mounts: f.observed };
        expect(f.app.verifyCreated("captured-id", "project-identity")).toEqual({ kind: "mismatch", reason: changed === "id" ? "created container identity changed during inspection" : "created container project mount identity label changed" });
        expect(f.trace).not.toContain("host:/project");
        expect(f.trace).not.toContain("source:/project");
        expect(f.trace.at(-1)).toBe("cleanup");
    });

    it("refreshes unavailable creation inspection before final-attempt filesystem proof", () => {
        const f = fixture(); f.state.runFinalRetry = true;
        f.state.inspections.push({ kind: "unavailable" });
        expect(f.app.verifyCreated("captured-id", "project-identity")).toEqual(verifiedIdentity);
        expect(f.trace.filter(event => event === "inspect")).toHaveLength(2);
        expect(f.trace).toContain("proof:/project:true");
        expect(f.trace).not.toContain("proof:/project:false");
        expect(f.trace.filter(event => event === "cleanup")).toHaveLength(1);
        expect(f.retryDecisions).toEqual([true]);
    });

    it("performs the additional fresh default daemon check even after exact-source admission", () => {
        const f = fixture([daemon]); f.state.finalDaemon = true;
        f.state.daemonProof = { kind: "mismatch", reason: "foreign daemon" };
        expect(f.app.verifyCreated("captured-id", "project-identity")).toEqual({ kind: "mismatch", reason: "foreign daemon" });
        expect(f.trace).toContain("source:/manager");
        expect(f.trace.indexOf("source:/manager")).toBeLessThan(f.trace.indexOf("daemon"));
        expect(f.trace.at(-1)).toBe("cleanup");
    });

    it("does not use final daemon proof to rescue a mount mismatch", () => {
        const f = fixture([daemon]); f.state.finalDaemon = true;
        f.source.set("/manager", daemonFacts({ generalPathMatch: "mismatch", literalSourceMatch: false }));
        expect(f.app.verifyCreated("captured-id", "project-identity")).toEqual(mismatch("bind source changed for /manager", "/manager"));
        expect(f.trace).not.toContain("daemon");
    });
});

function mountContracts(ports: ContainerMountVerificationPorts): void {
    // @ts-expect-error Native mount DTOs cannot replace normalized mount observations.
    const raw: ObservedMountContract = { Source: "host", Destination: "/project", Type: "bind", RW: true };
    // @ts-expect-error Opaque native status does not authorize source admission.
    ports.observeSource = () => ({ status: 0, stdout: "matching source" });
    // @ts-expect-error Proof must settle synchronously before admission.
    ports.proveDaemon = async () => ({ kind: "verified", via: "daemon" });
    void raw;
}
void mountContracts;
