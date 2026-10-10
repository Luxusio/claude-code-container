import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import { runtimeCli } from "../../container-runtime.js";
import { withCodexConfigLock } from "../../codex-config-lock.js";
import { prepareCodexConfigForContainer, restoreCodexConfigHostOwnership } from "../../docker.js";
import { CODEX_HARNESS_BOOTSTRAP, ensureCodexHarness } from "../../codex-harness.js";

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

    it("does not suppress an exception from warning publication", () => {
        const sentinel = new Error("warning fault");
        vi.mocked(spawnSync).mockImplementationOnce(() => { throw new Error("transport"); });
        vi.spyOn(console, "warn").mockImplementation(() => { throw sentinel; });
        expect(() => ensureCodexHarness("final-id")).toThrow(sentinel);
        expect(restoreCodexConfigHostOwnership).toHaveBeenCalledOnce();
    });
});
