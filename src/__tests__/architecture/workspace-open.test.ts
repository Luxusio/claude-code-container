import { describe, expect, it } from "vitest";
import { createWorkspaceOpen } from "../../application/workspace/open.js";
import type { WorkspaceOpenPorts } from "../../ports/workspace/open.js";
import type { WorkspaceRegistrationRepair, WorkspaceOpenEvent } from "../../domain/workspace/open.js";
import { createWorkspaceOpenPresentation } from "../../adapters/workspace/open-presentation.js";

const SOURCE = "/source";
const WORKSPACE = "/source--feature";
const BRANCH = "feature";
function fixture() {
    const state = { locked: false, scopeEntries: 0, finalGuard: false, reports: [] as WorkspaceOpenEvent[] };
    const held = () => { expect(state.locked, "opening native authority requires the family guard").toBe(true); };
    const ports: WorkspaceOpenPorts = {
        path: () => WORKSPACE, projectId: () => "source-family",
        async family(projectId, attempt) {
            expect(projectId).toBe("source-family");
            expect(state.locked).toBe(false);
            state.scopeEntries++;
            if (state.scopeEntries > 2) throw new Error("workspace-open-retried-more-than-once");
            state.locked = true;
            try { return await attempt(); } finally { state.locked = false; }
        },
        validateBranch: () => { held(); return undefined; }, exists: () => true, hasGitMetadata: () => true,
        repairRoot: () => { held(); return undefined; }, assertOwner: () => { held(); return undefined; },
        missingRegistration: () => false, registrationPreflight: () => null,
        recoverRegistration: () => { throw new Error("unexpected-registration-recovery"); },
        recoveryError: createWorkspaceOpenPresentation({ prompt: async () => "n", report: () => undefined, reportError: () => undefined, safeLiteral: text => text }).recoveryError,
        assertBranch: (_path, _branch, _cwd, allowTrackedGitlinks) => { held(); state.finalGuard = allowTrackedGitlinks; return undefined; },
        actualBranch: () => BRANCH, repairNested: () => [], broken: () => [],
        repairContent: async () => { throw new Error("unexpected-content-repair"); }, submoduleRepos: () => null,
        initSubmodules: () => { throw new Error("unexpected-submodule-initialization"); },
        create: () => ({ workspacePath: WORKSPACE, created: [], copied: [] }), damage: () => null,
        repairRegistration: () => { throw new Error("unexpected-metadata-repair"); },
        confirm: async () => { throw new Error("unexpected-opening-prompt"); },
        report: (event) => { state.reports.push(event); return undefined; },
    };
    return { ports, state, held, open: () => createWorkspaceOpen(ports).open(SOURCE, BRANCH) };
}

