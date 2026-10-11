import { describe, expect, it } from "vitest";
import { createWorkspaceOpen } from "../../application/workspace/open.js";
import type { WorkspaceOpenPorts } from "../../ports/workspace/open.js";
import type { WorkspaceRegistrationRepair } from "../../domain/workspace/open.js";

const SOURCE = "/source";
const WORKSPACE = "/source--feature";
const BRANCH = "feature";
class RequestedExit extends Error {
    constructor(readonly code: number) { super(`exit ${code}`); }
}

function fixture() {
    const state = { locked: false, scopeEntries: 0, finalGuard: false, reports: [] as string[], errors: [] as string[] };
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
        recoverRegistration: () => { throw new Error("unexpected-registration-recovery"); }, safeLiteral: (text) => text,
        assertBranch: (_path, _branch, _cwd, allowTrackedGitlinks) => { held(); state.finalGuard = allowTrackedGitlinks; return undefined; },
        actualBranch: () => BRANCH, repairNested: () => [], broken: () => [],
        repairContent: async () => { throw new Error("unexpected-content-repair"); }, submoduleRepos: () => null,
        initSubmodules: () => { throw new Error("unexpected-submodule-initialization"); },
        create: () => ({ workspacePath: WORKSPACE, created: [], copied: [] }), damage: () => null,
        repairRegistration: () => { throw new Error("unexpected-metadata-repair"); },
        prompt: async () => { throw new Error("unexpected-opening-prompt"); },
        report: (message) => { state.reports.push(message); return undefined; },
        reportError: (message) => { state.errors.push(message); return undefined; },
        exit: (code) => { throw new RequestedExit(code); },
    };
    return { ports, state, held, open: () => createWorkspaceOpen(ports).open(SOURCE, BRANCH) };
}

