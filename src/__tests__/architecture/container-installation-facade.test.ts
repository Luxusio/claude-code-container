import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ spawn: vi.fn(), exports: {} as Record<string, unknown>, cli: "docker", runtimeReads: 0, runtimeEffect: undefined as (() => void) | undefined, calls: [] as unknown[][], outcomes: [] as Array<Record<string, unknown>> }));
vi.mock("child_process", async original => {
    const actual = await original<typeof import("node:child_process")>(); const blocked = () => { throw new Error("Forbidden fixture process"); };
    const exports = { ...actual, spawnSync: state.spawn, spawn: blocked, exec: blocked, execSync: blocked, execFile: blocked, execFileSync: blocked, fork: blocked }; state.exports = exports; return exports;
});
vi.mock("../../container-runtime.js", async original => ({ ...await original<typeof import("../../container-runtime.js")>(), runtimeCli: () => { state.runtimeReads++; state.runtimeEffect?.(); return state.cli; } }));
vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => process.platform === "win32" ? "C:\\ccc-installation-fake\\home" : "/ccc-installation-fake/home" }));
const setup = await import("../../container-setup.js");
beforeEach(() => {
    vi.resetAllMocks(); state.calls = []; state.outcomes = []; state.cli = "docker"; state.runtimeReads = 0; state.runtimeEffect = undefined; state.exports.spawnSync = state.spawn;
    state.spawn.mockImplementation((...args: unknown[]) => { state.calls.push(args); if (!state.outcomes.length) throw new Error("Unexpected additional command"); return { stdout: "", stderr: "", ...state.outcomes.shift() }; });
    vi.spyOn(console, "log").mockImplementation(function(this: unknown) { });
    vi.spyOn(process.stderr, "write").mockImplementation(function(this: unknown) { return true; });
});
afterEach(() => { state.exports.spawnSync = state.spawn; state.runtimeEffect = undefined; vi.restoreAllMocks(); });
describe("actual container installation native composition", () => {

    it("bounds native installation and confirmation commands", () => {
        state.outcomes = [{ status: 0, stdout: "INSTALL" }, { status: 0 }, { status: 0, stdout: "VALID" }];
        setup.ensureClaudeInContainer("target");
        expect(state.calls.map(call => call[0])).toEqual(["docker", "docker", "docker"]);
        expect(state.calls[0][2]).toEqual({ encoding: "utf-8", timeout: 150_000 });
        expect(state.calls[1][2]).toEqual({ stdio: "inherit", timeout: 300_000 });
    });
    it("preserves public arities without exposing private implementation helpers", () => {
        expect(setup.ensureClaudeInContainer.length).toBe(1); expect(setup.ensureUvAvailable.length).toBe(1); expect(setup.ensureTools.length).toBe(2);
        expect("ensureNpmTool" in setup).toBe(false); expect("ensureCodexBubblewrap" in setup).toBe(false);
    });
});
