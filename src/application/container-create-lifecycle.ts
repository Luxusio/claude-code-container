import type {
    ContainerCreateLifecyclePorts,
    ContainerCreateLifecycleRequest,
    ContainerCreateLifecycleOutcome,
    CreatedContainerRejection,
    RejectedContainerCleanup,
} from "../ports/container-create-lifecycle.js";

export function createContainerCreateLifecycle<PreparedCreate>(ports: ContainerCreateLifecyclePorts<PreparedCreate>) {
    for (const name of [
        "withFamilyLock", "namespaceExists", "findCollision", "reportCreating",
        "reportLabWarning", "reportCreateFailure", "prepareCreate",
        "assertProjectSources", "assertDeviceSources", "assertFilesystemSources",
        "create", "verifyCreated", "removeRejected", "explicitlyAbsent",
        "syncMcp", "fixSsh", "syncGit", "finish",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container create lifecycle requires a callable ${name} port.`);
        }
    }

    function run(request: ContainerCreateLifecycleRequest): ContainerCreateLifecycleOutcome {
        const { containerName, projectMountIdentity, profile, debug } = request;
        return ports.withFamilyLock(`mount-${projectMountIdentity}`, () => {
            if (ports.namespaceExists(containerName)) {
                return { kind: "refused", failure: { kind: "namespace-appeared", containerName } };
            }
            const collision = ports.findCollision();
            if (collision) {
                return { kind: "refused", failure: { kind: "collision", containerName: collision.containerName, profile: profile ?? "default" } };
            }
            ports.reportCreating(containerName, debug);
            ports.reportLabWarning();
            const prepared = ports.prepareCreate();
            ports.assertProjectSources();
            ports.assertDeviceSources();
            ports.assertFilesystemSources();
            const result = ports.create(prepared);
            if (result.kind === "failed") {
                ports.reportCreateFailure();
                return { kind: "refused", failure: { kind: "create-failed" } };
            }
            const createdContainerId = result.containerId;

            let rejection: CreatedContainerRejection | undefined;
            try {
                ports.assertProjectSources();
                ports.assertDeviceSources();
                ports.assertFilesystemSources();
                if (!createdContainerId) {
                    rejection = { kind: "missing-id-verification" };
                } else {
                    const verification = ports.verifyCreated(createdContainerId);
                    if (verification.kind !== "verified") {
                        rejection = { kind: "verification-failed", reason: verification.reason };
                    }
                }
            } catch {
                rejection = { kind: "post-create-check-failed" };
            }
            if (rejection) {
                let cleanup: RejectedContainerCleanup = { kind: "not-authorized" };
                if (createdContainerId) {
                    let removal: "completed" | "failed" = "completed";
                    try { ports.removeRejected(createdContainerId); }
                    catch { removal = "failed"; }
                    let absence: "proved" | "unproved" | "failed";
                    try { absence = ports.explicitlyAbsent(createdContainerId) ? "proved" : "unproved"; }
                    catch { absence = "failed"; }
                    cleanup = { kind: "attempted", containerId: createdContainerId, removal, absence };
                }
                return { kind: "rejected", rejection, cleanup };
            }

            if (!createdContainerId) {
                return { kind: "refused", failure: { kind: "unpinned-session" } };
            }
            ports.syncMcp(createdContainerId);
            ports.fixSsh(createdContainerId);
            ports.syncGit(createdContainerId);
            return { kind: "completed", value: ports.finish(createdContainerId) };
        });
    }

    return { run };
}
