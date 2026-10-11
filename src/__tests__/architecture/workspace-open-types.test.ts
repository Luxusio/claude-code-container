import { describe, expect, it } from "vitest";
import { createWorkspaceOpen } from "../../application/workspace/open.js";
import type { WorkspaceOpenPorts } from "../../ports/workspace/open.js";

function consumedContracts(ports: WorkspaceOpenPorts) {
    const opened: Promise<string> = createWorkspaceOpen(ports).open("/source", "feature");
    const { family, ...withoutFamily } = ports;
    // @ts-expect-error workspace opening requires its native family critical scope
    createWorkspaceOpen(withoutFamily);
    const { registrationPreflight, ...withoutPreflight } = ports;
    // @ts-expect-error missing registration recovery requires captured native inspection
    createWorkspaceOpen(withoutPreflight);
    const { assertBranch, ...withoutFinalGuard } = ports;
    // @ts-expect-error final workspace ownership and branch validation are required
    createWorkspaceOpen(withoutFinalGuard);
    // @ts-expect-error branch validation must finish before filesystem observations
    createWorkspaceOpen({ ...ports, validateBranch: async () => undefined });
    // @ts-expect-error ownership observations must settle synchronously
    createWorkspaceOpen({ ...ports, assertOwner: async () => undefined });
    // @ts-expect-error captured registration inspection cannot defer its fence
    createWorkspaceOpen({ ...ports, registrationPreflight: async () => null });
    // @ts-expect-error confirmed native registration recovery is synchronous
    createWorkspaceOpen({ ...ports, recoverRegistration: async () => ({ repaired: true }) });
    // @ts-expect-error final native branch guard cannot defer settlement
    createWorkspaceOpen({ ...ports, assertBranch: async () => undefined });
    // @ts-expect-error optional initialization must complete before creation
    createWorkspaceOpen({ ...ports, initSubmodules: async () => undefined });
    // @ts-expect-error reporting is a synchronous presentation effect
    createWorkspaceOpen({ ...ports, report: async () => undefined });
    // @ts-expect-error captured native registration fences are synchronous
    createWorkspaceOpen({ ...ports, registrationPreflight: () => ({ assertUnchanged: async () => undefined }) });
    void [opened, family, registrationPreflight, assertBranch];
}
void consumedContracts;

describe("workspace opening typed consumer", () => {
    it("stops before filesystem discovery when native branch admission fails", async () => {
        const messages: string[] = [];
        const unexpected = (): never => { throw new Error("rejected-branch-must-not-observe-or-mutate-workspace"); };
        const exit = new Error("requested exit");
        const ports: WorkspaceOpenPorts = {
            path: () => "/source--invalid", projectId: () => "source-family",
            family: async (_projectId, attempt) => attempt(),
            validateBranch: () => { throw new Error("invalid branch"); },
            exists: unexpected, hasGitMetadata: unexpected, repairRoot: unexpected, assertOwner: unexpected,
            missingRegistration: () => false, registrationPreflight: unexpected, recoverRegistration: unexpected,
            safeLiteral: (text) => text, assertBranch: unexpected, actualBranch: unexpected, repairNested: unexpected,
            broken: unexpected, repairContent: unexpected, submoduleRepos: unexpected, initSubmodules: unexpected,
            create: unexpected, damage: () => null, repairRegistration: unexpected, prompt: unexpected,
            report: unexpected, reportError: (message) => { messages.push(message); return undefined; },
            exit: (code) => { expect(code).toBe(1); throw exit; },
        };
        const opened: Promise<string> = createWorkspaceOpen(ports).open("/source", "invalid");
        await expect(opened).rejects.toBe(exit);
        expect(messages).toEqual(["Error: invalid branch"]);
    });
});
