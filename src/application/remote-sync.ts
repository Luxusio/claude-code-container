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
        const deadline = ports.now() + timeoutMs;
        const checkInterval = 1000;

        ports.report({ kind: "sync-waiting" });

        while (true) {
            const remainingMs = deadline - ports.now();
            if (!(remainingMs >= 1)) break;
            const observation = ports.observeSync(sessionName, undefined, remainingMs);
            if (observation.kind === "unavailable") ports.fail("sync-missing");

            const remainingAfterObservation = deadline - ports.now();
            if (observation.watching && remainingAfterObservation > 0) {
                ports.report({ kind: "sync-completed" });
                return;
            }

            if (observation.failed) {
                ports.report({ kind: "sync-failed", observation });
                ports.fail("sync-failed", observation.evidence);
            }
            if (!(remainingAfterObservation > 0)) break;

            ports.report({ kind: "sync-poll" });
            const sleepMs = Math.min(checkInterval, deadline - ports.now());
            if (!(sleepMs > 0)) break;
            await ports.sleep(sleepMs);
        }

        ports.report({ kind: "sync-timeout" });
        ports.fail("sync-timeout");
    }

    return { ensureSync, waitForSync };
}
