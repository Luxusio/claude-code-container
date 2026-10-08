import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createWorkspaceCreationDispatch, createWorkspaceRemovalDispatch } from "../../application/workspace/dispatch.js";
import { coreBoundaryViolations } from "./core-boundary.js";

// Exact public admission regions from c284ead3 worktree blob 4b5d78e4.
const frozenAdmission = "export function createWorkspace(\n    sourcePath: string,\n    branch: string,\n): WorktreeResult {\n    validateBranchName(branch);\n\n    const resolved = resolve(sourcePath);\n    const wsPath = getWorkspacePath(resolved, branch);\n\n    // Checked from the workspace's parent, which is the source's parent, so a hit is always\n    // some other repository: the source itself is never its own ancestor here.\n    const enclosing = enclosingGitWorkingTree(dirname(wsPath));\n    if (enclosing) warnWorkspaceInsideRepository(wsPath, enclosing);\n\n    // Unified mode: top-level is a git repo\n    if (hasGitMetadata(resolved)) {\n        return createUnifiedWorkspace({ repositoryPath: resolved, destinationPath: wsPath, branch });\n    }\n\n    // Multi-repo mode: scan children\n    return createMultiRepoWorkspace({ repositoryPath: resolved, destinationPath: wsPath, branch });\n}\nexport function removeWorkspace(\n    sourcePath: string,\n    branch: string,\n    opts?: { force?: boolean },\n): RemoveResult {\n    validateBranchName(branch);\n\n    const resolved = resolve(sourcePath);\n    const wsPath = getWorkspacePath(resolved, branch);\n\n    if (!existsSync(wsPath)) {\n        throw new Error(`Workspace not found: ${wsPath}`);\n    }\n\n    assertWorkspaceBranch(\n        wsPath,\n        branch,\n        spawnSync,\n        resolved,\n        { allowTrackedGitlinks: true },\n    );\n    // A nested repository ccc declines to manage is not deleted SILENTLY. It is still deleted\n    // when the operator says so: a command that removes a workspace removes what is inside it,\n    // and `--force` is where they say they know. An earlier version of this guard held under\n    // `--force` too, arguing that `--force` means \"delete my modified and untracked files\" and\n    // not \"delete a repository you could not even inspect\" — that was this file's reasoning,\n    // not the repository owner's, and it left `ccc rm -f` with no way through on a workspace\n    // the owner wanted gone. The warning still happens; only the veto is lifted.\n    if (opts?.force !== true) {\n        const unreachable: string[] = [];\n        scanUnifiedNestedRepositories(wsPath, {\n            allowRegisteredWorktrees: true,\n            openingExistingWorkspace: true,\n            unreachable,\n        });\n        if (unreachable.length > 0) {\n            return {\n                removed: [],\n                // NOT forceWouldNotHelp: -f is now exactly what helps, and the CLI's standing\n                // advice to use it is correct here.\n                // Both the refusal and its remedy from one observation of the path: telling\n                // someone to move files out of an empty directory sends them looking for files\n                // that are not there, and telling them to move files out of a directory they\n                // cannot read is worse still — the reason ccc refuses is that it could not\n                // look, and that is what to say.\n                errors: unreachable.map((path) => unmanagedPathRefusal(path, pathContent(path))),\n            };\n        }\n    }\n\n    const workspaceIdentity = captureDirectoryIdentity(wsPath);\n\n    // Unified mode: top-level is a git repo → remove single worktree\n    if (hasGitMetadata(resolved)) {\n        return removeUnifiedWorkspace({\n            repositoryPath: resolved,\n            destinationPath: wsPath,\n            branch,\n            options: opts,\n        }, workspaceIdentity);\n    }\n\n    // Multi-repo mode\n    return removeMultiRepoWorkspace({\n        repositoryPath: resolved,\n        destinationPath: wsPath,\n        branch,\n        options: opts,\n    }, workspaceIdentity);\n}";
const file = resolve("src/worktree.ts");
function currentAdmission(): string {
    const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const names = new Set(["createWorkspace", "removeWorkspace", "workspaceCreationDispatch", "workspaceRemovalDispatch"]);
    return tree.statements.filter(node => ts.isFunctionDeclaration(node) ? !!node.name && names.has(node.name.text)
        : ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && names.has(declaration.name.text)))
        .map(node => node.getText(tree)).join("\n");
}
function fixture(old: boolean, unified: boolean, stage?: string, unreachable: string[] = []) {
    const events: unknown[] = [];
    const failure = { stage };
    const identity = { raw: "identity" };
    const result = { removed: ["removed"], errors: [] };
    const created = { workspacePath: "workspace", created: [], copied: [] };
    let originalOptions: object | undefined;
    const run = () => { throw new Error("Unplanned native process"); };
    const effect = (name: string, callback: (...args: unknown[]) => unknown) => function (this: unknown, ...args: unknown[]) {
        expect(this).toBeUndefined(); events.push(name); if (stage === name) throw failure; return callback(...args);
    };
    const remove = (request: unknown, receipt: unknown) => {
        const value = request as { options?: { force?: boolean } };
        expect(value.options).toBe(originalOptions); expect(receipt).toBe(identity);
        if (value.options) events.push(["callee-force", value.options.force]);
        return result;
    };
    const compiled = ts.transpileModule(old ? frozenAdmission : currentAdmission(), {
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
        options(value: object | undefined) { originalOptions = value; },
    };
}

describe("frozen and actual workspace admission facade", () => {
    it.each([true, false])("keeps native call order and return identity (unified=%s)", unified => {
        const before = fixture(true, unified); const after = fixture(false, unified);
        for (const f of [before, after]) {
            expect(f.api.createWorkspace("raw", "feature")).toBe(f.created);
            let reads = 0;
            const options = { get force() { f.events.push("force-getter"); return ++reads === 1 ? false : true; } };
            f.options(options);
            expect(f.api.removeWorkspace("raw", "feature", options)).toBe(f.result);
            expect(reads).toBe(2);
        }
        expect(after.events).toEqual(before.events);
    });
    it("uses one content observation for each refusal without capturing or dispatching", () => {
        const before = fixture(true, true, undefined, ["unreadable", "empty"]);
        const after = fixture(false, true, undefined, ["unreadable", "empty"]);
        expect(after.api.removeWorkspace("raw", "feature")).toEqual(before.api.removeWorkspace("raw", "feature"));
        expect(after.events).toEqual(before.events);
        expect(after.events).not.toContain("identity");
    });
    it.each(["validate", "resolve", "workspacePath", "exists", "assertBranch", "scan", "identity", "metadata", "removeUnified"])("retains native admission exception identity at %s", stage => {
        const before = fixture(true, true, stage); const after = fixture(false, true, stage);
        for (const f of [before, after]) {
            let error: unknown;
            try { f.api.removeWorkspace("raw", "feature"); } catch (failure) { error = failure; }
            expect(error).toBe(f.failure);
        }
        expect(after.events).toEqual(before.events);
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
