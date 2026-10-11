import { describe, expect, it } from "vitest";
import { createContainerCreateLifecycle } from "../../application/container-create-lifecycle.js";
import type { ContainerCreateLifecyclePorts, ContainerCreateResult, CreatedContainerMountVerification } from "../../ports/container-create-lifecycle.js";

const id = "A".repeat(64);
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
    const ports: ContainerCreateLifecyclePorts<typeof prepared> = {
        failCreate: failure => { throw failure; },
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
        expect(f.app.run(request)).toBe("public-name");
        expect(f.trace).toEqual([...pre, ...post, ...handoff]);
        expect(f.state.locked).toBe(false);
    });
    it("refuses occupied namespaces before preparation", () => {
        const f = fixture(); f.state.namespace = true;
        expect(thrown(() => f.app.run(request))).toEqual({ kind: "namespace-appeared", containerName: "name" });
        expect(f.trace).toEqual(pre.slice(0, 2));
    });
    it.each([undefined, "", "lab-runner"])("preserves collision profile %s", profile => {
        const f = fixture(); f.state.collision = { containerName: "owner" };
        expect(thrown(() => f.app.run({ ...request, profile }))).toEqual({ kind: "collision", containerName: "owner", profile: profile ?? "default" });
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
        expect(thrown(() => f.app.run(request))).toEqual({ kind: "create-failed" });
        expect(f.trace).toEqual([...pre, "failure"]);
    });
    it("null ID still repeats source assertions and refuses without unpinned cleanup", () => {
        const f = fixture(); f.state.result = { kind: "created", containerId: null };
        expect(thrown(() => f.app.run(request))).toEqual({ kind: "missing-id-verification" });
        expect(f.trace).toEqual([...pre, ...post]);
    });
    it.each(["shape", "source", "identity", "daemon"] as const)("accepts verified via %s", via => {
        const f = fixture(); f.state.verification = { kind: "verified", via };
        expect(f.app.run(request)).toBe("public-name");
        expect(f.trace).toEqual([...pre, ...post, ...handoff]);
    });
    it.each([
        { kind: "deferred", reason: "pending", containerPath: "/project" },
        { kind: "retryable", reason: "pending" }, { kind: "mismatch", reason: "changed" },
    ] satisfies CreatedContainerMountVerification[])("rejects $kind using exact ID and explicit absence", verification => {
        const f = fixture(); f.state.verification = verification;
        expect(thrown(() => f.app.run(request))).toEqual({ kind: "verification-failed", reason: verification.reason });
        expect(f.trace).toEqual([...pre, ...post, "verify:" + id, "remove:" + id, "absent:" + id]);
    });
    it.each(["assertProjectSources", "assertDeviceSources", "assertFilesystemSources"] as const)("compensates post-create %s substitution", port => {
        const f = fixture(); const failure = new Error("source swapped"); const original = f.ports[port]; let checks = 0;
        f.ports[port] = () => { if (++checks === 2) throw failure; return original(); };
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace.slice(-2)).toEqual(["remove:" + id, "absent:" + id]);
        expect(f.trace).not.toContain("mcp:" + id);
    });
    it("preserves the primary cause when rejected container absence is unproved", () => {
        const f = fixture(); const failure = new Error("proof failed"); f.state.absent = false;
        f.ports.verifyCreated = () => { throw failure; };
        expect(thrown(() => f.app.run(request))).toEqual({ kind: "rejected-removal-failed", containerId: id, error: failure });
        expect(f.trace.slice(-2)).toEqual(["remove:" + id, "absent:" + id]);
    });
    it.each(["syncMcp", "fixSsh", "syncGit", "finish"] as const)("preserves late %s failure without rollback", port => {
        const f = fixture(); const failure = new Error("helper failed"); f.ports[port] = () => { throw failure; };
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace).toContain("verify:" + id);
        expect(f.trace.some(event => event.startsWith("remove:"))).toBe(false);
    });
});
