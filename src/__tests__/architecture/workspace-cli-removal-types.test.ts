import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createWorkspaceCliRemoval } from "../../application/workspace/cli-removal.js";
import type { WorkspaceCliRemovalPorts, WorkspaceCliContainerIdentity } from "../../ports/workspace/cli-removal.js";

// Original public helper generics/default signatures were checked strictly
// through b51 SOURCE and genuine production DTS before candidate writes.
// Original420 SOURCE/196 DTS files: zero diagnostics, strict:true,
// skipLibCheck:false, same options and seven consumed negative contracts.
function contracts(ports: WorkspaceCliRemovalPorts) {
    const operation: (cwd: string, branch: string, force: boolean) => void = createWorkspaceCliRemoval(ports);
    const result: void = operation("source", "branch", false);
    void result;
    // @ts-expect-error Native composition is mandatory.
    createWorkspaceCliRemoval();
    // @ts-expect-error Family guard selection is mandatory.
    createWorkspaceCliRemoval({ ...ports, selectFamilyLock: undefined });
    // @ts-expect-error Claims cannot be replaced by a whole removal workflow.
    createWorkspaceCliRemoval({ ...ports, selectClaims: undefined });
    // @ts-expect-error Runtime readiness remains synchronous.
    createWorkspaceCliRemoval({ ...ports, selectRuntimeReadiness: async () => () => undefined });
    // @ts-expect-error A selected readiness effect cannot settle asynchronously.
    createWorkspaceCliRemoval({ ...ports, selectRuntimeReadiness: () => async () => undefined });
    // @ts-expect-error A selected ownership assertion cannot settle asynchronously.
    createWorkspaceCliRemoval({ ...ports, selectOwnershipAssertion: () => async () => undefined });
    // @ts-expect-error A selected console log effect cannot settle asynchronously.
    createWorkspaceCliRemoval({ ...ports, selectLog: () => async () => undefined });
    // @ts-expect-error A selected console error effect cannot settle asynchronously.
    createWorkspaceCliRemoval({ ...ports, selectError: () => async () => undefined });
    // @ts-expect-error Workspace removal remains a synchronous canonical result.
    createWorkspaceCliRemoval({ ...ports, selectRemoveWorkspace: () => async () => ({ removed: [], errors: [] }) });
    // @ts-expect-error Identity is inspected synchronously before workspace deletion.
    createWorkspaceCliRemoval({ ...ports, selectManagedIdentity: () => async () => null });
    // @ts-expect-error Container runner selection cannot be asynchronous.
    createWorkspaceCliRemoval({ ...ports, selectRunner: async () => ports.selectRunner() });
    // @ts-expect-error Console selection occurs synchronously before coercion.
    createWorkspaceCliRemoval({ ...ports, selectLog: async () => () => undefined });
    // @ts-expect-error Native exit must not become a returning function.
    createWorkspaceCliRemoval({ ...ports, selectExit: () => () => undefined });
    // @ts-expect-error Ownership admission is literally true.
    ports.selectOwnershipAssertion()("workspace", "branch", "source", { allowTrackedGitlinks: false });
    // @ts-expect-error Force keeps its public boolean signature.
    operation("source", "branch", "truthy");
    // @ts-expect-error Opaque native workflows do not implement the semantic ports.
    createWorkspaceCliRemoval({ runNativeWorkflow: operation });
    const identity: WorkspaceCliContainerIdentity = { containerId: "id", running: true };
    void identity;
}
void contracts;

const originalPublicContracts = `
const value={errors: [] as string[],extra: 123};
const completed=removeWorkspaceThenContainers(()=>value,()=>['container']);
const same: typeof value = completed.result;
const names: string[] = completed.removedContainers;
const plan: WorkspaceContainerRemoval[] = prepareWorkspaceContainerRemovalPlan('workspace');
const removals:string[]=removePreparedWorkspaceContainers(plan);
const result:boolean=workspaceRemovalCompleted(value);
const receipt: {exact:true}=withWorkspaceRemovalLifecycleLock('project',false,()=>({exact:true as const}));
void [same,names,removals,result,receipt];
// @ts-expect-error original child result is synchronous
removeWorkspaceThenContainers(async()=>value,()=>[]);
// @ts-expect-error container removals synchronous
removeWorkspaceThenContainers(()=>value,async()=>[]);
// @ts-expect-error force retains boolean public signature
withWorkspaceRemovalLifecycleLock('project','truthy',()=>null);
// @ts-expect-error workspacePath required
prepareWorkspaceContainerRemovalPlan();
// @ts-expect-error synchronous identity probe
prepareWorkspaceContainerRemovalPlan('workspace',()=>[],async()=>null);
// @ts-expect-error canonical errors field required
workspaceRemovalCompleted({removed:[]});
// @ts-expect-error readonly plan cannot be mutated
const writable: WorkspaceContainerRemoval[] = [] as readonly WorkspaceContainerRemoval[];
void writable;
`;

