import { describe, expect, it } from "vitest";
import { createCodexHarness } from "../../application/codex-harness.js";
import type { CodexHarnessPorts } from "../../ports/codex-harness.js";

function fixture(overrides: Partial<CodexHarnessPorts> = {}) {
    const trace: string[] = [];
    const warnings: unknown[] = [];
    const ports: CodexHarnessPorts = {
        withConfigLock: (operation, profile) => {
            trace.push(`lock:${profile}`);
            try { return operation(); } finally { trace.push("unlock"); }
        },
        prepareConfig: (container, profile) => { trace.push(`prepare:${container}:${profile}`); },
        executeBootstrap: container => { trace.push(`execute:${container}`); return {kind: "completed", output: "installed"}; },
        restoreAccess: (container, profile) => { trace.push(`restore:${container}:${profile}`); },
        publishBootstrapOutput: message => { trace.push(`output:${message}`); return undefined; },
        publishUnavailable: failure => { trace.push("warning"); warnings.push(failure); return undefined; },
        ...overrides,
    };
    return {ports, trace, warnings, ensure: () => createCodexHarness(ports).ensure("target", "work")};
}

describe("Codex Harness complete synchronous host policy", () => {

    it("constructs without invoking native effects", () => {
        const effect = () => { throw new Error("unexpected effect"); };
        expect(createCodexHarness({withConfigLock:effect,prepareConfig:effect,executeBootstrap:effect,restoreAccess:effect,publishBootstrapOutput:effect,publishUnavailable:effect}).ensure).toBeTypeOf("function");
    });
    it.each(["withConfigLock", "prepareConfig", "executeBootstrap", "restoreAccess", "publishBootstrapOutput", "publishUnavailable"])("rejects an absent or noncallable required binding: %s", name => {
        const all = Object.fromEntries(["withConfigLock", "prepareConfig", "executeBootstrap", "restoreAccess", "publishBootstrapOutput", "publishUnavailable"].map(key => [key, () => undefined]));
        delete all[name];
        expect(() => createCodexHarness(all as unknown as CodexHarnessPorts)).toThrow(TypeError);
        all[name] = 1 as unknown as () => undefined;
        expect(() => createCodexHarness(all as unknown as CodexHarnessPorts)).toThrow(TypeError);
    });

    it("publishes completed output and restores before releasing the lock", () => {
        const f = fixture();
        expect(f.ensure()).toBeUndefined();
        expect(f.trace).toEqual(["lock:work", "prepare:target:work", "execute:target", "output:installed", "restore:target:work", "unlock"]);
        expect(f.warnings).toEqual([]);
    });

    it.each(["completed", "failed"] as const)("omits empty output for a %s observation", kind => {
        const f = fixture();
        const failure = new Error("unavailable");
        const ports = {...f.ports, executeBootstrap: () => {
            f.trace.push("execute:target");
            return kind === "completed" ? {kind, output: ""} : {kind, output: "", failure};
        }};
        expect(createCodexHarness(ports).ensure("target", "work")).toBeUndefined();
        expect(f.trace).toEqual(["lock:work", "prepare:target:work", "execute:target", "restore:target:work", "unlock", ...(kind === "failed" ? ["warning"] : [])]);
        expect(f.warnings).toEqual(kind === "failed" ? [failure] : []);
    });

    it.each([
        {name: "Error", failure: new Error("installer failed")},
        {name: "opaque failure", failure: {code: "transport-timeout"}},
        {name: "undefined failure", failure: undefined},
    ])("publishes output before restoring and reporting the supplied $name", ({failure}) => {
        const f = fixture();
        const ports = {...f.ports, executeBootstrap: () => { f.trace.push("execute:target"); return {kind: "failed" as const, output: "installed", failure}; }};
        expect(createCodexHarness(ports).ensure("target", "work")).toBeUndefined();
        expect(f.trace).toEqual(["lock:work", "prepare:target:work", "execute:target", "output:installed", "restore:target:work", "unlock", "warning"]);
        expect(f.warnings).toHaveLength(1);
        expect(f.warnings[0]).toBe(failure);
    });

    it.each(["prepareConfig", "executeBootstrap", "publishBootstrapOutput"] as const)("restores within the lock after %s throws", stage => {
        const f = fixture();
        const failure = new Error("operation failed");
        const ports = {...f.ports, [stage]: () => { f.trace.push("failure"); throw failure; }};
        expect(createCodexHarness(ports).ensure("target", "work")).toBeUndefined();
        const preceding = stage === "prepareConfig" ? [] : stage === "executeBootstrap" ? ["prepare:target:work"] : ["prepare:target:work", "execute:target"];
        expect(f.trace).toEqual(["lock:work", ...preceding, "failure", "restore:target:work", "unlock", "warning"]);
        expect(f.warnings[0]).toBe(failure);
    });

    it("lets restoration failure replace an earlier output failure", () => {
        const f = fixture();
        const failure = new Error("restore failed");
        const ports = {...f.ports,
            publishBootstrapOutput: () => { f.trace.push("output failure"); throw new Error("output failed"); },
            restoreAccess: () => { f.trace.push("restore failure"); throw failure; },
        };
        expect(createCodexHarness(ports).ensure("target", "work")).toBeUndefined();
        expect(f.trace).toEqual(["lock:work", "prepare:target:work", "execute:target", "output failure", "restore failure", "unlock", "warning"]);
        expect(f.warnings).toHaveLength(1);
        expect(f.warnings[0]).toBe(failure);
    });

    it("warns on lock refusal without entering preparation or restoration", () => {
        const failure = new Error("lock refused");
        const f = fixture({withConfigLock: () => { throw failure; }});
        expect(f.ensure()).toBeUndefined();
        expect(f.trace).toEqual(["warning"]);
        expect(f.warnings[0]).toBe(failure);
    });

    it("propagates warning publication failure after restoration and lock release", () => {
        const sentinel = new Error("warning failed");
        const f = fixture();
        const ports = {...f.ports,
            executeBootstrap: () => { f.trace.push("execute failure"); throw new Error("transport failed"); },
            publishUnavailable: () => { f.trace.push("warning failure"); throw sentinel; },
        };
        let thrown: unknown;
        try { createCodexHarness(ports).ensure("target", "work"); } catch (error) { thrown = error; }
        expect(thrown).toBe(sentinel);
        expect(f.trace).toEqual(["lock:work", "prepare:target:work", "execute failure", "restore:target:work", "unlock", "warning failure"]);
    });
});
