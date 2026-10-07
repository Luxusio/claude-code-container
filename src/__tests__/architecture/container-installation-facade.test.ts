import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ spawn: vi.fn(), exports: {} as Record<string, unknown>, cli: "docker", runtimeReads: 0, runtimeEffect: undefined as (() => void) | undefined, calls: [] as unknown[][], outcomes: [] as Array<Record<string, unknown>> }));
vi.mock("child_process", async original => {
    const actual = await original<typeof import("node:child_process")>(); const blocked = () => { throw new Error("Forbidden fixture process"); };
    const exports = { ...actual, spawnSync: state.spawn, spawn: blocked, exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, fork: blocked }; state.exports = exports; return exports;
});
vi.mock("../../container-runtime.js", async original => ({ ...await original<typeof import("../../container-runtime.js")>(), runtimeCli: () => { state.runtimeReads++; state.runtimeEffect?.(); return state.cli; } }));
vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => process.platform === "win32" ? "C:\\ccc-installation-fake\\home" : "/ccc-installation-fake/home" }));
const setup = await import("../../container-setup.js"), registry = await import("../../tool-registry.js");
beforeEach(() => {
    vi.resetAllMocks(); state.calls = []; state.outcomes = []; state.cli = "docker"; state.runtimeReads = 0; state.runtimeEffect = undefined; state.exports.spawnSync = state.spawn;
    state.spawn.mockImplementation((...args: unknown[]) => { state.calls.push(args); if (!state.outcomes.length) throw new Error("Unexpected additional command"); return { stdout: "", stderr: "", ...state.outcomes.shift() }; });
    vi.spyOn(console, "log").mockImplementation(function(this: unknown) { expect(this).toBe(console); });
    vi.spyOn(process.stderr, "write").mockImplementation(function(this: unknown) { expect(this).toBe(process.stderr); return true; });
});
afterEach(() => { state.exports.spawnSync = state.spawn; state.runtimeEffect = undefined; vi.restoreAllMocks(); });
describe("actual container installation native composition", () => {
    it("captures native spawn before runtime lookup can replace its binding", () => {
        const failure = {}, redirected = vi.fn(() => { throw failure; }); state.outcomes = [{ status: 0, stdout: "VALID" }];
        state.runtimeEffect = () => { state.exports.spawnSync = redirected; };
        expect(setup.ensureClaudeInContainer("target")).toBeUndefined(); expect(state.calls).toHaveLength(1); expect(redirected).not.toHaveBeenCalled();
        expect(() => setup.ensureClaudeInContainer("target")).toThrow(); expect(redirected).toHaveBeenCalledTimes(1);
    });
    it("uses fresh runtime for each Claude command and exact timeouts/options", () => {
        state.outcomes = [{ status: 0, stdout: "INSTALL" }, { status: 0 }, { status: 0, stdout: "VALID" }];
        let selected = 0; state.runtimeEffect = () => { state.cli = ++selected === 2 ? "podman" : "docker"; };
        setup.ensureClaudeInContainer("target"); expect(state.calls.map(call => call[0])).toEqual(["docker", "podman", "docker"]); expect(state.runtimeReads).toBe(3);
        expect(state.calls[0][2]).toEqual({ encoding: "utf-8", timeout: 150_000 }); expect(state.calls[1][2]).toEqual({ stdio: "inherit", timeout: 300_000 });
    });
    it("pins bubblewrap CLI before all commands despite later runtime changes", () => {
        state.outcomes = [{ status: 0 }, { status: 0 }, { status: 42 }, { status: 0 }, { status: 0 }, { status: 0 }];
        state.spawn.mockImplementation((...args: unknown[]) => { state.calls.push(args); if (state.calls.length === 3) state.cli = "podman"; return { stdout: "", stderr: "", ...state.outcomes.shift() }; });
        setup.ensureTools("target", registry.getToolByName("codex")!); expect(state.calls).toHaveLength(6); expect(state.calls.slice(2).map(call => call[0])).toEqual(["docker", "docker", "docker", "docker"]); expect(state.runtimeReads).toBe(3);
        expect(state.calls[3][1]).toEqual(["exec", "-u", "root", "target", "timeout", "-k", "5s", "285s", "apt-get", "-o", "APT::Update::Error-Mode=any", "update"]);
    });
    it("preserves public arities without exposing private implementation helpers", () => {
        expect(setup.ensureClaudeInContainer.length).toBe(1); expect(setup.ensureUvAvailable.length).toBe(1); expect(setup.ensureTools.length).toBe(2);
        expect("ensureNpmTool" in setup).toBe(false); expect("ensureCodexBubblewrap" in setup).toBe(false);
    });
});
