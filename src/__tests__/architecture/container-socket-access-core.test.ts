import { describe, expect, it } from "vitest";
import { createContainerSocketAccess } from "../../application/container-socket-access.js";
import type { ContainerSocketAccessPorts, ContainerSocketAccessProbe } from "../../ports/container-socket-access.js";
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}
function fixture(probe: ContainerSocketAccessProbe = { kind: "requires-group", user: "ccc", gid: "0" }, grantOk = true) {
    const trace: unknown[] = [];
    const ports: ContainerSocketAccessPorts = {
        probe(target) { trace.push(["probe", target]); return probe; },
        grant(target, user, gid) { trace.push(["grant", target, user, gid]); return { ok: grantOk }; },
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

describe("container socket access semantic observations", () => {
    it("returns after a usable probe without granting or warning", () => {
        const f = fixture({ kind: "usable" });
        expect(createContainerSocketAccess(f.ports).run("exact-target")).toBeUndefined();
        expect(f.trace).toEqual([["probe", "exact-target"]]);
    });
    it("grants the observed user and GID on the exact probed target", () => {
        const f = fixture({ kind: "requires-group", user: "ubuntu", gid: "00042" });
        expect(createContainerSocketAccess(f.ports).run("pinned-target")).toBeUndefined();
        expect(f.trace).toEqual([["probe", "pinned-target"], ["grant", "pinned-target", "ubuntu", "00042"]]);
    });
    it("warns for an unavailable probe without granting access", () => {
        const f = fixture({ kind: "unavailable" });
        expect(createContainerSocketAccess(f.ports).run("target")).toBeUndefined();
        expect(f.trace).toEqual([["probe", "target"], "warn"]);
    });
    it.each([true, false])("uses semantic grant completion %s to decide whether to warn", ok => {
        const f = fixture({ kind: "requires-group", user: "ccc", gid: "0" }, ok);
        expect(createContainerSocketAccess(f.ports).run("target")).toBeUndefined();
        expect(f.trace).toEqual([["probe", "target"], ["grant", "target", "ccc", "0"], ...(ok ? [] : ["warn"])]);
    });
});

describe("container socket access effect exceptions", () => {
    const steps = ["probe", "grant", "warn"];
    it.each(steps)("preserves Error/non-Error at %s and stops later effects", step => {
        for (const failure of [new Error(step), { step }]) {
            const trace: string[] = [];
            const visit = (name: string) => { trace.push(name); if (name === step) throw failure; };
            const app = createContainerSocketAccess({
                probe() { visit("probe"); return { kind: "requires-group", user: "ccc", gid: "0" }; },
                grant() { visit("grant"); return { ok: false }; },
                warn() { visit("warn"); return undefined; },
            });
            expect(thrown(() => app.run("target"))).toBe(failure);
            expect(trace).toEqual(steps.slice(0, steps.indexOf(step) + 1));
        }
    });
    it.each(["probe", "grant"] as const)("keeps the warning available after a thrown %s effect", step => {
        const f = fixture({ kind: "requires-group", user: "ccc", gid: "0" }, false);
        const failure = new Error(step);
        const original = f.ports[step];
        if (step === "probe") f.ports.probe = () => { throw failure; };
        else f.ports.grant = () => { throw failure; };
        const app = createContainerSocketAccess(f.ports);
        expect(thrown(() => app.run("failed"))).toBe(failure);
        expect(f.trace).not.toContain("warn");
        if (step === "probe") f.ports.probe = original as ContainerSocketAccessPorts["probe"];
        else f.ports.grant = original as ContainerSocketAccessPorts["grant"];
        app.run("later");
        expect(f.trace.at(-1)).toBe("warn");
    });
});

describe("container socket warning lifetime", () => {
    it("warns once across targets while continuing probes and grants, and reset only forgets state", () => {
        const f = fixture({ kind: "requires-group", user: "ccc", gid: "0" }, false);
        const app = createContainerSocketAccess(f.ports);
        app.run("one"); app.run("two");
        expect(f.trace).toEqual([["probe", "one"], ["grant", "one", "ccc", "0"], "warn", ["probe", "two"], ["grant", "two", "ccc", "0"]]);
        const beforeReset = [...f.trace];
        expect(app.resetWarning()).toBeUndefined();
        expect(f.trace).toEqual(beforeReset);
        app.run("three");
        expect(f.trace.at(-1)).toBe("warn");
        expect(f.trace.filter(entry => entry === "warn")).toHaveLength(2);
    });
    it("shares one warning across unavailable probes and failed grants", () => {
        const f = fixture({ kind: "unavailable" }, false);
        const app = createContainerSocketAccess(f.ports);
        app.run("unavailable");
        f.ports.probe = target => { f.trace.push(["probe", target]); return { kind: "requires-group", user: "ccc", gid: "0" }; };
        app.run("group-needed");
        expect(f.trace).toEqual([["probe", "unavailable"], "warn", ["probe", "group-needed"], ["grant", "group-needed", "ccc", "0"]]);
    });
    it("keeps separate application state even when ports are shared", () => {
        const f = fixture({ kind: "unavailable" });
        const one = createContainerSocketAccess(f.ports), two = createContainerSocketAccess(f.ports);
        one.run("one"); one.run("one"); two.run("two");
        expect(f.trace.filter(entry => entry === "warn")).toHaveLength(2);
    });
    it("advances state before warning, including reentrant failures and thrown warnings", () => {
        for (const failure of [new Error("warn"), { failure: "warn" }]) {
            const f = fixture({ kind: "unavailable" });
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
        const f = fixture({ kind: "unavailable" });
        const app = createContainerSocketAccess(f.ports);
        f.ports.warn = () => { f.trace.push("warn"); app.resetWarning(); return undefined; };
        app.run("one"); app.run("two");
        expect(f.trace.filter(entry => entry === "warn")).toHaveLength(2);
    });
});
