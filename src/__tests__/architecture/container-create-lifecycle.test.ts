import { describe, expect, it } from "vitest";
import { createContainerCreateLifecycle } from "../../application/container-create-lifecycle.js";
import type { ContainerCreateLifecyclePorts, ContainerCreateResult, CreatedContainerMountVerification } from "../../ports/container-create-lifecycle.js";

// The semantic port supplies a qualified identity; its native parser has a
// separate facade owner. Core fixtures do not repeat that parser's policy.
const id = "semantic-container-id";
const request = { containerName: "name", projectMountIdentity: "physical" };
const pre = ["lock:mount-physical", "namespace", "collision", "creating", "lab", "prepare", "project", "device", "filesystem", "create"];
const post = ["project", "device", "filesystem"];
const handoff = ["verify", "mcp", "ssh", "git", "finish"].map(operation => operation + ":" + id);

function fixture() {
    const trace: string[] = [];
    const prepared = { fixture: true };
    const state = { namespace: false, collision: null as { containerName: string } | null,
        result: { kind: "created", containerId: id } as ContainerCreateResult,
        verification: { kind: "verified", via: "identity" } as CreatedContainerMountVerification,
        absent: true, locked: false };
    const effect = (name: string): undefined => { expect(state.locked).toBe(true); trace.push(name); };
    // Keep the baseline's required legacy callback inert on the new contract.
    // The namespace regression below therefore fails on the old run behavior,
    // rather than on a missing constructor collaborator.
    const legacy = { failCreate: (failure: unknown): never => { throw failure; } };
    const ports: ContainerCreateLifecyclePorts<typeof prepared> = {
        ...legacy,
        withFamilyLock: (prefix, operation) => { trace.push("lock:" + prefix); state.locked = true; try { return operation(); } finally { state.locked = false; } },
        namespaceExists: () => { effect("namespace"); return state.namespace; },
        findCollision: () => { effect("collision"); return state.collision; },
        reportCreating: () => effect("creating"), reportLabWarning: () => effect("lab"),
        reportCreateFailure: () => effect("failure"),
        prepareCreate: () => { effect("prepare"); return prepared; },
        assertProjectSources: () => effect("project"), assertDeviceSources: () => effect("device"),
        assertFilesystemSources: () => effect("filesystem"),
        create: supplied => { expect(supplied).toBe(prepared); effect("create"); return state.result; },
        verifyCreated: target => { effect("verify:" + target); return state.verification; },
        removeRejected: target => effect("remove:" + target),
        explicitlyAbsent: target => { effect("absent:" + target); return state.absent; },
        syncMcp: target => effect("mcp:" + target), fixSsh: target => effect("ssh:" + target),
        syncGit: target => effect("git:" + target),
        finish: target => { effect("finish:" + target); return "public-name"; },
    };
    return { state, trace, ports, app: createContainerCreateLifecycle(ports) };
}
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected exception");
}
describe("create lifecycle semantic ownership", () => {
    it("keeps preparation, both source guards and pinned handoff inside the family lock", () => {
        const f = fixture();
        expect(f.app.run(request)).toEqual({ kind: "completed", value: "public-name" });
        expect(f.trace).toEqual([...pre, ...post, ...handoff]);
        expect(f.state.locked).toBe(false);
    });
    it("regression: core container creation returns namespace refusal before preparation", () => {
        const f = fixture(); f.state.namespace = true;
        expect(f.app.run(request)).toEqual({ kind: "refused", failure: { kind: "namespace-appeared", containerName: "name" } });
        expect(f.trace).toEqual(pre.slice(0, 2));
    });
    it.each([undefined, "", "lab-runner"])("preserves collision profile %s", profile => {
        const f = fixture(); f.state.collision = { containerName: "owner" };
        expect(f.app.run({ ...request, profile })).toEqual({ kind: "refused", failure: { kind: "collision", containerName: "owner", profile: profile ?? "default" } });
        expect(f.trace).toEqual(pre.slice(0, 3));
    });
    it.each(["assertProjectSources", "assertDeviceSources", "assertFilesystemSources"] as const)("pre-create %s failure prevents dispatch", port => {
        const f = fixture(); const failure = new Error("source changed");
        f.ports[port] = () => { throw failure; };
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace).not.toContain("create");
        expect(f.trace.some(event => event.startsWith("remove:"))).toBe(false);
    });
    it("failed creation reports failure without post-create checks or cleanup", () => {
        const f = fixture(); f.state.result = { kind: "failed" };
        expect(f.app.run(request)).toEqual({ kind: "refused", failure: { kind: "create-failed" } });
        expect(f.trace).toEqual([...pre, "failure"]);
    });
    it("null ID still repeats source assertions and refuses without unpinned cleanup", () => {
        const f = fixture(); f.state.result = { kind: "created", containerId: null };
        expect(f.app.run(request)).toEqual({ kind: "rejected", rejection: { kind: "missing-id-verification" }, cleanup: { kind: "not-authorized" } });
        expect(f.trace).toEqual([...pre, ...post]);
    });
    it.each(["shape", "source", "identity", "daemon"] as const)("accepts verified via %s", via => {
        const f = fixture(); f.state.verification = { kind: "verified", via };
        expect(f.app.run(request)).toEqual({ kind: "completed", value: "public-name" });
        expect(f.trace).toEqual([...pre, ...post, ...handoff]);
    });
    it.each([
        { kind: "deferred", reason: "pending", containerPath: "/project" },
        { kind: "retryable", reason: "pending" }, { kind: "mismatch", reason: "changed" },
    ] satisfies CreatedContainerMountVerification[])("rejects $kind using exact ID and explicit absence", verification => {
        const f = fixture(); f.state.verification = verification;
        expect(f.app.run(request)).toEqual({ kind: "rejected", rejection: { kind: "verification-failed", reason: verification.reason },
            cleanup: { kind: "attempted", containerId: id, removal: "completed", absence: "proved" } });
        expect(f.trace).toEqual([...pre, ...post, "verify:" + id, "remove:" + id, "absent:" + id]);
    });
    it.each(["assertProjectSources", "assertDeviceSources", "assertFilesystemSources"] as const)("compensates post-create %s substitution", port => {
        const f = fixture(); const failure = new Error("source swapped"); const original = f.ports[port]; let checks = 0;
        f.ports[port] = () => { if (++checks === 2) throw failure; return original(); };
        expect(f.app.run(request)).toEqual({ kind: "rejected", rejection: { kind: "post-create-check-failed" },
            cleanup: { kind: "attempted", containerId: id, removal: "completed", absence: "proved" } });
        expect(f.trace.slice(-2)).toEqual(["remove:" + id, "absent:" + id]);
        expect(f.trace).not.toContain("mcp:" + id);
    });
    it.each([
        ["completed", "proved"], ["completed", "unproved"], ["completed", "failed"],
        ["failed", "proved"], ["failed", "unproved"], ["failed", "failed"],
    ] as const)("returns only finite cleanup facts when removal=%s and absence=%s", (removal, absence) => {
        const f = fixture(); const primary = { native: "private verifier cause" };
        f.ports.verifyCreated = () => { throw primary; };
        f.ports.removeRejected = target => { f.trace.push("remove:" + target); if (removal === "failed") throw { native: "private removal cause" }; };
        f.ports.explicitlyAbsent = target => { f.trace.push("absent:" + target); if (absence === "failed") throw { native: "private absence cause" }; return absence === "proved"; };
        expect(f.app.run(request)).toEqual({ kind: "rejected", rejection: { kind: "post-create-check-failed" },
            cleanup: { kind: "attempted", containerId: id, removal, absence } });
        expect(f.trace.slice(-2)).toEqual(["remove:" + id, "absent:" + id]);
        expect(f.trace).not.toContain("mcp:" + id);
    });
    it("does not authorize cleanup when a repeated source check throws without an ID", () => {
        const f = fixture(); f.state.result = { kind: "created", containerId: null }; let checks = 0;
        f.ports.assertProjectSources = () => { if (++checks === 2) throw undefined; };
        expect(f.app.run(request)).toEqual({ kind: "rejected", rejection: { kind: "post-create-check-failed" }, cleanup: { kind: "not-authorized" } });
        expect(f.trace.some(event => event.startsWith("remove:") || event.startsWith("absent:"))).toBe(false);
    });
    it("preserves method receivers and reads core collaborators at invocation time", () => {
        const f = fixture();
        const namespace = f.ports.namespaceExists;
        f.ports.namespaceExists = function (name) { expect(this).toBe(f.ports); expect(name).toBe("name"); return namespace(name); };
        const finish = f.ports.finish;
        f.ports.finish = function (target) { expect(this).toBe(f.ports); finish(target); return "replaced-public-name"; };
        expect(f.app.run(request)).toEqual({ kind: "completed", value: "replaced-public-name" });
        expect(f.trace).toEqual([...pre, ...post, ...handoff]);
    });
    it.each(["syncMcp", "fixSsh", "syncGit", "finish"] as const)("preserves late %s failure without rollback", port => {
        const f = fixture(); const failure = new Error("helper failed"); f.ports[port] = () => { throw failure; };
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace).toContain("verify:" + id);
        expect(f.trace.some(event => event.startsWith("remove:"))).toBe(false);
    });
});