describe("workspace opening policy", () => {
    it("qualifies metadata-free source ownership before discovery and allows tracked Gitlinks only at the final guard", async () => {
        const f = fixture();
        f.ports.hasGitMetadata = () => false;
        let admissionChecked = false;
        let finalChecked = false;
        f.ports.assertBranch = (path, branch, cwd, allowTrackedGitlinks) => {
            f.held(); expect([path, branch, cwd]).toEqual([WORKSPACE, BRANCH, SOURCE]);
            if (!admissionChecked) { expect(allowTrackedGitlinks).toBe(false); admissionChecked = true; }
            else { expect(allowTrackedGitlinks).toBe(true); finalChecked = true; }
            return undefined;
        };
        f.ports.actualBranch = () => { expect(admissionChecked).toBe(true); return BRANCH; };
        await expect(f.open()).resolves.toEqual({ kind: "opened", path: WORKSPACE });
        expect(finalChecked).toBe(true);
    });

    it("keeps the original owner diagnosis when recovery has no preflight", async () => {
        const f = fixture();
        const original = new Error("missing root registration");
        f.ports.assertOwner = () => { throw original; };
        f.ports.missingRegistration = error => error === original;
        await expect(f.open()).rejects.toBe(original);
        expect(f.state.locked).toBe(false);
        expect(f.state.finalGuard).toBe(false);
        expect(f.state.reports.some(event => event.kind === "existing")).toBe(false);
    });

    it("checks repaired root ownership before observing or mutating nested content", async () => {
        const f = fixture();
        let rootRepaired = false;
        const original = new Error("foreign root owner");
        f.ports.repairRoot = () => { f.held(); rootRepaired = true; return undefined; };
        f.ports.assertOwner = () => { expect(rootRepaired).toBe(true); throw original; };
        f.ports.actualBranch = () => { throw new Error("foreign-owner-must-not-observe-content"); };
        await expect(f.open()).rejects.toBe(original);
        expect(f.state.finalGuard).toBe(false);
    });

    it("repairs broken content only after confirmation while retaining family authority", async () => {
        const f = fixture();
        let confirmed = false;
        let repaired = false;
        f.ports.broken = () => [{ name: "child" }];
        f.ports.confirm = async request => { f.held(); expect(request).toEqual({ purpose: "broken-content" }); confirmed = true; return true; };
        f.ports.repairContent = async (cwd, path, name, branch) => {
            f.held(); expect(confirmed).toBe(true);
            expect([cwd, path, name, branch]).toEqual([SOURCE, WORKSPACE, "child", BRANCH]);
            repaired = true;
        };
        f.ports.assertBranch = (path, branch, cwd, allowTrackedGitlinks) => {
            f.held(); expect(repaired).toBe(true);
            expect([path, branch, cwd, allowTrackedGitlinks]).toEqual([WORKSPACE, BRANCH, SOURCE, true]);
            return undefined;
        };
        await expect(f.open()).resolves.toEqual({ kind: "opened", path: WORKSPACE });
    });

    it("creates after declined optional submodule setup and qualifies the actual workspace", async () => {
        const f = fixture();
        f.ports.exists = () => false;
        f.ports.submoduleRepos = () => ["child"];
        f.ports.confirm = async () => { f.held(); return false; };
        await expect(f.open()).resolves.toEqual({ kind: "opened", path: WORKSPACE });
        expect(f.state.finalGuard).toBe(true);
        expect(f.state.reports).toContainEqual({ kind: "created", result: { workspacePath: WORKSPACE, created: [], copied: [] } });
    });

    it("rethrows the missing-registration diagnosis when recovery is declined", async () => {
        const f = fixture();
        const original = new Error("root registration missing");
        f.ports.assertOwner = () => { f.held(); throw original; };
        f.ports.missingRegistration = (error) => error === original;
        f.ports.registrationPreflight = () => ({ assertUnchanged: () => undefined });
        f.ports.confirm = async request => { f.held(); expect(request).toEqual({ purpose: "missing-registration" }); return false; };
        await expect(f.open()).rejects.toBe(original);
        expect(f.state.locked).toBe(false);
        expect(f.state.reports).toContainEqual({ kind: "missing-registration", error: original });
    });

    it("hands the captured registration fence to recovery and reasserts repaired ownership", async () => {
        const f = fixture();
        const original = new Error("root registration missing");
        let repaired = false;
        let fencePassed = false;
        let repairedOwnershipChecked = false;
        f.ports.assertOwner = () => { f.held(); if (!repaired) throw original; repairedOwnershipChecked = true; return undefined; };
        f.ports.actualBranch = () => { expect(repairedOwnershipChecked).toBe(true); return BRANCH; };
        f.ports.missingRegistration = (error) => error === original;
        f.ports.registrationPreflight = () => ({ assertUnchanged: () => { f.held(); fencePassed = true; return undefined; } });
        f.ports.confirm = async () => { f.held(); return true; };
        f.ports.recoverRegistration = (_path, _cwd, _branch, preflight) => {
            f.held();
            if (!preflight.assertUnchanged) throw new Error("captured-registration-fence-required");
            preflight.assertUnchanged();
            repaired = fencePassed;
            return { repaired };
        };
        await expect(f.open()).resolves.toEqual({ kind: "opened", path: WORKSPACE });
        expect(repaired).toBe(true);
        expect(repairedOwnershipChecked).toBe(true);
        expect(f.state.finalGuard).toBe(true);
        expect(f.state.locked).toBe(false);
    });

    it("refuses recovery when the captured registration observation changes", async () => {
        const f = fixture();
        const original = new Error("root registration missing");
        let changed = false;
        let published = false;
        f.ports.assertOwner = () => { throw original; };
        f.ports.missingRegistration = (error) => error === original;
        f.ports.registrationPreflight = () => ({ assertUnchanged: () => {
            if (changed) throw new Error("registration changed after inspection");
            return undefined;
        } });
        f.ports.confirm = async () => { f.held(); changed = true; return true; };
        f.ports.recoverRegistration = (_path, _cwd, _branch, preflight) => {
            try { preflight.assertUnchanged?.(); }
            catch { return { repaired: false, failure: "registration changed after inspection" }; }
            published = true;
            return { repaired: true };
        };
        await expect(f.open()).rejects.toThrow("Reason: registration changed after inspection");
        expect(published).toBe(false);
        expect(f.state.locked).toBe(false);
    });

    it("refuses a different branch at the selected workspace path before nested repair", async () => {
        const f = fixture();
        f.ports.actualBranch = () => "feature/other";
        f.ports.repairNested = () => { throw new Error("collision-must-not-repair-content"); };
        f.ports.broken = () => { throw new Error("collision-must-not-observe-content"); };
        await expect(f.open()).resolves.toEqual({ kind: "refused", reason: "branch-collision", actualBranch: "feature/other", branch: BRANCH });
        expect(f.state.locked).toBe(false);
        expect(f.state.finalGuard).toBe(false);
    });

    it("returns failed optional initialization before creating a workspace", async () => {
        const f = fixture();
        f.ports.exists = () => false;
        f.ports.submoduleRepos = () => ["child"];
        f.ports.confirm = async request => { f.held(); expect(request).toEqual({ purpose: "initialize-submodules" }); return true; };
        const original = new Error("submodule initialization failed");
        f.ports.initSubmodules = () => { throw original; };
        f.ports.create = () => { throw new Error("failed-init-must-not-create"); };
        await expect(f.open()).resolves.toEqual({ kind: "refused", reason: "submodule-initialization-failed", error: original });
        expect(f.state.reports.some(event => event.kind === "created")).toBe(false);
        expect(f.state.reports.some(event => event.kind === "creating")).toBe(false);
        expect(f.state.finalGuard).toBe(false);
        expect(f.state.locked).toBe(false);
    });

    it("returns a failed workspace creation without running the final guard", async () => {
        const f = fixture();
        f.ports.exists = () => false;
        const original = new Error("workspace creation failed");
        f.ports.create = () => { f.held(); throw original; };
        await expect(f.open()).resolves.toEqual({ kind: "refused", reason: "creation-failed", error: original });
        expect(f.state.locked).toBe(false);
        expect(f.state.finalGuard).toBe(false);
        expect(f.state.reports.some(event => event.kind === "created")).toBe(false);
    });

    it("propagates the final branch guard's refusal instead of opening changed content", async () => {
        const f = fixture();
        const original = new Error("workspace branch changed");
        f.ports.assertBranch = () => { f.held(); throw original; };
        await expect(f.open()).rejects.toBe(original);
        expect(f.state.locked).toBe(false);
    });

    it("opens declined broken content only after the qualified final branch guard", async () => {
        const f = fixture();
        f.ports.broken = () => [{ name: "child" }];
        f.ports.confirm = async request => { f.held(); expect(request).toEqual({ purpose: "broken-content" }); return false; };
        await expect(f.open()).resolves.toEqual({ kind: "opened", path: WORKSPACE });
        expect(f.state.finalGuard).toBe(true);
        expect(f.state.reports).toContainEqual({ kind: "broken-content", entries: [{ name: "child" }] });
    });
});

