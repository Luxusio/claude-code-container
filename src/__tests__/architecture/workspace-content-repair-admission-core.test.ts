import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createWorkspaceContentRepairAdmission } from "../../application/workspace/content-repair-admission.js";
import type { WorkspaceContentRepairAdmissionPorts } from "../../ports/workspace/content-repair-admission.js";

// Authenticated before candidate authoring: accepted 9d6ec945, source SHA256
// b70ba8715cc9c613614eb6bdc4dd357ce0fa36ab54632a8ddd550abf9c23f59a.
// Exact full function text; never reconstructed from current candidate output.
const originalRepair = "async function repairBrokenWorktree(\n    cwd: string,\n    wsPath: string,\n    name: string,\n    branch: string,\n): Promise<void> {\n    try {\n        const fixed = fixBrokenWorktree(cwd, wsPath, name, branch, true);\n        console.log(fixed\n            ? `  ${name}: fixed (content preserved)`\n            : `  ${name}: failed to fix (content unchanged)`);\n        return;\n    } catch (error) {\n        if (!(error instanceof WorktreeContentConflictError)) {\n            // Not a disagreement about content. The repair already rolled itself back, so the\n            // directory is as it was; report it and leave the rest of the workspace alone.\n            console.log(`  ${name}: failed to fix (content unchanged) - ${(error as Error).message}`);\n            return;\n        }\n        const relativeConflicts = error.conflicts.map((path) => relative(error.worktreeRoot, path));\n        console.log(`  ${name}: cannot merge - these files differ between your copy and branch '${branch}':`);\n        for (const conflict of relativeConflicts) console.log(`      ${conflict}`);\n        console.log(\"      Nothing was changed or lost; the directory is exactly as it was.\");\n        console.log(\"      ccc can move your versions aside so the branch's versions can be checked out.\");\n        console.log(\"      Your versions stay on disk and can be moved back or merged by hand.\");\n        const answer = await prompt(\"  Move them aside and repair? (y/N) \", true);\n        if (answer !== \"y\" && answer !== \"yes\") {\n            console.log(`  ${name}: left unrepaired (content unchanged)`);\n            return;\n        }\n        const preserved = setAsideConflictingContent(error.worktreeRoot, error.conflicts);\n        console.log(`  ${name}: your versions moved to ${preserved}`);\n        try {\n            const fixed = fixBrokenWorktree(cwd, wsPath, name, branch, true);\n            console.log(fixed\n                ? `  ${name}: fixed (remaining content preserved)`\n                : `  ${name}: failed to fix (content unchanged)`);\n        } catch (retryError) {\n            console.log(`  ${name}: failed to fix (content unchanged) - ${(retryError as Error).message}`);\n            console.log(`      Your set-aside versions remain in ${preserved}`);\n        }\n    }\n}";
const originalJS = ts.transpileModule(originalRepair + "\nexport { repairBrokenWorktree };", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type Scenario = { initial?: "true" | "null" | "ordinary" | "lookalike"; answer?: string; retry?: "null" | "throw"; fault?: string; mutation?: boolean; empty?: boolean };
function fixture(scenario: Scenario, original: boolean) {
    const trace: unknown[] = [];
    const failure = new Error("raw failure");
    const retryFailure = new Error("retry failure");
    class Conflict extends Error { conflicts: readonly string[]; worktreeRoot: string; constructor(root: string, paths: readonly string[]) { super("conflict"); this.worktreeRoot = root; this.conflicts = paths; } }
    const values = scenario.empty ? [] : ["/tree/z", "/tree/a"];
    const firstPaths = new Proxy(values, { get(target, property, receiver) { if (property === "map") hit("map-get"); if (property === "0" || property === "1") hit("path:" + property); return Reflect.get(target, property, receiver); } });
    const postPaths = ["/changed/new"];
    const conflict = new Conflict("/tree", firstPaths);
    let calls = 0; let suspended = false; let logs = 0; let selected = 0;
    const hit = (phase: string) => { trace.push(phase); if (scenario.fault === phase) throw failure; };
    Object.defineProperty(conflict, "worktreeRoot", { get() { hit("root-get"); return suspended && scenario.mutation ? "/changed" : "/tree"; } });
    Object.defineProperty(conflict, "conflicts", { get() { hit("conflicts-get"); return suspended && scenario.mutation ? postPaths : firstPaths; } });
    Object.defineProperty(failure, "message", { get() { hit("message-get"); return "raw failure"; } });
    Object.defineProperty(retryFailure, "message", { get() { hit("retry-message-get"); return "retry failure"; } });
    const repair = function(this: unknown, ...args: unknown[]) {
        expect(this).toBeUndefined(); hit("repair:" + (++calls)); trace.push(args);
        if (calls > 1) { if (scenario.retry === "throw") throw retryFailure; return scenario.retry === "null" ? null : { name: "repo", branch: "feature", action: "worktree-new" as const }; }
        if (scenario.initial === "true") return { name: "repo", branch: "feature", action: "worktree-new" as const };
        if (scenario.initial === "null") return null;
        if (scenario.initial === "ordinary") throw failure;
        if (scenario.initial === "lookalike") throw { name: "Conflict", conflicts: firstPaths, worktreeRoot: "/tree", message: "lookalike" };
        throw conflict;
    };
    const relative = function(this: unknown, root: string, path: string) { expect(this).toBeUndefined(); hit("relative:" + path); trace.push(["relative", root, path]); return path.slice(root.length + 1); };
    const aside = function(this: unknown, root: string, paths: readonly string[]) {
        expect(this).toBeUndefined(); hit("aside"); expect(root).toBe(suspended && scenario.mutation ? "/changed" : "/tree"); expect(paths).toBe(suspended && scenario.mutation ? postPaths : firstPaths); trace.push(["aside", root, paths]); return "/backup";
    };
    const consoleObject = { get log() { hit("select-log:" + (++selected)); return function(this: unknown, message: string) { expect(this).toBe(consoleObject); hit("log:" + (++logs)); trace.push(["notice", message]); }; } };
    const prompt = async (question: string, normalize: true) => { hit("prompt"); trace.push([question, normalize]); await Promise.resolve(); suspended = true; hit("prompt-settled"); return scenario.answer ?? "y"; };
    const ports: WorkspaceContentRepairAdmissionPorts = {
        repairConfirmed: (cwd, wsPath, name, branch, confirmed) => repair(cwd, wsPath, name, branch, confirmed),
        isContentConflict(cause): cause is Conflict { hit("classify"); return cause instanceof Conflict; },
        selectRelative() { hit("select-relative"); return relative; },
        selectLog() { const selectedLog = consoleObject.log; return message => Reflect.apply(selectedLog, consoleObject, [message]); },
        prompt,
        selectSetAside() { hit("select-aside"); return aside; },
    };
    let operation: (cwd: string, wsPath: string, name: string, branch: string) => Promise<void>;
    if (original) {
        const module = { exports: {} as { repairBrokenWorktree: typeof operation } };
        const globals = { module, exports: module.exports, console: consoleObject, fixBrokenWorktree: repair, prompt, WorktreeContentConflictError: Conflict };
        Object.defineProperty(globals, "relative", { get() { hit("select-relative"); return relative; } });
        Object.defineProperty(globals, "setAsideConflictingContent", { get() { hit("select-aside"); return aside; } });
        // instanceof is the original native authority. The extra trace marker is
        // added through Symbol.hasInstance, preserving genuine Error identity.
        Object.defineProperty(Conflict, Symbol.hasInstance, { value(cause: unknown) { hit("classify"); return Function.prototype[Symbol.hasInstance].call(Conflict, cause); } });
        runInNewContext(originalJS, globals); operation = module.exports.repairBrokenWorktree;
    } else operation = createWorkspaceContentRepairAdmission(ports);
    return { operation, trace, failure, retryFailure, get calls() { return calls; } };
}
async function observe(scenario: Scenario, original: boolean) {
    const f = fixture(scenario, original);
    const pending = f.operation("/source", "/workspace", "repo", "feature");
    const synchronous = structuredClone(f.trace);
    let failure: unknown;
    try { expect(await pending).toBeUndefined(); } catch (error) { failure = error; }
    const rejection = failure === undefined ? "none" : failure === f.failure ? "raw" : failure === f.retryFailure ? "retry" : "other";
    const selectionError = (scenario.fault === "select-relative" || scenario.fault === "select-aside") && failure
        ? { rawSame: failure === f.failure, name: (failure as Error).name,
            // Reading the known raw fixture message getter would itself append
            // an effect after failure. Its fixed literal is already constructor
            // data; the historical VM ReferenceError is inspected directly.
            message: failure === f.failure ? "raw failure" : (failure as Error).message }
        : undefined;
    return { synchronous, trace: f.trace, calls: f.calls, rejection, selectionError };
}
const scenarios: Scenario[] = [
    { initial: "true" }, { initial: "null" }, { initial: "ordinary" }, { initial: "lookalike" },
    ...["y", "yes", "n", "YES", "Y", "", " yes "].map(answer => ({ answer })),
    { empty: true }, { mutation: true }, { retry: "null" }, { retry: "throw" },
    ...["repair:1", "repair:2", "classify", "conflicts-get", "map-get", "path:0", "path:1", "root-get", "select-relative", "relative:/tree/z", "relative:/tree/a", "prompt", "prompt-settled", "select-aside", "aside"].map(fault => ({ fault })),
    { initial: "ordinary", fault: "message-get" }, { retry: "throw", fault: "retry-message-get" },
    ...Array.from({ length: 11 }, (_, index) => ({ fault: "select-log:" + (index + 1) })),
    ...Array.from({ length: 11 }, (_, index) => ({ fault: "log:" + (index + 1) })),
];
describe("content repair admission immutable original differential", () => {
    for (const [index, scenario] of scenarios.entries()) it(`preserves branch and exceptional order ${index}: ${JSON.stringify(scenario)}`, async () => {
        const before = await observe(scenario, true);
        const after = await observe(scenario, false);
        if (scenario.fault === "select-relative" || scenario.fault === "select-aside") {
            // These two historical global-identifier accessor fixtures expose
            // a VM-only surface: ESM named imports have no getter lookup fault.
            // Preserve the actual historical ReferenceError and the raw port
            // selector failure separately; never normalize one into the other
            // or label this pair native imported-binding equivalence.
            expect(before.rejection).toBe("other");
            expect(before.selectionError).toEqual({ rawSame: false, name: "ReferenceError",
                message: scenario.fault === "select-relative" ? "relative is not defined" : "setAsideConflictingContent is not defined" });
            expect(after.rejection).toBe("raw");
            expect(after.selectionError).toEqual({ rawSame: true, name: "Error", message: "raw failure" });
            expect(after.synchronous).toEqual(before.synchronous);
            expect(after.trace).toEqual(before.trace);
            expect(after.calls).toBe(before.calls);
            expect(after.trace.at(-1)).toBe(scenario.fault);
            expect(after.calls).toBe(1);
            if (scenario.fault === "select-relative") expect(after.trace).not.toContain("root-get");
            else {
                const postPrompt = after.trace.slice(after.trace.indexOf("prompt-settled") + 1);
                expect(postPrompt).toEqual(["select-aside"]);
            }
        } else expect(after).toEqual(before);
        expect(after.calls).toBeLessThanOrEqual(2);
        expect(after.synchronous[0]).toBe("repair:1");
        if (scenario.fault === "aside") { expect(after.calls).toBe(1); expect(after.rejection).toBe("raw"); }
    });
});
