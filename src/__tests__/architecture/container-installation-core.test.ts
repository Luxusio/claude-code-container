import { describe, expect, it } from "vitest";
import { createContainerToolInstallation } from "../../application/tooling/container-installation.js";
import type { ContainerToolInstallationPorts, ContainerToolProbeObservation, CachedNpmObservation, NpmInstallationDefinition } from "../../ports/tooling/container-installation.js";
import type { ToolDefinition } from "../../domain/tool-registry.js";

function fixture() {
    const events: string[] = [], calls: unknown[][] = [], sets: Set<string>[] = [];
    const probe = Symbol("opaque probe"), tool = { cmd: "gemini", pkg: "@google/gemini-cli" };
    const results: Record<string, ContainerToolProbeObservation[]> = {};
    let cli = 0;
    function command(name: string) {
        events.push(`capture:${name}`);
        return function(this: unknown, ...args: unknown[]) {
            expect(this).toBeUndefined(); events.push(name); calls.push([name, ...args]);
            return results[name]?.shift() ?? { status: 0, stdout: name === "claude" ? "VALID" : name === "npm" ? "gemini" : name === "cache" ? "READY" : "", stderr: "" };
        };
    }
    const ports: ContainerToolInstallationPorts<symbol> = {
        prepareClaudeProbe() { events.push("prepare"); return probe; },
        captureClaudeProbe() { return command("claude"); }, captureClaudeInstall() { return command("claude-install"); },
        getNpmTools() { events.push("catalog"); return [tool]; },
        captureNpmProbe() { return command("npm"); }, captureNpmCachedProbe() { return command("cache") as (target: string, tool: NpmInstallationDefinition) => CachedNpmObservation; },
        captureNpmCleanup() { return command("cleanup"); }, captureNpmShimCleanup() { return command("shim"); }, captureNpmInstall() { return command("npm-install"); },
        captureNpmReshim() { return command("reshim"); }, captureNpmWrapper() { return command("wrapper"); },
        createBubblewrapSession() {
            events.push("bubble-session"); cli++;
            return {
                probe: () => { events.push("bubble"); calls.push(["bubble", cli]); return results.bubble?.shift() ?? { status: 0 }; },
                updatePackageIndex: () => { events.push("index"); calls.push(["index", cli]); return results.index?.shift() ?? { status: 0 }; },
                install: () => { events.push("bubble-install"); calls.push(["bubble-install", cli]); return results["bubble-install"]?.shift() ?? { status: 0 }; },
            };
        },
        captureUvProbe() { return command("uv"); }, captureUvInstall() { return command("uv-install"); },
        reportProbeNotes(_stderr, seen) { events.push("notes"); sets.push(seen); return undefined; },
        probeDiagnostic(stderr) { events.push("diagnostic"); return stderr ? `: ${stderr}` : ""; },
        sanitizeForTerminal(text) { events.push("sanitize"); return text; },
        captureLog() { events.push("capture:log"); return text => { events.push("log"); calls.push(["log", text]); return undefined; }; },
        reportUvProgress() { events.push("uv-progress"); return undefined; },
    };
    return { ports, app: createContainerToolInstallation(ports), events, calls, sets, probe, tool, results };
}
const active = { name: "gemini" } as ToolDefinition;
function thrown(action: () => unknown) { try { action(); } catch (error) { return error; } throw new Error("Expected failure"); }

