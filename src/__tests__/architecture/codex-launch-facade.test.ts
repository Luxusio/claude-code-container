import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { spawnSync } from "node:child_process";
import { prepareCodexLaunch } from "../../codex-launch.js";

const missing = { status: 1, stdout: "ccc-codex-daemon-missing\n", stderr: "", signal: null };
const help = { status: 0, stdout: "Usage: codex app-server daemon start [OPTIONS]\n", stderr: "", signal: null };
const ok = { status: 0, stdout: "", stderr: "", signal: null };
const run = (prefix: string[], command: string[], runner: ReturnType<typeof vi.fn>) => prepareCodexLaunch("fixture-runtime", prefix, command, runner as unknown as typeof spawnSync);
function thrown(invoke: () => unknown): unknown { try { invoke(); } catch (error) { return error; } throw new Error("Expected failure"); }

describe("actual Codex launch native composition", () => {
    it("keeps exact native script and bare receiver", () => {
        const receivers: unknown[] = [];
        const runner = vi.fn(function(this: unknown) { receivers.push(this); return ok; });
        run(["exec", "-w", "/synthetic path", "fixture"], ["codex"], runner);
        expect(receivers).toEqual([undefined]);
        expect(runner.mock.calls[0]).toEqual(["fixture-runtime", ["exec", "-w", "/synthetic path", "fixture", "node", "-e", expect.any(String)], { encoding: "utf8", timeout: 5000, maxBuffer: 65536, stdio: "pipe" }]);
        const source = readFileSync(new URL("../../codex-launch.ts", import.meta.url), "utf8");
        const probe = source.split("const DAEMON_EXECUTABLE_PROBE = \x60")[1].split("\x60;")[0];
        // Independent c284ead3 source literal fingerprint captured before this cutover.
        expect(createHash("sha256").update(probe).digest("hex")).toBe("62025f6a605b692e601927a74d9bcc0ec4a9fc9815359b0ed9200151d03c8836");
    });
    it("binds start after executable confirmation and preserves the prefix snapshot and shared mutable options", () => {
        const prefix = ["exec", "old"], command = ["codex", "-c", "model=old"];
        let phase = 0, options: Record<string, unknown> | undefined;
        const runner = vi.fn((_runtime: string, _args: string[], selected: Record<string, unknown>) => {
            if (++phase === 1) { prefix.push("after-probe"); command[0] = "selected-codex"; options = selected; selected.extra = "retained"; return missing; }
            if (phase === 2) { expect(selected).toBe(options); prefix.push("after-binding"); command[0] = "later-codex"; selected.maxBuffer = 123; return help; }
            expect(selected).not.toBe(options); expect(selected).toEqual({ encoding: "utf8", timeout: 60000, maxBuffer: 123, stdio: "pipe", extra: "retained" }); return ok;
        });
        const result = run(prefix, command, runner);
        expect(result.command).toEqual(["codex", "-c", "model=old"]);
        expect(runner.mock.calls[1][1]).toEqual(["exec", "old", "after-probe", "selected-codex", "app-server", "daemon", "start", "--help"]);
        expect(runner.mock.calls[2][1]).toEqual(["exec", "old", "after-probe", "selected-codex", "app-server", "daemon", "start", "-c", "model=old"]);
    });
    it("preserves prefix binding failures outside the help catch", () => {
        const prefix = ["exec"], sentinel = Symbol("second spread");
        const runner = vi.fn(() => { Object.defineProperty(prefix, Symbol.iterator, { value() { throw sentinel; } }); return missing; });
        expect(thrown(() => run(prefix, ["codex"], runner))).toBe(sentinel); expect(runner).toHaveBeenCalledTimes(1);
    });
    it("keeps fallback native prefix/executable live while returning the old command snapshot", () => {
        const prefix = ["exec", "original"], command = ["codex", "resume", "session"], options: unknown[] = [];
        let phase = 0;
        const runner = vi.fn((_runtime: string, _args: string[], selected: unknown) => {
            options.push(selected);
            if (++phase === 1) return missing;
            if (phase === 2) return help;
            if (phase === 3) { prefix.push("fallback-live"); command[0] = "new-codex"; return { ...ok, status: 1, stderr: "Error: daemon executable not found at /fake/packages/app-server-daemon/current/bin/codex;" }; }
            return { ...ok, stdout: "  --no-daemon\n" };
        });
        expect(run(prefix, command, runner).command).toEqual(["codex", "--no-daemon", "resume", "session"]);
        expect(runner.mock.calls[3][1]).toEqual(["exec", "original", "fallback-live", "new-codex", "--help"]);
        expect(options[0]).toBe(options[1]); expect(options[3]).toBe(options[0]); expect(options[2]).not.toBe(options[0]);
    });
    it("leaves help stdout coercion failure uncaught and stops before initialization", () => {
        const sentinel = Symbol("coercion");
        const runner = vi.fn().mockReturnValueOnce(missing).mockReturnValueOnce({ ...help, stdout: { toString() { throw sentinel; } } });
        expect(thrown(() => run(["exec"], ["codex"], runner))).toBe(sentinel); expect(runner).toHaveBeenCalledTimes(2);
    });
});
