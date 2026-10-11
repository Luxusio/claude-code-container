import { describe, expect, it } from "vitest";
import { createContainerToolInstallation } from "../../application/tooling/container-installation.js";
import type { ContainerToolInstallationPorts, ContainerToolFailure, ContainerToolEvent, ClaudeProbeObservation, ClaudeConfirmation, NpmWrapperObservation, NpmCacheObservation, DependencyObservation, ContainerToolEffect } from "../../ports/tooling/container-installation.js";
import type { ToolDefinition } from "../../domain/tool-registry.js";

const active = { name: "gemini" } as ToolDefinition;
function fixture() {
    const calls: string[] = [], events: ContainerToolEvent[] = [], failures: [ContainerToolFailure, symbol | undefined][] = [];
    const evidence = Symbol("evidence"), probe = Symbol("probe");
    const state = {
        claude: { kind: "valid" } as ClaudeProbeObservation<symbol>, confirmation: { kind: "usable" } as ClaudeConfirmation<symbol>,
        wrapper: { kind: "missing" } as NpmWrapperObservation<symbol>, cache: { kind: "ready" } as NpmCacheObservation<symbol>,
        bubble: [{ kind: "available" }] as DependencyObservation<symbol>[], uv: { kind: "available" } as DependencyObservation<symbol>,
        catalog: [{ cmd: "gemini", pkg: "@google/gemini-cli" }], effects: {} as Record<string, ContainerToolEffect<symbol>>,
    };
    const effect = (name: string): ContainerToolEffect<symbol> => { calls.push(name); return state.effects[name] ?? { kind: "succeeded" }; };
    const ports: ContainerToolInstallationPorts<symbol, symbol> = {
        prepareClaudeProbe() { calls.push("prepare"); return probe; },
        probeClaude(target, handle) { expect([target, handle]).toEqual(["target", probe]); calls.push("claude"); return state.claude; },
        confirmClaude(target, handle) { expect([target, handle]).toEqual(["target", probe]); calls.push("confirm"); return state.confirmation; },
        installClaude: () => effect("claude-install"), getNpmTools() { calls.push("catalog"); return state.catalog; },
        probeNpmWrapper() { calls.push("wrapper-probe"); return state.wrapper; }, probeNpmCache() { calls.push("cache"); return state.cache; },
        cleanupNpmPackage: () => effect("cleanup"), cleanupNpmShim: () => effect("shim"), installNpm: () => effect("npm-install"),
        reshimNpm: () => effect("reshim"), writeNpmWrapper: () => effect("wrapper"),
        createBubblewrapSession(target) { expect(target).toBe("target"); calls.push("session"); return {
            probe() { calls.push("bubble-probe"); return state.bubble.shift()!; }, updatePackageIndex: () => effect("index"), install: () => effect("bubble-install"),
        }; },
        probeUv() { calls.push("uv-probe"); return state.uv; }, installUv: () => effect("uv-install"),
        report(event) { events.push(event); return undefined; }, fail(failure, detail) { failures.push([failure, detail]); throw new Error("refused"); },
    };
    return { app: createContainerToolInstallation(ports), state, calls, events, failures, evidence };
}

