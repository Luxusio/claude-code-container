import { isolateGitFixture } from "../helpers/git-fixture.js";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokenWorkspaceRepairPorts } from "../../ports/workspace/repair-broken.js";
import type { WorkspaceRepairAuthority } from "../../domain/workspace/repair-authority.js";

const injection = vi.hoisted(() => ({
    processStatus: undefined as undefined | number,
    semanticFailure: false,
    rollbackFailure: false,
    addedReceipt: undefined as unknown,
    compensatedReceipt: undefined as unknown,
    diagnostic: undefined as undefined | string,
    postRenameGuardFailure: undefined as Error | undefined,
    postRegistrationGuardFailure: undefined as Error | undefined,
    pendingGuardFailure: undefined as Error | undefined,
    nativeBranchFailure: false,
    beforeAddFailure: undefined as Error | undefined,
    afterAddFailure: undefined as Error | undefined,
    requireReceiptFailure: undefined as Error | undefined,
    createMergeFailure: undefined as Error | undefined,
    registrationRestoreFailure: undefined as Error | undefined,
    replaceRegistrationBeforeRestore: false,
    savedRegistrationPath: undefined as string | undefined,
    registrationSuccessorInode: undefined as number | undefined,
    directorySuccessor: false,
    successorInode: undefined as number | undefined,
    settlementFailure: undefined as "before" | "after" | undefined,
    settlementAttempts: 0,
    addedDestinationInode: undefined as number | undefined,
    backupPath: undefined as string | undefined,
    registrationBackupPath: undefined as string | undefined,
    nativeConflict: undefined as Error | undefined,
}));
vi.mock("child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("child_process");
    return { ...actual, spawnSync: ((...args: unknown[]) => {
        const result = Reflect.apply(actual.spawnSync, undefined, args) as ReturnType<typeof actual.spawnSync>;
        const argv = args[1] as string[] | undefined;
        if (injection.nativeBranchFailure && argv?.[0] === "show-ref"
            && argv[1] === "--quiet" && argv[2] === "--verify") {
            injection.nativeBranchFailure = false;
            return { ...result, status: 128, stderr: "fatal: branch observation denied\n" };
        }
        return injection.processStatus !== undefined && argv?.[0] === "checkout" && argv[1] === "--force"
            ? { ...result, status: injection.processStatus, error: new Error("broken native process error"), stderr: "  fatal: broken native detail  \n" }
            : result;
    }) as typeof actual.spawnSync };
});
vi.mock("../../application/workspace/repair-broken.js", async () => {
    const actual = await vi.importActual<typeof import("../../application/workspace/repair-broken.js")>("../../application/workspace/repair-broken.js");
    const wrapped: typeof actual.createBrokenWorkspaceRepair = ports => actual.createBrokenWorkspaceRepair({
        ...ports,
        assertNestedWorktreeDestinationFence(...args) {
            if (injection.pendingGuardFailure) {
                const failure = injection.pendingGuardFailure;
                injection.pendingGuardFailure = undefined;
                throw failure;
            }
            return ports.assertNestedWorktreeDestinationFence(...args);
        },
        renameBrokenCheckout(...args) {
            ports.renameBrokenCheckout(...args);
            injection.backupPath = args[1];
            injection.pendingGuardFailure = injection.postRenameGuardFailure;
            injection.postRenameGuardFailure = undefined;
        },
        quarantineMissingWorktreeRegistration(...args) {
            const registration = ports.quarantineMissingWorktreeRegistration(...args);
            injection.registrationBackupPath = registration.location.path;
            injection.pendingGuardFailure = injection.postRegistrationGuardFailure;
            injection.postRegistrationGuardFailure = undefined;
            return registration;
        },
        runPreparedWorktreeAdd(...args) {
            if (injection.beforeAddFailure) throw injection.beforeAddFailure;
            const observation = ports.runPreparedWorktreeAdd(...args);
            injection.addedReceipt = observation.registrationFence;
            injection.addedDestinationInode = lstatSync(args[1]).ino;
            if (injection.afterAddFailure) throw injection.afterAddFailure;
            return injection.semanticFailure
                ? { ...observation, result: Object.freeze({ succeeded: false, failureReason: "  classified broken refusal  \n" }) }
                : observation;
        },
        rollbackFailedWorktreeAdd(...args) {
            injection.compensatedReceipt = args[6];
            if (injection.rollbackFailure) throw new Error("owned repair compensation refused");
            return ports.rollbackFailedWorktreeAdd(...args);
        },
        requireWorktreeRegistrationFence(...args) {
            if (injection.requireReceiptFailure) throw injection.requireReceiptFailure;
            return ports.requireWorktreeRegistrationFence(...args);
        },
        createPreservedContentMerge(...args) {
            if (injection.createMergeFailure) throw injection.createMergeFailure;
            return ports.createPreservedContentMerge(...args);
        },
        createContentConflictError(...args) {
            const conflict = ports.createContentConflictError(...args);
            injection.nativeConflict = conflict;
            return conflict;
        },
        rollbackQuarantinedPath(...args) {
            if (injection.directorySuccessor) {
                injection.directorySuccessor = false;
                mkdirSync(args[0]);
                writeFileSync(join(args[0], "successor.txt"), "new owner must survive\n");
                injection.successorInode = lstatSync(args[0]).ino;
            }
            return ports.rollbackQuarantinedPath(...args);
        },
        restoreQuarantinedMissingWorktreeRegistration(...args) {
            if (injection.registrationRestoreFailure) throw injection.registrationRestoreFailure;
            if (injection.replaceRegistrationBeforeRestore) {
                injection.replaceRegistrationBeforeRestore = false;
                const path = args[0].location.path;
                injection.savedRegistrationPath = `${path}.saved-metadata`;
                renameSync(path, injection.savedRegistrationPath);
                mkdirSync(path);
                writeFileSync(join(path, "successor-metadata.txt"), "unrelated registration metadata\n");
                injection.registrationSuccessorInode = lstatSync(path).ino;
            }
            return ports.restoreQuarantinedMissingWorktreeRegistration(...args);
        },
        commitQuarantinedMissingWorktreeRegistration(...args) {
            injection.settlementAttempts += 1;
            if (injection.settlementFailure === "before") throw new Error("first registration settlement refused");
            ports.commitQuarantinedMissingWorktreeRegistration(...args);
            if (injection.settlementFailure === "after") throw new Error("registration settlement failed after native deletion");
        },
        warnWorktreeRepairFailure(path, detail) {
            injection.diagnostic = detail;
            return ports.warnWorktreeRepairFailure(path, detail);
        },
    });
    return { ...actual, createBrokenWorkspaceRepair: wrapped };
});
import { createBrokenWorkspaceRepair } from "../../application/workspace/repair-broken.js";
import { createWorkspace, fixBrokenWorktree, isValidWorktree, WorktreeContentConflictError } from "../../worktree.js";

