import { describe, expect, it } from "vitest";
import { createContainerSessionHandoff } from "../../application/container-session-handoff.js";
import type { ExistingContainerIdentity } from "../../ports/container-existing-lifecycle.js";
import type { ContainerSessionHandoffPorts } from "../../ports/container-session-handoff.js";

const id = "a".repeat(64);
const refusal = "Container identity changed before session handoff; refusing to join.";
const capabilities = ["assertProjectSources", "assertFilesystemSources", "identity"] as const;

function fixture() {
    const trace: string[] = [];
    const state = { identity: { containerId: id, running: true } as ExistingContainerIdentity | null };
    const ports: ContainerSessionHandoffPorts = {
        assertProjectSources: () => { trace.push("project"); return undefined; },
        assertFilesystemSources: () => { trace.push("filesystem"); return undefined; },
        identity: target => { trace.push(`identity:${target}`); return state.identity; },
    };
    return { trace, state, ports, app: createContainerSessionHandoff(ports) };
}

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}

describe("session handoff required capabilities", () => {

    it("rejects absent and malformed capabilities before effects", () => {
        const f = fixture();
        for (const name of capabilities) {
            for (const invalid of [undefined, null, false, 1, "function", {}]) {
                const error = thrown(() => createContainerSessionHandoff({ ...f.ports, [name]: invalid } as unknown as ContainerSessionHandoffPorts));
                expect(error).toBeInstanceOf(TypeError);
                expect((error as Error).message).toBe(`Container session handoff requires a callable ${name} port.`);
            }
        }
        for (const invalid of [undefined, null, {}]) {
            expect(() => createContainerSessionHandoff(invalid as unknown as ContainerSessionHandoffPorts)).toThrow(TypeError);
        }
        expect(f.trace).toEqual([]);
    });

    it.each(capabilities)("preserves thrown capability getter values at %s", name => {
        for (const failure of [new Error("getter"), { getter: name }]) {
            const f = fixture();
            const observed = {} as ContainerSessionHandoffPorts;
            for (const capability of capabilities) {
                Object.defineProperty(observed, capability, {
                    get() {
                        f.trace.push(capability);
                        if (capability === name) throw failure;
                        return f.ports[capability];
                    },
                });
            }
            expect(thrown(() => createContainerSessionHandoff(observed))).toBe(failure);
            expect(f.trace).toEqual(capabilities.slice(0, capabilities.indexOf(name) + 1));
        }
    });

    it("stops validation at the first malformed capability", () => {
        const f = fixture();
        const observed = {
            get assertProjectSources() { f.trace.push("project-getter"); return false; },
            get assertFilesystemSources() { throw new Error("must not read"); },
            get identity() { throw new Error("must not read"); },
        };
        expect(() => createContainerSessionHandoff(observed as unknown as ContainerSessionHandoffPorts)).toThrow(TypeError);
        expect(f.trace).toEqual(["project-getter"]);
    });
});

describe("session handoff ordering and identity", () => {
    it("asserts sources, inspects the pinned ID, and calls readiness bare before returning the name", () => {
        const f = fixture();
        const onReady = function (this: unknown, target: string) {
            f.trace.push(`ready:${target}`);
            return "ignored";
        };
        expect(f.app.run(id, "public-name", onReady)).toBe("public-name");
        expect(f.trace).toEqual(["project", "filesystem", `identity:${id}`, `ready:${id}`]);
    });

    it.each([undefined, null, false, 0, ""])("skips identity for absent or falsy readiness %s", callback => {
        const f = fixture();
        f.ports.identity = () => { throw new Error("must not inspect"); };
        expect(f.app.run(id, "name", callback as unknown as (id: string) => void)).toBe("name");
        expect(f.trace).toEqual(["project", "filesystem"]);
    });

    it.each([null, { running: false, containerId: id }, { running: true, containerId: "replacement" }])("refuses missing, stopped or replaced identity %s", identity => {
        const f = fixture(); f.state.identity = identity;
        const failure = thrown(() => f.app.run(id, "name", () => { f.trace.push("ready"); }));
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(refusal);
        expect(f.trace).toEqual(["project", "filesystem", `identity:${id}`]);
    });

    it("does not read a stopped identity's throwing ID getter", () => {
        const f = fixture();
        f.state.identity = { running: false, get containerId(): string { throw new Error("must not read"); } };
        expect(() => f.app.run(id, "name", () => {})).toThrow(refusal);
    });

    it.each(["project", "filesystem", "identity", "running", "containerId", "ready"])("propagates sentinel Error and non-Error values unchanged at %s", stage => {
        for (const failure of [new Error(stage), { stage }]) {
            const f = fixture();
            const step = (name: string): undefined => {
                f.trace.push(name);
                if (stage === name) throw failure;
                return undefined;
            };
            f.ports.assertProjectSources = () => step("project");
            f.ports.assertFilesystemSources = () => step("filesystem");
            f.ports.identity = target => {
                expect(target).toBe(id);
                step("identity");
                return {
                    get running() { step("running"); return true; },
                    get containerId() { step("containerId"); return id; },
                };
            };
            expect(thrown(() => f.app.run(id, "name", () => step("ready")))).toBe(failure);
            const order = ["project", "filesystem", "identity", "running", "containerId", "ready"];
            expect(f.trace).toEqual(order.slice(0, order.indexOf(stage) + 1));
        }
    });

    it("delays malformed truthy callback failure until after sources and valid identity", () => {
        const f = fixture();
        expect(() => f.app.run(id, "name", {} as (id: string) => void)).toThrow(TypeError);
        expect(f.trace).toEqual(["project", "filesystem", `identity:${id}`]);
        f.state.identity = null;
        expect(() => f.app.run(id, "name", {} as (id: string) => void)).toThrow(refusal);
    });

    it("ignores Promise readiness results without observing or awaiting them", () => {
        const f = fixture();
        const result = Promise.resolve("ignored");
        Object.defineProperty(result, "then", { get() { throw new Error("must not observe"); } });
        expect(f.app.run(id, "name", target => {
            expect(target).toBe(id);
            f.trace.push("ready");
            return result;
        })).toBe("name");
        expect(f.trace).toEqual(["project", "filesystem", `identity:${id}`, "ready"]);
    });
});
