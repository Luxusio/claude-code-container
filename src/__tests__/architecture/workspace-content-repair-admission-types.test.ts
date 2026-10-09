import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createWorkspaceContentRepairAdmission } from "../../application/workspace/content-repair-admission.js";
import type { WorkspaceContentRepairAdmissionPorts, WorkspaceContentRepairConflict } from "../../ports/workspace/content-repair-admission.js";


// Accepted original API/outcome: complete native function signature from 9d6ec945
// (index source b70ba8715cc9c613614eb6bdc4dd357ce0fa36ab54632a8ddd550abf9c23f59a)
// was (cwd:string, wsPath:string, name:string, branch:string)=>Promise<void>.
// Native fix returned WorktreeRepoResult|null synchronously; prompt returned
// Promise<string>; native conflict stores the original readonly array/root.
function contracts(ports: WorkspaceContentRepairAdmissionPorts) {
    const operation: (cwd: string, wsPath: string, name: string, branch: string) => Promise<void> = createWorkspaceContentRepairAdmission(ports);
    const result: Promise<void> = operation("source", "workspace", "repo", "branch");
    void result;
    // @ts-expect-error Native defaults are not an application composition.
    createWorkspaceContentRepairAdmission();
    // @ts-expect-error Repair capability is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, repairConfirmed: undefined });
    // @ts-expect-error Fixed native classification capability is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, isContentConflict: undefined });
    // @ts-expect-error Native relative selection is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, selectRelative: undefined });
    // @ts-expect-error Native console selection is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, selectLog: undefined });
    // @ts-expect-error Native prompt is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, prompt: undefined });
    // @ts-expect-error Native quarantine selection is mandatory.
    createWorkspaceContentRepairAdmission({ ...ports, selectSetAside: undefined });
    // @ts-expect-error Synchronous initial repair must not become an async operation.
    createWorkspaceContentRepairAdmission({ ...ports, repairConfirmed: async () => null });
    // @ts-expect-error Log callee selection occurs synchronously.
    createWorkspaceContentRepairAdmission({ ...ports, selectLog: async () => () => undefined });
    // @ts-expect-error Relative callee selection occurs synchronously.
    createWorkspaceContentRepairAdmission({ ...ports, selectRelative: async () => (root: string, path: string) => root + path });
    // @ts-expect-error Set-aside callee selection occurs synchronously.
    createWorkspaceContentRepairAdmission({ ...ports, selectSetAside: async () => () => "backup" });
    // @ts-expect-error Native relative operation is synchronous.
    createWorkspaceContentRepairAdmission({ ...ports, selectRelative: () => async () => "relative" });
    // @ts-expect-error Native quarantine returns a saved path synchronously.
    createWorkspaceContentRepairAdmission({ ...ports, selectSetAside: () => async () => "backup" });
    // @ts-expect-error Prompt retains asynchronous settlement.
    createWorkspaceContentRepairAdmission({ ...ports, prompt: () => "yes" });
    // @ts-expect-error Native repair authorization is literal true.
    ports.repairConfirmed("source", "workspace", "repo", "branch", false);
    // @ts-expect-error Prompt normalization is literal true.
    ports.prompt("question", false);
    // @ts-expect-error Operation arguments remain strings.
    operation("source", "workspace", 1, "branch");
    // @ts-expect-error Whole native workflow callback cannot substitute semantic ports.
    createWorkspaceContentRepairAdmission({ runNativeWorkflow: operation });
    // @ts-expect-error Application outcome is asynchronous void, not a native repair result.
    const synchronous: null = operation("source", "workspace", "repo", "branch");
    void synchronous;
    const conflict: WorkspaceContentRepairConflict = { worktreeRoot: "root", conflicts: ["file"] };
    // @ts-expect-error A readonly native conflict reference cannot be mutated by core.
    conflict.conflicts.push("second");
}
void contracts;

