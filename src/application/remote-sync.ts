import type { RemoteConfig } from "../domain/remote-services.js";
import type { RemoteSyncPorts } from "../ports/remote-services.js";

export function createRemoteSync<Evidence>(ports: RemoteSyncPorts<Evidence>) {
    async function ensureSync(projectPath: string, config: RemoteConfig, containerTarget: string, containerDisplayName = containerTarget): Promise<string> {
        const fullPath = ports.resolveProjectPath(projectPath);
        const sessionName = ports.getMutagenSessionName(fullPath);
        const projectId = ports.getProjectId(fullPath);

        ports.startSyncDaemon();

        // Reuse requires the exact container ID pinned for this invocation.
        const existing = ports.observeSync(sessionName, containerTarget);
        if (existing.kind === "observed") {
            if (!existing.endpointMatches) {
                ports.report({ kind: "sync-replacing" });
                const terminated = ports.terminateStaleSync(sessionName);
                if (!terminated.ok) ports.fail("sync-terminate-failed", terminated.evidence);
            } else {
                if (existing.paused) {
                    ports.report({ kind: "sync-resuming" });
                    const resumed = ports.resumeSync(sessionName);
                    if (!resumed.ok) ports.fail("sync-resume-failed", resumed.evidence);
                } else {
                    ports.report({ kind: "sync-existing", observation: existing });
                }
                return sessionName;
            }
        }

        ports.report({ kind: "sync-creating", localPath: fullPath, containerDisplayName, projectId, host: config.host });
        const created = ports.createSync({ name: sessionName, localPath: fullPath, config, containerId: containerTarget, projectId });
        if (!created.ok) ports.fail("sync-create-failed", created.evidence);
        return sessionName;
    }

    async function waitForSync(sessionName: string, timeoutMs: number = 120000): Promise<void> {
        const startTime = ports.now();
        const checkInterval = 1000;

        ports.report({ kind: "sync-waiting" });

        while (ports.now() - startTime < timeoutMs) {
            const observation = ports.observeSync(sessionName);
            if (observation.kind === "unavailable") ports.fail("sync-missing");

            if (observation.watching) {
                ports.report({ kind: "sync-completed" });
                return;
            }

            if (observation.failed) {
                ports.report({ kind: "sync-failed", observation });
                ports.fail("sync-failed", observation.evidence);
            }

            ports.report({ kind: "sync-poll" });
            await ports.sleep(checkInterval);
        }

        ports.report({ kind: "sync-timeout" });
        ports.fail("sync-timeout");
    }

    return { ensureSync, waitForSync };
}
