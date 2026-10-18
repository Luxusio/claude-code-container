import { describe, expect, it } from "vitest";
import { createCodexResumeRecovery } from "../../application/tool-session/codex-resume-recovery.js";
import { parseCodexResumeRecoveryPlan, selectCodexResumeRecovery, type CodexResumeRecoveryPlan } from "../../domain/tool-session/codex-resume.js";
import type { CodexResumeRecoveryPorts } from "../../ports/tool-session/codex-resume-recovery.js";

// Native-shaped data belongs only to this test adapter; the operation receives it opaquely.
type Observation = { code: number; output: string; stderr: string; overflow: boolean; signal: string | null };
const observation = (extra: Partial<Observation> = {}): Observation => ({ code: 0, output: "", stderr: "", overflow: false, signal: null, ...extra });
const plan = (): CodexResumeRecoveryPlan => ({ command: ["codex", "resume", "--last"], retry: ["codex", "resume"], config: [] });

function fixture() {
    const trace: string[] = [];
    const runner = {};
    const report = () => {};
    type Ports = CodexResumeRecoveryPorts<object, string, typeof report, Observation>;
    const ports: { -readonly [Key in keyof Ports]: Ports[Key] } = {
        probeTerminal: async invocation => { expect(invocation.runner).toBe(runner); trace.push("probe"); return observation({ output: "util-linux" }); },
        terminalSupported: value => value.code === 0 && value.output.includes("util-linux"),
        launchOriginal: async (_invocation, _command, direct) => { trace.push(direct ? "direct" : "original"); return observation({ code: direct ? 7 : 1 }); },
        recoverableOriginal: value => value.code === 1 && !value.signal,
        exitCode: value => value.code,
        qualifyRollout: () => { trace.push("qualify"); return { id: "id", path: "qualified" }; },
        probeMigration: async () => { trace.push("support"); return observation(); },
        supportsMigration: () => true,
        migrateThread: async (_invocation, _command, _config, id) => { expect(id).toBe("id"); trace.push("migrate"); return observation(); },
        missingMetadata: () => false,
        migrationSucceeded: value => value.code === 0 && !value.signal && !value.overflow,
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
    it("does not qualify an original failure that carries a signal", async () => {
        const f = fixture(); f.ports.launchOriginal = async () => observation({ code: 1, signal: "SIGTERM" });
        expect(await f.run()).toBe(1); expect(f.trace).toEqual(["probe", "dispose"]);
    });
    it("short-circuits migration success before inspecting repaired-thread evidence", async () => {
        const f = fixture(); f.ports.migrationSucceeded = () => false;
        f.ports.repairedThread = () => { throw new Error("must not inspect unsuccessful migration"); };
        expect(await f.run()).toBe(1); expect(f.trace.slice(-2)).toEqual(["migration", "dispose"]);
        expect(f.trace).not.toContain("retry");
    });
    it.each(["rollout", "support", "repaired"])("does not retry when %s qualification is refused", async stage => {
        const f = fixture();
        if (stage === "rollout") f.ports.qualifyRollout = () => null;
        if (stage === "support") f.ports.supportsMigration = () => false;
        if (stage === "repaired") f.ports.repairedThread = () => false;
        expect(await f.run()).toBe(1); expect(f.trace).not.toContain("retry");
        expect(f.trace.at(-1)).toBe("dispose");
    });
    it("reports a failed second migration without renewing the metadata fallback", async () => {
        const f = fixture(); f.ports.missingMetadata = () => true;
        let migrations = 0;
        f.ports.migrateThread = async () => { f.trace.push("migrate"); return observation({ code: ++migrations === 1 ? 0 : 1 }); };
        expect(await f.run()).toBe(1);
        expect(f.trace).toEqual(["probe", "original", "qualify", "support", "notice", "migrate", "metadata", "migrate", "migration-after-metadata", "dispose"]);
    });
    it.each(["probe", "original", "support", "migrate", "metadata"])("honors interruption after %s before querying its observation or starting another effect", async stage => {
        const f = fixture(); let interrupted = false;
        const poison = () => { throw new Error("query ran after interruption"); };
        f.ports.interruption = () => interrupted ? 130 : 0;
        if (stage === "probe") {
            f.ports.probeTerminal = async () => { interrupted = true; return observation(); };
            f.ports.terminalSupported = poison;
        } else if (stage === "original") {
            f.ports.launchOriginal = async () => { interrupted = true; return observation(); };
            f.ports.recoverableOriginal = poison;
        } else if (stage === "support") {
            f.ports.probeMigration = async () => { interrupted = true; return observation(); };
            f.ports.supportsMigration = poison;
        } else if (stage === "migrate") {
            f.ports.migrateThread = async () => { interrupted = true; return observation(); };
            f.ports.missingMetadata = poison;
            f.ports.migrationSucceeded = poison;
        } else {
            f.ports.missingMetadata = () => true;
            f.ports.restoreMetadata = async () => { interrupted = true; return { ok: true }; };
        }
        f.ports.exitCode = poison;
        expect(await f.run()).toBe(130); expect(f.trace.at(-1)).toBe("dispose");
        expect(f.trace).not.toContain("retry");
    });
    it("recovers using symbol evidence with no native observation fields", async () => {
        const probe = Symbol("terminal"), first = Symbol("first"), help = Symbol("help");
        const migration = Symbol("migration"), retried = Symbol("retried");
        const seen: symbol[] = [];
        const ports: CodexResumeRecoveryPorts<object, string, undefined, symbol> = {
            probeTerminal: async () => probe,
            terminalSupported: value => { expect(value).toBe(probe); return true; },
            launchOriginal: async (_invocation, command, direct) => { expect(command).toEqual(plan().command); expect(direct).toBe(false); return first; },
            recoverableOriginal: value => { expect(value).toBe(first); return true; },
            qualifyRollout: (_invocation, value) => { expect(value).toBe(first); return { id: "opaque-id", path: "qualified" }; },
            probeMigration: async () => help,
            supportsMigration: value => { expect(value).toBe(help); return true; },
            migrateThread: async (_invocation, command, config, id) => { expect([command, config, id]).toEqual([plan().command, [], "opaque-id"]); return migration; },
            missingMetadata: value => { expect(value).toBe(migration); return false; },
            restoreMetadata: async () => { throw new Error("unexpected metadata fallback"); },
            migrationSucceeded: value => { expect(value).toBe(migration); return true; },
            repairedThread: (value, id) => { expect([value, id]).toEqual([migration, "opaque-id"]); return true; },
            retryResume: async (_invocation, retry, id) => { expect([retry, id]).toEqual([plan().retry, "opaque-id"]); seen.push(retried); return retried; },
            exitCode: value => { expect(value).toBe(retried); return 23; },
            interruption: () => 0,
            reportRecovery: () => {}, reportFailure: () => { throw new Error("unexpected recovery failure"); },
            dispose: () => { seen.push(probe); },
        };
        expect(await createCodexResumeRecovery(ports)(plan(), {}, "opaque-home", undefined)).toBe(23);
        expect(seen).toEqual([retried, probe]);
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
