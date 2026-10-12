import type {
    ContainerCreateLifecyclePorts,
    ContainerCreateLifecycleRequest,
} from "../ports/container-create-lifecycle.js";

export function createContainerCreateLifecycle<PreparedCreate>(ports: ContainerCreateLifecyclePorts<PreparedCreate>) {
    for (const name of [
        "failCreate", "withFamilyLock", "namespaceExists", "findCollision", "reportCreating",
        "reportLabWarning", "reportCreateFailure", "prepareCreate",
        "assertProjectSources", "assertDeviceSources", "assertFilesystemSources",
        "create", "verifyCreated", "removeRejected", "explicitlyAbsent",
        "syncMcp", "fixSsh", "syncGit", "finish",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container create lifecycle requires a callable ${name} port.`);
        }
    }

    function run(request: ContainerCreateLifecycleRequest): string {
        const { containerName, projectMountIdentity, profile, debug } = request;
        return ports.withFamilyLock(`mount-${projectMountIdentity}`, () => {
            if (ports.namespaceExists(containerName)) {
                ports.failCreate({ kind: "namespace-appeared", containerName });
            }
            const collision = ports.findCollision();
            if (collision) {
                ports.failCreate({ kind: "collision", containerName: collision.containerName, profile: profile ?? "default" });
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
                ports.failCreate({ kind: "create-failed" });
            }
            const createdContainerId = result.containerId;

            try {
                ports.assertProjectSources();
                ports.assertDeviceSources();
                ports.assertFilesystemSources();
                if (!createdContainerId) ports.failCreate({ kind: "missing-id-verification" });
                const verification = ports.verifyCreated(createdContainerId);
                if (verification.kind !== "verified") {
                    ports.failCreate({ kind: "verification-failed", reason: verification.reason });
                }
            } catch (error) {
                if (createdContainerId) {
                    const compensationFailures: unknown[] = [];
                    try { ports.removeRejected(createdContainerId); }
                    catch (removalError) { compensationFailures.push(removalError); }
                    let absent = false;
                    try { absent = ports.explicitlyAbsent(createdContainerId); }
                    catch (absenceError) { compensationFailures.push(absenceError); }
                    if (compensationFailures.length > 0) {
                        throw new AggregateError([error, ...compensationFailures],
                            "Created container verification and rejected-container cleanup failed", { cause: error });
                    }
                    if (!absent) {
                        ports.failCreate({ kind: "rejected-removal-failed", containerId: createdContainerId, error });
                    }
                }
                throw error;
            }

            if (!createdContainerId) {
                ports.failCreate({ kind: "unpinned-session" });
            }
            ports.syncMcp(createdContainerId);
            ports.fixSsh(createdContainerId);
            ports.syncGit(createdContainerId);
            return ports.finish(createdContainerId);
        });
    }

    return { run };
}
