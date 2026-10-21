import { describe, expect, it, vi } from "vitest";
import { createWorkspaceSubmoduleInitialization } from "../../application/workspace/submodule-initialization.js";
import type { WorkspaceEntry } from "../../domain/workspace/source-entry.js";
import type { WorkspaceSubmoduleInitializationPorts } from "../../ports/workspace/submodule-initialization.js";

function consumedContracts(ports: WorkspaceSubmoduleInitializationPorts): void {
    const completion: undefined = createWorkspaceSubmoduleInitialization(ports).initialize("source");
    const { addSubmodule, ...withoutRegistration } = ports;
    // @ts-expect-error Registration is a required effect, not an optional callback.
    createWorkspaceSubmoduleInitialization(withoutRegistration);
    // @ts-expect-error Repository initialization must settle before configuration and scanning.
    createWorkspaceSubmoduleInitialization({ ...ports, initializeRepository: async () => undefined });
    // @ts-expect-error Tracking-branch observations must settle before submodule registration.
    createWorkspaceSubmoduleInitialization({ ...ports, localBranchExists: async () => true });
    // @ts-expect-error Root configuration selects existing settings rather than arbitrary Git arguments.
    ports.configureRoot("source", "arbitrary-config");
    void [completion, addSubmodule];
}
void consumedContracts;

function repository(name: string, isGitRepo = true): WorkspaceEntry {
    return { name, path: `/resolved/${name}`, isGitRepo };
}

function fixture(entries: WorkspaceEntry[] = [repository("repo-a")]) {
    const state = { branches: new Set(["master"]), current: "feature/topic", origin: "" };
    const ports = {
        resolveSource: vi.fn<WorkspaceSubmoduleInitializationPorts["resolveSource"]>(() => "/resolved"),
        initializeRepository: vi.fn<WorkspaceSubmoduleInitializationPorts["initializeRepository"]>(() => undefined),
        configureRoot: vi.fn<WorkspaceSubmoduleInitializationPorts["configureRoot"]>(() => undefined),
        scanEntries: vi.fn<WorkspaceSubmoduleInitializationPorts["scanEntries"]>(() => entries),
        localBranchExists: vi.fn<WorkspaceSubmoduleInitializationPorts["localBranchExists"]>((_path, branch) => state.branches.has(branch)),
        currentBranch: vi.fn<WorkspaceSubmoduleInitializationPorts["currentBranch"]>(() => state.current),
        originUrl: vi.fn<WorkspaceSubmoduleInitializationPorts["originUrl"]>(() => state.origin),
        addSubmodule: vi.fn<WorkspaceSubmoduleInitializationPorts["addSubmodule"]>(() => undefined),
        configureSubmodule: vi.fn<WorkspaceSubmoduleInitializationPorts["configureSubmodule"]>(() => undefined),
        stage: vi.fn<WorkspaceSubmoduleInitializationPorts["stage"]>(() => undefined),
        commit: vi.fn<WorkspaceSubmoduleInitializationPorts["commit"]>(() => undefined),
    } satisfies WorkspaceSubmoduleInitializationPorts;
    return { ports, state, initialize: () => createWorkspaceSubmoduleInitialization(ports).initialize("relative source") };
}

