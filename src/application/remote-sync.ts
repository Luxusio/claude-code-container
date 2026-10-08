import { parseMutagenSyncStatus, type RemoteConfig } from "../domain/remote-services.js";
import type { RemoteSyncPorts } from "../ports/remote-services.js";

export function observeRemoteSyncStatus(ports: RemoteSyncPorts, sessionName: string): string | null {
    const result = ports.observeSync(sessionName);
    if (result.error || result.status !== 0) return null;
    return parseMutagenSyncStatus(result.stdout ?? "");
}

export function createRemoteSync(ports: RemoteSyncPorts) {
    for (const name of ["resolveProjectPath", "getProjectId", "getMutagenSessionName", "startSyncDaemon", "observeSync", "terminateSync", "resumeSync", "createSync", "readCommonIgnoreDirs", "captureLog", "captureProgress", "now", "sleep"] as const) {
        if (typeof ports?.[name] !== "function") throw new TypeError(`Remote sync requires a callable ${name} port.`);
    }
async function ensureSync(projectPath: string, config: RemoteConfig, containerTarget: string, containerDisplayName = containerTarget): Promise<string> {
    const fullPath = ports.resolveProjectPath(projectPath);
    const sessionName = ports.getMutagenSessionName(fullPath);
    const projectId = ports.getProjectId(fullPath);

    // Ensure mutagen daemon is running
    ports.startSyncDaemon();

    // Existing sessions are reusable only when their endpoint is the exact
    // container ID pinned for this invocation.
    const existing = ports.observeSync(sessionName);
    if (!existing.error && existing.status === 0) {
        const output = existing.stdout ?? "";
        const expectedEndpoint = `docker://${containerTarget}/`;
        if (!output.includes(expectedEndpoint)) {
            ports.captureLog()("Replacing stale sync session...");
            const terminated = ports.terminateSync(sessionName);
            if (terminated.error || terminated.status !== 0) {
                throw new Error("Failed to terminate stale sync session");
            }
        } else {
            const existingStatus = parseMutagenSyncStatus(output);
            if (existingStatus.toLowerCase().includes("paused")) {
                ports.captureLog()("Resuming paused sync...");
                const resumed = ports.resumeSync(sessionName);
                if (resumed.error || resumed.status !== 0) throw new Error("Failed to resume sync session");
            } else {
                ports.captureLog()(`Sync already running (${existingStatus})`);
            }
            return sessionName;
        }
    }

    // Create new sync session - sync to container via SSH
    ports.captureLog()("Creating sync session...");
    ports.captureLog()(`  Local:  ${fullPath}`);
    ports.captureLog()(`  Remote: docker://${containerDisplayName}/project/${projectId} (via ${config.host})`);

    // Mutagen sync to remote docker container
    // Format: user@host:docker://container/path
    const mutagenArgs = [
        "sync", "create",
        fullPath,
        `${config.user}@${config.host}:docker://${containerTarget}/project/${projectId}`,
        "--name", sessionName,
        "--ignore-vcs",
        ...ports.readCommonIgnoreDirs().map(dir => `--ignore=${dir}`)
    ];
    const createResult = ports.createSync(mutagenArgs);

    if (createResult.status !== 0) {
        throw new Error("Failed to create sync session");
    }

    return sessionName;
}

/**
 * Wait for sync to reach "Watching for changes" state.
 */
async function waitForSync(sessionName: string, timeoutMs: number = 120000): Promise<void> {
    const startTime = ports.now();
    const checkInterval = 1000;

    ports.captureProgress()("Waiting for initial sync...");

    while (ports.now() - startTime < timeoutMs) {
        const status = observeRemoteSyncStatus(ports, sessionName);

        if (status === null) {
            throw new Error("Sync session not found");
        }

        if (status.toLowerCase().includes("watching")) {
            ports.captureLog()(" done");
            return;
        }

        if (status.toLowerCase().includes("error") || status.toLowerCase().includes("halted")) {
            ports.captureLog()(` failed: ${status}`);
            throw new Error(`Sync failed: ${status}`);
        }

        ports.captureProgress()(".");
        await ports.sleep(checkInterval);
    }

    ports.captureLog()(" timeout");
    throw new Error("Sync timeout - initial sync did not complete");
}

    return { ensureSync, waitForSync };
}
