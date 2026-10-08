import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createBrokenWorkspaceRepair } from "../../application/workspace/repair-broken.js";

const frozenBroken = "function fixBrokenWorktreeSanitized(\n    sourcePath: string,\n    wsPath: string,\n    repoName: string,\n    branch: string,\n    confirmed: boolean,\n    cleanupOperations: {\n        removeMergedBackup?: (path: string) => void;\n    },\n): WorktreeRepoResult | null {\n    if (!confirmed) {\n        throw new Error(\"Explicit confirmation is required to replace broken worktree content.\");\n    }\n    const resolved = resolve(sourcePath);\n    assertWorkspaceRootOwnership(wsPath, resolved);\n\n    // Find the source repo\n    const sourceEntries = scanUnifiedNestedRepositories(\n        resolved,\n        {\n            strict: true,\n            allowRegisteredWorktrees: Boolean(\n                primarySourceRepositoryForWorktree(resolved),\n            ),\n        },\n    );\n    const sourceRepo = sourceEntries.find((e) => e.name === repoName && e.isGitRepo);\n    if (!sourceRepo) return null;\n    const destPath = join(wsPath, ...sourceRepo.name.split(\"/\"));\n    for (const ancestor of sourceEntries.filter((entry) => (\n        entry.isGitRepo\n        && sourceRepo.name.startsWith(`${entry.name}/`)\n    ))) {\n        const ancestorDestination = join(wsPath, ...ancestor.name.split(\"/\"));\n        if (!isValidWorktree(ancestorDestination, ancestor.path)) {\n            throw new Error(\n                `Cannot repair '${repoName}' beneath unmanaged ancestor '${ancestor.name}'.`,\n            );\n        }\n    }\n    const sourceIdentity = captureNestedRepositoryIdentity(sourceRepo.path);\n    const createdParentDirectories = new Map<string, DirectoryIdentity>();\n    const destinationFence = ensureNestedWorktreeParent(\n        wsPath,\n        destPath,\n        createdParentDirectories,\n    );\n    const operationGuard = (): void => {\n        assertNestedRepositoryIdentity(sourceRepo.path, sourceIdentity);\n        assertNestedWorktreeDestinationFence(wsPath, destPath, destinationFence);\n    };\n    operationGuard();\n    // Not always destPath: see unreachableRegistrationPathHoldingBranch. Everything below\n    // takes this path as \"the path the registration records\", which is what the quarantine\n    // and its rollback have always keyed on — so displacing a container-side entry needs no\n    // new machinery, only the right path.\n    const staleRegistrationPath = registrationToDisplace(\n        sourceRepo.path,\n        destPath,\n        branch,\n    )?.path ?? destPath;\n    const staleRegistrationFence = captureMissingWorktreeRegistrationFence(\n        sourceRepo.path,\n        staleRegistrationPath,\n        branch,\n    );\n    operationGuard();\n\n    let backup: QuarantineLocation | null = null;\n    let backupIdentity: DirectoryIdentity | null = null;\n    let quarantinedStaleRegistration: QuarantinedMissingWorktreeRegistration | null = null;\n    // The directory rollback renames the quarantined content back INTO, which is the\n    // destination's own parent — not the workspace root. Those are the same path only for a\n    // top-level repository name; for a nested one such as `services/catchy-api` they never are,\n    // so every rollback below threw `identity changed before deletion: <ws>/services` BEFORE\n    // restoring anything, and the content stayed in the quarantine directory. The operator saw\n    // it as `ccc` losing a submodule on every attempt: answering the repair prompt moved the\n    // directory away and the failed rollback left it there.\n    const destinationParentIdentity = captureDirectoryIdentity(dirname(destPath));\n    const restoreStaleRegistration = (): void => {\n        if (!quarantinedStaleRegistration) return;\n        restoreQuarantinedMissingWorktreeRegistration(quarantinedStaleRegistration);\n        quarantinedStaleRegistration = null;\n    };\n    // Committing a quarantined registration DELETES it. That is right for the destination's\n    // own stale entry — it describes this very path and this repair is what replaces it. It\n    // is not right for one displaced from somewhere else: what we cannot reach, we cannot\n    // prove is dead. Everything a worktree keeps outside its working directory lives in that\n    // directory — HEAD, the index, per-worktree refs, the reflog, an in-progress rebase — so\n    // deleting it on a wrong guess loses work that is not even on this machine to look at.\n    // Kept in the quarantine instead, and the operator is told where.\n    const displacedRegistration = staleRegistrationPath !== destPath;\n    const settleStaleRegistration = (): void => {\n        if (!quarantinedStaleRegistration) return;\n        if (displacedRegistration) {\n            warnDisplacedWorktreeRegistration(\n                staleRegistrationPath,\n                quarantinedStaleRegistration.location.path,\n            );\n        } else {\n            commitQuarantinedMissingWorktreeRegistration(quarantinedStaleRegistration);\n        }\n        quarantinedStaleRegistration = null;\n    };\n    if (pathExistsStrict(destPath)) {\n        operationGuard();\n        backupIdentity = captureDirectoryIdentity(destPath);\n        backup = createPrivateQuarantine(destPath, dirname(wsPath));\n        try {\n            operationGuard();\n            assertDirectoryIdentity(destPath, backupIdentity);\n            renameSync(destPath, backup.path);\n            operationGuard();\n            assertQuarantinedIdentity(backup.path, backupIdentity, \"directory\");\n        } catch (error) {\n            if (!pathExistsStrict(backup.path)) removePrivateQuarantine(backup);\n            throw error;\n        }\n    }\n\n    if (staleRegistrationFence) {\n        try {\n            operationGuard();\n            quarantinedStaleRegistration = withPinnedNestedRepository(\n                sourceIdentity,\n                () => quarantineMissingWorktreeRegistration(\n                    sourceRepo.path,\n                    staleRegistrationPath,\n                    staleRegistrationFence,\n                ),\n            );\n            operationGuard();\n        } catch (error) {\n            if (backup && backupIdentity) {\n                operationGuard();\n                rollbackQuarantinedPath(\n                    destPath,\n                    backup,\n                    backupIdentity,\n                    destinationParentIdentity,\n                    \"directory\",\n                );\n                operationGuard();\n            }\n            throw error;\n        }\n    }\n\n    // Create worktree\n    operationGuard();\n    const existence = branchExistsInRepo(sourceRepo.path, branch);\n    operationGuard();\n    let action: WorktreeRepoResult[\"action\"];\n\n    switch (existence) {\n        case \"local\":\n            action = \"worktree-existing\";\n            break;\n        case \"remote\":\n            action = \"worktree-remote\";\n            break;\n        case \"none\":\n            action = \"worktree-new\";\n            break;\n    }\n    let expectedBranchOid: BranchCreationFence;\n    let destinationIdentity: DirectoryIdentity;\n    try {\n        ({\n            expectedBranchOid,\n            destinationIdentity,\n        } = withPinnedNestedRepository(\n            sourceIdentity,\n            () => prepareWorktreeCreation(\n                sourceRepo.path,\n                destPath,\n                branch,\n                action,\n                operationGuard,\n                dirname(wsPath),\n            ),\n        ));\n    } catch (error) {\n        if (backup && backupIdentity) {\n            operationGuard();\n            rollbackQuarantinedPath(\n                destPath,\n                backup,\n                backupIdentity,\n                destinationParentIdentity,\n                \"directory\",\n            );\n            operationGuard();\n        }\n        restoreStaleRegistration();\n        throw error;\n    }\n    const { result, registrationFence } = runPreparedWorktreeAdd(\n        sourceRepo.path,\n        destPath,\n        branch,\n        expectedBranchOid.expectedOid,\n        destinationIdentity,\n        operationGuard,\n        sourceIdentity,\n    );\n\n    if (result.status !== 0) {\n        try {\n            operationGuard();\n            rollbackFailedWorktreeAdd(\n                sourceRepo.path,\n                destPath,\n                branch,\n                action,\n                expectedBranchOid,\n                destinationIdentity,\n                registrationFence,\n                dirname(wsPath),\n                sourceIdentity,\n                operationGuard,\n            );\n            operationGuard();\n        } catch (rollbackError) {\n            const preservation = backup\n                ? `; original content remains in '${backup.directory}'`\n                : \"\";\n            throw new Error(\n                `Failed worktree repair rollback: ${(rollbackError as Error).message}${preservation}.`,\n                { cause: rollbackError },\n            );\n        }\n        if (backup && backupIdentity) {\n            operationGuard();\n            const restored = rollbackQuarantinedPath(\n                destPath,\n                backup,\n                backupIdentity,\n                destinationParentIdentity,\n                \"directory\",\n            );\n            operationGuard();\n            if (!restored) {\n                throw new Error(\n                    `Failed worktree creation could not restore original content from '${backup.directory}'.`,\n                );\n            }\n        }\n        restoreStaleRegistration();\n        warnWorktreeRepairFailure(destPath, result.stderr ?? \"\");\n        return null;\n    }\n    const createdRegistrationFence = requireWorktreeRegistrationFence(\n        registrationFence,\n        destPath,\n    );\n\n    if (backup && backupIdentity) {\n        const preservedContentMerge: PreservedContentMerge = {\n            worktreeRoot: destPath,\n            skippedIgnoredDependencyTrees: [],\n            conflicts: [],\n        };\n        try {\n            operationGuard();\n            if (!isValidWorktree(destPath, sourceRepo.path)) {\n                throw new Error(\"Created worktree ownership could not be verified.\");\n            }\n            operationGuard();\n            assertQuarantinedIdentity(backup.path, backupIdentity, \"directory\");\n            for (const name of readdirSync(backup.path)) {\n                if (name === \".git\") continue;\n                mergePreservingContent(\n                    join(backup.path, name),\n                    join(destPath, name),\n                    preservedContentMerge,\n                );\n            }\n            if (preservedContentMerge.conflicts.length > 0) {\n                throw new WorktreeContentConflictError(destPath, preservedContentMerge.conflicts);\n            }\n        } catch (error) {\n            if (pathExistsStrict(destPath)) {\n                operationGuard();\n                if (!isValidWorktree(destPath, sourceRepo.path)) {\n                    throw new Error(\n                        `${(error as Error).message}; created worktree ownership changed during rollback`,\n                        { cause: error },\n                    );\n                }\n                removeRegisteredWorktree(\n                    sourceRepo.path,\n                    destPath,\n                    createdRegistrationFence.destinationIdentity,\n                    true,\n                    dirname(wsPath),\n                    createdRegistrationFence,\n                    pinnedNestedRepositoryEnvironment(sourceIdentity),\n                    operationGuard,\n                );\n                operationGuard();\n                withPinnedNestedRepository(sourceIdentity, () => (\n                    rollbackFailedCreatedBranch(\n                        sourceRepo.path,\n                        branch,\n                        action,\n                        expectedBranchOid,\n                    )\n                ));\n            }\n            operationGuard();\n            rollbackQuarantinedPath(\n                destPath,\n                backup,\n                backupIdentity,\n                destinationParentIdentity,\n                \"directory\",\n            );\n            operationGuard();\n            restoreStaleRegistration();\n            throw error;\n        }\n\n        // The replacement is now the authoritative worktree. Cleanup failures\n        // must not roll it back after either quarantine has been settled.\n        settleStaleRegistration();\n        if (preservedContentMerge.skippedIgnoredDependencyTrees.length > 0) {\n            process.stderr.write(\n                `[ccc] NOTE: Recreated ${terminalSafe(destPath)} without ignored generated dependency trees that may contain platform-specific links.\\n`\n                + `      Skipped: ${preservedContentMerge.skippedIgnoredDependencyTrees.map((tree) => terminalSafe(tree.destinationPath)).join(\", \")}\\n`\n                + \"      Run the repository's package-manager install command in the repaired worktree.\\n\",\n            );\n        }\n        const removeMergedBackup = cleanupOperations.removeMergedBackup\n            ?? ((path: string) => rmSync(path, { recursive: true, force: true }));\n        operationGuard();\n        assertQuarantinedIdentity(backup.path, backupIdentity, \"directory\");\n        unlinkCapturedIgnoredDependencyLinks(\n            preservedContentMerge.skippedIgnoredDependencyTrees,\n        );\n        assertQuarantinedIdentity(backup.path, backupIdentity, \"directory\");\n        removeMergedBackup(backup.path);\n        operationGuard();\n        if (pathExistsStrict(backup.path)) {\n            throw new Error(`Broken-worktree backup was not removed: ${backup.path}`);\n        }\n        removePrivateQuarantine(backup);\n    }\n\n    settleStaleRegistration();\n    return { name: repoName, branch, action };\n}";
const file = resolve("src/worktree.ts");
const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const beforeCode = compile(frozenBroken + "\nexport { fixBrokenWorktreeSanitized };");
const afterCode = compile(tree.statements.filter(node => ts.isFunctionDeclaration(node) ? node.name?.text === "fixBrokenWorktreeSanitized"
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "brokenWorkspaceRepair"))
    .map(node => node.getText(tree)).join("\n") + "\nexport { fixBrokenWorktreeSanitized };");

