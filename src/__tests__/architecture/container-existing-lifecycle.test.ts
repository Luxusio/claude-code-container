import { describe, expect, it } from "vitest";
import { createContainerExistingLifecycle } from "../../application/container-existing-lifecycle.js";
import type { ContainerExistingLifecyclePorts, ContainerReplacementRequest } from "../../ports/container-existing-lifecycle.js";

function fixture() {
    const trace: string[] = [];
    const state = {
        listing: { known: true, containerId: "id" as string | null },
        identity: { containerId: "id", running: false } as { containerId: string; running: boolean } | null,
        managed: { containerId: "id", running: true } as { containerId: string; running: boolean } | null,
        contract: true as boolean | null, safe: true, running: true, ready: true,
        devices: [true, true],
    };
    const effect = (name: string, id?: string): undefined => { trace.push(id === undefined ? name : `${name}:${id}`); return undefined; };
    const ports: ContainerExistingLifecyclePorts = {
        listContainer: name => { trace.push(`list:${name}`); return state.listing; },
        identity: target => { trace.push(`identity:${target}`); return state.identity; },
        managedIdentity: (id, path) => { trace.push(`managed:${id}:${path}`); return state.managed; },
        assertProjectSources: () => effect("project"), assertDeviceSources: () => effect("device"),
        assertFilesystemSources: () => effect("filesystem"),
        inspectContract: id => { trace.push(`contract:${id}`); return state.contract; },
        safeToDefer: id => { trace.push(`safe:${id}`); return state.safe; },
        isRunning: name => { trace.push(`running:${name}`); return state.running; },
        canExec: id => { trace.push(`exec:${id}`); return state.ready; },
        canExecAfterBriefRetry: id => { trace.push(`brief:${id}`); return state.ready; },
        deviceSourcesMatch: () => { trace.push("matches"); return state.devices.shift() ?? true; },
        syncMcp: id => effect("mcp", id), fixSsh: id => effect("ssh", id), syncGit: id => effect("git", id),
        start: id => effect("start", id), stop: id => effect("stop", id), remove: id => effect("remove", id),
        reportContractMismatch: name => effect("mismatch", name), reportContractMatch: name => effect("match", name),
        reportRestart: name => effect("restart", name), reportRecreation: reason => effect("recreate", reason),
        reportDeferred: reason => effect("defer", reason),
        throwUnsafeDefer: reason => { trace.push(`unsafe:${reason}`); throw new Error(`unsafe:${reason}`); },
        finish: id => effect("finish", id),
    };
    return { trace, state, ports, app: createContainerExistingLifecycle(ports) };
}
const pre = ["list:name", "project", "device", "filesystem", "contract:id", "project", "device", "filesystem"];
const join = ["mcp:id", "ssh:id", "git:id", "matches", "finish:id"];
const guard = (operation: () => void) => { operation(); return true; };
const replacement = { containerName: "name", reason: "reason", expectedContainerId: "id" };

describe("existing lifecycle explicit construction", () => {
    it("validates every callable without effects", () => {
        const f = fixture();
        expect(f.trace).toEqual([]);
        for (const name of Object.keys(f.ports)) {
            for (const invalid of [undefined, null, false, 1, "function", {}]) {
                expect(() => createContainerExistingLifecycle({ ...f.ports, [name]: invalid } as unknown as ContainerExistingLifecyclePorts)).toThrow(`callable ${name}`);
            }
        }
        expect(() => createContainerExistingLifecycle(undefined as unknown as ContainerExistingLifecyclePorts)).toThrow(TypeError);
        expect(f.trace).toEqual([]);
    });
    it("keeps each invocation's recreated ID independent", () => {
        const f = fixture();
        f.state.contract = false;
        expect(f.app.run({ containerName: "name", replacementGuard: guard })).toEqual({ kind: "continue-to-create" });
        f.trace.length = 0;
        f.state.contract = true;
        expect(f.app.run({ containerName: "name" })).toEqual({ kind: "joined", containerId: "id" });
        expect(f.trace).toContain("exec:id");
    });
    it("uses current port replacements and their receiver at each observation/effect", () => {
        const f = fixture(); const replacementCalls: string[] = [];
        for (const name of Object.keys(f.ports) as Array<keyof ContainerExistingLifecyclePorts>) {
            const original = f.ports[name];
            Object.assign(f.ports, { [name]: function (this: ContainerExistingLifecyclePorts, ...args: unknown[]) {
                expect(this).toBe(f.ports); replacementCalls.push(name); return Reflect.apply(original, this, args);
            } });
        }
        expect(f.app.run({ containerName: "name" })).toEqual({ kind: "joined", containerId: "id" });
        expect(replacementCalls).toEqual(["listContainer", "assertProjectSources", "assertDeviceSources", "assertFilesystemSources", "inspectContract", "assertProjectSources", "assertDeviceSources", "assertFilesystemSources", "isRunning", "canExec", "deviceSourcesMatch", "syncMcp", "fixSsh", "syncGit", "deviceSourcesMatch", "finish"]);
    });
});