function presentationFixture(answer = "n") {
    const output: string[] = [];
    const errors: string[] = [];
    const questions: string[] = [];
    const sanitized: string[] = [];
    const presentation = createWorkspaceOpenPresentation({
        prompt: async question => { questions.push(question); return answer; },
        report: message => { output.push(message); return undefined; },
        reportError: message => { errors.push(message); return undefined; },
        safeLiteral: text => { sanitized.push(text); return text.replace(/\u001b/g, "<ESC>"); },
    });
    return { presentation, output, errors, questions, sanitized };
}

describe("native workspace opening presentation", () => {
    it.each(["y", "yes", "n", "Y", "YES", " yes", "yes ", ""])("decodes confirmation %j with the existing exact answer policy", async answer => {
        const f = presentationFixture(answer);
        await expect(f.presentation.confirm({ purpose: "missing-registration" })).resolves.toBe(answer === "y" || answer === "yes");
        expect(f.questions).toEqual(["Recreate the missing Git worktree registration now? (y/N) "]);
    });

    it("renders each ordinary confirmation and singular/plural damaged registration prompt", async () => {
        const f = presentationFixture();
        await f.presentation.confirm({ purpose: "broken-content" });
        await f.presentation.confirm({ purpose: "initialize-submodules" });
        await f.presentation.confirm({ purpose: "damaged-registration", repairCount: 1 });
        await f.presentation.confirm({ purpose: "damaged-registration", repairCount: 2 });
        expect(f.questions).toEqual([
            "Stash content and recreate as proper worktrees? (y/N) ",
            "Initialize as git repo and add them as submodules? (y/N) ",
            "Run this now? (y/N) ", "Run these now? (y/N) ",
        ]);
    });

    it("renders existing, repaired, broken and newly created workspaces with exact current messages", () => {
        const f = presentationFixture();
        f.presentation.report({ kind: "registration-recreated", path: WORKSPACE });
        f.presentation.report({ kind: "existing", path: WORKSPACE });
        f.presentation.report({ kind: "nested-repaired", repo: { name: "nested", branch: BRANCH, action: "worktree-existing" } });
        f.presentation.report({ kind: "broken-content", entries: [{ name: "broken" }] });
        f.presentation.report({ kind: "submodule-candidates", repos: ["one", "two"] });
        f.presentation.report({ kind: "submodules-initialized" });
        f.presentation.report({ kind: "creating", branch: BRANCH });
        f.presentation.report({ kind: "created", result: {
            workspacePath: WORKSPACE,
            created: [{ name: "old", branch: BRANCH, action: "worktree-existing" }, { name: "remote", branch: BRANCH, action: "worktree-remote" }, { name: "new", branch: BRANCH, action: "worktree-new" }], copied: ["plain"],
        } });
        expect(f.output).toEqual([
            `Recreated Git worktree registration: ${WORKSPACE}`, `Using existing workspace: ${WORKSPACE}`,
            "  nested: worktree (repaired)", "Found 1 broken worktree(s):", "  broken: has content but is not a valid worktree",
            "This directory is not a git repository.", "Found git repos: one, two", "Initialized git repo with submodules.",
            "Creating workspace for branch 'feature'...", `Workspace created: ${WORKSPACE}`,
            "  old: worktree (existing branch)", "  remote: worktree (from remote)", "  new: worktree (new branch)", "  plain: copied",
        ]);
        expect(f.errors).toEqual([]);
    });

    it("renders missing/damaged registrations and individual repair success/failure", () => {
        const f = presentationFixture();
        f.presentation.report({ kind: "missing-registration", error: new Error("missing registration") });
        f.presentation.report({ kind: "damaged-registration", damage: { message: "damaged metadata", repairs: [repair] } });
        f.presentation.report({ kind: "registration-repair", repair, outcome: { ok: true, detail: "" } });
        f.presentation.report({ kind: "registration-repair", repair, outcome: { ok: false, detail: "native refusal" } });
        f.presentation.report({ kind: "registration-repair", repair, outcome: { ok: false, detail: "" } });
        expect(f.errors).toEqual(["missing registration", "", "damaged metadata", "", "  git worktree repair /checkout/child", "    in /source/child", "  repaired /checkout/child", "  could not repair /checkout/child: native refusal", "  could not repair /checkout/child"]);
        expect(f.output).toEqual([]);
    });

    it("renders terminal refusals without adding output effects", () => {
        const f = presentationFixture();
        f.presentation.refusal({ kind: "refused", reason: "branch-collision", actualBranch: "feature/other", branch: BRANCH });
        for (const reason of ["invalid-branch", "submodule-initialization-failed", "creation-failed"] as const) {
            f.presentation.refusal({ kind: "refused", reason, error: new Error(reason) });
        }
        expect(f.errors).toEqual([
            "Error: Workspace exists for branch 'feature/other', not 'feature'.",
            "Different branches map to the same directory due to '/' → '-' conversion.",
            "Error: invalid-branch", "Error: submodule-initialization-failed", "Error: creation-failed",
        ]);
        expect(f.output).toEqual([]);
    });

    it("constructs recovery errors with bounded safe detail and the exact absent-detail fallback", () => {
        const f = presentationFixture();
        const detail = "\u001b" + "x".repeat(600);
        const error = f.presentation.recoveryError(WORKSPACE, detail);
        expect(error).toBeInstanceOf(Error);
        expect(f.sanitized).toEqual([detail.slice(0, 500)]);
        expect(error.message).toBe(`Could not recreate the missing Git worktree registration for '${WORKSPACE}'. Workspace files were left unchanged. Reason: <ESC>${"x".repeat(499)}`);
        for (const failure of [undefined, ""]) {
            expect(f.presentation.recoveryError(WORKSPACE, failure).message).toBe(`Could not recreate the missing Git worktree registration for '${WORKSPACE}'. Workspace files were left unchanged. Reason: Git registration conditions changed during recovery.`);
        }
        expect(f.output).toEqual([]);
        expect(f.errors).toEqual([]);
    });
});

