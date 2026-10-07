import { describe, expect, it } from "vitest";
import { createDockerEndpointResolver } from "../../application/docker-endpoint-selection.js";
import type { DockerEndpointSelectionPorts } from "../../ports/docker-endpoint-selection.js";

const names = ["readContextOverride", "readHostOverride", "inspectContextEndpoint"] as const;
function fixture(context: string | undefined, host: string | undefined, endpoint: string | null) {
    const trace: unknown[][] = [];
    const ports: DockerEndpointSelectionPorts = {
        readContextOverride() { trace.push(["context"]); return context; },
        readHostOverride() { trace.push(["host"]); return host; },
        inspectContextEndpoint(name) { trace.push(["inspect", name]); return endpoint; },
    };
    return { ports, trace };
}
function thrown(run: () => unknown) { try { run(); } catch (error) { return error; } throw new Error("Expected throw"); }

describe("Docker endpoint selection policy", () => {
    it.each(["colima", " colima ", " ", "--format=hostile"])("uses exact truthy context %j ahead of a conflicting host", context => {
        const f = fixture(context, "tcp://shadowed:2376", "unix:///selected.sock");
        expect(createDockerEndpointResolver(f.ports)()).toBe("unix:///selected.sock");
        expect(f.trace).toEqual([["context"], ["inspect", context]]);
    });
    it.each([null, ""])("does not fall back to the shadowed host after selected context returns %j", endpoint => {
        const f = fixture("colima", "npipe:////./pipe/dockerDesktopLinuxEngine", endpoint);
        expect(createDockerEndpointResolver(f.ports)()).toBe(endpoint);
        expect(f.trace).toEqual([["context"], ["inspect", "colima"]]);
    });
    it.each([undefined, ""])("uses trimmed host without inspecting current context when override is %j", context => {
        const f = fixture(context, "  ssh://user@selected\n", null);
        expect(createDockerEndpointResolver(f.ports)()).toBe("ssh://user@selected");
        expect(f.trace).toEqual([["context"], ["host"]]);
    });
    it.each([undefined, "", " \n\t "])("inspects implicit current context for empty host %j", host => {
        const f = fixture(undefined, host, null);
        expect(createDockerEndpointResolver(f.ports)()).toBeNull();
        expect(f.trace).toEqual([["context"], ["host"], ["inspect", undefined]]);
    });
    it("validates capabilities in order without executing effects", () => {
        const f = fixture(undefined, undefined, null); const reads: string[] = [];
        const ports = {} as DockerEndpointSelectionPorts;
        for (const name of names) Object.defineProperty(ports, name, { get() { reads.push(name); return f.ports[name]; } });
        createDockerEndpointResolver(ports);
        expect(reads).toEqual(names); expect(f.trace).toEqual([]);
    });
    it.each(names)("rejects malformed %s before later capability getters or effects", selected => {
        for (const invalid of [undefined, null, 0, false, {}, "callable"]) {
            const reads: string[] = []; const f = fixture(undefined, undefined, null);
            const ports = {} as DockerEndpointSelectionPorts;
            for (const name of names) Object.defineProperty(ports, name, { get() { reads.push(name); return name === selected ? invalid : f.ports[name]; } });
            expect(thrown(() => createDockerEndpointResolver(ports))).toBeInstanceOf(TypeError);
            expect(reads).toEqual(names.slice(0, names.indexOf(selected) + 1)); expect(f.trace).toEqual([]);
        }
    });
    it.each(names)("preserves error identity and suppresses later effects from %s", selected => {
        for (const failure of [new Error(selected), { selected }]) {
            const f = fixture(undefined, undefined, null);
            const original = f.ports[selected];
            Object.assign(f.ports, { [selected]: (...args: unknown[]) => { Reflect.apply(original, f.ports, args); throw failure; } });
            expect(thrown(createDockerEndpointResolver(f.ports))).toBe(failure);
            expect(f.trace).toEqual([["context"], ["host"], ["inspect", undefined]].slice(0, names.indexOf(selected) + 1));
        }
    });
    it("reads live ports and environment on every resolver call", () => {
        const f = fixture(undefined, "tcp://first:2376", null); const resolve = createDockerEndpointResolver(f.ports);
        expect(resolve()).toBe("tcp://first:2376");
        f.ports.readContextOverride = function () { expect(this).toBe(f.ports); return "second"; };
        f.ports.inspectContextEndpoint = function (context) { expect(this).toBe(f.ports); expect(context).toBe("second"); return "unix:///second.sock"; };
        expect(resolve()).toBe("unix:///second.sock");
    });
});