describe("generated workspace submodule initialization", () => {
    it.each([
        { label: "master before main/current", branches: ["master", "main"], current: "feature/topic", selected: "master", probes: ["master"], origin: "https://example.invalid/repo.git" },
        { label: "main before current", branches: ["main"], current: "feature/topic", selected: "main", probes: ["master", "main"], origin: "" },
        { label: "current branch fallback", branches: [], current: "feature/topic", selected: "feature/topic", probes: ["master", "main"], origin: "" },
        { label: "detached HEAD", branches: [], current: "HEAD", selected: "", probes: ["master", "main"], origin: "" },
        { label: "missing current branch", branches: [], current: "", selected: "", probes: ["master", "main"], origin: "" },
    ])("selects $label and uses the origin or local repository path", ({ branches, current, selected, probes, origin }) => {
        const f = fixture();
        f.state.branches = new Set(branches);
        f.state.current = current;
        f.state.origin = origin;

        expect(f.initialize()).toBeUndefined();

        expect(f.ports.addSubmodule).toHaveBeenCalledExactlyOnceWith("/resolved", "repo-a", origin || "/resolved/repo-a", selected);
        expect(f.ports.localBranchExists.mock.calls).toEqual(probes.map(branch => ["/resolved/repo-a", branch]));
        expect(f.ports.currentBranch.mock.calls).toEqual(branches.length ? [] : [["/resolved/repo-a"]]);
    });

    it("registers every repository in scan order before configuring submodules and committing", () => {
        const f = fixture([repository("repo-b"), repository("shared", false), repository("repo-a")]);
        const registered: Array<Parameters<WorkspaceSubmoduleInitializationPorts["addSubmodule"]>> = [];
        const configured: Array<Parameters<WorkspaceSubmoduleInitializationPorts["configureSubmodule"]>> = [];
        let staged = false, committed = false;
        f.ports.addSubmodule.mockImplementation((...args) => {
            expect(configured).toEqual([]);
            expect(staged).toBe(false);
            registered.push(args);
            return undefined;
        });
        f.ports.configureSubmodule.mockImplementation((...args) => {
            expect(registered.map(([, name]) => name)).toEqual(["repo-b", "repo-a"]);
            expect(staged).toBe(false);
            configured.push(args);
            return undefined;
        });
        f.ports.stage.mockImplementation(() => {
            expect(configured).toEqual([
                ["/resolved", "repo-b", "ignore-content"], ["/resolved", "repo-b", "disable-updates"],
                ["/resolved", "repo-a", "ignore-content"], ["/resolved", "repo-a", "disable-updates"],
            ]);
            staged = true;
            return undefined;
        });
        f.ports.commit.mockImplementation(() => { expect(staged).toBe(true); committed = true; return undefined; });

        expect(f.initialize()).toBeUndefined();

        expect(registered).toEqual([
            ["/resolved", "repo-b", "/resolved/repo-b", "master"],
            ["/resolved", "repo-a", "/resolved/repo-a", "master"],
        ]);
        expect(committed).toBe(true);
    });

    it("propagates initialization failure before configuration or scanning", () => {
        const f = fixture();
        const failure = { nativeFailure: "init" };
        f.ports.initializeRepository.mockImplementation(() => { throw failure; });
        let caught: unknown;
        try { f.initialize(); } catch (error) { caught = error; }

        expect(caught).toBe(failure);
        expect(f.ports.configureRoot).not.toHaveBeenCalled();
        expect(f.ports.scanEntries).not.toHaveBeenCalled();
        expect(f.ports.addSubmodule).not.toHaveBeenCalled();
        expect(f.ports.commit).not.toHaveBeenCalled();
    });

    it("retains a partial registration and the original thrown value without configuring, staging or committing", () => {
        const f = fixture([repository("repo-a"), repository("repo-b"), repository("repo-c")]);
        const failure = new Error("second submodule refused");
        f.ports.addSubmodule.mockImplementation((_root, name) => { if (name === "repo-b") throw failure; return undefined; });
        let caught: unknown;
        try { f.initialize(); } catch (error) { caught = error; }

        expect(caught).toBe(failure);
        expect(f.ports.addSubmodule.mock.calls.map(([, name]) => name)).toEqual(["repo-a", "repo-b"]);
        expect(f.ports.originUrl.mock.calls).toEqual([["/resolved/repo-a"], ["/resolved/repo-b"]]);
        expect(f.ports.configureSubmodule).not.toHaveBeenCalled();
        expect(f.ports.stage).not.toHaveBeenCalled();
        expect(f.ports.commit).not.toHaveBeenCalled();
    });

    it("does not commit after staging throws and preserves that exact failure", () => {
        const f = fixture();
        const failure = Symbol("stage failed");
        f.ports.stage.mockImplementation(() => { throw failure; });
        let caught: unknown;
        try { f.initialize(); } catch (error) { caught = error; }

        expect(caught).toBe(failure);
        expect(f.ports.configureSubmodule.mock.calls).toEqual([
            ["/resolved", "repo-a", "ignore-content"], ["/resolved", "repo-a", "disable-updates"],
        ]);
        expect(f.ports.commit).not.toHaveBeenCalled();
    });
});
