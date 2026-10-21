import type { WorkspaceSubmoduleInitializationPorts } from "../../ports/workspace/submodule-initialization.js";

export function createWorkspaceSubmoduleInitialization(ports: WorkspaceSubmoduleInitializationPorts) {
    function initialize(dirPath: string): undefined {
        const root = ports.resolveSource(dirPath);
        ports.initializeRepository(root);
        for (const setting of [
            "author-email", "author-name", "unsigned-commits", "local-file-transport", "local-submodule-marker",
        ] as const) ports.configureRoot(root, setting);

        const repositories = ports.scanEntries(root).filter(entry => entry.isGitRepo);
        for (const repository of repositories) {
            const repositoryPath = repository.path;
            let branch: string;
            if (ports.localBranchExists(repositoryPath, "master")) branch = "master";
            else if (ports.localBranchExists(repositoryPath, "main")) branch = "main";
            else {
                const current = ports.currentBranch(repositoryPath);
                branch = current && current !== "HEAD" ? current : "";
            }
            const remoteUrl = ports.originUrl(repository.path);
            const url = remoteUrl || repository.path;
            ports.addSubmodule(root, repository.name, url, branch);
        }

        for (const repository of repositories) {
            ports.configureSubmodule(root, repository.name, "ignore-content");
            ports.configureSubmodule(root, repository.name, "disable-updates");
        }
        ports.stage(root);
        ports.commit(root);
    }

    return { initialize };
}