const repair: WorkspaceRegistrationRepair = { checkoutPath: "/checkout/child", sourcePath: "/source/child" };
describe("damaged workspace metadata recovery", () => {
    it("rethrows damage without repairs instead of prompting or retrying", async () => {
        const f = fixture();
        const original = new Error("damaged metadata");
        f.ports.assertOwner = () => { throw original; };
        f.ports.damage = (error) => error === original ? { message: original.message, repairs: [] } : null;
        await expect(f.open()).rejects.toBe(original);
        expect(f.state.scopeEntries).toBe(1);
    });

    it("releases the family guard before a declined damaged-registration prompt", async () => {
        const f = fixture();
        const original = new Error("damaged metadata");
        f.ports.assertOwner = () => { f.held(); throw original; };
        f.ports.damage = (error) => error === original ? { message: original.message, repairs: [repair] } : null;
        f.ports.confirm = async request => { expect(f.state.locked).toBe(false); expect(request).toEqual({ purpose: "damaged-registration", repairCount: 1 }); return false; };
        await expect(f.open()).rejects.toBe(original);
        expect(f.state.scopeEntries).toBe(1);
        expect(f.state.locked).toBe(false);
    });

    it("keeps the original damage when every native registration repair fails", async () => {
        const f = fixture();
        const original = new Error("damaged metadata");
        f.ports.assertOwner = () => { throw original; };
        f.ports.damage = (error) => error === original ? { message: original.message, repairs: [repair] } : null;
        f.ports.confirm = async () => { expect(f.state.locked).toBe(false); return true; };
        f.ports.repairRegistration = () => { expect(f.state.locked).toBe(false); return { ok: false, detail: "native repair refused" }; };
        await expect(f.open()).rejects.toBe(original);
        expect(f.state.scopeEntries).toBe(1);
        expect(f.state.reports).toContainEqual({ kind: "registration-repair", repair, outcome: { ok: false, detail: "native repair refused" } });
    });

    it("reacquires the same family guard once after partial repair success", async () => {
        const f = fixture();
        const original = new Error("damaged metadata");
        const otherRepair = { checkoutPath: "/checkout/other", sourcePath: "/source/other" };
        let repaired = false;
        f.ports.assertOwner = () => { f.held(); if (!repaired) throw original; return undefined; };
        f.ports.damage = (error) => error === original ? { message: original.message, repairs: [repair, otherRepair] } : null;
        f.ports.confirm = async () => { expect(f.state.locked).toBe(false); return true; };
        f.ports.repairRegistration = (candidate) => {
            expect(f.state.locked).toBe(false);
            if (candidate.checkoutPath === repair.checkoutPath) { repaired = true; return { ok: true, detail: "" }; }
            return { ok: false, detail: "other checkout still damaged" };
        };
        await expect(f.open()).resolves.toEqual({ kind: "opened", path: WORKSPACE });
        expect(f.state.scopeEntries).toBe(2);
        expect(f.state.locked).toBe(false);
        expect(f.state.finalGuard).toBe(true);
        expect(f.state.reports).toContainEqual({ kind: "registration-repair", repair: otherRepair, outcome: { ok: false, detail: "other checkout still damaged" } });
    });

    it("propagates a failed retry without offering another repair cycle", async () => {
        const f = fixture();
        const original = new Error("initial damage");
        const retryFailure = new Error("retry damage");
        let repaired = false;
        f.ports.assertOwner = () => { f.held(); throw repaired ? retryFailure : original; };
        f.ports.damage = (error) => error === original || error === retryFailure
            ? { message: error === original ? original.message : retryFailure.message, repairs: [repair] } : null;
        f.ports.confirm = async () => { if (repaired) throw new Error("retry-must-not-prompt-again"); return true; };
        f.ports.repairRegistration = () => { expect(f.state.locked).toBe(false); repaired = true; return { ok: true, detail: "" }; };
        await expect(f.open()).rejects.toBe(retryFailure);
        expect(f.state.scopeEntries).toBe(2);
        expect(f.state.locked).toBe(false);
    });
});
