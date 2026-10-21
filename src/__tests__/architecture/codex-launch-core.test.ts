import { describe, expect, it, vi } from "vitest";
import { createCodexLaunchPreparation } from "../../application/tool-session/codex-launch.js";
import type { CodexLaunchPorts } from "../../ports/tool-session/codex-launch.js";

function fixture() {
    const handle = Symbol("start");
    const ports: CodexLaunchPorts<symbol> = {
        probeDaemonExecutable: vi.fn<CodexLaunchPorts<symbol>["probeDaemonExecutable"]>(() => ({ kind: "missing" })),
        prepareStart: vi.fn(() => handle),
        probeDaemonStartHelp: vi.fn<CodexLaunchPorts<symbol>["probeDaemonStartHelp"]>(selected => { expect(selected).toBe(handle); return { kind: "supported" }; }),
        initializeDaemon: vi.fn<CodexLaunchPorts<symbol>["initializeDaemon"]>((selected, _args) => { expect(selected).toBe(handle); return { kind: "success" }; }),
        probeDaemonFallbackHelp: vi.fn<CodexLaunchPorts<symbol>["probeDaemonFallbackHelp"]>(() => ({ kind: "supported" })),
        describeInitializationFailure: error => ({ status: 1, cause: error }),
    };
    return { ports, handle, app: createCodexLaunchPreparation(ports) };
}
describe("semantic Codex launch operation", () => {
    it.each([["codex", "exec", "request"], ["codex", "--config"], ["codex", "unknown-command"]])("bypasses excluded or invalid commands: %j", (...command) => {
        const f = fixture(), result = f.app.prepare(command);
        expect(result).toEqual({ ok: true, command }); expect(result.command).not.toBe(command);
        expect(f.ports.probeDaemonExecutable).not.toHaveBeenCalled();
    });
    it("forwards supported configuration in order through one opaque preparation", () => {
        const f = fixture(), command = ["codex", "-c", "model=x", "--enable=feature", "resume", "uuid"];
        expect(f.app.prepare(command)).toEqual({ ok: true, command });
        expect(f.ports.prepareStart).toHaveBeenCalledTimes(1);
        expect(f.ports.initializeDaemon).toHaveBeenCalledExactlyOnceWith(f.handle, ["-c", "model=x", "--enable=feature"]);
    });
    it("keeps value arguments adjacent while preparing an interactive local-provider launch", () => {
        const f = fixture(), command = ["codex", "--local-provider", "ollama", "--model", "plugin",
            "--sandbox", "workspace-write", "--ask-for-approval", "never", "--add-dir", "other-directory",
            "--cd", "project-directory", "--image", "existing.png", "--config", "model=x",
            "--enable", "feature", "--disable=other", "--oss", "--search", "inspect this image"];
        const before = [...command];
        const result = f.app.prepare(command);
        expect(result).toEqual({ ok: true, command: before });
        expect(result.command).not.toBe(command);
        expect(command).toEqual(before);
        expect(f.ports.initializeDaemon).toHaveBeenCalledExactlyOnceWith(f.handle,
            ["--config", "model=x", "--enable", "feature", "--disable=other"]);
    });
    it.each(["resume", "fork"])("allows %s after a value that resembles an administrative command", subcommand => {
        const f = fixture(), command = ["codex", "--model", "plugin", "--local-provider", "ollama", subcommand, "thread"];
        expect(f.app.prepare(command)).toEqual({ ok: true, command });
        expect(f.ports.initializeDaemon).toHaveBeenCalledExactlyOnceWith(f.handle, []);
        expect(command).toEqual(["codex", "--model", "plugin", "--local-provider", "ollama", subcommand, "thread"]);
    });
    it.each(["e", "a", "plugin", "remote-control", "update", "exec-server"])("does not prepare administrative %s after a model value", subcommand => {
        const f = fixture(), command = ["codex", "--model", "selected-model", subcommand];
        expect(f.app.prepare(command)).toEqual({ ok: true, command });
        expect(f.ports.probeDaemonExecutable).not.toHaveBeenCalled();
        expect(f.ports.prepareStart).not.toHaveBeenCalled();
        expect(f.ports.initializeDaemon).not.toHaveBeenCalled();
    });
    it.each([
        ["codex", "--local-provider"],
        ["codex", "--model"],
        ["codex", "--remote", "wss://invalid", "resume", "thread"],
        ["codex", "--remote=wss://invalid", "resume", "thread"],
        ["codex", "--unknown", "resume", "thread"],
    ])("retains missing-value, remote and unknown launch refusal: %j", (...command) => {
        const f = fixture();
        expect(f.app.prepare(command)).toEqual({ ok: true, command });
        expect(f.ports.probeDaemonExecutable).not.toHaveBeenCalled();
        expect(f.ports.initializeDaemon).not.toHaveBeenCalled();
    });
    it.each([["-p", "named"], ["--profile", "named"], ["-pnamed"], ["--profile=named"]])("keeps named-profile launch refusal for %j", (...profile) => {
        const f = fixture(), command = ["codex", ...profile, "resume", "thread"];
        expect(f.app.prepare(command)).toEqual({ ok: false, command, status: 1, reason: "profile-unsupported" });
        expect(f.ports.initializeDaemon).not.toHaveBeenCalled();
    });
    it("does not prepare a start without positive absence", () => {
        const f = fixture(); vi.mocked(f.ports.probeDaemonExecutable).mockReturnValue({ kind: "available-or-inconclusive" });
        expect(f.app.prepare(["codex"])).toEqual({ ok: true, command: ["codex"] });
        expect(f.ports.prepareStart).not.toHaveBeenCalled();
    });
    it.each(["executable", "help"] as const)("keeps %s probe exceptions inside their original catch", stage => {
        const f = fixture(), fail = () => { throw new Error("probe unavailable"); };
        if (stage === "executable") vi.mocked(f.ports.probeDaemonExecutable).mockImplementation(fail);
        else vi.mocked(f.ports.probeDaemonStartHelp).mockImplementation(fail);
        expect(f.app.prepare(["codex"])).toEqual({ ok: true, command: ["codex"] });
        expect(f.ports.initializeDaemon).not.toHaveBeenCalled();
    });
    it("propagates preparation creation failure without initializing", () => {
        const f = fixture(), cause = new Error("binding failed"); vi.mocked(f.ports.prepareStart).mockImplementation(() => { throw cause; });
        expect(() => f.app.prepare(["codex"])).toThrow(cause); expect(f.ports.initializeDaemon).not.toHaveBeenCalled();
    });
    it.each(["executable", "help"] as const)("refuses known engine unavailability during %s", stage => {
        const f = fixture(), cause = new Error("private engine detail");
        if (stage === "executable") vi.mocked(f.ports.probeDaemonExecutable).mockReturnValue({ kind: "engine-unavailable", cause });
        else vi.mocked(f.ports.probeDaemonStartHelp).mockReturnValue({ kind: "engine-unavailable", cause });
        expect(f.app.prepare(["codex"])).toEqual({ ok: false, command: ["codex"], status: 1, reason: "engine-unavailable", cause });
        expect(f.ports.initializeDaemon).not.toHaveBeenCalled(); expect(f.ports.probeDaemonFallbackHelp).not.toHaveBeenCalled();
    });
    it("requires supported start before refusing a profile", () => {
        const f = fixture(), command = ["codex", "--profile", "named"];
        expect(f.app.prepare(command)).toEqual({ ok: false, command, status: 1, reason: "profile-unsupported" });
        expect(f.ports.initializeDaemon).not.toHaveBeenCalled();
        vi.mocked(f.ports.probeDaemonStartHelp).mockReturnValue({ kind: "unsupported-or-inconclusive" });
        expect(f.app.prepare(command)).toEqual({ ok: true, command });
    });
    it("preserves normalized initialization status and cause without probing fallback", () => {
        const f = fixture(), cause = new Error("bounded native failure");
        vi.mocked(f.ports.initializeDaemon).mockReturnValue({ kind: "failure", status: 143, cause });
        expect(f.app.prepare(["codex"])).toEqual({ ok: false, command: ["codex"], status: 143, reason: "initialization-failed", cause });
        expect(f.ports.probeDaemonFallbackHelp).not.toHaveBeenCalled();
    });
    it("qualifies fallback once and leaves command rendering to native presentation", () => {
        const f = fixture(), cause = new Error("incomplete"), command = ["codex", "resume", "old"];
        vi.mocked(f.ports.initializeDaemon).mockReturnValue({ kind: "installation-incomplete", status: 1, cause });
        expect(f.app.prepare(command)).toEqual({ ok: true, command, reason: "installation-incomplete-fallback" });
        expect(f.ports.initializeDaemon).toHaveBeenCalledTimes(1); expect(f.ports.probeDaemonFallbackHelp).toHaveBeenCalledTimes(1);
    });
    it.each([false, true])("fails incomplete initialization when fallback is unsupported or throws (throw=%s)", throws => {
        const f = fixture(), cause = new Error("incomplete"), helpFailure = new Error("help failed");
        vi.mocked(f.ports.initializeDaemon).mockReturnValue({ kind: "installation-incomplete", status: 7, cause });
        vi.mocked(f.ports.probeDaemonFallbackHelp).mockImplementation(() => { if (throws) throw helpFailure; return { kind: "unsupported" }; });
        expect(f.app.prepare(["codex"])).toEqual({ ok: false, command: ["codex"], status: throws ? 1 : 7, reason: "initialization-failed", cause: throws ? helpFailure : cause });
        expect(f.ports.initializeDaemon).toHaveBeenCalledTimes(1);
    });
    it("normalizes initialization exceptions through the native failure observation", () => {
        const f = fixture(), cause = new Error("spawn failed");
        vi.mocked(f.ports.initializeDaemon).mockImplementation(() => { throw cause; });
        expect(f.app.prepare(["codex"])).toEqual({ ok: false, command: ["codex"], status: 1, reason: "initialization-failed", cause });
    });
});
