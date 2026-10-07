import type {
    ContainerExistingLifecyclePorts,
    ContainerExistingLifecycleRequest,
    ContainerExistingLifecycleResult,
    ContainerReplacementRequest,
} from "../ports/container-existing-lifecycle.js";

export function createContainerExistingLifecycle(ports: ContainerExistingLifecyclePorts) {
    for (const name of [
        "listContainer", "identity", "managedIdentity", "assertProjectSources",
        "assertDeviceSources", "assertFilesystemSources", "inspectContract",
        "safeToDefer", "isRunning", "canExec", "canExecAfterBriefRetry",
        "deviceSourcesMatch", "syncMcp", "fixSsh", "syncGit", "start", "stop",
        "remove", "reportContractMismatch", "reportContractMatch", "reportRestart",
        "reportRecreation", "reportDeferred", "throwUnsafeDefer", "finish",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container existing lifecycle requires a callable ${name} port.`);
        }
    }

    function replace(request: ContainerReplacementRequest): boolean {
        const { containerName, reason, replacementGuard, onRecreate } = request;
        if (!replacementGuard) {
            throw new Error("Container replacement requires a lifecycle/session guard.");
        }
        const initialIdentity = ports.identity(containerName);
        if (!initialIdentity) return false;
        const pinnedContainerId = request.expectedContainerId ?? initialIdentity.containerId;
        if (initialIdentity.containerId !== pinnedContainerId) return false;
        let replacementConfirmed = false;
        const guarded = replacementGuard(() => {
            if (request.initiallyRunningContainerId === pinnedContainerId || initialIdentity.running) return;
            const currentIdentity = ports.identity(pinnedContainerId);
            if (!currentIdentity || currentIdentity.containerId !== pinnedContainerId || currentIdentity.running) return;
            // Ordinary removal retains the stopped-path fence against an external start.
            ports.reportRecreation(reason);
            ports.remove(pinnedContainerId);
            onRecreate?.();
            replacementConfirmed = true;
        });
        return guarded && replacementConfirmed;
    }

    function run(request: ContainerExistingLifecycleRequest): ContainerExistingLifecycleResult {
        const {
            containerName, debug, managedProjectPath, initiallyRunningContainerId,
            replacementGuard, onRecreate,
        } = request;
        const listedContainer = ports.listContainer(containerName);
        let lifecycleContainerId = listedContainer.containerId;
        const markRecreated = () => {
            lifecycleContainerId = null;
            onRecreate?.();
        };
        const finish = (containerId: string): ContainerExistingLifecycleResult => {
            ports.finish(containerId);
            return { kind: "joined", containerId };
        };
        const replaceCurrent = (reason: string, expectedContainerId: string) => replace({
            containerName, reason, expectedContainerId, managedProjectPath,
            initiallyRunningContainerId, replacementGuard, onRecreate: markRecreated,
        });
        const readiness = (id: string) => replacementGuard
            ? ports.canExecAfterBriefRetry(id)
            : ports.canExec(id);

        if (!listedContainer.known) {
            throw new Error("Container identity inspection failed; the existing container was preserved.");
        }
        if (initiallyRunningContainerId && listedContainer.containerId !== initiallyRunningContainerId) {
            throw new Error(
                "Container observed running at startup became unavailable or changed identity; "
                + "refusing to create a replacement in the same invocation.",
            );
        }
        if (listedContainer.containerId) {
            ports.assertProjectSources();
            ports.assertDeviceSources();
            ports.assertFilesystemSources();
            let contractMismatchReason = "container contract changed";
            const contractMatches = ports.inspectContract(
                listedContainer.containerId,
                (reason) => { contractMismatchReason = reason; },
            );
            ports.assertProjectSources();
            ports.assertDeviceSources();
            ports.assertFilesystemSources();
            if (contractMatches === null) {
                throw new Error(
                    `Container contract verification is temporarily unavailable (${contractMismatchReason}); `
                    + "the existing container was preserved without replacement or join.",
                );
            }
            if (!contractMatches) {
                if (debug) ports.reportContractMismatch(containerName);
                if (replacementGuard) {
                    const recreated = replaceCurrent(contractMismatchReason, listedContainer.containerId);
                    if (!recreated) {
                        let unsafeDeferReason = "unknown safety mismatch";
                        if (!ports.safeToDefer(
                            listedContainer.containerId,
                            (reason) => { unsafeDeferReason = reason; },
                        )) {
                            ports.throwUnsafeDefer(unsafeDeferReason);
                        }
                        if (!ports.isRunning(containerName)) {
                            throw new Error("Container contract update is required, but automatic replacement was not authorized.");
                        }
                        if (!ports.canExecAfterBriefRetry(listedContainer.containerId)) {
                            throw new Error("Running container is unavailable; automatic destructive recovery was refused.");
                        }
                        ports.reportDeferred(contractMismatchReason);
                        ports.fixSsh(listedContainer.containerId);
                        ports.syncGit(listedContainer.containerId);
                        return finish(listedContainer.containerId);
                    }
                } else {
                    replace({ containerName, reason: contractMismatchReason, onRecreate });
                }
            } else if (debug) {
                ports.reportContractMatch(containerName);
            }
        }

        const namedContainerIsRunning = ports.isRunning(containerName);
        if (lifecycleContainerId && namedContainerIsRunning) {
            if (readiness(lifecycleContainerId)) {
                if (!ports.deviceSourcesMatch()) {
                    if (replacementGuard) {
                        if (!replaceCurrent("device-lab mount source identity changed", lifecycleContainerId)) {
                            throw new Error("Device-lab mount source changed during validation; preserving the existing running container without joining it.");
                        }
                    } else {
                        replace({ containerName, reason: "device-lab mount source identity changed", onRecreate });
                    }
                } else {
                    ports.syncMcp(lifecycleContainerId);
                    ports.fixSsh(lifecycleContainerId);
                    ports.syncGit(lifecycleContainerId);
                    if (ports.deviceSourcesMatch()) return finish(lifecycleContainerId);
                    if (replacementGuard) {
                        if (!replaceCurrent("device-lab mount source identity changed", lifecycleContainerId)) {
                            throw new Error("Device-lab mount source changed during synchronization; preserving the existing running container without joining it.");
                        }
                    } else {
                        replace({ containerName, reason: "device-lab mount source identity changed", onRecreate });
                    }
                }
            } else if (replacementGuard) {
                if (!replaceCurrent("container exec failed", lifecycleContainerId)) {
                    throw new Error("Running container is unavailable; automatic destructive recovery was refused.");
                }
            } else {
                replace({ containerName, reason: "container exec failed", onRecreate });
            }
        }

        if (lifecycleContainerId) {
            if (debug) ports.reportRestart(containerName);
            ports.assertProjectSources();
            if (!ports.deviceSourcesMatch()) {
                if (!replaceCurrent("device-lab mount source identity changed", lifecycleContainerId)) {
                    throw new Error("Device-lab mount source changed; automatic replacement was not authorized.");
                }
            } else {
                ports.start(lifecycleContainerId);
                if (!readiness(lifecycleContainerId)) {
                    throw new Error("Restarted container is unavailable; preserving it without automatic replacement.");
                }
                ports.syncMcp(lifecycleContainerId);
                ports.fixSsh(lifecycleContainerId);
                ports.syncGit(lifecycleContainerId);
                if (ports.deviceSourcesMatch()) return finish(lifecycleContainerId);
                throw new Error("Device-lab mount source changed during restart; preserving the restarted container without replacement.");
            }
        }

        return { kind: "continue-to-create" };
    }

    return { run, replace };
}
