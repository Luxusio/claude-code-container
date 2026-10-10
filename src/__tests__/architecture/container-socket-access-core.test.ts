import { describe, expect, it } from "vitest";
import { createContainerSocketAccess } from "../../application/container-socket-access.js";
import type { ContainerSocketAccessPorts } from "../../ports/container-socket-access.js";
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}
function fixture(status: number | null = 10, stdout: unknown = "ccc\n0\n", grantStatus: number | null = 0) {
    const trace: unknown[] = [];
    const ports: ContainerSocketAccessPorts = {
        probe(target) { trace.push(["probe", target]); return { status, stdout }; },
        grant(target, user, gid) { trace.push(["grant", target, user, gid]); return { status: grantStatus }; },
        warn() { trace.push("warn"); return undefined; },
    };
    return { trace, ports };
}

describe("container socket access construction", () => {

    it("rejects absent ports with the first diagnostic", () => {
        for (const invalid of [undefined, null, {}]) expect(() => createContainerSocketAccess(invalid as ContainerSocketAccessPorts))
            .toThrow("Container socket access requires a callable probe port.");
    });

});

describe("container socket access observations and validation", () => {
    it("returns immediately on status zero without observing stdout", () => {
        const f = fixture();
        f.ports.probe = target => { f.trace.push(["probe", target]); return {
            get status() { f.trace.push("status"); return 0; },
            get stdout(): unknown { throw new Error("unreachable stdout"); },
        }; };
        expect(createContainerSocketAccess(f.ports).run("exact-target")).toBeUndefined();
        expect(f.trace).toEqual([["probe", "exact-target"], "status"]);
    });

    it.each(["a 0", "_ 1", "a_b-9 000", `${"a".repeat(32)} 1234567890`, "ubuntu 1000", "ccc 0 ignored"])("grants exact valid tokens: %s", stdout => {
        const f = fixture(10, stdout);
        createContainerSocketAccess(f.ports).run("target");
        const [user, gid] = stdout.split(/\s+/);
        expect(f.trace).toEqual([["probe", "target"], ["grant", "target", user, gid]]);
    });
    it.each([undefined, null, "", " \t\n", "ccc", "0ccc 0", "CCC 0", "bad;user 0", "ccc$(id) 0", `${"a".repeat(33)} 0`, "ccc -1", "ccc 0x1", "ccc 1;id", "ccc 12345678901", 123, Symbol("x"), { toString: () => "ccc nope" }])("rejects malformed output without grant: %s", stdout => {
        const f = fixture();
        f.ports.probe = target => { f.trace.push(["probe", target]); return { status: 10, stdout }; };
        createContainerSocketAccess(f.ports).run("target");
        expect(f.trace).toEqual([["probe", "target"], "warn"]);
    });
    it.each([1, -1, null, 124, 137])("warns for returned probe status %s without inspecting error", status => {
        const f = fixture();
        f.ports.probe = () => ({ status, stdout: "ccc 0", get error(): unknown { throw new Error("unreachable error"); } });
        createContainerSocketAccess(f.ports).run("target");
        expect(f.trace).toEqual(["warn"]);
    });
    it.each([0, 1, null, 124, 137])("classifies only grant status %s", status => {
        const f = fixture();
        f.ports.grant = () => ({ status, get error(): unknown { throw new Error("unreachable error"); } });
        expect(createContainerSocketAccess(f.ports).run("target")).toBeUndefined();
        expect(f.trace).toEqual([["probe", "target"], ...(status === 0 ? [] : ["warn"])]);
    });

});

describe("container socket access exception identity", () => {
    const steps = ["probe", "status:1", "stdout", "coerce", "status:2", "grant", "grant-status", "warn"];
    it.each(steps)("preserves Error/non-Error at %s and stops later effects", step => {
        for (const failure of [new Error(step), { step }]) {
            const trace: string[] = [];
            const visit = (name: string) => { trace.push(name); if (name === step) throw failure; };
            let reads = 0;
            const app = createContainerSocketAccess({
                probe() { visit("probe"); return {
                    get status() { visit(`status:${++reads}`); return 10; },
                    get stdout() { visit("stdout"); return { toString() { visit("coerce"); return "ccc 0"; } }; },
                }; },
                grant() { visit("grant"); return { get status() { visit("grant-status"); return 1; } }; },
                warn() { visit("warn"); return undefined; },
            });
            expect(thrown(() => app.run("target"))).toBe(failure);
            expect(trace).toEqual(steps.slice(0, steps.indexOf(step) + 1));
        }
    });
});

describe("container socket warning lifetime", () => {
    it("warns once across targets while continuing native observations, and reset only forgets state", () => {
        const f = fixture(10, "ccc 0", 1);
        const app = createContainerSocketAccess(f.ports);
        app.run("one"); app.run("two");
        expect(f.trace).toEqual([["probe", "one"], ["grant", "one", "ccc", "0"], "warn", ["probe", "two"], ["grant", "two", "ccc", "0"]]);
        const beforeReset = [...f.trace];
        expect(app.resetWarning()).toBeUndefined();
        expect(f.trace).toEqual(beforeReset);
        app.run("three");
        expect(f.trace.at(-1)).toBe("warn");
    });
    it("keeps separate application state even when ports are shared", () => {
        const f = fixture(1);
        const one = createContainerSocketAccess(f.ports), two = createContainerSocketAccess(f.ports);
        one.run("one"); one.run("one"); two.run("two");
        expect(f.trace.filter(entry => entry === "warn")).toHaveLength(2);
    });
    it("advances state before warning, including reentrant failures and thrown warnings", () => {
        for (const failure of [new Error("warn"), { failure: "warn" }]) {
            const f = fixture(1);
            const app = createContainerSocketAccess(f.ports);
            f.ports.warn = () => { f.trace.push("warn"); app.run("reentrant"); throw failure; };
            expect(thrown(() => app.run("outer"))).toBe(failure);
            expect(app.run("later")).toBeUndefined();
            expect(f.trace).toEqual([["probe", "outer"], "warn", ["probe", "reentrant"], ["probe", "later"]]);
            app.resetWarning();
            expect(thrown(() => app.run("reset"))).toBe(failure);
        }
    });
    it("lets a warning reset state for the next invocation", () => {
        const f = fixture(1);
        const app = createContainerSocketAccess(f.ports);
        f.ports.warn = () => { f.trace.push("warn"); app.resetWarning(); return undefined; };
        app.run("one"); app.run("two");
        expect(f.trace.filter(entry => entry === "warn")).toHaveLength(2);
    });

});