describe("existing lifecycle observations and contract", () => {
    it("refuses unknown listing before further observations", () => {
        const f = fixture(); f.state.listing.known = false;
        expect(() => f.app.run({ containerName: "name", replacementGuard: guard })).toThrow("identity inspection failed");
        expect(f.trace).toEqual(["list:name"]);
    });
    it.each([null, "successor"])("refuses lost initial running identity %s", containerId => {
        const f = fixture(); f.state.listing.containerId = containerId;
        expect(() => f.app.run({ containerName: "name", initiallyRunningContainerId: "id" })).toThrow("observed running at startup");
        expect(f.trace).toEqual(["list:name"]);
    });
    it.each([false, true])("absent listing still observes named running=%s", running => {
        const f = fixture(); f.state.listing.containerId = null; f.state.running = running;
        expect(f.app.run({ containerName: "name" })).toEqual({ kind: "continue-to-create" });
        expect(f.trace).toEqual(["list:name", "running:name"]);
    });
    it("reads an unavailable reason after all post-inspection assertions", () => {
        const f = fixture(); let report: (reason: string) => void = () => {};
        f.ports.inspectContract = (id, callback) => { f.trace.push(`contract:${id}`); report = callback; callback("first"); return null; };
        f.ports.assertFilesystemSources = () => { f.trace.push("filesystem"); report("last"); return undefined; };
        expect(() => f.app.run({ containerName: "name", replacementGuard: guard })).toThrow("temporarily unavailable (last)");
        expect(f.trace).toEqual(pre);
    });
    it("uses unavailable fallback and never invokes guard", () => {
        const f = fixture(); f.state.contract = null;
        expect(() => f.app.run({ containerName: "name", replacementGuard: () => { throw new Error("guard called"); } })).toThrow("(container contract changed)");
        expect(f.trace).toEqual(pre);
    });
    it("reports mismatched debug then missing guard without identity query", () => {
        const f = fixture(); f.state.contract = false;
        expect(() => f.app.run({ containerName: "name", debug: true })).toThrow("requires a lifecycle/session guard");
        expect(f.trace).toEqual([...pre, "mismatch:name"]);
    });
    it("reports matching debug before named-running observation", () => {
        const f = fixture(); f.app.run({ containerName: "name", debug: true });
        expect(f.trace).toEqual([...pre, "match:name", "running:name", "exec:id", "matches", ...join]);
    });
    it("confirmed mismatch clears lifecycle before callback and continues to creation", () => {
        const f = fixture(); f.state.contract = false;
        expect(f.app.run({ containerName: "name", replacementGuard: guard, onRecreate: () => { f.trace.push("callback"); } })).toEqual({ kind: "continue-to-create" });
        expect(f.trace).toEqual([...pre, "identity:name", "identity:id", "recreate:container contract changed", "remove:id", "callback", "running:name"]);
    });
    it.each(["unsafe", "stopped", "unready", "safe"])("unconfirmed mismatch follows %s defer", mode => {
        const f = fixture(); f.state.contract = false; f.state.safe = mode !== "unsafe";
        f.state.running = mode !== "stopped"; f.state.ready = mode !== "unready";
        const run = () => f.app.run({ containerName: "name", replacementGuard: () => false });
        if (mode === "safe") expect(run()).toEqual({ kind: "joined", containerId: "id" });
        else expect(run).toThrow(mode === "unsafe" ? "unsafe:unknown safety mismatch" : mode === "stopped" ? "automatic replacement was not authorized" : "destructive recovery was refused");
        const expected = [...pre, "identity:name", "safe:id"];
        if (mode === "unsafe") expected.push("unsafe:unknown safety mismatch");
        else {
            expected.push("running:name");
            if (mode !== "stopped") expected.push("brief:id");
            if (mode === "safe") expected.push("defer:container contract changed", "ssh:id", "git:id", "finish:id");
        }
        expect(f.trace).toEqual(expected);
    });
    it("propagates the actual unsafe reason through the required outer throw", () => {
        const f = fixture(); f.state.contract = false;
        f.ports.safeToDefer = (_id, report) => { report("unsafe mount"); return false; };
        const original = { failure: "restart" };
        f.ports.throwUnsafeDefer = reason => { expect(reason).toBe("unsafe mount"); throw original; };
        try { f.app.run({ containerName: "name", replacementGuard: () => false }); throw new Error("unexpected join"); }
        catch (error) { expect(error).toBe(original); }
    });
    it("defer observes mismatch reason mutations from later readiness callbacks", () => {
        const f = fixture(); let report: (reason: string) => void = () => {};
        f.ports.inspectContract = (id, callback) => { f.trace.push(`contract:${id}`); report = callback; callback("initial mismatch"); return false; };
        f.ports.isRunning = name => { f.trace.push(`running:${name}`); report("running mismatch"); return true; };
        f.ports.canExecAfterBriefRetry = id => { f.trace.push(`brief:${id}`); report("latest mismatch"); return true; };
        expect(f.app.run({ containerName: "name", replacementGuard: () => false })).toEqual({ kind: "joined", containerId: "id" });
        expect(f.trace).toEqual([...pre, "identity:name", "safe:id", "running:name", "brief:id", "defer:latest mismatch", "ssh:id", "git:id", "finish:id"]);
    });
    it.each(["safeToDefer", "canExecAfterBriefRetry", "reportDeferred", "fixSsh", "syncGit", "finish"] as const)("defer propagates %s failure without completed join", name => {
        const f = fixture(); f.state.contract = false; const failure = { port: name };
        Object.assign(f.ports, { [name]: () => { throw failure; } });
        try { f.app.run({ containerName: "name", replacementGuard: () => false }); throw new Error("unexpected join"); }
        catch (error) { expect(error).toBe(failure); }
        expect(f.trace.some(event => /^(remove|start|mcp):/.test(event))).toBe(false);
    });
});