interface Scenario { fault?: string; afterFault?: string; noBackup?: boolean; noSource?: boolean; displaced?: boolean; conflict?: boolean; dependencies?: boolean; addFailure?: boolean; errorAtZero?: boolean; customCleanup?: boolean; }
function fixture(old: boolean, scenario: Scenario) {
    const events: string[] = [];
    const failure = new Error("synthetic failure"); let injected = false;
    const destination = "/ws/repo"; const backup = "/private/old";
    const exists = new Set(scenario.noBackup ? [] : [destination]);
    let quarantined = false; let settled = false; let callbackReads = 0;
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
    runInNewContext(old ? beforeCode : afterCode, context);
    const cleanup = { get removeMergedBackup() {
        callbackReads++; events.push(`cleanup:get:${settled}`);
        if (scenario.fault === "cleanup-getter") throw failure;
        if (!scenario.customCleanup) return undefined;
        return function (this: unknown, path: string) { expect(this).toBeUndefined(); events.push(`cleanup:run:${path}`); exists.delete(path); };
    } };
    let result: unknown; let error: unknown;
    try { result = (context.exports as { fixBrokenWorktreeSanitized(...args: unknown[]): unknown }).fixBrokenWorktreeSanitized("raw", "/ws", "repo", "feature", true, cleanup); } catch (cause) { error = cause; }
    const normalized = error instanceof Error ? { name: error.name, message: error.message, identity: error === failure, cause: error.cause instanceof Error ? error.cause.message : undefined } : error;
    return { result, error: normalized, events, exists: [...exists], quarantined, settled, callbackReads };
}

