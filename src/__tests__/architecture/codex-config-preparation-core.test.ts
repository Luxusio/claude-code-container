import { describe, expect, it } from "vitest";
import { createCodexConfigPreparation } from "../../application/codex-config-preparation.js";
import type { CodexConfigPreparationPorts } from "../../ports/codex-config-preparation.js";

const stages = ["probe", "repair", "finalize"] as const;
type Stage = typeof stages[number];
type Result = ReturnType<CodexConfigPreparationPorts[Stage]>;
function fixture(stage?: Stage, observation?: Result) {
    const trace: string[] = [];
    const ports: CodexConfigPreparationPorts = {
        probe(target) { trace.push(`probe:${target}`); return stage === "probe" ? observation! : { status: 1 }; },
        repair(target) { trace.push(`repair:${target}`); return stage === "repair" ? observation! : { status: 0 }; },
        finalize(target) { trace.push(`finalize:${target}`); return stage === "finalize" ? observation! : { status: 0 }; },
    };
    return { ports, trace, app: () => createCodexConfigPreparation(ports) };
}
function message(stage: Stage, timedOut = false) {
    return `Codex config ${stage === "probe" ? "access probe" : "repair"} ${timedOut ? "timed out" : "failed"}`;
}

describe("Codex config preparation construction", () => {

    it("rejects absent ports at probe", () => {
        for (const invalid of [undefined, null, {}]) expect(() => createCodexConfigPreparation(invalid as CodexConfigPreparationPorts))
            .toThrow("Codex config preparation requires a callable probe port.");
    });

});

describe("Codex config preparation decisions", () => {
    it("returns on probe zero without reading error or any unrelated field", () => {
        const f = fixture("probe", { status: 0, get error(): unknown { throw new Error("unreachable"); } });
        expect(f.app().run("exact target")).toBeUndefined();
        expect(f.trace).toEqual(["probe:exact target"]);
    });
    it("repairs and finalizes in order with the exact target and no persistent state", () => {
        const f = fixture(); const app = f.app();
        expect(app.run("one")).toBeUndefined(); expect(app.run("two")).toBeUndefined();
        expect(f.trace).toEqual(["probe:one", "repair:one", "finalize:one", "probe:two", "repair:two", "finalize:two"]);
    });
    it.each(stages)("classifies all returned %s observations without replay", stage => {
        const outcomes: Array<[Result, boolean]> = [
            [{ status: null, error: { code: "ETIMEDOUT" } }, true],
            [{ status: 124 }, true], [{ status: 137 }, true],
            [{ status: null }, false], [{ status: -1 }, false], [{ status: 42 }, false],
            [{ status: stage === "probe" ? 1 : 0, error: new Error("native") }, false],
            [{ status: stage === "probe" ? 1 : 0, error: { code: "ENOENT" } }, false],
        ];
        if (stage !== "probe") outcomes.push([{ status: 1 }, false], [{ status: 0, error: { code: "ETIMEDOUT" } }, true]);
        for (const [result, timeout] of outcomes) {
            const f = fixture(stage, result);
            expect(() => f.app().run("target")).toThrow(message(stage, timeout));
            expect(f.trace).toEqual(stages.slice(0, stages.indexOf(stage) + 1).map(s => `${s}:target`));
        }
    });
    it.each(stages)("retains primitive/nullish and opaque %s error semantics", stage => {
        for (const error of [undefined, null, false, 0, "", NaN, true, 1, "ETIMEDOUT", Symbol("opaque"), 1n, {}, { code: 124 }]) {
            const f = fixture(stage, { status: stage === "probe" ? 1 : 0, error });
            if (error) expect(() => f.app().run("target")).toThrow(message(stage));
            else expect(f.app().run("target")).toBeUndefined();
            expect(f.trace).toEqual((error ? stages.slice(0, stages.indexOf(stage) + 1) : stages).map(s => `${s}:target`));
        }
    });

    it("keeps nested runs independent while an outer repair is active", () => {
        const f = fixture(); const app = f.app();
        f.ports.repair = function (target) {
            f.trace.push(`repair:${target}`);
            if (target === "outer") expect(app.run("inner")).toBeUndefined();
            return { status: 0 };
        };
        expect(app.run("outer")).toBeUndefined();
        expect(f.trace).toEqual(["probe:outer", "repair:outer", "probe:inner", "repair:inner", "finalize:inner", "finalize:outer"]);
    });
});
