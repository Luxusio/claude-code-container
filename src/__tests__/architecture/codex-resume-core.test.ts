import { describe, expect, it } from "vitest";
import { createCodexResumeRecovery } from "../../application/tool-session/codex-resume-recovery.js";
import { parseCodexResumeRecoveryPlan, selectCodexResumeRecovery, type CodexResumeObservation, type CodexResumeRecoveryPlan } from "../../domain/tool-session/codex-resume.js";
import type { CodexResumeRecoveryPorts } from "../../ports/tool-session/codex-resume-recovery.js";

const observation = (extra: Partial<CodexResumeObservation> = {}): CodexResumeObservation => ({ code: 0, output: "", stderr: "", overflow: false, signal: null, ...extra });
const plan = (): CodexResumeRecoveryPlan => ({ command: ["codex", "resume", "--last"], retry: ["codex", "resume"], config: [] });

function fixture() {
    const trace: string[] = [];
    const runner = {};
    const report = () => {};
    type Ports = CodexResumeRecoveryPorts<object, string, typeof report>;
    const ports: { -readonly [Key in keyof Ports]: Ports[Key] } = {
        probeTerminal: async invocation => { expect(invocation.runner).toBe(runner); trace.push("probe"); return observation({ output: "util-linux" }); },
        launchOriginal: async (_invocation, _command, direct) => { trace.push(direct ? "direct" : "original"); return observation({ code: direct ? 7 : 1 }); },
        qualifyRollout: () => { trace.push("qualify"); return { id: "id", path: "qualified" }; },
        probeMigration: async () => { trace.push("support"); return observation(); },
        supportsMigration: () => true,
        migrateThread: async (_invocation, _command, _config, id) => { expect(id).toBe("id"); trace.push("migrate"); return observation(); },
        missingMetadata: () => false,
        restoreMetadata: async () => { trace.push("metadata"); return { ok: true }; },
        repairedThread: () => true,
        retryResume: async (_invocation, _retry, id) => { expect(id).toBe("id"); trace.push("retry"); return observation({ code: 9 }); },
        interruption: () => 0,
        reportRecovery: () => { trace.push("notice"); },
        reportFailure: (_invocation, stage) => { trace.push(stage); },
        dispose: invocation => { expect(invocation.report).toBe(report); trace.push("dispose"); },
    };
    return { ports, trace, run: () => createCodexResumeRecovery(ports)(plan(), runner, "opaque-home", report) };
}

describe("Codex resume inward operation", () => {
    it("runs one scoped repair and one exact retry through required semantic ports", async () => {
        const f = fixture(); expect(await f.run()).toBe(9);
        expect(f.trace).toEqual(["probe", "original", "qualify", "support", "notice", "migrate", "retry", "dispose"]);
    });
    it("bounds the targeted metadata fallback before the same single retry", async () => {
        const f = fixture(); f.ports.missingMetadata = () => true;
        expect(await f.run()).toBe(9);
        expect(f.trace).toEqual(["probe", "original", "qualify", "support", "notice", "migrate", "metadata", "migrate", "retry", "dispose"]);
    });
    it.each(["metadata-support", "metadata-home", "metadata-initialize", "metadata-read", "metadata-close"] as const)("preserves original failure after %s", async stage => {
        const f = fixture(); f.ports.missingMetadata = () => true; f.ports.restoreMetadata = async () => ({ ok: false, stage });
        expect(await f.run()).toBe(1); expect(f.trace.slice(-2)).toEqual([stage, "dispose"]); expect(f.trace).not.toContain("retry");
    });
    it("keeps direct fallback outside later interruption checks", async () => {
        const f = fixture(); let reads = 0; f.ports.interruption = () => { reads++; return 0; };
        f.ports.probeTerminal = async () => observation({ code: 1 });
        expect(await f.run()).toBe(7); expect(reads).toBe(1); expect(f.trace).toEqual(["direct", "dispose"]);
    });
    it.each([0, 2, 143])("preserves original exit %s without qualifying a rollout", async code => {
        const f = fixture(); f.ports.launchOriginal = async () => observation({ code });
        expect(await f.run()).toBe(code); expect(f.trace).toEqual(["probe", "dispose"]);
    });
    it("does not retry a signaled or overflowing migration", async () => {
        for (const extra of [{ signal: "SIGTERM" }, { overflow: true }, { code: 1 }]) {
            const f = fixture(); f.ports.migrateThread = async () => observation(extra);
            expect(await f.run()).toBe(1); expect(f.trace.slice(-2)).toEqual(["migration", "dispose"]); expect(f.trace).not.toContain("retry");
        }
    });
    it("does not inspect or dispose after pre-try plan getters reject", async () => {
        const f = fixture(); const sentinel = {}; const input = plan(); Object.defineProperty(input, "config", { get() { throw sentinel; } });
        await expect(createCodexResumeRecovery(f.ports)(input, {}, "", () => {})).rejects.toBe(sentinel); expect(f.trace).toEqual([]);
    });
    it("propagates raw effect faults while allowing disposal to override them", async () => {
        const f = fixture(); const fault = {}; f.ports.probeTerminal = () => { throw fault; };
        await expect(f.run()).rejects.toBe(fault); expect(f.trace).toEqual(["dispose"]);
        const cleanup = {}; f.ports.dispose = () => { throw cleanup; }; await expect(f.run()).rejects.toBe(cleanup);
    });
});

describe("Codex resume pure planning and transport", () => {
    it("retains original/config options and removes only picker selectors from retry", () => {
        const command = ["codex", "-c=x", "resume", "--all", "--last", "thread", "--model", "m"];
        expect(selectCodexResumeRecovery(command)).toEqual({ eligible: true, plan: { command, retry: ["codex", "-c=x", "resume", "--model", "m"], config: ["-c=x"], selector: "thread" } });
    });
    it.each([["codex", "resume", "thread", "prompt"], ["codex", "resume", "--remote=wss://invalid"], ["codex", "resume", "-c"], ["claude", "resume"]])("does not admit %j", (...command) => {
        const selected = selectCodexResumeRecovery(command); expect(selected).toEqual({ eligible: false, command }); if (!selected.eligible) expect(selected.command).not.toBe(command);
    });
    it.each([undefined, "private malformed", "null", "[]", "{}", '{"command":[],"retry":["codex"],"config":[]}', '{"command":["codex"],"retry":["codex"],"config":1}'])("refuses malformed transport input %s", input => {
        expect(parseCodexResumeRecoveryPlan(input)).toBeNull();
    });
    it("keeps transport admission distinct from interactive invocation eligibility", () => {
        const input = { command: ["custom-executable"], retry: ["other"], config: [], selector: "" };
        expect(parseCodexResumeRecoveryPlan(JSON.stringify(input))).toEqual(input);
    });
});
