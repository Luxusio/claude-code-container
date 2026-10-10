import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createRootWorkspaceRepair } from "../../application/workspace/repair-root.js";

const file = resolve("src/worktree.ts");
const currentSource = readFileSync(file, "utf8");
const currentTree = ts.createSourceFile(file, currentSource, ts.ScriptTarget.Latest, true);
const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const afterCode = compile(currentTree.statements.filter(node => ts.isFunctionDeclaration(node) ? node.name?.text === "handleWorkspaceRootOwnership"
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "rootWorkspaceRepair"))
    .map(node => node.getText(currentTree)).join("\n") + "\nexport const replayRecreate = rootWorkspaceRepair.recreateMissingWorkspaceRootRegistration;\nexport { handleWorkspaceRootOwnership };");

interface Scenario { existing?: boolean; inspect?: boolean; fault?: string; addFailure?: boolean; addResidue?: boolean; branchConflict?: boolean; direct?: boolean; }
function fixture(scenario: Scenario) {
    const events: string[] = [];
    const source = "/source"; const workspace = "/work/ws";
    const common = "/source/.git"; const root = `${common}/worktrees`; const stale = `${root}/ws1`; const management = scenario.existing ? stale : `${root}/temporary`;
    const contents = new Map<string, string>([[`${workspace}/.git`, `gitdir: ${stale}\n`], [`${management}/HEAD`, "ref: refs/heads/feature\n"],
        [`${management}/gitdir`, scenario.existing ? "/old/missing/.git\n" : "/temporary/.git\n"], [`${management}/commondir`, "../..\n"]]);
    const directories = new Set([workspace, source, common, root, ...(scenario.existing ? [management] : [])]);
    const failure = new Error("synthetic fault"); let injected = false; let temporary = ""; let registered = false; let publications = 0;
    const directory = (path: string) => ({ realpath: path, dev: "dev", ino: path });
    const repository = (path: string) => ({ directory: directory(path), commonDirectory: directory(common) });
    class WorkspaceRootRecoveryRollbackError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "WorkspaceRootRecoveryRollbackError"; } }
    class WorkspaceBranchConflictError extends Error {}
    const methods: Record<string, (...args: unknown[]) => unknown> = {
        resolve: (...parts) => posix.resolve(...parts as string[]), join: (...parts) => posix.join(...parts as string[]), dirname: path => posix.dirname(path as string), basename: path => posix.basename(path as string), isAbsolute: path => posix.isAbsolute(path as string),
        getWorkspacePath: () => workspace, sameObservedPath: (left, right) => left === right, sameExistingObject: (left, right) => left === right,
        pathExistsStrict: path => directories.has(path as string) || contents.has(path as string),
        isValidWorktree: () => publications > 0,
        isSourceWorktreeManagementRoot: (path, directory) => path === `${directory}/worktrees`,
        workspaceRegistrationDigest: () => "digest", captureNestedWorkspaceOwnershipEvidence: () => null, assertWorkspaceOwnershipEvidence: () => undefined,
        captureNestedRepositoryIdentity: path => repository(path as string), assertNestedRepositoryIdentity: () => undefined,
        captureDirectoryIdentity: path => {
            if (!injected && scenario.fault === "temp-before-try" && path === temporary) { injected = true; throw failure; }
            return directory(path as string);
        },
        assertDirectoryIdentity: () => undefined,
        capturePathIdentity: path => {
            if (!injected && scenario.fault === "workspace-capture" && path === `${workspace}/.git` && publications === 1) { injected = true; throw failure; }
            if (!injected && scenario.fault === "registration-capture" && path === `${management}/gitdir` && publications === 2) { injected = true; throw failure; }
            if (!injected && scenario.fault === "existing-capture" && scenario.existing && path === `${management}/gitdir` && publications === 1) { injected = true; throw failure; }
            return directory(path as string);
        },
        assertPathIdentity: () => undefined, captureFileIdentity: path => directory(path as string), assertFileIdentity: () => undefined,
        captureDirectoryTree: path => ({ rawTree: path }), assertCapturedDirectoryTree: () => undefined,
        readFileSync: (path, encoding) => {
            if (!encoding) return Buffer.from("synthetic index");
            const value = contents.get(path as string);
            if (value === undefined) throw new Error(`Unplanned metadata read ${path}`);
            return value;
        },
        readdirSync: path => contents.has(`${path}/.git`) ? [".git"] : [],
        mkdirSync: path => { temporary = path as string; directories.add(temporary); },
        rmdirSync: path => { directories.delete(path as string); }, unlinkSync: path => { contents.delete(path as string); },
        lstatSync: () => ({ isFile: () => true }), randomBytes: () => ({ toString: () => "0".repeat(32) }),
        portableWorktreeGitDirectory: (_workspace, managementDirectory) => managementDirectory,
        portableWorktreeBackpointer: path => path,
        normalizeWorktreeMetadataFile: (path, content, _identity, original) => {
            expect(contents.get(path as string)).toBe(original);
            contents.set(path as string, content as string); publications++;
        },
        pinnedNestedRepositoryEnvironment: () => ({}), withPinnedNestedRepository: (_identity, operation) => (operation as () => unknown)(),
        throwOnLiveWorkspaceBranchConflict: () => { if (scenario.branchConflict) throw new WorkspaceBranchConflictError("live branch"); },
        registeredWorktreePath: () => registered,
        missingWorktreeManagementMatches: () => true,
        quarantineMissingWorktreeRegistration: () => ({ location: { path: "private-registration" } }),
        commitQuarantinedMissingWorktreeRegistration: () => { directories.delete(management); registered = false; },
        gitFailureReason: stderr => stderr || undefined,
        spawnSync: (_executable, args) => {
            const command = args as string[]; events.push(`git:${command.join(" ")}`);
            if (command[0] === "worktree" && command[1] === "add") {
                if (!scenario.addFailure || scenario.addResidue) {
                    contents.set(`${temporary}/.git`, `gitdir: ${management}\n`); directories.add(management); registered = true;
                }
                return { status: scenario.addFailure ? 1 : 0, stdout: "", stderr: scenario.addFailure ? "add failed" : "" };
            }
            if (command[0] === "worktree" && command[1] === "remove") {
                contents.delete(`${temporary}/.git`); directories.delete(temporary); registered = false;
            }
            return { status: 0, stdout: command[0] === "rev-parse" ? "oid\n" : "", stderr: "" };
        },
    };
    const context: Record<string, unknown> = { exports: {}, Error, createRootWorkspaceRepair, WorkspaceRootRecoveryRollbackError, WorkspaceBranchConflictError,
        process: { platform: "linux" }, require() { throw new Error("Unplanned fixture import"); } };
    for (const [name, method] of Object.entries(methods)) context[name] = (...args: unknown[]) => {
        events.push(`${name}:${typeof args[0] === "string" ? args[0] : "receipt"}`);
        if (!injected && scenario.fault === name) { injected = true; throw failure; }
        return method(...args);
    };
    runInNewContext(afterCode, context);
    const api = context.exports as { handleWorkspaceRootOwnership(...args: unknown[]): unknown; replayRecreate(...args: unknown[]): unknown };
    const report = function (this: unknown, reason: string) { events.push(`report:${reason}`); };
    let result: unknown; let error: unknown;
    try {
        result = scenario.direct ? api.replayRecreate(workspace, source, "feature", common, repository(source), stale,
            directory(workspace), directory(`${workspace}/.git`), contents.get(`${workspace}/.git`), "confirmed", report)
            : api.handleWorkspaceRootOwnership(workspace, source, "feature", scenario.inspect ? "inspect" : scenario.existing ? "none" : "confirmed", report,
                function (this: unknown, guard: () => void) { events.push("preflight-ready"); guard(); });
    } catch (failure) { error = failure; }
    const normalizedError = error instanceof Error ? { name: error.name, message: error.message,
        cause: error.cause instanceof Error ? error.cause.message : undefined, identity: error === failure } : error;
    return { result, error: normalizedError, events, directories: [...directories], contents: [...contents], publications };
}

describe("root workspace recovery and backpointer compensation", () => {
    it.each([{}, { existing: true }, { inspect: true }] satisfies Scenario[])("executes a successful actual recovery path before comparing faults: %j", scenario => {
        expect(fixture( scenario).result).toBe(true);
    });

    it("does not add cleanup after pretry temporary identity capture failure", () => {
        const result = fixture( { fault: "temp-before-try", direct: true });
        expect(result.error).toEqual(expect.objectContaining({ identity: true }));
        expect(result.events.some(event => event.startsWith("rmdirSync:"))).toBe(false);
        expect(result.directories.some(path => path.includes(".ccc-register-"))).toBe(true);
    });
    it("does not fabricate an installed receipt to roll back an existing backpointer capture failure", () => {
        const result = fixture( { existing: true, fault: "existing-capture" });
        expect(result.result).toBe(false); expect(result.publications).toBe(1);
    });

});
