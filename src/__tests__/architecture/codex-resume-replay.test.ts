import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { CodexResumeRecoveryPlan } from "../../codex-resume-recovery-runtime.js";
import type { ResumeProcessRunner } from "../../codex-resume-process.js";

// Inert pre-cutover source, c284ead3. Native dependencies below have no host fallback.
const LEGACY_RUNTIME = "import { failedResumeRollout, missingResumeMetadata, migrationRepairedThread, supportsRolloutMigration } from \"./codex-resume-diagnostics.js\";\nimport { restoreResumeMetadata, type ResumeMetadataFailureStage } from \"./codex-resume-metadata.js\";\nimport { terminalResumeCommand, type ResumeProcessRunner } from \"./codex-resume-process.js\";\n\nexport interface CodexResumeRecoveryPlan {\n    command: string[];\n    retry: string[];\n    config: string[];\n    selector?: string;\n}\n\ntype ResumeFailureStage = ResumeMetadataFailureStage | \"migration\" | \"migration-after-metadata\";\n\nconst FAILURE_EXPLANATIONS: Record<ResumeFailureStage, string> = {\n    \"metadata-support\": \"Codex metadata recovery is unavailable\",\n    \"metadata-home\": \"Could not verify the Codex data directory\",\n    \"metadata-initialize\": \"Could not verify the metadata server\",\n    \"metadata-read\": \"Could not restore this session's metadata\",\n    \"metadata-close\": \"The metadata server did not finish cleanly\",\n    \"migration\": \"Session migration failed\",\n    \"migration-after-metadata\": \"Session migration failed after metadata recovery\",\n};\n\nfunction failureMessage(stage: ResumeFailureStage): string {\n    return `[ccc] ${FAILURE_EXPLANATIONS[stage]} (${stage}).\\n`;\n}\n\n/** Run one original launch, at most one native scoped repair, and at most one retry. */\nexport async function runCodexResumeRecovery(\n    plan: CodexResumeRecoveryPlan,\n    runner: ResumeProcessRunner,\n    home: string,\n    report: (message: string) => void,\n): Promise<number> {\n    const { command, retry, config, selector } = plan;\n    try {\n        const script = await runner.run([\"/usr/bin/script\", \"--version\"], { timeoutMs: 5000 });\n        if (runner.interrupted) return runner.interrupted;\n        if (script.code !== 0 || !script.output.includes(\"util-linux\")) {\n            return (await runner.run(command, { direct: true })).code;\n        }\n        const first = await runner.run(terminalResumeCommand(command), { terminal: true });\n        if (runner.interrupted) return runner.interrupted;\n        if (first.code !== 1 || first.signal) return first.code;\n        const rollout = failedResumeRollout(first.output, home, selector);\n        if (!rollout) return first.code;\n        const { id } = rollout;\n        const help = await runner.run([command[0], \"migrate-rollouts\", \"--help\"], { timeoutMs: 5000 });\n        if (runner.interrupted) return runner.interrupted;\n        if (!supportsRolloutMigration(help)) return first.code;\n        report(\"[ccc] Repairing this session's history index and resuming once.\\n\");\n        let migrationStage: \"migration\" | \"migration-after-metadata\" = \"migration\";\n        let migration = await runner.run(\n            [command[0], \"migrate-rollouts\", ...config, \"--apply\", \"--thread\", id, \"--json\"],\n            { timeoutMs: 60000 },\n        );\n        if (runner.interrupted) return runner.interrupted;\n        if (missingResumeMetadata(migration, id)) {\n            const restored = await restoreResumeMetadata(command[0], config, rollout, home, runner);\n            if (runner.interrupted) return runner.interrupted;\n            if (!restored.ok) {\n                report(failureMessage(restored.stage));\n                return first.code;\n            }\n            migrationStage = \"migration-after-metadata\";\n            migration = await runner.run(\n                [command[0], \"migrate-rollouts\", ...config, \"--apply\", \"--thread\", id, \"--json\"],\n                { timeoutMs: 60000 },\n            );\n            if (runner.interrupted) return runner.interrupted;\n        }\n        const repaired = migration.code === 0 && !migration.signal && !migration.overflow\n            && migrationRepairedThread(migration.output, id);\n        if (!repaired) {\n            report(failureMessage(migrationStage));\n            return first.code;\n        }\n        return (await runner.run(terminalResumeCommand([...retry, id]), { terminal: true })).code;\n    } finally {\n        runner.dispose();\n    }\n}\n";

