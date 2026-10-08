import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { coreBoundaryViolations } from "./core-boundary.js";

// Frozen c284ead3 compatibility facade; execution has only injected fake filesystem/presentation.
const LEGACY_FACADE = "import { readFileSync } from \"node:fs\";\nimport type { CodexResumeRecoveryPlan } from \"./codex-resume-recovery-runtime.js\";\n\nconst VALUE_OPTIONS = new Set([\n    \"-c\", \"--config\", \"--enable\", \"--disable\", \"-m\", \"--model\", \"-s\", \"--sandbox\",\n    \"-a\", \"--ask-for-approval\", \"--local-provider\", \"--add-dir\",\n]);\nconst CONFIG_OPTIONS = new Set([\"-c\", \"--config\", \"--enable\", \"--disable\"]);\nconst BOOLEAN_OPTIONS = new Set([\n    \"--no-daemon\", \"--no-alt-screen\", \"--oss\", \"--strict-config\", \"--approve-for-me\",\n    \"--dangerously-bypass-approvals-and-sandbox\", \"--dangerously-bypass-hook-trust\", \"--search\",\n]);\nconst SELECTOR_OPTIONS = new Set([\"--last\", \"--all\", \"--include-non-interactive\"]);\n\n/** Wrap only local resume without a prompt; the container retains its existing identity and environment. */\nexport function buildCodexResumeRecoveryCommand(command: readonly string[]): string[] {\n    const unchanged = [...command];\n    if (command[0] !== \"codex\") return unchanged;\n    let resume = false;\n    let selector: string | undefined;\n    const retry = [command[0]];\n    const config: string[] = [];\n    for (let index = 1; index < command.length; index += 1) {\n        const argument = command[index];\n        if (!argument.startsWith(\"-\")) {\n            if (!resume) {\n                if (argument !== \"resume\") return unchanged;\n                resume = true;\n                retry.push(argument);\n            } else if (selector === undefined) selector = argument;\n            else return unchanged; // A second positional argument is a prompt and must never be replayed.\n            continue;\n        }\n        const equals = argument.indexOf(\"=\");\n        const flag = equals < 0 ? argument : argument.slice(0, equals);\n        if (VALUE_OPTIONS.has(flag)) {\n            const values = [argument];\n            if (equals < 0) {\n                if (++index >= command.length) return unchanged;\n                values.push(command[index]);\n            }\n            retry.push(...values);\n            if (CONFIG_OPTIONS.has(flag)) config.push(...values);\n        } else if (SELECTOR_OPTIONS.has(argument) && resume) {\n            // The failed picker/last selection is replaced by its validated UUID after recovery.\n        } else if (BOOLEAN_OPTIONS.has(argument)) retry.push(argument);\n        else return unchanged;\n    }\n    if (!resume) return unchanged;\n    const plan: CodexResumeRecoveryPlan = { command: unchanged, retry, config, selector };\n    try {\n        const runtime = readFileSync(new URL(\"../dist/codex-resume-runtime.cjs\", import.meta.url), \"utf8\");\n        return [\"node\", \"-e\", runtime, \"--\", JSON.stringify(plan)];\n    } catch {\n        console.error(\"[ccc] Automatic resume recovery is unavailable; rebuild or reinstall CCC.\");\n        return unchanged;\n    }\n}\n";

function execute(source: string, values: string[], unavailable: boolean, warnThrows = false) {
    const trace: unknown[] = [];
    const sentinel = "raw-warning-sentinel";
    const command = new Proxy(values, { get(target, key, receiver) { trace.push(["arg", String(key)]); return Reflect.get(target, key, receiver); } });
    const facade: Record<string, unknown> = {};
    const nativeFs = Object.defineProperty({}, "readFileSync", {
        get() {
            trace.push(["callee", "read"]);
            return function(this: unknown, url: URL, encoding: string) {
                expect(this).toBeUndefined(); trace.push(["read", url.pathname, encoding]);
                if (unavailable) throw {};
                return "fixture-runtime";
            };
        },
    });
    const presenter = { error(message: string) { expect(this).toBe(presenter); trace.push(["warning", message]); if (warnThrows) throw sentinel; } };
    const requireFixture = (specifier: string) => {
        if (specifier === "node:fs") return nativeFs;
        if (specifier === "./domain/tool-session/codex-resume.js") {
            const exported: Record<string, unknown> = {};
            const domain = readFileSync(fileURLToPath(new URL("../../domain/tool-session/codex-resume.ts", import.meta.url)), "utf8");
            new Function("exports", ts.transpileModule(domain, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(exported);
            return exported;
        }
        throw new Error("Unexpected facade dependency: " + specifier);
    };
    const compiled = ts.transpileModule(source.replaceAll("import.meta.url", '"file:///fixture/src/codex-resume-recovery.js"'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    new Function("require", "exports", "console", "URL", compiled)(requireFixture, facade, presenter, URL);
    const build = facade.buildCodexResumeRecoveryCommand as (command: readonly string[]) => string[];
    let result: string[] | undefined;
    let error: unknown;
    try { result = build(command); } catch (caught) { error = caught; expect(caught).toBe(sentinel); }
    if (result) expect(result).not.toBe(command);
    return { trace, result, error };
}

describe("frozen Codex resume facade", () => {
    const candidate = readFileSync(fileURLToPath(new URL("../../codex-resume-recovery.ts", import.meta.url)), "utf8");
    const cases = [
        [], ["codex"], ["claude", "resume"], ["codex", "resume"], ["codex", "resume", "id"],
        ["codex", "-c", 'model="private"', "resume", "--last", "--all", "--include-non-interactive"],
        ["codex", "--enable=x", "--disable", "x", "resume", "--model=m", "--search"],
        ["codex", "resume", "id", "prompt"], ["codex", "resume", "--remote=wss://invalid"],
        ["codex", "resume", "--image", "image"], ["codex", "--profile", "p", "resume"],
        ["codex", "resume", "--"], ["codex", "resume", "-c"], ["codex", "resume", "--unknown"],
    ];
    it.each(cases)("preserves planner, transport and native argument observations: %j", (...values) => {
        for (const unavailable of [false, true]) expect(execute(candidate, values, unavailable)).toEqual(execute(LEGACY_FACADE, values, unavailable));
    });
    it("preserves an exception from the unavailable-runtime warning", () => {
        expect(execute(candidate, ["codex", "resume"], true, true)).toEqual(execute(LEGACY_FACADE, ["codex", "resume"], true, true));
    });
    it("keeps every actual inward module inside the existing dependency boundary", () => {
        for (const path of ["domain/tool-session/codex-resume", "ports/tool-session/codex-resume-recovery", "application/tool-session/codex-resume-recovery"]) {
            const file = fileURLToPath(new URL("../../" + path + ".ts", import.meta.url));
            expect(coreBoundaryViolations(readFileSync(file, "utf8"), file, { root: fileURLToPath(new URL("../../", import.meta.url)), language: "ts" })).toEqual([]);
        }
    });
    it("rejects native defaults and application-to-facade dependencies", () => {
        const file = fileURLToPath(new URL("../../application/tool-session/codex-resume-recovery.ts", import.meta.url));
        const boundary = { root: fileURLToPath(new URL("../../", import.meta.url)), language: "ts" as const };
        for (const mutation of ['import {spawn} from "node:child_process";', 'process.env.CODEX_HOME;', 'Date.now();', 'import "../../codex-resume-process.js";', 'import("node:fs");']) {
            expect(coreBoundaryViolations(mutation, file, boundary).length).toBeGreaterThan(0);
        }
    });
});

