import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import { runtimeCli } from "../../container-runtime.js";
import { withCodexConfigLock } from "../../codex-config-lock.js";
import { prepareCodexConfigForContainer, restoreCodexConfigHostOwnership } from "../../docker.js";
import { CODEX_HARNESS_BOOTSTRAP, ensureCodexHarness } from "../../codex-harness.js";
import { createNativeCodexHarnessPorts } from "../../adapters/codex-harness.js";

// Deny native effects before the facade is imported; every allowed call is private observation.
vi.mock("child_process", () => ({spawnSync: vi.fn(() => { throw new Error("unconfigured native transport"); })}));
vi.mock("../../container-runtime.js", () => ({runtimeCli: vi.fn(() => "fixture-runtime")}));
vi.mock("../../docker.js", () => ({prepareCodexConfigForContainer: vi.fn(), restoreCodexConfigHostOwnership: vi.fn()}));
vi.mock("../../codex-config-lock.js", () => ({withCodexConfigLock: vi.fn((operation: () => unknown) => operation())}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(spawnSync).mockReturnValue({status: 0, stdout: "", stderr: ""} as ReturnType<typeof spawnSync>);
});
afterEach(() => vi.restoreAllMocks());

describe("actual Codex Harness facade and native binding", () => {

    it.each([undefined, "work"])("executes the generated entire program under the selected lock: %s", profile => {
        ensureCodexHarness("final-id", profile);
        expect(withCodexConfigLock).toHaveBeenCalledWith(expect.any(Function), profile);
        expect(prepareCodexConfigForContainer).toHaveBeenCalledWith("final-id", profile);
        expect(restoreCodexConfigHostOwnership).toHaveBeenCalledWith("final-id", profile);
        expect(runtimeCli).toHaveBeenCalledOnce();
        expect(spawnSync).toHaveBeenCalledExactlyOnceWith("fixture-runtime", ["exec", "-i", "--workdir", "/home/ccc", "--env", "HOME=/home/ccc", "--env", "GIT_TERMINAL_PROMPT=0", "final-id", "python3", "-"], {input: CODEX_HARNESS_BOOTSTRAP, encoding: "utf-8", timeout: 135000});
        expect(CODEX_HARNESS_BOOTSTRAP).toContain("run_bootstrap(NativeBootstrapPorts())");
        expect(vi.mocked(prepareCodexConfigForContainer).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(spawnSync).mock.invocationCallOrder[0]);
        expect(vi.mocked(spawnSync).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(restoreCodexConfigHostOwnership).mock.invocationCallOrder[0]);
    });

    it.each([
        {name: "zero status with trimmed output", result: {status: 0, stdout: "  installed\n", stderr: "unused"}, output: "installed"},
        {name: "zero status with whitespace output", result: {status: 0, stdout: " \t\n", stderr: "unused"}, output: ""},
        {name: "zero status without output", result: {status: 0, stdout: undefined, stderr: ""}, output: ""},
    ])("normalizes $name to a completed observation", ({result, output}) => {
        vi.mocked(spawnSync).mockReturnValueOnce(result as ReturnType<typeof spawnSync>);
        expect(createNativeCodexHarnessPorts().executeBootstrap("final-id")).toEqual({kind: "completed", output});
    });

    it.each([
        {name: "nonzero status", result: {status: 1, stdout: "  installed\n", stderr: "  installer failed\n"}, output: "installed", reason: "installer failed"},
        {name: "null status", result: {status: null, stdout: "  progress\n", stderr: ""}, output: "progress", reason: "bootstrap exited null"},
        {name: "whitespace stderr", result: {status: 7, stdout: "", stderr: " \t\n"}, output: "", reason: "bootstrap exited 7"},
        {name: "truthy error at zero status", result: {status: 0, stdout: "  progress\n", stderr: "secondary", error: new Error("transport failed")}, output: "progress", reason: "transport failed"},
        {name: "empty error message before stderr", result: {status: 1, stdout: "", stderr: "secondary", error: new Error("")}, output: "", reason: ""},
    ])("normalizes $name to a failed observation", ({result, output, reason}) => {
        vi.mocked(spawnSync).mockReturnValueOnce(result as ReturnType<typeof spawnSync>);
        const observation = createNativeCodexHarnessPorts().executeBootstrap("final-id");
        expect(observation.kind).toBe("failed");
        expect(observation.output).toBe(output);
        if (observation.kind !== "failed") throw new Error("bootstrap failure was classified as completed");
        expect(observation.failure).toBeInstanceOf(Error);
        expect((observation.failure as Error).message).toBe(reason);
    });

    it.each([
        {failure: new Error("native failure"), reason: "native failure"},
        {failure: "opaque failure", reason: "opaque failure"},
        {failure: undefined, reason: "undefined"},
    ])("formats a nonfatal native warning from $reason", ({failure, reason}) => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        expect(createNativeCodexHarnessPorts().publishUnavailable(failure)).toBeUndefined();
        expect(warn).toHaveBeenCalledExactlyOnceWith(`[ccc] Harness is unavailable: ${reason}. Codex will continue. Check the container's ~/.codex/config.toml and Harness installation, then retry ccc codex.`);
    });

    it("does not suppress an exception from warning publication", () => {
        const sentinel = new Error("warning fault");
        vi.mocked(spawnSync).mockImplementationOnce(() => { throw new Error("transport"); });
        vi.spyOn(console, "warn").mockImplementation(() => { throw sentinel; });
        expect(() => ensureCodexHarness("final-id")).toThrow(sentinel);
        expect(restoreCodexConfigHostOwnership).toHaveBeenCalledOnce();
    });
});
