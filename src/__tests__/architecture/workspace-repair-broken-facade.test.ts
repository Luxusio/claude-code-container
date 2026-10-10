import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createBrokenWorkspaceRepair } from "../../application/workspace/repair-broken.js";

const file = resolve("src/worktree.ts");
const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const afterCode = compile(tree.statements.filter(node => ts.isFunctionDeclaration(node) ? node.name?.text === "fixBrokenWorktreeSanitized"
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "brokenWorkspaceRepair"))
    .map(node => node.getText(tree)).join("\n") + "\nexport { fixBrokenWorktreeSanitized };");

interface Scenario { fault?: string; afterFault?: string; noBackup?: boolean; noSource?: boolean; displaced?: boolean; conflict?: boolean; dependencies?: boolean; addFailure?: boolean; errorAtZero?: boolean; customCleanup?: boolean; }
function fixture(scenario: Scenario) {
    const events: string[] = [];
    const failure = new Error("synthetic failure"); let injected = false;
    const destination = "/ws/repo"; const backup = "/private/old";
    const exists = new Set(scenario.noBackup ? [] : [destination]);
    let quarantined = false; let settled = false;
    const directory = (path: string) => ({ realpath: path, dev: "1", ino: path });
    const repository = { directory: directory("/source/repo"), commonDirectory: directory("/source/repo/.git") };
    const receipt = { destinationIdentity: directory(destination) };
    class WorktreeContentConflictError extends Error {
        readonly conflicts: readonly string[];
        constructor(path: string, conflicts: string[]) { super(`conflict:${path}:${conflicts.join(",")}`); this.name = "WorktreeContentConflictError"; this.conflicts = conflicts; }
    }
    const methods: Record<string, (...args: unknown[]) => unknown> = {
        resolve: () => "/source", join: (...parts) => posix.join(...parts as string[]), dirname: path => posix.dirname(path as string),
        assertWorkspaceRootOwnership: () => undefined, primarySourceRepositoryForWorktree: () => null,
        scanUnifiedNestedRepositories: () => scenario.noSource ? [] : [{ name: "repo", path: "/source/repo", isGitRepo: true }],
        captureNestedRepositoryIdentity: () => repository, assertNestedRepositoryIdentity: (_path, observed) => { expect(observed).toBe(repository); },
        ensureNestedWorktreeParent: () => ({ workspace: directory("/ws"), parents: [] }), assertNestedWorktreeDestinationFence: () => undefined,
        pathExistsStrict: path => exists.has(path as string),
        captureDirectoryIdentity: path => directory(path as string), assertDirectoryIdentity: () => undefined,
        registrationToDisplace: () => scenario.displaced ? { path: "/foreign/held" } : null,
        captureMissingWorktreeRegistrationFence: () => ({ managementIdentity: directory("/management/old") }),
        createPrivateQuarantine: () => ({ directory: "/private", path: backup, directoryIdentity: directory("/private") }),
        renameSync: (from, to) => { exists.delete(from as string); exists.add(to as string); },
        assertQuarantinedIdentity: () => undefined,
        removePrivateQuarantine: () => undefined,
        withPinnedNestedRepository: (_identity, operation) => (operation as () => unknown)(),
        quarantineMissingWorktreeRegistration: () => { quarantined = true; return { location: { path: "/private/registration" } }; },
        restoreQuarantinedMissingWorktreeRegistration: () => { quarantined = false; },
        commitQuarantinedMissingWorktreeRegistration: () => { quarantined = false; settled = true; },
        warnDisplacedWorktreeRegistration: () => { settled = true; },
        branchExistsInRepo: () => "local",
        prepareWorktreeCreation: () => { exists.add(destination); return { expectedBranchOid: { expectedOid: "oid" }, destinationIdentity: directory(destination) }; },
        runPreparedWorktreeAdd: () => {
            exists.add(destination);
            return { result: scenario.errorAtZero ? { status: 0, get error() { throw new Error("unexpected error observation at status zero"); } }
                : { status: scenario.addFailure ? 1 : 0, stderr: scenario.addFailure ? "native failure" : "" }, registrationFence: receipt };
        },
        requireWorktreeRegistrationFence: observed => { expect(observed).toBe(receipt); return receipt; },
        rollbackFailedWorktreeAdd: () => { exists.delete(destination); },
        rollbackQuarantinedPath: () => { exists.delete(backup); exists.add(destination); return true; },
        warnWorktreeRepairFailure: () => undefined,
        isValidWorktree: () => true,
        readdirSync: () => [".git", "old.txt"],
        mergePreservingContent: (_source, _destination, merge) => {
            const state = merge as { conflicts: string[]; skippedIgnoredDependencyTrees: Array<{ destinationPath: string }> };
            if (scenario.conflict) state.conflicts.push("old.txt");
            if (scenario.dependencies) state.skippedIgnoredDependencyTrees.push({ destinationPath: `${destination}/node_modules` });
        },
        removeRegisteredWorktree: (_source, path, identity) => { expect(identity).toBe(receipt.destinationIdentity); exists.delete(path as string); },
        pinnedNestedRepositoryEnvironment: () => ({}), rollbackFailedCreatedBranch: () => undefined,
        terminalSafe: path => path,
        unlinkCapturedIgnoredDependencyLinks: () => undefined,
        rmSync: (path, options) => { expect(options).toEqual({ recursive: true, force: true }); exists.delete(path as string); },
    };
    const context: Record<string, unknown> = { exports: {}, Error, createBrokenWorkspaceRepair, WorktreeContentConflictError,
        process: { stderr: { write(message: string) { events.push(`notice:${message}`); } } },
        require() { throw new Error("Unplanned fixture import"); } };
    for (const [name, method] of Object.entries(methods)) context[name] = (...args: unknown[]) => {
        events.push(`${name}:${typeof args[0] === "string" ? args[0] : "receipt"}`);
        if (!injected && scenario.fault === name) { injected = true; throw failure; }
        const result = method(...args);
        if (!injected && scenario.afterFault === name) { injected = true; throw failure; }
        return result;
    };
    runInNewContext(afterCode, context);
    const cleanup = { get removeMergedBackup() {
        events.push(`cleanup:get:${settled}`);
        if (scenario.fault === "cleanup-getter") throw failure;
        if (!scenario.customCleanup) return undefined;
        return function (this: unknown, path: string) { events.push(`cleanup:run:${path}`); exists.delete(path); };
    } };
    let result: unknown; let error: unknown;
    try { result = (context.exports as { fixBrokenWorktreeSanitized(...args: unknown[]): unknown }).fixBrokenWorktreeSanitized("raw", "/ws", "repo", "feature", true, cleanup); } catch (cause) { error = cause; }
    const normalized = error instanceof Error ? { name: error.name, message: error.message, identity: error === failure, cause: error.cause instanceof Error ? error.cause.message : undefined } : error;
    return { result, error: normalized, events, exists: [...exists], quarantined, settled, };
}

describe("broken workspace replacement transaction", () => {
    it.each([{}, { noBackup: true }, { displaced: true }, { customCleanup: true }, { errorAtZero: true }] satisfies Scenario[])("repairs the workspace successfully: %j", scenario => {
        expect(fixture( scenario).result).toEqual({ name: "repo", branch: "feature", action: "worktree-existing" });
    });

    it.each(["runPreparedWorktreeAdd", "requireWorktreeRegistrationFence"])("retains the quarantined backup after %s fails", fault => {
        const result = fixture( { fault });
        expect(result.error).toEqual(expect.objectContaining({ identity: true }));
        expect(result.exists).toContain(backupPath());
        expect(result.events.some(event => event.startsWith("rollbackQuarantinedPath:"))).toBe(false);
    });

    it("retains the committed replacement on a late cleanup getter failure", () => {
        const result = fixture( { fault: "cleanup-getter" });
        expect(result.settled).toBe(true); expect(result.exists).toContain("/ws/repo");
        expect(result.events.some(event => event.startsWith("removeRegisteredWorktree:"))).toBe(false);
    });
});
function backupPath() { return "/private/old"; }
