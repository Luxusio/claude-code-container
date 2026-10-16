import { describe, expect, it } from "vitest";
import { createCodexConfigPreparation } from "../../application/codex-config-preparation.js";
import type { CodexConfigPreparationObservation, CodexConfigPreparationPorts } from "../../ports/codex-config-preparation.js";

const stages = ["probe", "repair", "finalize"] as const;
type Stage = typeof stages[number];
type FailureKind = "timed-out" | "failed";
function fixture(stage?: Stage, observation?: CodexConfigPreparationObservation) {
    const trace: string[] = [];
    const ports: CodexConfigPreparationPorts = {
        probe(target) { trace.push(`probe:${target}`); return stage === "probe" ? observation! : { kind: "repair-required" }; },
        repair(target) { trace.push(`repair:${target}`); return stage === "repair" ? observation as ReturnType<CodexConfigPreparationPorts["repair"]> : { kind: "ready" }; },
        finalize(target) { trace.push(`finalize:${target}`); return stage === "finalize" ? observation as ReturnType<CodexConfigPreparationPorts["finalize"]> : { kind: "ready" }; },
    };
    return { ports, trace, app: () => createCodexConfigPreparation(ports) };
}
function message(stage: Stage, kind: FailureKind) {
    return `Codex config ${stage === "probe" ? "access probe" : "repair"} ${kind === "timed-out" ? "timed out" : "failed"}`;
}
function caught(action: () => unknown): unknown {
    try { action(); } catch (error) { return error; }
    throw new Error("Expected failure");
}

describe("Codex config preparation construction", () => {
    it("rejects absent ports at probe", () => {
        for (const invalid of [undefined, null, {}]) expect(() => createCodexConfigPreparation(invalid as CodexConfigPreparationPorts))
            .toThrow("Codex config preparation requires a callable probe port.");
    });
});

describe("Codex config preparation decisions", () => {
    it("returns on semantic ready without reading failure details or repairing", () => {
        const ready = { kind: "ready" as const, get failure(): Error { throw new Error("unreachable"); } };
        const f = fixture("probe", ready);
        expect(f.app().run("exact target")).toBeUndefined();
        expect(f.trace).toEqual(["probe:exact target"]);
    });
    it("repairs and finalizes semantic repair-required in order with no persistent state", () => {
        const f = fixture(); const app = f.app();
        expect(app.run("one")).toBeUndefined(); expect(app.run("two")).toBeUndefined();
        expect(f.trace).toEqual(["probe:one", "repair:one", "finalize:one", "probe:two", "repair:two", "finalize:two"]);
    });
    it.each(stages)("stops at semantic %s failure without replay or later work", stage => {
        for (const kind of ["timed-out", "failed"] as const) {
            const f = fixture(stage, { kind });
            expect(() => f.app().run("target")).toThrow(message(stage, kind));
            expect(f.trace).toEqual(stages.slice(0, stages.indexOf(stage) + 1).map(s => `${s}:target`));
        }
    });
    it.each(stages)("preserves the supplied semantic %s failure identity", stage => {
        for (const kind of ["timed-out", "failed"] as const) {
            const failure = new Error(`specific ${stage} detail`);
            const f = fixture(stage, { kind, failure });
            expect(caught(() => f.app().run("target"))).toBe(failure);
            expect(f.trace).toEqual(stages.slice(0, stages.indexOf(stage) + 1).map(s => `${s}:target`));
        }
    });
    it.each(stages)("propagates %s dispatch faults without continuation", stage => {
        const f = fixture(); const failure = { stage };
        f.ports[stage] = () => { f.trace.push(`${stage}:target`); throw failure; };
        expect(caught(() => f.app().run("target"))).toBe(failure);
        expect(f.trace).toEqual(stages.slice(0, stages.indexOf(stage) + 1).map(s => `${s}:target`));
    });
    it("keeps nested runs independent while an outer repair is active", () => {
        const f = fixture(); const app = f.app();
        f.ports.repair = function (target) {
            f.trace.push(`repair:${target}`);
            if (target === "outer") expect(app.run("inner")).toBeUndefined();
            return { kind: "ready" };
        };
        expect(app.run("outer")).toBeUndefined();
        expect(f.trace).toEqual(["probe:outer", "repair:outer", "probe:inner", "repair:inner", "finalize:inner", "finalize:outer"]);
    });
});