describe("complete container installation policy", () => {
    it("constructs without reading even throwing capabilities", () => {
        const ports = new Proxy({} as ContainerToolInstallationPorts<symbol>, { get() { throw new Error("eager read"); } });
        expect(Object.keys(createContainerToolInstallation(ports))).toEqual(["ensureClaude", "ensureNpm", "ensureCodexBubblewrap", "ensureUv"]);
    });
    it.each(["VALID", "RESTORED", "RESTORED 1.2.3"])("preserves Claude %s branch and avoids installation", stdout => {
        const f = fixture(); f.results.claude = [{ status: 0, stdout }]; expect(f.app.ensureClaude("target")).toBeUndefined();
        expect(f.calls.filter(([name]) => name !== "log")).toEqual([["claude", "target", f.probe]]);
        expect(f.events).toEqual(["prepare", "capture:claude", "claude", "notes", ...(stdout.startsWith("RESTORED") ? ["sanitize", "capture:log", "log"] : [])]);
    });
    it("reuses opaque probe and original per-call note Set across install and confirmation", () => {
        const f = fixture(); f.results.claude = [{ status: 0, stdout: "INSTALL" }, { status: 0, stdout: "RESTORED 1.2" }];
        f.app.ensureClaude("target"); expect(f.calls.filter(([name]) => name !== "log")).toEqual([["claude", "target", f.probe], ["claude-install", "target"], ["claude", "target", f.probe]]);
        expect(f.sets).toHaveLength(2); expect(f.sets[0]).toBe(f.sets[1]); f.app.ensureClaude("target"); expect(f.sets[2]).not.toBe(f.sets[0]);
    });
    it("reads confirmation stdout before error or status and retains thrown identity", () => {
        const f = fixture(), failure = {};
        f.results.claude = [{ status: 0, stdout: "INSTALL" }, { get stdout(): never { throw failure; }, get status(): never { throw new Error("later status"); }, get error(): never { throw new Error("later error"); } }];
        expect(thrown(() => f.app.ensureClaude("target"))).toBe(failure); expect(f.sets).toHaveLength(1);
    });
    it.each([{ status: 124 }, { status: 137 }, { status: null, error: { code: "ETIMEDOUT" } }, { status: 1 }, { status: 0, stdout: "INVALID" }])("rejects unusable Claude probe %j without install", observation => {
        const f = fixture(); f.results.claude = [observation]; expect(() => f.app.ensureClaude("target")).toThrow(/Claude readiness probe/); expect(f.calls.map(([name]) => name)).toEqual(["claude"]);
    });
    it.each(["READY", "MISSING"])("preserves npm cached %s order and original metadata", state => {
        const f = fixture(); f.results.cache = [{ status: 0, stdout: state }]; f.app.ensureNpm("target", active);
        expect(f.calls.filter(([name]) => name !== "log").map(([name]) => name)).toEqual(["npm", "cache", ...(state === "MISSING" ? ["cleanup", "shim", "npm-install", "reshim"] : []), "wrapper"]);
        for (const call of f.calls.filter(([name]) => ["npm", "cache", "shim", "npm-install", "wrapper"].includes(String(name)))) expect(call[2]).toBe(f.tool);
        if (state === "MISSING") expect(f.calls.find(([name]) => name === "cleanup")).toEqual(["cleanup", "target", '"$gdir/@google/.gemini-cli-"*']);
    });
    it("avoids cache and mutations when wrapper probe does not name missing tool", () => {
        const f = fixture(); f.results.npm = [{ status: 0, stdout: "" }]; f.app.ensureNpm("target", active); expect(f.calls).toEqual([["npm", "target", f.tool]]);
    });
    it("rejects missing catalog before commands and preserves find receiver", () => {
        const f = fixture(), array: typeof f.tool[] = [];
        const find = array.find; Object.defineProperty(array, "find", { value: function(this: typeof array, ...args: Parameters<typeof find>) { expect(this).toBe(array); return find.apply(this, args); } });
        Object.defineProperty(f.ports, "getNpmTools", { value: () => array }); expect(() => f.app.ensureNpm("target", active)).toThrow("has no npm installation definition"); expect(f.calls).toEqual([]);
    });
    it("reads package metadata before capturing cleanup command", () => {
        const f = fixture(); f.results.cache = [{ status: 0, stdout: "MISSING" }]; let reads = 0;
        Object.defineProperty(f.tool, "pkg", { get() { expect(f.events).not.toContain("capture:cleanup"); reads++; return "@google/gemini-cli"; } });
        f.app.ensureNpm("target", active); expect(reads).toBe(3);
    });
    it("retains direct cached stdout trim and invalid cache rejection", () => {
        const f = fixture(); f.results.cache = [{ status: 0, stdout: "INVALID" }]; expect(() => f.app.ensureNpm("target", active)).toThrow("returned an invalid result"); expect(f.events).not.toContain("capture:wrapper");
        const g = fixture(); g.results.cache = [{ status: 0 }]; expect(() => g.app.ensureNpm("target", active)).toThrow(TypeError); expect(g.events).not.toContain("capture:wrapper");
    });
    it.each([0, 42])("preserves bubblewrap %s with one session", status => {
        const f = fixture(); f.results.bubble = [{ status }, { status: 0 }]; f.app.ensureCodexBubblewrap("target");
        expect(f.calls.filter(([name]) => name !== "log")).toEqual(status === 42 ? [["bubble", 1], ["index", 1], ["bubble-install", 1], ["bubble", 1]] : [["bubble", 1]]);
    });
    it.each([0, 1])("preserves uv %s branch", status => {
        const f = fixture(); f.results.uv = [{ status }]; f.app.ensureUv("target"); expect(f.calls.map(([name]) => name)).toEqual(status ? ["uv", "uv-install"] : ["uv"]); expect(f.events.includes("uv-progress")).toBe(status === 1);
    });
    it.each([2, 124, 137])("uv status %s is probe failure rather than error-code timeout", status => {
        const f = fixture(); f.results.uv = [{ status }]; expect(() => f.app.ensureUv("target")).toThrow("Container uv probe failed"); expect(f.events).not.toContain("uv-progress");
    });
    it.each(["claude-install", "cache", "cleanup", "shim", "npm-install", "reshim", "wrapper", "index", "bubble-install", "uv-install"])("stops after failed mutation %s", stage => {
        const f = fixture(); f.results.claude = [{ status: 0, stdout: "INSTALL" }]; f.results.cache = [{ status: 0, stdout: "MISSING" }]; f.results.bubble = [{ status: 42 }]; f.results.uv = [{ status: 1 }]; f.results[stage] = [{ status: 137 }];
        const run = stage === "claude-install" ? () => f.app.ensureClaude("target") : stage.startsWith("uv") ? () => f.app.ensureUv("target") : ["index", "bubble-install"].includes(stage) ? () => f.app.ensureCodexBubblewrap("target") : () => f.app.ensureNpm("target", active);
        expect(run).toThrow(/timed out/); expect(f.calls.at(-1)?.[0]).toBe(stage);
    });
    it.each(["prepareClaudeProbe", "captureClaudeProbe", "captureClaudeInstall", "getNpmTools", "captureNpmProbe", "captureNpmCachedProbe", "captureNpmCleanup", "captureNpmShimCleanup", "captureNpmInstall", "captureNpmReshim", "captureNpmWrapper", "createBubblewrapSession", "captureUvProbe", "captureUvInstall", "reportProbeNotes", "probeDiagnostic", "sanitizeForTerminal", "captureLog", "reportUvProgress"] as const)("propagates %s capability faults without later effects", name => {
        const f = fixture(), failure = { capability: name };
        f.results.claude = [{ status: 0, stdout: name === "sanitizeForTerminal" ? "RESTORED 1.2" : name === "probeDiagnostic" ? "" : "INSTALL" }];
        if (name === "probeDiagnostic") f.results.claude = [{ status: 1, stderr: "reason" }];
        f.results.cache = [{ status: 0, stdout: "MISSING" }]; f.results.uv = [{ status: 1 }];
        Object.defineProperty(f.ports, name, { value: () => { f.events.push(`fault:${name}`); throw failure; } });
        const run = name === "createBubblewrapSession" ? () => f.app.ensureCodexBubblewrap("target")
            : name.startsWith("captureUv") || name === "reportUvProgress" ? () => f.app.ensureUv("target")
            : name.startsWith("captureNpm") || name === "getNpmTools" ? () => f.app.ensureNpm("target", active)
            : () => f.app.ensureClaude("target");
        expect(thrown(run)).toBe(failure); expect(f.events.at(-1)).toBe(`fault:${name}`);
    });
    it("preserves changing status and raw getter failures instead of normalizing", () => {
        const f = fixture(), failure = {}; let reads = 0;
        f.results.uv = [{ get status() { return ++reads === 1 ? 0 : 1; }, get error() { return undefined; } }]; f.app.ensureUv("target"); expect(reads).toBe(2); expect(f.events).toContain("uv-progress");
        const g = fixture(); g.results.npm = [{ status: 0, get error(): never { throw failure; } }]; expect(thrown(() => g.app.ensureNpm("target", active))).toBe(failure); expect(g.calls).toHaveLength(1);
    });
});
