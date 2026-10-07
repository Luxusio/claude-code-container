import { expect, it } from "vitest";
import { WORKTREE_SEPARATOR, formatWorkspaceSiblingBasename, iterateWorkspaceSourceBasenames } from "../../domain/workspace-naming.js";
import { WORKTREE_SEPARATOR as facadeSeparator, getWorkspacePath } from "../../worktree.js";

function contracts() {
    const literal: "--" = WORKTREE_SEPARATOR;
    const publicLiteral: "--" = facadeSeparator;
    const formatted: string = formatWorkspaceSiblingBasename("repo", "branch");
    const iterator: Generator<string, void, unknown> = iterateWorkspaceSourceBasenames("repo--branch");
    const nativePath: string = getWorkspacePath("repo", "branch");
    // @ts-expect-error Source basename is required.
    formatWorkspaceSiblingBasename();
    // @ts-expect-error Branch is required.
    formatWorkspaceSiblingBasename("repo");
    // @ts-expect-error No numeric source coercion contract.
    formatWorkspaceSiblingBasename(1, "branch");
    // @ts-expect-error No numeric branch coercion contract.
    formatWorkspaceSiblingBasename("repo", 1);
    // @ts-expect-error Iterator requires a string basename.
    iterateWorkspaceSourceBasenames(1);
    // @ts-expect-error Iterator requires an argument.
    iterateWorkspaceSourceBasenames();
    // @ts-expect-error Candidate traversal is lazy, not an array.
    const eager: string[] = iterateWorkspaceSourceBasenames("repo--branch");
    // @ts-expect-error Separator's literal type is preserved.
    const changed: "-" = facadeSeparator;
    void [literal, publicLiteral, formatted, iterator, nativePath, eager, changed];
}
void contracts;
it("preserves the existing public literal separator", () => expect(facadeSeparator).toBe(WORKTREE_SEPARATOR));
