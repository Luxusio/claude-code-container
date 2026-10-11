import { describe, expect, it, vi } from "vitest";
import type { spawnSync } from "node:child_process";
import { prepareCodexLaunch, prepareCodexLaunchSemantic, presentCodexLaunchPreparation } from "../../codex-launch.js";

const ok = { status: 0, stdout: "", stderr: "", signal: null };
describe("Codex launch native composition", () => {
    it("redacts engine diagnostics at the public boundary while retaining the semantic refusal", () => {
        const secret = "private-engine-url-token";
        const runner = vi.fn(() => ({ ...ok, status: 1, stderr: `Cannot connect to the Docker daemon at unix:///${secret}` }));
        const result = prepareCodexLaunchSemantic("docker", ["exec", "fixture"], ["codex"], runner as unknown as typeof spawnSync);
        expect(result).toMatchObject({ ok: false, reason: "engine-unavailable", status: 1 });
        const publicResult = presentCodexLaunchPreparation(result);
        expect(publicResult).toMatchObject({ ok: false, status: 1, error: expect.stringContaining("Container engine is unavailable") });
        expect(JSON.stringify(publicResult)).not.toContain(secret);
        expect(runner).toHaveBeenCalledTimes(1);
    });
    it.each([["SIGHUP", 129], ["SIGQUIT", 1]] as const)("renders native initialization signal %s with the preserved status", (signal, status) => {
        const runner = vi.fn().mockReturnValueOnce({ ...ok, status: 1, stdout: "ccc-codex-daemon-missing\n" })
            .mockReturnValueOnce({ ...ok, stdout: "Usage: codex app-server daemon start [OPTIONS]\n" })
            .mockReturnValueOnce({ ...ok, status: null, signal });
        expect(prepareCodexLaunch("docker", ["exec", "fixture"], ["codex"], runner as unknown as typeof spawnSync))
            .toMatchObject({ ok: false, status, error: expect.stringContaining("signal " + signal) });
        expect(runner).toHaveBeenCalledTimes(3);
    });
    it("bounds initialization diagnostics in the public failure", () => {
        const runner = vi.fn().mockReturnValueOnce({ ...ok, status: 1, stdout: "ccc-codex-daemon-missing\n" })
            .mockReturnValueOnce({ ...ok, stdout: "Usage: codex app-server daemon start [OPTIONS]\n" })
            .mockReturnValueOnce({ ...ok, status: 9, stderr: "x".repeat(1500) + "private-tail" });
        const result = prepareCodexLaunch("docker", ["exec", "fixture"], ["codex"], runner as unknown as typeof spawnSync);
        expect(result).toMatchObject({ ok: false, status: 9 });
        expect(JSON.stringify(result)).not.toContain("private-tail");
    });
    it("uses a bounded native probe before starting the daemon", () => {
        const runner = vi.fn().mockReturnValueOnce({...ok, status: 1, stdout: "ccc-codex-daemon-missing\n"})
            .mockReturnValueOnce({...ok, stdout: "Usage: codex app-server daemon start [OPTIONS]\n"}).mockReturnValue(ok);
        expect(prepareCodexLaunch("fixture-runtime", ["exec", "fixture"], ["codex"], runner as unknown as typeof spawnSync).command).toEqual(["codex"]);
        expect(runner.mock.calls[0]).toEqual(["fixture-runtime", ["exec", "fixture", "node", "-e", expect.any(String)], {encoding:"utf8",timeout:5000,maxBuffer:65536,stdio:"pipe"}]);
        expect(runner.mock.calls[1][1]).toEqual(["exec", "fixture", "codex", "app-server", "daemon", "start", "--help"]);
        expect(runner.mock.calls[2][1]).toEqual(["exec", "fixture", "codex", "app-server", "daemon", "start"]);
    });
});
