import type { WorkspaceEntry } from "../../domain/workspace/source-entry.js";

export type RootSetting = "author-email" | "author-name" | "unsigned-commits"
    | "local-file-transport" | "local-submodule-marker";
export type SubmoduleSetting = "ignore-content" | "disable-updates";

export interface WorkspaceSubmoduleInitializationPorts {
    resolveSource(path: string): string;
    initializeRepository(root: string): undefined;
    configureRoot(root: string, setting: RootSetting): undefined;
    scanEntries(root: string): WorkspaceEntry[];
    localBranchExists(repository: string, branch: "master" | "main"): boolean;
    currentBranch(repository: string): string;
    originUrl(repository: string): string;
    addSubmodule(root: string, name: string, url: string, branch: string): undefined;
    configureSubmodule(root: string, name: string, setting: SubmoduleSetting): undefined;
    stage(root: string): undefined;
    commit(root: string): undefined;
}
