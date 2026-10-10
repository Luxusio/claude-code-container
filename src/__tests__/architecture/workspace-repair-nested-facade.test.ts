import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createNestedWorkspaceRepair } from "../../application/workspace/repair-nested.js";

const file = resolve("src/worktree.ts");
function compiled(source: string) { return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; }
const currentTree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const currentCode = compiled(currentTree.statements.filter(node => ts.isFunctionDeclaration(node) ? node.name?.text === "repairWorkspace"
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "nestedWorkspaceRepair"))
    .map(node => node.getText(currentTree)).join("\n"));

interface Scenario { fault?: string; normalizeFailure?: boolean; stale?: boolean; empty?: boolean; blocked?: boolean; addError?: boolean; }
function fixture(scenario: Scenario) {
    const events: string[] = [];
    const fault = Object.assign(new Error("synthetic fault"), { marker: "fault" });
    const normalizeFault = new Error("normalization failed");
    const exists = new Set<string>(scenario.empty ? ["ws/first"] : []);
    let injected = false;
    const directory = (path: string) => ({ realpath: path, dev: "1", ino: path });
    const entries = ["first", "second"].map(name => ({ name, path: `source/${name}`, isGitRepo: true, type: "repo" }));
    if (scenario.blocked) entries.push({ name: "first/child", path: "source/first/child", isGitRepo: true, type: "repo" });
    const identity = (path: string) => ({ directory: directory(path), commonDirectory: directory(`${path}/git`) });
    const registration = (path: string) => ({ destinationIdentity: directory(path) });
    const methods: Record<string, (...args: unknown[]) => unknown> = {
        resolve: () => "source", join: (...parts) => posix.join(...parts as string[]), dirname: path => posix.dirname(path as string), basename: path => posix.basename(path as string),
        hasGitMetadata: () => true, primarySourceRepositoryForWorktree: () => null, gitLinkKind: () => "directory",
        assertWorkspaceOwnership: () => undefined, assertWorkspaceRootOwnership: () => undefined,
        scanUnifiedNestedRepositories: () => entries, captureNestedRepositoryIdentity: path => identity(path as string),
        assertNestedRepositoryIdentity: () => undefined, assertDirectoryIdentity: () => undefined, assertNestedWorktreeDestinationFence: () => undefined,
        ensureNestedWorktreeParent: (_workspace, destination, created) => {
            (created as Map<string, object>).set(`parent/${destination}`, directory(`parent/${destination}`));
            return { workspace: directory("ws"), parents: [] };
        },
        pathExistsStrict: path => exists.has(path as string) || String(path).startsWith("parent/"),
        captureDirectoryIdentity: path => directory(path as string),
        readdirSync: path => scenario.blocked && path === "ws/first" ? ["foreign"] : [],
        mkdirSync: path => { exists.add(path as string); },
        isValidWorktree: path => !(scenario.blocked && path === "ws/first"),
        removeDirectoryByQuarantine: path => { exists.delete(path as string); },
        withPinnedNestedRepository: (_identity, operation) => (operation as () => unknown)(),
        captureMissingWorktreeRegistrationFence: (_source, destination) => scenario.stale ? { managementIdentity: directory(`management/${destination}`) } : null,
        managementGitdirBackpointer: path => String(path).replace("management/", "").replace(/\/gitdir$/, "/.git"),
        sameDirectExistingObject: () => true,
        quarantineMissingWorktreeRegistration: (_source, destination) => ({ location: { path: `private/${destination}` } }),
        registeredWorktreePath: () => false,
        restoreQuarantinedMissingWorktreeRegistration: () => undefined,
        branchExistsInRepo: () => "local",
        prepareWorktreeCreation: (_source, destination) => ({ expectedBranchOid: { expectedOid: "oid" }, destinationIdentity: directory(destination as string) }),
        runPreparedWorktreeAdd: (_source, destination) => {
            exists.add(destination as string);
            return { result: scenario.addError && destination === "ws/second" ? { status: 0, error: new Error("native add error"), stderr: "" } : { status: 0 }, registrationFence: registration(destination as string) };
        },
        requireWorktreeRegistrationFence: receipt => receipt,
        pinnedNestedRepositoryEnvironment: () => ({}),
        removeRegisteredWorktree: (_source, destination) => { exists.delete(destination as string); },
        rollbackFailedCreatedBranch: () => undefined,
        rollbackFailedWorktreeAdd: (_source, destination) => { exists.delete(destination as string); },
        normalizeOwnerVerifiedWorktreeGitLink: () => { if (scenario.normalizeFailure) throw normalizeFault; },
        terminalSafe: value => value,
    };
    if (scenario.blocked) exists.add("ws/first");
    const exports = {};
    const context: Record<string, unknown> = { exports, Error, createNestedWorkspaceRepair,
        process: { platform: "linux", stderr: { write(message: string) { events.push(`notice:${message}`); if (scenario.fault === "notice") throw fault; } } },
        require() { throw new Error("Unplanned fixture import"); },
    };
    for (const [name, method] of Object.entries(methods)) context[name] = (...args: unknown[]) => {
        events.push(`${name}:${typeof args[0] === "string" ? args[0] : "receipt"}`);
        if (!injected && scenario.fault === name) { injected = true; throw fault; }
        return method(...args);
    };
    runInNewContext(currentCode, context);
    let result: unknown; let failure: unknown;
    try { result = (exports as { repairWorkspace(source: string, destination: string, branch: string): unknown }).repairWorkspace("raw", "ws", "feature"); } catch (error) { failure = error; }
    const error = failure === fault ? "fault" : failure === normalizeFault ? "normalization" : failure instanceof Error ? { message: failure.message, cause: failure.cause === normalizeFault ? "normalization" : failure.cause === fault ? "fault" : undefined } : failure;
    return { result, error, events, existing: [...exists] };
}

describe("nested workspace repair transaction", () => {

    it("leaves committed checkouts intact when preserved-registration notice throws", () => {
        const result = fixture( { stale: true, fault: "notice" });
        expect(result.error).toBe("fault");
        expect(result.existing).toContain("ws/first"); expect(result.existing).toContain("ws/second");
        expect(result.events.some(event => event.startsWith("removeRegisteredWorktree:"))).toBe(false);
    });
    it("compensates created entries in reverse order after normalization fails", () => {
        const result = fixture( { normalizeFailure: true });
        expect(result.events.filter(event => event.startsWith("removeRegisteredWorktree:"))).toEqual(["removeRegisteredWorktree:source/second", "removeRegisteredWorktree:source/first"]);
    });
});
