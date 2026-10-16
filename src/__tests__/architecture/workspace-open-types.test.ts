import { describe, expect, it } from "vitest";
import { createWorkspaceOpen } from "../../application/workspace/open.js";
import type { WorkspaceOpenPorts } from "../../ports/workspace/open.js";
import type { WorkspaceOpenOutcome, WorkspaceOpenEvent, WorkspaceOpenConfirmation } from "../../domain/workspace/open.js";

function consumedContracts(ports: WorkspaceOpenPorts) {
    const opened: Promise<WorkspaceOpenOutcome> = createWorkspaceOpen(ports).open("/source", "feature");
    const confirmation: WorkspaceOpenConfirmation = { purpose: "damaged-registration", repairCount: 2 };
    const confirmed: Promise<boolean> = ports.confirm(confirmation);
    const event: WorkspaceOpenEvent = { kind: "existing", path: "/source--feature" };
    ports.report(event);
    // @ts-expect-error semantic confirmations return a boolean, never raw prompt input
    createWorkspaceOpen({ ...ports, confirm: async () => "yes" });
    // @ts-expect-error semantic reporting accepts finite facts, never terminal text
    ports.report("Using existing workspace: /source--feature");
    // @ts-expect-error prompt purposes cannot contain arbitrary terminal questions
    ports.confirm({ purpose: "Recreate now? (y/N) " });
    // @ts-expect-error native recovery failures must be Errors ready to throw
    createWorkspaceOpen({ ...ports, recoveryError: () => "failed recovery" });
    const { family, ...withoutFamily } = ports;
    // @ts-expect-error workspace opening requires its native family critical scope
    createWorkspaceOpen(withoutFamily);
    const { registrationPreflight, ...withoutPreflight } = ports;
    // @ts-expect-error missing registration recovery requires captured native inspection
    createWorkspaceOpen(withoutPreflight);
    const { assertWorkspace, ...withoutFinalGuard } = ports;
    // @ts-expect-error final workspace ownership and readiness validation are required
    createWorkspaceOpen(withoutFinalGuard);
    const { inspectWorkspace, ...withoutInspection } = ports;
    // @ts-expect-error existing content must pass native topology inspection before repair
    createWorkspaceOpen(withoutInspection);
    // @ts-expect-error branch validation must finish before filesystem observations
    createWorkspaceOpen({ ...ports, validateBranch: async () => undefined });
    // @ts-expect-error ownership observations must settle synchronously
    createWorkspaceOpen({ ...ports, assertOwner: async () => undefined });
    // @ts-expect-error captured registration inspection cannot defer its fence
    createWorkspaceOpen({ ...ports, registrationPreflight: async () => null });
    // @ts-expect-error confirmed native registration recovery is synchronous
    createWorkspaceOpen({ ...ports, recoverRegistration: async () => ({ repaired: true }) });
    // @ts-expect-error final native workspace readiness cannot defer settlement
    createWorkspaceOpen({ ...ports, assertWorkspace: async () => undefined });
    // @ts-expect-error existing workspace inspection must finish before content mutation
    createWorkspaceOpen({ ...ports, inspectWorkspace: async () => undefined });
    // @ts-expect-error existing workspace opening does not inspect a shared checked-out branch
    createWorkspaceOpen({ ...ports, actualBranch: () => "feature/other" });
    // @ts-expect-error differing existing branches are not a workspace refusal outcome
    const branchCollision: WorkspaceOpenOutcome = { kind: "refused", reason: "branch-collision", actualBranch: "feature/other", branch: "feature" };
    // @ts-expect-error optional initialization must complete before creation
    createWorkspaceOpen({ ...ports, initSubmodules: async () => undefined });
    // @ts-expect-error reporting is a synchronous presentation effect
    createWorkspaceOpen({ ...ports, report: async () => undefined });
    // @ts-expect-error captured native registration fences are synchronous
    createWorkspaceOpen({ ...ports, registrationPreflight: () => ({ assertUnchanged: async () => undefined }) });
    void [opened, confirmed, family, registrationPreflight, assertWorkspace, inspectWorkspace, branchCollision];
}
void consumedContracts;

describe("workspace opening typed consumer", () => {
    it("returns an invalid-branch refusal after releasing native family authority", async () => {
        const unexpected = (): never => { throw new Error("rejected-branch-must-not-observe-or-mutate-workspace"); };
        const original = new Error("invalid branch");
        let locked = false;
        const ports: WorkspaceOpenPorts = {
            path: () => "/source--invalid", projectId: () => "source-family",
            family: async (_projectId, attempt) => { locked = true; try { return await attempt(); } finally { locked = false; } },
            validateBranch: () => { expect(locked).toBe(true); throw original; },
            exists: unexpected, hasGitMetadata: unexpected, repairRoot: unexpected, assertOwner: unexpected,
            missingRegistration: () => false, registrationPreflight: unexpected, recoverRegistration: unexpected,
            recoveryError: unexpected, inspectWorkspace: unexpected, assertWorkspace: unexpected, repairNested: unexpected,
            broken: unexpected, repairContent: unexpected, submoduleRepos: unexpected, initSubmodules: unexpected,
            create: unexpected, damage: unexpected, repairRegistration: unexpected, confirm: unexpected, report: unexpected,
        };
        const outcome: WorkspaceOpenOutcome = await createWorkspaceOpen(ports).open("/source", "invalid");
        expect(locked).toBe(false);
        expect(outcome).toEqual({ kind: "refused", reason: "invalid-branch", error: original });
    });
});
