import type { WorkspaceBranchValidationPorts } from "../ports/workspace-branch-validation.js";

export function createWorkspaceBranchValidation(ports: WorkspaceBranchValidationPorts) {
    if (typeof ports?.utf8ByteLength !== "function") {
        throw new TypeError("Workspace branch validation requires a callable utf8ByteLength port.");
    }

    function validate(branch: string): string {
        if (!branch || branch.trim() === "") {
            throw new Error("Invalid branch name: cannot be empty");
        }

        // Flag injection prevention
        if (branch.startsWith("-")) {
            throw new Error(
                `Invalid branch name '${branch}': cannot start with '-'`,
            );
        }

        // Path traversal prevention
        if (branch.includes("..")) {
            throw new Error(
                `Invalid branch name '${branch}': cannot contain '..'`,
            );
        }

        // git-check-ref-format forbidden characters:
        // control chars, space, ~, ^, :, ?, *, [, \, DEL
        // Also reject @{ (git refspec syntax)
        const invalidChars = /[\x00-\x1f\x7f ~^:?*[\]\\]/;
        if (invalidChars.test(branch)) {
            throw new Error(
                `Invalid branch name '${branch}': contains forbidden characters`,
            );
        }

        if (branch.includes("@{")) {
            throw new Error(
                `Invalid branch name '${branch}': cannot contain '@{'`,
            );
        }

        // Cannot start or end with slash, or contain consecutive slashes
        if (branch.startsWith("/") || branch.endsWith("/")) {
            throw new Error(
                `Invalid branch name '${branch}': cannot start or end with '/'`,
            );
        }

        if (branch.includes("//")) {
            throw new Error(
                `Invalid branch name '${branch}': cannot contain consecutive slashes`,
            );
        }

        // Cannot end with .lock
        if (branch.endsWith(".lock")) {
            throw new Error(
                `Invalid branch name '${branch}': cannot end with '.lock'`,
            );
        }

        // Cannot end with dot
        if (branch.endsWith(".")) {
            throw new Error(
                `Invalid branch name '${branch}': cannot end with '.'`,
            );
        }

        // Length limit
        if (ports.utf8ByteLength(branch) > 255) {
            throw new Error(
                `Invalid branch name: too long (max 255 bytes)`,
            );
        }

        return branch;
    }

    return validate;
}