function git(repository: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
}
function init(repository: string): void {
    mkdirSync(repository, { recursive: true });
    git(repository, "init");
    git(repository, "config", "user.name", "Broken repair fixture");
    git(repository, "config", "user.email", "test@example.invalid");
    git(repository, "config", "commit.gpgsign", "false");
    writeFileSync(join(repository, "owned.txt"), "original source content\n");
    git(repository, "add", "owned.txt");
    git(repository, "commit", "-m", "initial");
}

describe("broken repair semantic admission and native compensation", () => {
    let root: string;
    let restoreGitEnvironment: () => void;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-broken-repair-"));
        restoreGitEnvironment = isolateGitFixture(join(root, "home"));
    });
    afterEach(() => {
        injection.processStatus = undefined;
        injection.semanticFailure = false;
        injection.rollbackFailure = false;
        injection.addedReceipt = undefined;
        injection.compensatedReceipt = undefined;
        injection.diagnostic = undefined;
        injection.postRenameGuardFailure = undefined;
        injection.postRegistrationGuardFailure = undefined;
        injection.pendingGuardFailure = undefined;
        injection.nativeBranchFailure = false;
        injection.beforeAddFailure = undefined;
        injection.afterAddFailure = undefined;
        injection.requireReceiptFailure = undefined;
        injection.createMergeFailure = undefined;
        injection.registrationRestoreFailure = undefined;
        injection.replaceRegistrationBeforeRestore = false;
        injection.savedRegistrationPath = undefined;
        injection.registrationSuccessorInode = undefined;
        injection.directorySuccessor = false;
        injection.successorInode = undefined;
        injection.settlementFailure = undefined;
        injection.settlementAttempts = 0;
        injection.addedDestinationInode = undefined;
        injection.backupPath = undefined;
        injection.registrationBackupPath = undefined;
        injection.nativeConflict = undefined;
        restoreGitEnvironment();
        rmSync(root, { recursive: true, force: true });
    });

    function brokenCheckout() {
        const source = join(root, "source");
        const nestedSource = join(source, "nested");
        init(source); init(nestedSource);
        const branch = "broken-topic";
        const workspace = createWorkspace(source, branch).workspacePath;
        const destination = join(workspace, "nested");
        git(nestedSource, "worktree", "remove", "--force", destination);
        git(nestedSource, "branch", "-D", branch);
        mkdirSync(destination);
        writeFileSync(join(destination, "operator.txt"), "preserve broken content\n");
        const originalInode = lstatSync(destination).ino;
        const registrations = git(nestedSource, "worktree", "list", "--porcelain");
        return { source, nestedSource, workspace, destination, branch, originalInode, registrations };
    }

    function directoryFiles(directory: string, relative = ""): Array<[string, string]> {
        return readdirSync(join(directory, relative), { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name))
            .flatMap(entry => {
                const name = join(relative, entry.name);
                return entry.isDirectory() ? directoryFiles(directory, name)
                    : [[name, readFileSync(join(directory, name)).toString("base64")] as [string, string]];
            });
    }

    function staleCheckout(conflict = false) {
        const source = join(root, "source");
        const nestedSource = join(source, "nested");
        init(source); init(nestedSource);
        const branch = "broken-topic";
        const workspace = createWorkspace(source, branch).workspacePath;
        const destination = join(workspace, "nested");
        const management = git(destination, "rev-parse", "--absolute-git-dir");
        const managementInode = lstatSync(management).ino;
        const registrationFiles = directoryFiles(management);
        rmSync(destination, { recursive: true, force: true });
        mkdirSync(destination);
        writeFileSync(join(destination, "operator.txt"), "preserve broken content\n");
        if (conflict) writeFileSync(join(destination, "owned.txt"), "operator's conflicting version\n");
        const originalInode = lstatSync(destination).ino;
        const originalFiles = directoryFiles(destination);
        const registrations = git(nestedSource, "worktree", "list", "--porcelain");
        return { source, nestedSource, workspace, destination, branch, originalInode,
            originalFiles, management, managementInode, registrationFiles, registrations };
    }

    function expectRestored(f: ReturnType<typeof staleCheckout>): void {
        expect(lstatSync(f.destination).ino).toBe(f.originalInode);
        expect(directoryFiles(f.destination)).toEqual(f.originalFiles);
        expect(lstatSync(f.management).ino).toBe(f.managementInode);
        expect(directoryFiles(f.management)).toEqual(f.registrationFiles);
        expect(git(f.nestedSource, "worktree", "list", "--porcelain")).toBe(f.registrations);
        expect(isValidWorktree(f.destination, f.nestedSource)).toBe(false);
    }

    function expectBackupPreserved(f: ReturnType<typeof staleCheckout>): void {
        expect(injection.backupPath).toBeDefined();
        expect(lstatSync(injection.backupPath!).ino).toBe(f.originalInode);
        expect(directoryFiles(injection.backupPath!)).toEqual(f.originalFiles);
    }

    function repairFailure(f: ReturnType<typeof staleCheckout>): Error {
        let failure: unknown;
        try { fixBrokenWorktree(f.source, f.workspace, "nested", f.branch, true); }
        catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        return failure as Error;
    }

    it("requires explicit confirmation before considering repair", () => {
        const ports = {} as BrokenWorkspaceRepairPorts<WorkspaceRepairAuthority>;
        expect(() => createBrokenWorkspaceRepair(ports).fixBrokenWorktreeSanitized("source", "workspace", "repo", "branch", false, {}))
            .toThrow("Explicit confirmation is required to replace broken worktree content.");
    });

    it("preserves status-only acceptance when a completed native add also carries a process error", () => {
        const f = brokenCheckout();
        injection.processStatus = 0;
        expect(fixBrokenWorktree(f.source, f.workspace, "nested", f.branch, true))
            .toEqual({ name: "nested", branch: f.branch, action: "worktree-new" });
        injection.processStatus = undefined;
        expect(isValidWorktree(f.destination, f.nestedSource)).toBe(true);
        expect(readFileSync(join(f.destination, "operator.txt"), "utf8")).toBe("preserve broken content\n");
        expect(readFileSync(join(f.destination, "owned.txt"), "utf8")).toBe("original source content\n");
        expect(git(f.nestedSource, "status", "--porcelain")).toBe("");
        expect(injection.compensatedReceipt).toBeUndefined();
    });

    it.each(["semantic", "native"] as const)("restores the exact broken checkout after a side-effecting %s refusal", kind => {
        const f = brokenCheckout();
        injection.semanticFailure = kind === "semantic";
        injection.processStatus = kind === "native" ? 1 : undefined;
        expect(fixBrokenWorktree(f.source, f.workspace, "nested", f.branch, true)).toBeNull();
        injection.processStatus = undefined;
        expect(injection.addedReceipt).toBeDefined();
        expect(injection.addedReceipt).not.toBeNull();
        expect(injection.compensatedReceipt).toBe(injection.addedReceipt);
        expect(injection.diagnostic).toBe(kind === "semantic" ? "  classified broken refusal  \n" : "  fatal: broken native detail  \n");
        expect(lstatSync(f.destination).ino).toBe(f.originalInode);
        expect(readFileSync(join(f.destination, "operator.txt"), "utf8")).toBe("preserve broken content\n");
        expect(existsSync(join(f.destination, ".git"))).toBe(false);
        expect(git(f.nestedSource, "worktree", "list", "--porcelain")).toBe(f.registrations);
        expect(spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`], { cwd: f.nestedSource, stdio: "pipe" }).status).toBe(1);
        expect(readFileSync(join(f.nestedSource, "owned.txt"), "utf8")).toBe("original source content\n");
    });

    it("reports failed compensation and preserves original content in its quarantine", () => {
        const f = brokenCheckout();
        injection.semanticFailure = true;
        injection.rollbackFailure = true;
        let failure: Error | undefined;
        try { fixBrokenWorktree(f.source, f.workspace, "nested", f.branch, true); }
        catch (error) { failure = error as Error; }
        expect(failure).toBeInstanceOf(Error);
        expect(failure!.message).toContain("Failed worktree repair rollback: owned repair compensation refused");
        const preserved = /original content remains in '([^']+)'/.exec(failure!.message)?.[1];
        expect(preserved).toBeDefined();
        expect(readFileSync(join(preserved!, "nested", "operator.txt"), "utf8")).toBe("preserve broken content\n");
        expect(isValidWorktree(f.destination, f.nestedSource)).toBe(true);
        expect(injection.diagnostic).toBeUndefined();
    });

    it("restores the renamed directory after a one-shot post-rename guard refusal", () => {
        const f = staleCheckout();
        const refusal = new Error("post-rename destination observation refused");
        injection.postRenameGuardFailure = refusal;
        expect(repairFailure(f)).toBe(refusal);
        expectRestored(f);
        expect(injection.addedReceipt).toBeUndefined();
        expect(existsSync(injection.backupPath!)).toBe(false);
    });

    it("restores both native identities when the guard throws after registration quarantine returned", () => {
        const f = staleCheckout();
        const refusal = new Error("post-registration destination observation refused");
        injection.postRegistrationGuardFailure = refusal;
        expect(repairFailure(f)).toBe(refusal);
        expectRestored(f);
        expect(injection.registrationBackupPath).toBeDefined();
        expect(existsSync(injection.registrationBackupPath!)).toBe(false);
        expect(injection.addedReceipt).toBeUndefined();
    });

    it("restores directory and registration when native branch observation errors", () => {
        const f = staleCheckout();
        injection.nativeBranchFailure = true;
        expect(repairFailure(f).message).toContain("Unable to inspect local branch");
        expectRestored(f);
        expect(injection.addedReceipt).toBeUndefined();
    });

    it("compensates the exact prepared empty checkout when add throws before effects", () => {
        const f = staleCheckout();
        const refusal = new Error("native add failed before effects");
        injection.beforeAddFailure = refusal;
        expect(repairFailure(f)).toBe(refusal);
        expectRestored(f);
        expect(injection.addedReceipt).toBeUndefined();
        expect(injection.compensatedReceipt).toBeNull();
    });

    it("preserves an added native worktree and original backup when add throws without returning its receipt", () => {
        const f = staleCheckout();
        const refusal = new Error("native add threw before returning receipt");
        injection.afterAddFailure = refusal;
        const failure = repairFailure(f);
        expect(failure).not.toBe(refusal);
        expect(failure.cause).toBe(refusal);
        expect(failure.message).toContain(injection.backupPath!);
        expect(failure.message).toContain(f.destination);
        expect(injection.addedReceipt).toBeDefined();
        expect(injection.addedReceipt).not.toBeNull();
        expect(isValidWorktree(f.destination, f.nestedSource)).toBe(true);
        expect(lstatSync(f.destination).ino).toBe(injection.addedDestinationInode);
        expect(readFileSync(join(f.destination, "owned.txt"), "utf8")).toBe("original source content\n");
        expectBackupPreserved(f);
        expect(existsSync(injection.registrationBackupPath!)).toBe(true);
        expect(injection.compensatedReceipt).not.toBe(injection.addedReceipt);
    });

    it.each(["receipt qualification", "merge-state construction"] as const)(
        "restores the exact original after returned native addition fails at %s",
        phase => {
            const f = staleCheckout();
            const refusal = new Error(`${phase} refused`);
            if (phase === "receipt qualification") injection.requireReceiptFailure = refusal;
            else injection.createMergeFailure = refusal;
            expect(repairFailure(f)).toBe(refusal);
            expect(injection.addedReceipt).toBeDefined();
            expect(injection.addedReceipt).not.toBeNull();
            expect(injection.compensatedReceipt).toBe(injection.addedReceipt);
            expectRestored(f);
        },
    );

    it("rethrows the genuine native content-conflict class only after complete restoration", () => {
        const f = staleCheckout(true);
        const failure = repairFailure(f);
        expect(failure).toBeInstanceOf(WorktreeContentConflictError);
        expect(failure).toBe(injection.nativeConflict);
        expect((failure as WorktreeContentConflictError).conflicts).toEqual([join(f.destination, "owned.txt")]);
        expectRestored(f);
    });

    it("preserves a successor and original backup instead of admitting an incompletely restored conflict", () => {
        const f = staleCheckout(true);
        injection.directorySuccessor = true;
        const failure = repairFailure(f);
        expect(injection.nativeConflict).toBeInstanceOf(WorktreeContentConflictError);
        expect(failure).not.toBeInstanceOf(WorktreeContentConflictError);
        expect(failure.cause).toBe(injection.nativeConflict);
        expect(failure.message).toContain(injection.backupPath!);
        expect(failure.message).toContain(f.destination);
        expect(lstatSync(f.destination).ino).toBe(injection.successorInode);
        expect(directoryFiles(f.destination)).toEqual([
            ["successor.txt", Buffer.from("new owner must survive\n").toString("base64")],
        ]);
        expectBackupPreserved(f);
    });

    it("reports retained registration metadata instead of exposing a restored-conflict class when metadata restore refuses", () => {
        const f = staleCheckout(true);
        injection.registrationRestoreFailure = new Error("native registration restoration refused");
        const failure = repairFailure(f);
        expect(injection.nativeConflict).toBeInstanceOf(WorktreeContentConflictError);
        expect(failure).not.toBeInstanceOf(WorktreeContentConflictError);
        expect(failure.cause).toBe(injection.nativeConflict);
        expect(failure.message).toContain("native registration restoration refused");
        expect(failure.message).toContain(injection.registrationBackupPath!);
        expect(lstatSync(f.destination).ino).toBe(f.originalInode);
        expect(directoryFiles(f.destination)).toEqual(f.originalFiles);
        expect(lstatSync(injection.registrationBackupPath!).ino).toBe(f.managementInode);
        expect(directoryFiles(injection.registrationBackupPath!)).toEqual(f.registrationFiles);
    });

    it("does not advertise a replacement registration quarantine as the original metadata after native restore refuses it", () => {
        const f = staleCheckout(true);
        injection.replaceRegistrationBeforeRestore = true;
        const failure = repairFailure(f);
        expect(injection.nativeConflict).toBeInstanceOf(WorktreeContentConflictError);
        expect(failure).not.toBeInstanceOf(WorktreeContentConflictError);
        expect(failure.cause).toBe(injection.nativeConflict);
        expect(failure.message).not.toContain(
            `original registration recovery location is '${injection.registrationBackupPath!}'`,
        );
        const registrationDiagnostic = failure.message.split(";").find(part => (
            part.includes(injection.registrationBackupPath!)
            && /unverified|(?:could not|not|cannot) be verified/i.test(part)
        ));
        expect(registrationDiagnostic).toBeDefined();
        expect(lstatSync(f.destination).ino).toBe(f.originalInode);
        expect(directoryFiles(f.destination)).toEqual(f.originalFiles);
        expect(lstatSync(injection.savedRegistrationPath!).ino).toBe(f.managementInode);
        expect(directoryFiles(injection.savedRegistrationPath!)).toEqual(f.registrationFiles);
        expect(lstatSync(injection.registrationBackupPath!).ino).toBe(injection.registrationSuccessorInode);
        expect(directoryFiles(injection.registrationBackupPath!)).toEqual([
            ["successor-metadata.txt", Buffer.from("unrelated registration metadata\n").toString("base64")],
        ]);
    });

    it.each(["before", "after"] as const)(
        "keeps the authoritative replacement when first settlement throws %s native metadata deletion",
        phase => {
            const f = staleCheckout();
            injection.settlementFailure = phase;
            expect(repairFailure(f).message).toContain(phase === "before"
                ? "first registration settlement refused"
                : "registration settlement failed after native deletion");
            expect(injection.settlementAttempts).toBe(1);
            expect(injection.compensatedReceipt).toBeUndefined();
            expect(isValidWorktree(f.destination, f.nestedSource)).toBe(true);
            expect(lstatSync(f.destination).ino).toBe(injection.addedDestinationInode);
            expect(readFileSync(join(f.destination, "operator.txt"), "utf8")).toBe("preserve broken content\n");
            expectBackupPreserved(f);
            expect(existsSync(injection.registrationBackupPath!)).toBe(phase === "before");
        },
    );

    it("keeps the committed replacement and backup when late backup cleanup throws", () => {
        const f = staleCheckout();
        const refusal = new Error("late backup cleanup refused");
        let failure: unknown;
        try {
            fixBrokenWorktree(f.source, f.workspace, "nested", f.branch, true, {
                removeMergedBackup: () => { throw refusal; },
            });
        } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).cause).toBe(refusal);
        expect((failure as Error).message).toContain(refusal.message);
        expect((failure as Error).message).toContain(f.destination);
        expect((failure as Error).message).toContain(injection.backupPath!);
        expect(injection.settlementAttempts).toBe(1);
        expect(injection.compensatedReceipt).toBeUndefined();
        expect(isValidWorktree(f.destination, f.nestedSource)).toBe(true);
        expect(lstatSync(f.destination).ino).toBe(injection.addedDestinationInode);
        expect(readFileSync(join(f.destination, "operator.txt"), "utf8")).toBe("preserve broken content\n");
        expectBackupPreserved(f);
    });
});
