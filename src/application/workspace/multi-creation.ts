import { createWorktreeAddition } from "./worktree-addition.js";
import type { WorktreeRepoResult, WorktreeResult } from "../../domain/workspace/creation-result.js";
import type { MultiCreationPorts, MultiCreationRequest } from "../../ports/workspace/multi-creation.js";

export type { WorkspaceEntry } from "../../domain/workspace/source-entry.js";
export type { WorktreeCreationAction, WorktreeRepoResult, WorktreeResult } from "../../domain/workspace/creation-result.js";
export type { MultiCreationPorts, MultiCreationRequest } from "../../ports/workspace/multi-creation.js";

export function createMultiWorkspaceCreation<Prepared, Registration extends object | symbol, WorkspaceIdentity, CopiedIdentity extends object | symbol>(
    ports: MultiCreationPorts<Prepared, Registration, WorkspaceIdentity, CopiedIdentity>,
): (request: MultiCreationRequest) => WorktreeResult {
    for (const name of [
        "scanSource", "destinationPath", "ensureWorkspaceParent", "createWorkspaceExclusive",
        "captureWorkspaceIdentity", "requireRegistration", "pathExists", "worktreeMatches",
        "removeRegisteredWorktree", "rollbackCreatedBranch", "assertWorkspaceIdentity",
        "workspaceEntryCount", "quarantineWorkspace", "copyEntry", "captureCopiedIdentity",
        "quarantineCopiedEntry",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Multi workspace creation requires a callable ${name} port.`);
        }
    }
    const addWorktree = createWorktreeAddition(ports);

    return (request) => {
        const entries = ports.scanSource(request);
        const gitRepos = entries.filter((e) => e.isGitRepo);

        if (gitRepos.length === 0) {
            throw new Error(
                "No git repositories found in current directory. Nothing to create worktrees for.",
            );
        }

        // Atomic create: ensure parent exists, then non-recursive mkdir
        ports.ensureWorkspaceParent(request);
        try {
            ports.createWorkspaceExclusive(request);
        } catch (e) {
            if ((e as { code?: string }).code === "EEXIST") {
                throw new Error(
                    `Workspace already exists or is being created by another process: ${request.destinationPath}`,
                );
            }
            throw e;
        }
        const workspaceIdentity = ports.captureWorkspaceIdentity(request);

        const created: WorktreeRepoResult[] = [];
        const preparedAdditions = new Map<string, Prepared>();
        const registrationFences = new Map<string, Registration>();
        const copied: string[] = [];
        const copiedIdentities = new Map<string, CopiedIdentity>();

        // Process git repos → worktree (with rollback on failure)
        try {
            for (const repo of gitRepos) {
                const destPath = ports.destinationPath(request, repo.name);
                const { action, prepared, registrationReceipt: registrationFence } = addWorktree({
                    repositoryPath: repo.path,
                    destinationPath: destPath,
                    branch: request.branch,
                    failureContext: { kind: "multi-repo", repositoryName: repo.name },
                });
                created.push({ name: repo.name, branch: request.branch, action });
                preparedAdditions.set(repo.name, prepared);
                registrationFences.set(
                    repo.name,
                    ports.requireRegistration(registrationFence, destPath),
                );
            }
        } catch (e) {
            const rollbackErrors: string[] = [];
            for (const c of created) {
                const destPath = ports.destinationPath(request, c.name);
                const sourceRepo = gitRepos.find((r) => r.name === c.name);
                if (!sourceRepo || !ports.pathExists(destPath)) continue;
                if (!ports.worktreeMatches(sourceRepo.path, destPath)) {
                    rollbackErrors.push(`${c.name}: worktree ownership changed during rollback`);
                    continue;
                }
                try {
                    const registrationFence = registrationFences.get(c.name);
                    if (!registrationFence) {
                        throw new Error("missing worktree registration fence");
                    }
                    ports.removeRegisteredWorktree(request, sourceRepo.path, destPath, registrationFence);
                    ports.rollbackCreatedBranch(
                        sourceRepo.path,
                        request.branch,
                        c.action,
                        preparedAdditions.get(c.name) ?? null,
                    );
                } catch (rollbackError) {
                    rollbackErrors.push(`${c.name}: ${(rollbackError as Error).message}`);
                }
            }
            if (rollbackErrors.length === 0) {
                try {
                    ports.assertWorkspaceIdentity(request, workspaceIdentity);
                    if (ports.workspaceEntryCount(request) !== 0) {
                        throw new Error("workspace is not empty after worktree rollback");
                    }
                    ports.quarantineWorkspace(request, workspaceIdentity);
                } catch (rollbackError) {
                    rollbackErrors.push((rollbackError as Error).message);
                }
            }
            if (rollbackErrors.length > 0) {
                throw new Error(
                    `${(e as Error).message}; workspace rollback failed: ${rollbackErrors.join("; ")}`,
                    { cause: e },
                );
            }
            throw e;
        }

        // Process non-repo items → copy (isolated per worktree)
        const nonRepos = entries.filter((e) => !e.isGitRepo);
        for (const entry of nonRepos) {
            const destPath = ports.destinationPath(request, entry.name);
            try {
                ports.copyEntry(entry.path, destPath);
                if (!ports.pathExists(destPath)) {
                    throw new Error(`Source entry could not be copied safely: ${entry.path}`);
                }
                copied.push(entry.name);
                copiedIdentities.set(entry.name, ports.captureCopiedIdentity(destPath));
            } catch (e) {
                const rollbackErrors: string[] = [];
                for (const createdEntry of [...created].reverse()) {
                    const sourceRepo = gitRepos.find((repo) => (
                        repo.name === createdEntry.name
                    ));
                    if (!sourceRepo) continue;
                    try {
                        const registrationFence = registrationFences.get(createdEntry.name);
                        if (!registrationFence) {
                            throw new Error("missing worktree registration fence");
                        }
                        ports.removeRegisteredWorktree(
                            request,
                            sourceRepo.path,
                            ports.destinationPath(request, createdEntry.name),
                            registrationFence,
                        );
                        ports.rollbackCreatedBranch(
                            sourceRepo.path,
                            request.branch,
                            createdEntry.action,
                            preparedAdditions.get(createdEntry.name) ?? null,
                        );
                    } catch (rollbackError) {
                        rollbackErrors.push(
                            `${createdEntry.name}: ${(rollbackError as Error).message}`,
                        );
                    }
                }
                for (const copiedName of [...copied].reverse()) {
                    const identity = copiedIdentities.get(copiedName);
                    if (!identity) continue;
                    try {
                        ports.quarantineCopiedEntry(request, ports.destinationPath(request, copiedName), identity);
                    } catch (rollbackError) {
                        rollbackErrors.push(
                            `${copiedName}: ${(rollbackError as Error).message}`,
                        );
                    }
                }
                if (ports.pathExists(destPath)) {
                    rollbackErrors.push(`${entry.name}: partial copied content was preserved`);
                } else if (rollbackErrors.length === 0) {
                    try {
                        ports.assertWorkspaceIdentity(request, workspaceIdentity);
                        if (ports.workspaceEntryCount(request) === 0) {
                            ports.quarantineWorkspace(request, workspaceIdentity);
                        }
                    } catch (rollbackError) {
                        rollbackErrors.push((rollbackError as Error).message);
                    }
                }
                if (rollbackErrors.length > 0) {
                    throw new Error(
                        `${(e as Error).message}; workspace rollback failed: ${rollbackErrors.join("; ")}`,
                        { cause: e },
                    );
                }
                throw e;
            }
        }

        return { workspacePath: request.destinationPath, created, copied };
    };
}
