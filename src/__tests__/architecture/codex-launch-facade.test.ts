import { describe, expect, it, vi } from "vitest";
import type { spawnSync } from "node:child_process";
import { prepareCodexLaunch } from "../../codex-launch.js";

const ok = { status: 0, stdout: "", stderr: "", signal: null };
describe("Codex launch native composition", () => {
    it("uses a bounded native probe before starting the daemon", () => {
        const runner = vi.fn().mockReturnValueOnce({...ok, status: 1, stdout: "ccc-codex-daemon-missing\n"})
            .mockReturnValueOnce({...ok, stdout: "Usage: codex app-server daemon start [OPTIONS]\n"}).mockReturnValue(ok);
        expect(prepareCodexLaunch("fixture-runtime", ["exec", "fixture"], ["codex"], runner as unknown as typeof spawnSync).command).toEqual(["codex"]);
        expect(runner.mock.calls[0]).toEqual(["fixture-runtime", ["exec", "fixture", "node", "-e", expect.any(String)], {encoding:"utf8",timeout:5000,maxBuffer:65536,stdio:"pipe"}]);
        expect(runner.mock.calls[1][1]).toEqual(["exec", "fixture", "codex", "app-server", "daemon", "start", "--help"]);
        expect(runner.mock.calls[2][1]).toEqual(["exec", "fixture", "codex", "app-server", "daemon", "start"]);
    });
});
