import { describe, expect, it } from "vitest";
import { createCodexLaunchPreparation } from "../../application/tool-session/codex-launch.js";
import type { CodexDaemonObservation, CodexLaunchPorts } from "../../ports/tool-session/codex-launch.js";

const success = (extra: Partial<CodexDaemonObservation> = {}): CodexDaemonObservation => ({ error: undefined, signal: null, status: 0, stdout: "", stderr: "", ...extra });
const missing = () => success({ status: 1, stdout: "ccc-codex-daemon-missing\n" });
const startHelp = () => success({ stdout: "Usage: codex app-server daemon start [OPTIONS]\n" });
function failure(invoke: () => unknown): unknown { try { invoke(); } catch (error) { return error; } throw new Error("Expected failure"); }
function fixture() {
    const calls: string[] = [], handle = Symbol("start");
    const state = { executable: missing(), help: startHelp(), initialized: success(), fallback: success({ stdout: "  --no-daemon\n" }) };
    const ports: CodexLaunchPorts<symbol> = {
        probeDaemonExecutable() { calls.push("executable"); return state.executable; },
        prepareStart() { calls.push("bind"); return handle; },
        probeDaemonStartHelp(selected) { expect(selected).toBe(handle); calls.push("help"); return state.help; },
        initializeDaemon(selected, args) { expect(selected).toBe(handle); calls.push("start:" + args.join("|")); return state.initialized; },
        probeDaemonFallbackHelp() { calls.push("fallback"); return state.fallback; },
    };
    return { ports, calls, state, app: createCodexLaunchPreparation(ports) };
}
describe("complete Codex launch operation", () => {
    it("constructs without touching capabilities and skips administrative commands", () => {
        const f = fixture(); expect(f.calls).toEqual([]);
        Object.defineProperty(f.ports, "probeDaemonExecutable", { get() { throw new Error("Unexpected capability lookup"); } });
        const command = ["codex", "exec", "request"]; const result = f.app.prepare(command);
        expect(result).toEqual({ ok: true, command }); expect(result.command).not.toBe(command); expect(f.calls).toEqual([]);
    });
    it("prepares once and forwards the exact opaque start binding", () => {
        const f = fixture(), command = ["codex", "-c", "model=x", "--enable=feature", "resume", "uuid"];
        expect(f.app.prepare(command)).toEqual({ ok: true, command });
        expect(f.calls).toEqual(["executable", "bind", "help", "start:-c|model=x|--enable=feature"]);
    });
    it.each([success(), success({ status: 1 }), success({ status: 1, stdout: "ccc-codex-daemon-missing\n", stderr: "diagnostic" }), success({ signal: "SIGTERM" }), success({ error: new Error("spawn") })])("keeps inconclusive absence unchanged: %j", result => {
        const f = fixture(); f.state.executable = result;
        expect(f.app.prepare(["codex"])).toEqual({ ok: true, command: ["codex"] }); expect(f.calls).toEqual(["executable"]);
    });
    it.each(["call", "getter"])("swallows executable %s failure only in its original catch", kind => {
        const f = fixture(), sentinel = Symbol("probe");
        if (kind === "call") Object.defineProperty(f.ports, "probeDaemonExecutable", { value() { throw sentinel; } });
        else Object.defineProperty(f.state.executable, "error", { get() { throw sentinel; } });
        expect(f.app.prepare(["codex"])).toEqual({ ok: true, command: ["codex"] }); expect(f.calls).not.toContain("bind");
    });
    it("does not catch start binding or command-spread failures", () => {
        const f = fixture(), sentinel = Symbol("binding");
        Object.defineProperty(f.ports, "prepareStart", { value() { throw sentinel; } });
        expect(failure(() => f.app.prepare(["codex"]))).toBe(sentinel); expect(f.calls).toEqual(["executable"]);
        const bad = ["codex"]; Object.defineProperty(bad, Symbol.iterator, { value() { throw sentinel; } });
        expect(failure(() => f.app.prepare(bad))).toBe(sentinel);
    });
    it("keeps transport-probe observation failures inside the help catch", () => {
        const f = fixture(), sentinel = Symbol("help");
        Object.defineProperty(f.ports, "probeDaemonStartHelp", { value() { throw sentinel; } });
        expect(f.app.prepare(["codex"])).toEqual({ ok: true, command: ["codex"] });
        const g = fixture(); Object.defineProperty(g.state.help, "status", { get() { throw sentinel; } });
        expect(g.app.prepare(["codex"])).toEqual({ ok: true, command: ["codex"] }); expect(g.calls).toEqual(["executable", "bind", "help"]);
    });
    it.each(["executable", "help"] as const)("stops on a known engine failure during %s without starting the daemon", stage => {
        const f = fixture();
        f.state[stage] = success({ status: 1, stderr: "request returned 500 Internal Server Error for API route and version http://engine/exec/id/json" });
        expect(f.app.prepare(["codex"])).toMatchObject({ ok: false, status: 1, error: expect.stringContaining("Container engine is unavailable") });
        expect(f.calls).toEqual(stage === "executable" ? ["executable"] : ["executable", "bind", "help"]);
    });
    it("retains unsupported profile refusal after the positive help gate", () => {
        const f = fixture(); expect(f.app.prepare(["codex", "--profile", "named"])).toMatchObject({ ok: false, status: 1 });
        expect(f.calls).toEqual(["executable", "bind", "help"]);
    });
    it.each([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["unknown", 1]] as const)("maps initialization signal %s without another action", (signal, status) => {
        const f = fixture(); f.state.initialized = success({ signal, status: null });
        expect(f.app.prepare(["codex"])).toMatchObject({ ok: false, status, error: expect.stringContaining("signal " + signal) });
        expect(f.calls.at(-1)).toBe("start:");
    });
    it("uses fallback only for the exact partial-install diagnostic and advertised support", () => {
        const f = fixture(); f.state.initialized = success({ status: 1, stderr: "Error: daemon executable not found at /fake/packages/app-server-daemon/current/bin/codex;" });
        const command = ["codex", "resume", "old"];
        expect(f.app.prepare(command)).toMatchObject({ ok: true, command: ["codex", "--no-daemon", "resume", "old"] });
        expect(f.calls).toEqual(["executable", "bind", "help", "start:", "fallback"]);
        const g = fixture(); g.state.initialized = success({ status: 1, stderr: "unrelated" });
        expect(g.app.prepare(command)).toMatchObject({ ok: false }); expect(g.calls).not.toContain("fallback");
    });
    it("uses the original result snapshot while recognition observes the live command", () => {
        const f = fixture(), command = ["codex"];
        Object.defineProperty(command, Symbol.iterator, { value: function* () { yield "codex"; command[0] = "claude"; } });
        expect(f.app.prepare(command)).toEqual({ ok: true, command: ["codex"] }); expect(f.calls).toEqual([]);
    });
    it("retains original startup exception formatting and lets formatting failures escape", () => {
        const f = fixture(); Object.defineProperty(f.ports, "initializeDaemon", { value() { throw "raw error"; } });
        expect(f.app.prepare(["codex"])).toMatchObject({ ok: false, error: "Codex daemon initialization failed: raw error" });
        const g = fixture(), sentinel = Symbol("format"), value = new Error("old");
        Object.defineProperty(value, "message", { get() { throw sentinel; } });
        Object.defineProperty(g.ports, "initializeDaemon", { value() { throw value; } });
        expect(failure(() => g.app.prepare(["codex"]))).toBe(sentinel);
    });
    it("preserves raw short-circuit observation order", () => {
        const f = fixture(), reads: string[] = [];
        f.state.executable = {
            get error() { reads.push("error"); return undefined; }, get signal() { reads.push("signal"); return null; },
            get status() { reads.push("status"); return 1; }, get stdout() { reads.push("stdout"); return "ccc-codex-daemon-missing\n"; }, get stderr() { reads.push("stderr"); return ""; },
        };
        f.app.prepare(["codex"]); expect(reads).toEqual(["status", "stderr", "error", "signal", "status", "stdout", "stderr"]);
    });
});