describe("running reuse and stopped restart", () => {
    it.each([false, true])("selects readiness by guard presence %s and finishes after sync", guarded => {
        const f = fixture();
        expect(f.app.run({ containerName: "name", ...(guarded ? { replacementGuard: guard } : {}) })).toEqual({ kind: "joined", containerId: "id" });
        expect(f.trace).toEqual([...pre, "running:name", guarded ? "brief:id" : "exec:id", "matches", ...join]);
    });
    it.each(["before", "after", "unready"])("preserves running %s failure even when the guard authorizes replacement", mode => {
        const f = fixture(); f.state.identity = { containerId: "id", running: true };
        f.state.devices = mode === "before" ? [false] : [true, false]; f.state.ready = mode !== "unready";
        let guardCalls = 0;
        const run = () => f.app.run({ containerName: "name", replacementGuard: operation => { guardCalls++; operation(); return true; } });
        expect(run).toThrow(mode === "before" ? "during validation" : mode === "after" ? "during synchronization" : "destructive recovery was refused");
        const middle = mode === "unready" ? [] : mode === "before" ? ["matches"] : ["matches", "mcp:id", "ssh:id", "git:id", "matches"];
        expect(f.trace).toEqual([...pre, "running:name", "brief:id", ...middle, "identity:name"]);
        expect(guardCalls).toBe(1);
        expect(f.trace.some(event => /^(remove|stop|start|finish):/.test(event))).toBe(false);
    });
    it.each(["before", "after", "unready"])("veto preserves running %s failure without join", mode => {
        const f = fixture(); f.state.devices = mode === "before" ? [false] : [true, false]; f.state.ready = mode !== "unready";
        expect(() => f.app.run({ containerName: "name", replacementGuard: () => false })).toThrow(mode === "before" ? "during validation" : mode === "after" ? "during synchronization" : "destructive recovery was refused");
        expect(f.trace.at(-1)).toBe("identity:name");
        expect(f.trace.some(event => /^(remove|start|finish):/.test(event))).toBe(false);
    });
    it.each(["before", "after", "unready"])("requires guard for running %s failure before identity", mode => {
        const f = fixture(); f.state.devices = mode === "before" ? [false] : [true, false]; f.state.ready = mode !== "unready";
        expect(() => f.app.run({ containerName: "name" })).toThrow("requires a lifecycle/session guard");
        expect(f.trace.some(event => /^(identity|remove|start|finish):/.test(event))).toBe(false);
    });
    it.each([false, true])("restarts stopped ID using readiness mode guard=%s", guarded => {
        const f = fixture(); f.state.running = false;
        expect(f.app.run({ containerName: "name", debug: true, ...(guarded ? { replacementGuard: guard } : {}) })).toEqual({ kind: "joined", containerId: "id" });
        expect(f.trace).toEqual([...pre, "match:name", "running:name", "restart:name", "project", "matches", "start:id", guarded ? "brief:id" : "exec:id", ...join]);
    });
    it.each(["allowed", "veto", "missing"])("stopped drift replacement %s", mode => {
        const f = fixture(); f.state.running = false; f.state.devices = [false];
        const run = () => f.app.run({ containerName: "name", ...(mode === "missing" ? {} : { replacementGuard: mode === "allowed" ? guard : () => false }) });
        if (mode === "allowed") expect(run()).toEqual({ kind: "continue-to-create" });
        else expect(run).toThrow(mode === "missing" ? "requires a lifecycle/session guard" : "automatic replacement was not authorized");
        expect(f.trace).not.toContain("start:id");
        if (mode === "missing") expect(f.trace).not.toContain("identity:name");
    });
    it("start failure propagates without readiness or destructive replacement", () => {
        const f = fixture(); f.state.running = false; const failure = new Error("Stopped container could not be restarted; automatic replacement was refused.");
        f.ports.start = () => { f.trace.push("start:id"); throw failure; };
        expect(() => f.app.run({ containerName: "name", replacementGuard: guard })).toThrow(failure);
        expect(f.trace).toEqual([...pre, "running:name", "project", "matches", "start:id"]);
    });
    it("restart unready refuses without replacement", () => {
        const f = fixture(); f.state.running = false; f.state.ready = false;
        expect(() => f.app.run({ containerName: "name", replacementGuard: guard })).toThrow("Restarted container is unavailable");
        expect(f.trace).toEqual([...pre, "running:name", "project", "matches", "start:id", "brief:id"]);
    });
    it("restart drift after sync refuses without replacement", () => {
        const f = fixture(); f.state.running = false; f.state.devices = [true, false];
        expect(() => f.app.run({ containerName: "name", replacementGuard: guard })).toThrow("during restart");
        expect(f.trace).toEqual([...pre, "running:name", "project", "matches", "start:id", "brief:id", "mcp:id", "ssh:id", "git:id", "matches"]);
    });
    it.each(["assertProjectSources", "assertDeviceSources", "assertFilesystemSources", "inspectContract", "isRunning", "canExec", "deviceSourcesMatch", "syncMcp", "fixSsh", "syncGit", "finish"] as const)("propagates %s failure without fabricating a join or recovery", name => {
        const f = fixture(); const failure = { port: name };
        Object.assign(f.ports, { [name]: () => { throw failure; } });
        try { f.app.run({ containerName: "name" }); throw new Error("unexpected join"); } catch (error) { expect(error).toBe(failure); }
        expect(f.trace.some(event => /^(remove|start):/.test(event))).toBe(false);
    });
    it.each(["listContainer", "reportContractMismatch", "reportContractMatch", "reportRestart"] as const)("propagates observation/presentation %s failure", name => {
        const f = fixture(); const failure = { port: name };
        if (name === "reportContractMismatch") f.state.contract = false;
        if (name === "reportRestart") f.state.running = false;
        Object.assign(f.ports, { [name]: () => { throw failure; } });
        try { f.app.run({ containerName: "name", debug: true, replacementGuard: guard }); throw new Error("unexpected join"); }
        catch (error) { expect(error).toBe(failure); }
        expect(f.trace.some(event => /^(remove|start|finish):/.test(event))).toBe(false);
    });
});