describe("complete frozen broken replacement transaction replay", () => {
    it.each([{}, { noBackup: true }, { displaced: true }, { customCleanup: true }, { errorAtZero: true }] satisfies Scenario[])("executes actual success before comparing fault paths: %j", scenario => {
        expect(fixture(true, scenario).result).toEqual({ name: "repo", branch: "feature", action: "worktree-existing" });
        expect(fixture(false, scenario).result).toEqual({ name: "repo", branch: "feature", action: "worktree-existing" });
    });
    it.each([
        {}, { noBackup: true }, { noSource: true }, { displaced: true }, { conflict: true }, { dependencies: true }, { addFailure: true }, { errorAtZero: true }, { customCleanup: true },
        ...["resolve", "assertWorkspaceRootOwnership", "scanUnifiedNestedRepositories", "captureNestedRepositoryIdentity", "ensureNestedWorktreeParent", "createPrivateQuarantine",
            "renameSync", "quarantineMissingWorktreeRegistration", "prepareWorktreeCreation", "runPreparedWorktreeAdd", "requireWorktreeRegistrationFence", "mergePreservingContent",
            "commitQuarantinedMissingWorktreeRegistration", "unlinkCapturedIgnoredDependencyLinks", "rmSync", "removePrivateQuarantine", "cleanup-getter"].map(fault => ({ fault })),
        { afterFault: "runPreparedWorktreeAdd" }, { afterFault: "renameSync" },
        { conflict: true, fault: "removeRegisteredWorktree" }, { conflict: true, fault: "rollbackFailedCreatedBranch" },
        { addFailure: true, fault: "rollbackFailedWorktreeAdd" }, { addFailure: true, fault: "rollbackQuarantinedPath" },
    ] satisfies Scenario[])("preserves native trace, partial effects, raw failure and settlement at %j", scenario => {
        expect(fixture(false, scenario)).toEqual(fixture(true, scenario));
    });
    it.each(["runPreparedWorktreeAdd", "requireWorktreeRegistrationFence"])("does not introduce rescue around original unrescued %s", fault => {
        const result = fixture(false, { fault });
        expect(result.error).toEqual(expect.objectContaining({ identity: true }));
        expect(result.exists).toContain(backupPath());
        expect(result.events.some(event => event.startsWith("rollbackQuarantinedPath:"))).toBe(false);
    });
    it("looks up custom cleanup once after settlement and calls it as a bare callback", () => {
        const result = fixture(false, { customCleanup: true });
        expect(result.callbackReads).toBe(1); expect(result.events).toContain("cleanup:get:true");
        expect(result.events).toContain("cleanup:run:/private/old");
    });
    it("retains the committed replacement on a late cleanup getter failure", () => {
        const result = fixture(false, { fault: "cleanup-getter" });
        expect(result.settled).toBe(true); expect(result.exists).toContain("/ws/repo");
        expect(result.events.some(event => event.startsWith("removeRegisteredWorktree:"))).toBe(false);
    });
});
function backupPath() { return "/private/old"; }
