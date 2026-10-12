import { describe, expect, it } from "vitest";
import { createCodexHarness } from "../../application/codex-harness.js";
import type { CodexHarnessPorts } from "../../ports/codex-harness.js";

function fixture(overrides: Partial<CodexHarnessPorts> = {}) {
    const trace: string[] = [];
    const warnings: string[] = [];
    const ports: CodexHarnessPorts = {
        withConfigLock: (operation, profile) => {
            trace.push(`lock:${profile}`);
            try { return operation(); } finally { trace.push("unlock"); }
        },
        prepareConfig: (container, profile) => { trace.push(`prepare:${container}:${profile}`); },
        executeBootstrap: container => { trace.push(`execute:${container}`); return {status: 0, stdout: "  installed\n"}; },
        restoreAccess: (container, profile) => { trace.push(`restore:${container}:${profile}`); },
        publishBootstrapOutput: message => { trace.push(`output:${message}`); return undefined; },
        publishUnavailable: message => { trace.push("warning"); warnings.push(message); return undefined; },
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

    it.each([
        {result: {status: 1, stdout: "  installed\n", stderr: "  installer failed\n"}, reason: "installer failed"},
        {result: {status: null, stdout: "  installed\n", error: new Error("transport timeout"), stderr: "secondary"}, reason: "transport timeout"},
        {result: {status: null, stdout: "  installed\n"}, reason: "bootstrap exited null"},
    ])("publishes output before restoring and warning about $reason", ({result, reason}) => {
        const f = fixture();
        const ports = {...f.ports, executeBootstrap: () => { f.trace.push("execute:target"); return result; }};
        expect(createCodexHarness(ports).ensure("target", "work")).toBeUndefined();
        expect(f.trace).toEqual(["lock:work", "prepare:target:work", "execute:target", "output:installed", "restore:target:work", "unlock", "warning"]);
        expect(f.warnings).toEqual([`[ccc] Harness is unavailable: ${reason}. Codex will continue. Check the container's ~/.codex/config.toml and Harness installation, then retry ccc codex.`]);
    });

    it.each(["prepareConfig", "executeBootstrap", "publishBootstrapOutput"] as const)("restores within the lock after %s throws", stage => {
        const f = fixture();
        const ports = {...f.ports, [stage]: () => { f.trace.push("failure"); throw new Error("operation failed"); }};
        expect(createCodexHarness(ports).ensure("target", "work")).toBeUndefined();
        const preceding = stage === "prepareConfig" ? [] : stage === "executeBootstrap" ? ["prepare:target:work"] : ["prepare:target:work", "execute:target"];
        expect(f.trace).toEqual(["lock:work", ...preceding, "failure", "restore:target:work", "unlock", "warning"]);
        expect(f.warnings[0]).toContain("Harness is unavailable: operation failed.");
    });

    it("lets restoration failure replace an earlier output failure", () => {
        const f = fixture();
        const ports = {...f.ports,
            publishBootstrapOutput: () => { f.trace.push("output failure"); throw new Error("output failed"); },
            restoreAccess: () => { f.trace.push("restore failure"); throw new Error("restore failed"); },
        };
        expect(createCodexHarness(ports).ensure("target", "work")).toBeUndefined();
        expect(f.trace).toEqual(["lock:work", "prepare:target:work", "execute:target", "output failure", "restore failure", "unlock", "warning"]);
        expect(f.warnings[0]).toContain("Harness is unavailable: restore failed.");
        expect(f.warnings[0]).not.toContain("output failed");
    });

    it("warns on lock refusal without entering preparation or restoration", () => {
        const f = fixture({withConfigLock: () => { throw new Error("lock refused"); }});
        expect(f.ensure()).toBeUndefined();
        expect(f.trace).toEqual(["warning"]);
        expect(f.warnings[0]).toContain("Harness is unavailable: lock refused.");
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