describe("workspace opening policy", () => {
    it("rethrows the missing-registration diagnosis when recovery is declined", async () => {
        const f = fixture();
        const original = new Error("root registration missing");
        f.ports.assertOwner = () => { f.held(); throw original; };
        f.ports.missingRegistration = (error) => error === original;
        f.ports.registrationPreflight = () => ({ assertUnchanged: () => undefined });
        f.ports.prompt = async () => { f.held(); return "n"; };
        await expect(f.open()).rejects.toBe(original);
        expect(f.state.locked).toBe(false);
        expect(f.state.errors).toContain(original.message);
    });

    it("hands the captured registration fence to recovery and reasserts repaired ownership", async () => {
        const f = fixture();
        const original = new Error("root registration missing");
        let repaired = false;
        let fencePassed = false;
        f.ports.assertOwner = () => { f.held(); if (!repaired) throw original; return undefined; };
        f.ports.missingRegistration = (error) => error === original;
        f.ports.registrationPreflight = () => ({ assertUnchanged: () => { f.held(); fencePassed = true; return undefined; } });
        f.ports.prompt = async () => { f.held(); return "yes"; };
        f.ports.recoverRegistration = (_path, _cwd, _branch, preflight) => {
            f.held();
            if (!preflight.assertUnchanged) throw new Error("captured-registration-fence-required");
            preflight.assertUnchanged();
            repaired = fencePassed;
            return { repaired };
        };
        await expect(f.open()).resolves.toBe(WORKSPACE);
        expect(repaired).toBe(true);
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
        f.ports.prompt = async () => { changed = true; return "y"; };
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
        await expect(f.open()).rejects.toMatchObject({ code: 1 });
        expect(f.state.errors).toContain("Error: Workspace exists for branch 'feature/other', not 'feature'.");
        expect(f.state.finalGuard).toBe(false);
    });

    it("reports failed optional initialization and exits before creating a workspace", async () => {
        const f = fixture();
        f.ports.exists = () => false;
        f.ports.submoduleRepos = () => ["child"];
        f.ports.prompt = async () => { f.held(); return "y"; };
        f.ports.initSubmodules = () => { throw new Error("submodule initialization failed"); };
        f.ports.create = () => { throw new Error("failed-init-must-not-create"); };
        await expect(f.open()).rejects.toMatchObject({ code: 1 });
        expect(f.state.errors).toContain("Error: submodule initialization failed");
        expect(f.state.reports).not.toContain(`Workspace created: ${WORKSPACE}`);
    });

    it("reports a failed workspace creation without running the final guard", async () => {
        const f = fixture();
        f.ports.exists = () => false;
        f.ports.create = () => { f.held(); throw new Error("workspace creation failed"); };
        await expect(f.open()).rejects.toMatchObject({ code: 1 });
        expect(f.state.errors).toContain("Error: workspace creation failed");
        expect(f.state.finalGuard).toBe(false);
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
        f.ports.prompt = async () => { f.held(); return "n"; };
        await expect(f.open()).resolves.toBe(WORKSPACE);
        expect(f.state.finalGuard).toBe(true);
        expect(f.state.reports).toContain("  child: has content but is not a valid worktree");
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
        f.ports.prompt = async () => { expect(f.state.locked).toBe(false); return "n"; };
        await expect(f.open()).rejects.toBe(original);
        expect(f.state.scopeEntries).toBe(1);
        expect(f.state.locked).toBe(false);
    });

    it("keeps the original damage when every native registration repair fails", async () => {
        const f = fixture();
        const original = new Error("damaged metadata");
        f.ports.assertOwner = () => { throw original; };
        f.ports.damage = (error) => error === original ? { message: original.message, repairs: [repair] } : null;
        f.ports.prompt = async () => { expect(f.state.locked).toBe(false); return "y"; };
        f.ports.repairRegistration = () => { expect(f.state.locked).toBe(false); return { ok: false, detail: "native repair refused" }; };
        await expect(f.open()).rejects.toBe(original);
        expect(f.state.scopeEntries).toBe(1);
        expect(f.state.errors.some((message) => message.includes("native repair refused"))).toBe(true);
    });

    it("reacquires the same family guard once after partial repair success", async () => {
        const f = fixture();
        const original = new Error("damaged metadata");
        const otherRepair = { checkoutPath: "/checkout/other", sourcePath: "/source/other" };
        let repaired = false;
        f.ports.assertOwner = () => { f.held(); if (!repaired) throw original; return undefined; };
        f.ports.damage = (error) => error === original ? { message: original.message, repairs: [repair, otherRepair] } : null;
        f.ports.prompt = async () => { expect(f.state.locked).toBe(false); return "yes"; };
        f.ports.repairRegistration = (candidate) => {
            expect(f.state.locked).toBe(false);
            if (candidate.checkoutPath === repair.checkoutPath) { repaired = true; return { ok: true, detail: "" }; }
            return { ok: false, detail: "other checkout still damaged" };
        };
        await expect(f.open()).resolves.toBe(WORKSPACE);
        expect(f.state.scopeEntries).toBe(2);
        expect(f.state.locked).toBe(false);
        expect(f.state.finalGuard).toBe(true);
        expect(f.state.errors.some((message) => message.includes("other checkout still damaged"))).toBe(true);
    });

    it("propagates a failed retry without offering another repair cycle", async () => {
        const f = fixture();
        const original = new Error("initial damage");
        const retryFailure = new Error("retry damage");
        let repaired = false;
        f.ports.assertOwner = () => { f.held(); throw repaired ? retryFailure : original; };
        f.ports.damage = (error) => error === original || error === retryFailure
            ? { message: error === original ? original.message : retryFailure.message, repairs: [repair] } : null;
        f.ports.prompt = async () => { if (repaired) throw new Error("retry-must-not-prompt-again"); return "y"; };
        f.ports.repairRegistration = () => { expect(f.state.locked).toBe(false); repaired = true; return { ok: true, detail: "" }; };
        await expect(f.open()).rejects.toBe(retryFailure);
        expect(f.state.scopeEntries).toBe(2);
        expect(f.state.locked).toBe(false);
    });
});