type Recovery = (plan: CodexResumeRecoveryPlan, runner: ResumeProcessRunner, home: string, report: (message: string) => void) => Promise<number>;
type Trace = unknown[];
function load(source: string, native: Record<string, unknown>): Recovery {
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exported: Record<string, unknown> = {};
    const requireFixture = (specifier: string): unknown => {
        if (specifier in native) return native[specifier];
        if (specifier === "./application/tool-session/codex-resume-recovery.js") {
            const app: Record<string, unknown> = {};
            const appSource = readFileSync(fileURLToPath(new URL("../../application/tool-session/codex-resume-recovery.ts", import.meta.url)), "utf8");
            const output = ts.transpileModule(appSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
            new Function("exports", output)(app);
            return app;
        }
        throw new Error("Unexpected recovery dependency: " + specifier);
    };
    new Function("require", "exports", compiled)(requireFixture, exported);
    return exported.runCodexResumeRecovery as Recovery;
}

async function execute(source: string, mode: string) {
    const trace: Trace = [];
    const fault = { sentinel: "fault" };
    const cleanup = { sentinel: "cleanup" };
    let calls = 0;
    let codeReads = 0;
    const observed = (stage: string, overrides: Record<string, unknown> = {}) => new Proxy({
        code: 0, output: "", stderr: "", overflow: false, signal: null, ...overrides,
    }, {
        get(target, key, receiver) {
            trace.push(["result", stage, String(key)]);
            if (mode === "result-fault" && stage === "first" && key === "code") throw fault;
            if (mode === "first-reread" && stage === "first" && key === "code") return ++codeReads === 1 ? 1 : 7;
            return Reflect.get(target, key, receiver);
        },
    });
    const steps = [
        observed("script", { output: mode === "no-script" ? "" : "util-linux" }),
        observed("first", { code: mode === "direct" ? 23 : mode === "initial-success" ? 0 : 1, signal: mode === "signaled" ? "SIGTERM" : null, output: "qualify" }),
        observed("help", { output: mode === "no-support" ? "" : "supported" }),
        observed("migration", { code: mode === "migration-failed" || mode.startsWith("metadata") ? 1 : 0, stderr: mode.startsWith("metadata") ? "missing" : "", output: "repaired", overflow: mode === "overflow" }),
    ];
    if (mode === "no-script") steps.splice(1, steps.length, observed("direct", { code: 23 }));
    else {
        if (mode.startsWith("metadata") && mode !== "metadata-failed") steps.push(observed("migration2", { code: mode === "metadata-migration-failed" ? 1 : 0, output: "repaired" }));
        steps.push(observed("retry", { code: 9 }));
    }
    const nativeFunction = (name: string, value: unknown) => ({
        enumerable: true,
        get() { trace.push(["callee", name]); return value; },
    });
    const diagnostics = Object.defineProperties({}, {
        failedResumeRollout: nativeFunction("qualify", () => mode === "unqualified" || mode === "first-reread" ? null : { id: "id", path: "path" }),
        supportsRolloutMigration: nativeFunction("supports", (result: { output: string }) => result.output === "supported"),
        missingResumeMetadata: nativeFunction("missing", (result: { stderr: string }) => result.stderr === "missing"),
        migrationRepairedThread: nativeFunction("repaired", (output: string, id: string) => output === "repaired" && id === "id"),
    });
    const metadata = Object.defineProperties({}, {
        restoreResumeMetadata: nativeFunction("metadata", () => mode === "metadata-failed"
            ? Promise.resolve({ ok: false, stage: "metadata-read" })
            : Promise.resolve({ ok: true })),
    });
    const processes = Object.defineProperties({}, {
        terminalResumeCommand: nativeFunction("terminal", (command: readonly string[]) => ["terminal", ...command]),
    });
    const runner = Object.defineProperties({}, {
        run: {
            get() {
                trace.push(["callee", "run"]);
                if (mode === "lookup-fault") throw fault;
                return function(this: unknown, args: readonly string[], options: unknown) {
                    expect(this).toBe(runner);
                    trace.push(["run", [...args], options]); calls++;
                    if (mode === "run-fault-" + calls) throw fault;
                    return Promise.resolve(steps.shift());
                };
            },
        },
        interrupted: {
            get() { trace.push(["interrupted"]); return mode === "interrupt-" + calls ? 143 : 0; },
        },
        dispose: {
            get() {
                trace.push(["callee", "dispose"]);
                return function(this: unknown) {
                    expect(this).toBe(runner); trace.push(["dispose"]);
                    if (mode === "dispose-fault" || mode === "cleanup-overrides") throw cleanup;
                };
            },
        },
    }) as ResumeProcessRunner;
    const command = new Proxy(["codex", "resume", "--last"], {
        get(target, key, receiver) {
            trace.push(["command", String(key)]);
            if (mode === "command-fault" && calls === 2 && key === "0") throw fault;
            return Reflect.get(target, key, receiver);
        },
    });
    const config = new Proxy(["-c", "private"], {
        get(target, key, receiver) {
            trace.push(["config", String(key)]);
            if (mode === "config-fault" && key === Symbol.iterator) throw fault;
            return Reflect.get(target, key, receiver);
        },
    });
    const plan = Object.defineProperties({}, Object.fromEntries(Object.entries({
        command, retry: ["codex", "resume"], config, selector: undefined,
    }).map(([key, value]) => [key, {
        get() { trace.push(["plan", key]); if (mode === "plan-fault-" + key) throw fault; return value; },
    }]))) as CodexResumeRecoveryPlan;
    const report = function(this: unknown, message: string) {
        expect(this).toBeUndefined(); trace.push(["report", message]); if (mode === "report-fault") throw fault;
    };
    const run = load(source, {
        "./codex-resume-diagnostics.js": diagnostics,
        "./codex-resume-metadata.js": metadata,
        "./codex-resume-process.js": processes,
    });
    expect([run.name, run.length, run.constructor.name]).toEqual(["runCodexResumeRecovery", 4, "AsyncFunction"]);
    trace.push(["before"]);
    const promise = run(plan, runner, "home", report);
    trace.push(["returned"]);
    queueMicrotask(() => trace.push(["microtask"]));
    let status: number | undefined;
    let error: string | undefined;
    try { status = await promise; trace.push(["completed"]); }
    catch (caught) {
        if (caught !== fault && caught !== cleanup) throw caught;
        expect(caught).toBe(caught === fault ? fault : cleanup);
        error = caught === fault ? "fault" : "cleanup"; trace.push(["rejected"]);
    }
    return { trace, status, error };
}

describe("frozen native resume workflow replay", () => {
    const candidate = readFileSync(fileURLToPath(new URL("../../codex-resume-recovery-runtime.ts", import.meta.url)), "utf8");
    it.each([
        "normal", "no-script", "initial-success", "signaled", "unqualified", "first-reread", "no-support",
        "migration-failed", "overflow", "metadata-success", "metadata-failed", "metadata-migration-failed",
        "interrupt-1", "interrupt-2", "interrupt-3", "interrupt-4", "interrupt-5",
        "lookup-fault", "result-fault", "command-fault", "config-fault", "report-fault", "dispose-fault",
        "run-fault-1", "run-fault-2", "run-fault-3", "run-fault-4", "run-fault-5",
        "plan-fault-command", "plan-fault-retry", "plan-fault-config", "plan-fault-selector",
    ])("preserves raw native trace, status, failure and async behavior: %s", async mode => {
        expect(await execute(candidate, mode)).toEqual(await execute(LEGACY_RUNTIME, mode));
    });
});
