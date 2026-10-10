import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createWorkspaceCreationDispatch, createWorkspaceRemovalDispatch } from "../../application/workspace/dispatch.js";
import { coreBoundaryViolations } from "./core-boundary.js";

const file = resolve("src/worktree.ts");
function currentAdmission(): string {
    const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const names = new Set(["createWorkspace", "removeWorkspace", "workspaceCreationDispatch", "workspaceRemovalDispatch"]);
    return tree.statements.filter(node => ts.isFunctionDeclaration(node) ? !!node.name && names.has(node.name.text)
        : ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && names.has(declaration.name.text)))
        .map(node => node.getText(tree)).join("\n");
}
function fixture(unified: boolean, stage?: string, unreachable: string[] = []) {
    const events: unknown[] = [];
    const failure = { stage };
    const identity = { raw: "identity" };
    const result = { removed: ["removed"], errors: [] };
    const created = { workspacePath: "workspace", created: [], copied: [] };
    let selectedOptions: object | undefined;
    const run = () => { throw new Error("Unplanned native process"); };
    const effect = (name: string, callback: (...args: unknown[]) => unknown) => function (this: unknown, ...args: unknown[]) {
        events.push(name); if (stage === name) throw failure; return callback(...args);
    };
    const remove = (request: unknown, receipt: unknown) => {
        const value = request as { options?: { force?: boolean } };
        expect(value.options).toBe(selectedOptions); expect(receipt).toBe(identity);
        return result;
    };
    const compiled = ts.transpileModule(currentAdmission(), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    runInNewContext(compiled, { exports, Error, createWorkspaceCreationDispatch, createWorkspaceRemovalDispatch,
        validateBranchName: effect("validate", () => undefined),
        resolve: effect("resolve", () => "source"), getWorkspacePath: effect("workspacePath", () => "workspace"),
        dirname: effect("dirname", () => "parent"),
        enclosingGitWorkingTree: effect("enclosing", () => "enclosing"), warnWorkspaceInsideRepository: effect("warning", () => undefined),
        hasGitMetadata: effect("metadata", () => unified),
        createUnifiedWorkspace: effect("createUnified", () => created), createMultiRepoWorkspace: effect("createMulti", () => created),
        existsSync: effect("exists", () => true), spawnSync: run,
        assertWorkspaceBranch: effect("assertBranch", (...args) => { expect(args).toEqual(["workspace", "feature", run, "source", { allowTrackedGitlinks: true }]); }),
        scanUnifiedNestedRepositories: effect("scan", (_path, options) => {
            const observed = options as { unreachable: string[]; allowRegisteredWorktrees: boolean; openingExistingWorkspace: boolean };
            expect([observed.allowRegisteredWorktrees, observed.openingExistingWorkspace]).toEqual([true, true]);
            observed.unreachable.push(...unreachable);
        }),
        pathContent: effect("content", path => { events.push(path); return "unreadable"; }),
        unmanagedPathRefusal: effect("refusal", (path, content) => `${path}:${content}`),
        captureDirectoryIdentity: effect("identity", () => identity),
        removeUnifiedWorkspace: effect("removeUnified", remove), removeMultiRepoWorkspace: effect("removeMulti", remove),
        require() { throw new Error("Unplanned fixture import"); },
    });
    return { api: exports as { createWorkspace(source: string, branch: string): unknown; removeWorkspace(source: string, branch: string, options?: { force?: boolean }): unknown },
        events, failure, result, created,
        options(value: object | undefined) { selectedOptions = value; },
    };
}

describe("workspace admission facade", () => {
    it.each([true, false])("dispatches creation and admitted removal (unified=%s)", unified => {
        const f = fixture(unified);
        expect(f.api.createWorkspace("raw", "feature")).toBe(f.created);
        const options = { force: true }; f.options(options);
        expect(f.api.removeWorkspace("raw", "feature", options)).toBe(f.result);
        expect(f.events).toContain(unified ? "createUnified" : "createMulti");
        expect(f.events).toContain(unified ? "removeUnified" : "removeMulti");
    });
    it("refuses unmanaged content before identity capture or removal", () => {
        const f = fixture(true, undefined, ["unreadable", "empty"]);
        expect(f.api.removeWorkspace("raw", "feature")).toEqual({ removed: [], errors: ["unreadable:unreadable", "empty:unreadable"] });
        expect(f.events).not.toContain("identity");
        expect(f.events).not.toContain("removeUnified");
    });
    it.each(["validate", "resolve", "workspacePath", "exists", "assertBranch", "scan", "identity", "metadata", "removeUnified"])("propagates admission failure at %s", stage => {
        const f = fixture(true, stage);
        let error: unknown;
        try { f.api.removeWorkspace("raw", "feature"); } catch (failure) { error = failure; }
        expect(error).toBe(f.failure);
    });
    it("guards actual dispatch core and rejects native/ambient/outer dependencies", () => {
        const root = resolve("src"); const boundary = { root, language: "ts" as const };
        for (const layer of ["ports", "application"] as const) {
            const path = resolve(root, layer, "workspace/dispatch.ts"); const source = readFileSync(path, "utf8");
            expect(coreBoundaryViolations(source, path, boundary)).toEqual([]);
            for (const mutation of ["import { spawnSync } from 'node:child_process';", "process.cwd();", "Date.now();", "import('../../worktree.js');"]) {
                expect(coreBoundaryViolations(source + mutation, path, boundary)).not.toEqual([]);
            }
        }
    });
});