describe("identity-fenced replacement callbacks", () => {
    it("requires guard before querying identity", () => {
        const f = fixture(); expect(() => f.app.replace(replacement)).toThrow("requires a lifecycle/session guard"); expect(f.trace).toEqual([]);
    });
    it.each([null, { containerId: "successor", running: false }])("rejects absent or mismatched identity %s before guard", identity => {
        const f = fixture(); f.state.identity = identity;
        expect(f.app.replace({ ...replacement, replacementGuard: () => { throw new Error("guard called"); } })).toBe(false);
        expect(f.trace).toEqual(["identity:name"]);
    });
    it("pins observed identity when expected ID is omitted", () => {
        const f = fixture(); f.state.identity = { containerId: "observed", running: false };
        expect(f.app.replace({ containerName: "name", reason: "reason", replacementGuard: guard })).toBe(true);
        expect(f.trace).toEqual(["identity:name", "identity:observed", "recreate:reason", "remove:observed"]);
    });
    it.each([false, true])("guard returning %s without callback never confirms replacement", accepted => {
        const f = fixture(); expect(f.app.replace({ ...replacement, replacementGuard: () => accepted })).toBe(false);
        expect(f.trace).toEqual(["identity:name"]);
    });
    it("successful callback then false remains false with performed removal", () => {
        const f = fixture(); expect(f.app.replace({ ...replacement, replacementGuard: operation => { operation(); return false; } })).toBe(false);
        expect(f.trace).toEqual(["identity:name", "identity:id", "recreate:reason", "remove:id"]);
    });
    it("captured initially running identity cannot acquire later stopped authority", () => {
        const f = fixture(); f.state.identity = { containerId: "id", running: true };
        expect(f.app.replace({ ...replacement, replacementGuard: operation => { f.state.identity = { containerId: "id", running: false }; operation(); return true; } })).toBe(false);
        expect(f.trace).toEqual(["identity:name"]);
    });
    it("refuses removal when a captured stopped container becomes running inside the guard", () => {
        const f = fixture(); const callback = () => { throw new Error("callback called"); };
        expect(f.app.replace({ ...replacement, onRecreate: callback, replacementGuard: operation => {
            f.state.identity = { containerId: "id", running: true }; operation(); return true;
        } })).toBe(false);
        expect(f.trace).toEqual(["identity:name", "identity:id"]);
    });
    it.each([null, { containerId: "successor", running: false }])("refuses an unavailable or successor exact ID at the last check: %s", identity => {
        const f = fixture();
        expect(f.app.replace({ ...replacement, replacementGuard: operation => { f.state.identity = identity; operation(); return true; } })).toBe(false);
        expect(f.trace).toEqual(["identity:name", "identity:id"]);
    });
    it.each([undefined, "", "/project"])("startup-running ID is preserved regardless of managed project path %s", managedProjectPath => {
        const f = fixture(); let guardCalls = 0;
        expect(f.app.replace({ ...replacement, initiallyRunningContainerId: "id", managedProjectPath, replacementGuard: operation => { guardCalls++; operation(); return true; } })).toBe(false);
        expect(guardCalls).toBe(1);
        expect(f.trace).toEqual(["identity:name"]);
    });
    it.each([null, { containerId: "foreign", running: true }, { containerId: "id", running: false }, { containerId: "id", running: true }])("managed identity %s cannot grant replacement authority to startup-running ID", managed => {
        const f = fixture(); f.state.managed = managed;
        expect(f.app.replace({ ...replacement, initiallyRunningContainerId: "id", managedProjectPath: "/project", replacementGuard: guard })).toBe(false);
        expect(f.trace).toEqual(["identity:name"]);
    });
    it("re-proves each stopped callback and retains prior confirmation across a later successor", () => {
        const f = fixture(); let calls = 0;
        expect(f.app.replace({ ...replacement, onRecreate: () => { calls++; }, replacementGuard: operation => {
            operation(); f.state.identity = { containerId: "successor", running: false }; operation(); return true;
        } })).toBe(true);
        expect(calls).toBe(1);
        expect(f.trace).toEqual(["identity:name", "identity:id", "recreate:reason", "remove:id", "identity:id"]);
    });
    it("does not normalize multiple independently re-proven stopped callbacks into one removal", () => {
        const f = fixture(); let calls = 0;
        expect(f.app.replace({ ...replacement, onRecreate: () => { calls++; }, replacementGuard: operation => { operation(); operation(); return true; } })).toBe(true);
        expect(calls).toBe(2); expect(f.trace).toEqual(["identity:name", "identity:id", "recreate:reason", "remove:id", "identity:id", "recreate:reason", "remove:id"]);
    });
    it("does not query unused managed context during stopped replacement", () => {
        const f = fixture(); const request: ContainerReplacementRequest = { ...replacement, managedProjectPath: "/first" };
        f.ports.managedIdentity = () => { throw new Error("managed probe called"); };
        request.replacementGuard = operation => { operation(); request.managedProjectPath = "/second"; operation(); return true; };
        expect(f.app.replace(request)).toBe(true);
        expect(f.trace.filter(event => event.startsWith("managed:"))).toEqual([]);
        expect(f.trace.filter(event => event.startsWith("identity:"))).toEqual(["identity:name", "identity:id", "identity:id"]);
    });
    it.each(["identity", "reportRecreation"] as const)("propagates replacement %s failure without removal or callback", name => {
        const f = fixture(); const failure = { port: name };
        Object.assign(f.ports, { [name]: () => { throw failure; } });
        try { f.app.replace({ ...replacement, replacementGuard: guard, onRecreate: () => { throw new Error("callback called"); } }); throw new Error("unexpected success"); }
        catch (error) { expect(error).toBe(failure); }
        expect(f.trace).not.toContain("remove:id");
    });
    it("propagates the last identity observation error without removal or callback", () => {
        const f = fixture(); const failure = { port: "last identity" }; let reads = 0;
        f.ports.identity = target => { f.trace.push(`identity:${target}`); if (++reads === 2) throw failure; return f.state.identity; };
        try { f.app.replace({ ...replacement, replacementGuard: guard }); throw new Error("unexpected success"); }
        catch (error) { expect(error).toBe(failure); }
        expect(f.trace).toEqual(["identity:name", "identity:id"]);
    });
    it.each(["remove", "callback", "guard"])("propagates %s failure with only already-performed effects", mode => {
        const f = fixture(); const failure = { failure: mode };
        const request: ContainerReplacementRequest = { ...replacement, replacementGuard: guard, onRecreate: () => { f.trace.push("callback"); if (mode === "callback") throw failure; } };
        if (mode === "remove") f.ports.remove = () => { f.trace.push("remove:id"); throw failure; };
        if (mode === "guard") request.replacementGuard = operation => { operation(); throw failure; };
        try { f.app.replace(request); throw new Error("unexpected success"); } catch (error) { expect(error).toBe(failure); }
        const expected = ["identity:name", "identity:id", "recreate:reason", "remove:id"];
        if (mode === "callback" || mode === "guard") expected.push("callback");
        expect(f.trace).toEqual(expected);
    });
    it("false after successful lifecycle callback defers listed ID rather than restarting cleared ID", () => {
        const f = fixture(); f.state.contract = false;
        expect(f.app.run({ containerName: "name", replacementGuard: operation => { operation(); return false; } })).toEqual({ kind: "joined", containerId: "id" });
        expect(f.trace).toEqual([...pre, "identity:name", "identity:id", "recreate:container contract changed", "remove:id", "safe:id", "running:name", "brief:id", "defer:container contract changed", "ssh:id", "git:id", "finish:id"]);
    });
});