function coreBoundaryViolations(text: string, file: string, boundary: { root: string; language: "ts" }): string[] {
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const errors: string[] = [];
    const owner = relative(boundary.root, file).split(sep)[0];
    const ambient = new Set(["console", "process", "globalThis", "global", "fetch", "require", "Buffer", "setTimeout", "Date", "WorktreeContentConflictError"]);
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            const specifier = node.moduleSpecifier;
            if (specifier && ts.isStringLiteral(specifier)) {
                const target = relative(boundary.root, resolve(dirname(file), specifier.text)).split(sep)[0];
                const allowed = specifier.text.startsWith(".") && specifier.text.endsWith(".js")
                    && (target === "domain" || owner === "application" && ["ports", "application"].includes(target!));
                if (!allowed) errors.push("native/outward dependency: " + specifier.text);
            }
        }
        if (ts.isIdentifier(node) && ambient.has(node.text)) errors.push("native identifier: " + node.text);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) errors.push("dynamic import");
        ts.forEachChild(node, visit);
    };
    visit(tree);
    return errors;
}

const modules = ["src/application/workspace/content-repair-admission.ts", "src/ports/workspace/content-repair-admission.ts"];
describe("content repair strict source/emitted API and inward boundary", () => {
    it("checks the actual owned application and ports, plus representative forbidden capabilities", () => {
        for (const file of modules) expect(coreBoundaryViolations(readFileSync(file, "utf8"), resolve(file), { root: resolve("src"), language: "ts" })).toEqual([]);
        for (const prohibited of [
            'import { readFileSync } from "node:fs";',
            'import { relative } from "node:path";',
            'import { WorktreeContentConflictError } from "../../worktree.js";',
            'console.log("native");', 'process.cwd();', 'globalThis.fetch("url");',
        ]) expect(coreBoundaryViolations(prohibited, resolve(modules[0]!), { root: resolve("src"), language: "ts" }).length).toBeGreaterThan(0);
    });
    it("requires strict source and actual emitted declarations under the same non-relaxed options", () => {
        const contractsText = readFileSync("src/__tests__/architecture/workspace-content-repair-admission-types.test.ts", "utf8");
        const start = contractsText.indexOf("function contracts(");
        const end = contractsText.indexOf("void contracts;", start) + "void contracts;".length;
        expect(start).toBeGreaterThan(0);
        const body = contractsText.slice(start, end);
        const config = ts.readConfigFile(resolve("tsconfig.json"), ts.sys.readFile);
        expect(config.error).toBeUndefined();
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
        expect(parsed.errors).toEqual([]);
        expect(parsed.options.strict).toBe(true);
        for (const root of ["src", "dist"]) {
            const virtual = resolve(`content-repair-admission-${root}-contract.mts`);
            const text = `import { createWorkspaceContentRepairAdmission } from "./${root}/application/workspace/content-repair-admission.js";\nimport type { WorkspaceContentRepairAdmissionPorts, WorkspaceContentRepairConflict } from "./${root}/ports/workspace/content-repair-admission.js";\n${body}`;
            const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, rootDir: undefined, skipLibCheck: false };
            const host = ts.createCompilerHost(options);
            const read = host.readFile.bind(host);
            const exists = host.fileExists.bind(host);
            host.readFile = file => resolve(file) === virtual ? text : read(file);
            host.fileExists = file => resolve(file) === virtual || exists(file);
            const source = host.getSourceFile.bind(host);
            host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => resolve(file) === virtual
                ? ts.createSourceFile(file, text, languageVersion, true, ts.ScriptKind.TS)
                : source(file, languageVersion, onError, shouldCreateNewSourceFile);
            const program = ts.createProgram([virtual], options, host);
            const diagnostics = ts.getPreEmitDiagnostics(program);
            expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: file => file, getNewLine: () => "\n" })).toBe("");
            // Every negative is checked twice, through the actual source and
            // mandatory genuine emitted declarations. No noCheck/transpile
            // fallback, skipLibCheck relaxation or missing-dist skip exists.
        }
    }, 60_000);
});