describe("finite container installation policy", () => {
    it.each(["valid", "restored"] as const)("accepts Claude %s", kind => {
        const f = fixture(); f.state.claude = kind === "valid" ? { kind } : { kind, version: "1.2.3" };
        expect(f.app.ensureClaude("target")).toBeUndefined(); expect(f.calls).toEqual(["prepare", "claude"]);
        expect(f.events).toEqual(kind === "restored" ? [{ kind: "claude-restored", version: "1.2.3" }] : []);
    });
    it("installs then confirms Claude with the same opaque probe", () => {
        const f = fixture(); f.state.claude = { kind: "install-needed" }; f.app.ensureClaude("target");
        expect(f.calls).toEqual(["prepare", "claude", "claude-install", "confirm"]); expect(f.events).toEqual([{ kind: "claude-installing" }]);
    });
    it.each(["invalid", "timeout", "failure"] as const)("refuses Claude %s before installation", reason => {
        const f = fixture(); f.state.claude = reason === "invalid" ? { kind: "invalid" } : { kind: "failed", reason, evidence: f.evidence };
        expect(() => f.app.ensureClaude("target")).toThrow("refused"); expect(f.calls).toEqual(["prepare", "claude"]);
        expect(f.failures).toEqual([[reason === "invalid" ? { kind: "claude-probe-invalid" } : { kind: "claude-probe-failed", reason }, reason === "invalid" ? undefined : f.evidence]]);
    });
    it("refuses unusable confirmation with native evidence", () => {
        const f = fixture(); f.state.claude = { kind: "install-needed" }; f.state.confirmation = { kind: "unusable", evidence: f.evidence };
        expect(() => f.app.ensureClaude("target")).toThrow("refused"); expect(f.calls).toEqual(["prepare", "claude", "claude-install", "confirm"]);
        expect(f.failures).toEqual([[{ kind: "claude-confirmation-failed" }, f.evidence]]);
    });
    it("refuses missing catalog entry before npm work", () => {
        const f = fixture(); f.state.catalog = []; expect(() => f.app.ensureNpm("target", active)).toThrow("refused");
        expect(f.calls).toEqual(["catalog"]); expect(f.failures).toEqual([[{ kind: "npm-definition-missing", toolName: "gemini" }, undefined]]);
    });
    it("accepts a present wrapper without cache work", () => {
        const f = fixture(); f.state.wrapper = { kind: "present" }; f.app.ensureNpm("target", active);
        expect(f.calls).toEqual(["catalog", "wrapper-probe"]); expect(f.events).toEqual([]);
    });
    it.each(["ready", "missing"] as const)("repairs missing wrapper with %s cache", kind => {
        const f = fixture(); f.state.cache = { kind }; f.app.ensureNpm("target", active);
        expect(f.calls).toEqual(["catalog", "wrapper-probe", "cache", ...(kind === "missing" ? ["cleanup", "shim", "npm-install", "reshim"] : []), "wrapper"]);
        expect(f.events).toEqual(kind === "missing" ? [{ kind: "npm-installing", command: "gemini" }] : []);
    });
    it("refuses invalid cache before mutations", () => {
        const f = fixture(); f.state.cache = { kind: "invalid" }; expect(() => f.app.ensureNpm("target", active)).toThrow("refused");
        expect(f.calls).toEqual(["catalog", "wrapper-probe", "cache"]); expect(f.failures).toEqual([[{ kind: "npm-cache-invalid", command: "gemini" }, undefined]]);
    });
    it.each(["wrapper", "cache"] as const)("forwards %s probe failure without later work", stage => {
        const f = fixture(); f.state[stage] = { kind: "failed", reason: "timeout", evidence: f.evidence };
        expect(() => f.app.ensureNpm("target", active)).toThrow("refused");
        expect(f.calls).toEqual(["catalog", "wrapper-probe", ...(stage === "cache" ? ["cache"] : [])]);
        expect(f.failures).toEqual([[stage === "wrapper" ? { kind: "npm-wrapper-failed", reason: "timeout" } : { kind: "mutation-failed", mutation: "npm-cache", reason: "timeout", command: "gemini" }, f.evidence]]);
    });
    it("accepts available bubblewrap within one session", () => {
        const f = fixture(); f.app.ensureCodexBubblewrap("target"); expect(f.calls).toEqual(["session", "bubble-probe"]); expect(f.events).toEqual([]);
    });
    it("updates, installs and confirms missing bubblewrap within one session", () => {
        const f = fixture(); f.state.bubble = [{ kind: "missing" }, { kind: "available" }]; f.app.ensureCodexBubblewrap("target");
        expect(f.calls).toEqual(["session", "bubble-probe", "index", "bubble-install", "bubble-probe"]); expect(f.events).toEqual([{ kind: "bubblewrap-installing" }]);
    });
    it.each(["initial", "final"] as const)("distinguishes failed %s bubblewrap observation", stage => {
        const f = fixture(); const failed = { kind: "failed", reason: "timeout", evidence: f.evidence } as const;
        f.state.bubble = stage === "initial" ? [failed] : [{ kind: "missing" }, failed]; expect(() => f.app.ensureCodexBubblewrap("target")).toThrow("refused");
        expect(f.calls).toEqual(stage === "initial" ? ["session", "bubble-probe"] : ["session", "bubble-probe", "index", "bubble-install", "bubble-probe"]);
        expect(f.failures).toEqual([[{ kind: "mutation-failed", mutation: stage === "initial" ? "bubblewrap-probe" : "bubblewrap-confirmation", reason: "timeout" }, f.evidence]]);
    });
    it("refuses bubblewrap still missing after installation", () => {
        const f = fixture(); f.state.bubble = [{ kind: "missing" }, { kind: "missing" }]; expect(() => f.app.ensureCodexBubblewrap("target")).toThrow("refused");
        expect(f.failures).toEqual([[{ kind: "mutation-failed", mutation: "bubblewrap-confirmation", reason: "failure" }, undefined]]);
    });
    it.each(["available", "missing"] as const)("handles uv %s", kind => {
        const f = fixture(); f.state.uv = { kind }; f.app.ensureUv("target"); expect(f.calls).toEqual(kind === "available" ? ["uv-probe"] : ["uv-probe", "uv-install"]);
        expect(f.events).toEqual(kind === "available" ? [] : [{ kind: "uv-installing" }]);
    });
    it.each(["timeout", "failure"] as const)("refuses uv %s without installation", reason => {
        const f = fixture(); f.state.uv = { kind: "failed", reason, evidence: f.evidence }; expect(() => f.app.ensureUv("target")).toThrow("refused");
        expect(f.calls).toEqual(["uv-probe"]); expect(f.events).toEqual([]); expect(f.failures).toEqual([[{ kind: "uv-probe-failed", reason }, f.evidence]]);
    });
    it.each([
        ["claude-install", "claude-install"], ["cleanup", "npm-cleanup"], ["shim", "npm-shim-cleanup"], ["npm-install", "npm-install"],
        ["reshim", "npm-reshim"], ["wrapper", "npm-wrapper"], ["index", "bubblewrap-update"], ["bubble-install", "bubblewrap-install"], ["uv-install", "uv-install"],
    ] as const)("stops after failed %s mutation", (stage, mutation) => {
        const f = fixture(); f.state.effects[stage] = { kind: "failed", reason: "failure", evidence: f.evidence };
        f.state.claude = { kind: "install-needed" }; f.state.cache = { kind: "missing" }; f.state.bubble = [{ kind: "missing" }]; f.state.uv = { kind: "missing" };
        const run = stage === "claude-install" ? () => f.app.ensureClaude("target") : stage === "uv-install" ? () => f.app.ensureUv("target") : stage === "index" || stage === "bubble-install" ? () => f.app.ensureCodexBubblewrap("target") : () => f.app.ensureNpm("target", active);
        expect(run).toThrow("refused"); expect(f.calls.at(-1)).toBe(stage);
        expect(f.failures).toEqual([[{ kind: "mutation-failed", mutation, reason: "failure", ...(!["claude-install", "index", "bubble-install", "uv-install"].includes(stage) ? { command: "gemini" } : {}) }, f.evidence]]);
    });
});