function boundaryViolations(text: string, file: string): string[] {
    const root = resolve("src");
    const owner = relative(root, file).split(sep)[0];
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const errors: string[] = [];
    const ambient = new Set(["console", "process", "globalThis", "global", "fetch", "require", "Buffer", "setTimeout", "Date"]);
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            const specifier = node.moduleSpecifier;
            if (specifier && ts.isStringLiteral(specifier)) {
                const target = relative(root, resolve(dirname(file), specifier.text)).split(sep)[0];
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

const modules = ["src/application/workspace/cli-removal.ts", "src/ports/workspace/cli-removal.ts"];
describe("workspace CLI removal strict source/genuine declarations and inward boundary", () => {
    it("rejects outward native dependencies and ambient capabilities", () => {
        for (const file of modules) expect(boundaryViolations(readFileSync(file, "utf8"), resolve(file))).toEqual([]);
        for (const prohibited of [
            'import { readFileSync } from "node:fs";',
            'import { spawnSync } from "node:child_process";',
            'import { removeWorkspace } from "../../worktree.js";',
            'console.log("native");', 'process.cwd();', 'globalThis.fetch("url");',
            'import("node:module");',
        ]) expect(boundaryViolations(prohibited, resolve(modules[0]!)).length).toBeGreaterThan(0);
    });
    it("requires strict actual source and mandatory genuine DTS with all negative contracts consumed", () => {
        const text = readFileSync("src/__tests__/architecture/workspace-cli-removal-types.test.ts", "utf8");
        const start = text.indexOf("function contracts(");
        const end = text.indexOf("void contracts;", start) + "void contracts;".length;
        expect(start).toBeGreaterThan(0);
        const body = text.slice(start, end);
        const config = ts.readConfigFile(resolve("tsconfig.json"), ts.sys.readFile);
        expect(config.error).toBeUndefined();
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
        expect(parsed.errors).toEqual([]);
        expect(parsed.options.strict).toBe(true);
        for (const root of ["src", "dist"]) {
            const virtual = resolve(`workspace-cli-removal-${root}-contract.mts`);
            const probe = `import {createWorkspaceCliRemoval} from './${root}/application/workspace/cli-removal.js';\n`
                + `import type {WorkspaceCliRemovalPorts,WorkspaceCliContainerIdentity} from './${root}/ports/workspace/cli-removal.js';\n`
                + `import {removeWorkspaceThenContainers,prepareWorkspaceContainerRemovalPlan,removePreparedWorkspaceContainers,workspaceRemovalCompleted,withWorkspaceRemovalLifecycleLock} from './${root}/index.js';\n`
                + `import type {WorkspaceContainerRemoval} from './${root}/index.js';\n${body}\n${originalPublicContracts}`;
            const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, rootDir: undefined, skipLibCheck: false };
            const host = ts.createCompilerHost(options);
            const read = host.readFile.bind(host), exists = host.fileExists.bind(host), source = host.getSourceFile.bind(host);
            host.readFile = file => resolve(file) === virtual ? probe : read(file);
            host.fileExists = file => resolve(file) === virtual || exists(file);
            host.getSourceFile = (file, version, onError, fresh) => resolve(file) === virtual
                ? ts.createSourceFile(file, probe, version, true, ts.ScriptKind.TS)
                : source(file, version, onError, fresh);
            const program = ts.createProgram([virtual], options, host);
            const diagnostics = ts.getPreEmitDiagnostics(program);
            expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
                getCurrentDirectory: () => process.cwd(), getCanonicalFileName: file => file, getNewLine: () => "\n",
            })).toBe("");
            // Missing/dist failures and unused @ts-expect-error negatives fail.
            // SOURCE and genuine DTS use identical strict, non-relaxed options.
        }
    }, 60_000);
});
