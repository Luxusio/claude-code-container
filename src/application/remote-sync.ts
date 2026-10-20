import type { RemoteObservedSync, RemoteSyncAuthority, RemoteSyncBinding, RemoteSyncHandle, RemoteSyncInventory, RemoteSyncObservation } from "../domain/remote-services.js";
import type { RemoteSyncPorts } from "../ports/remote-services.js";

function sameAuthority(left: RemoteSyncAuthority, right: RemoteSyncAuthority): boolean {
    return left.localPath === right.localPath && left.user === right.user && left.host === right.host && left.projectId === right.projectId;
}

function sameBinding(left: RemoteSyncBinding, right: RemoteSyncBinding): boolean {
    return sameAuthority(left, right) && left.containerId === right.containerId;
}

export function createRemoteSync<Evidence>(ports: RemoteSyncPorts<Evidence>) {
    const syncLifecyclePrefix = (authority: RemoteSyncAuthority): string => `remote-sync--${ports.getProjectHash(authority.localPath)}`;

    function selectSync(inventory: RemoteSyncInventory<Evidence>, authority: RemoteSyncAuthority): RemoteSyncObservation<Evidence> {
        if (inventory.kind === "unknown") return inventory;
        const name = ports.getScopedMutagenSessionName(authority);
        const legacyName = ports.getMutagenSessionName(authority.localPath);
        const candidates = inventory.sessions.filter(session => session.name === name);
        if (inventory.sessions.some(session => session.name === legacyName ||
            (session.name !== name && session.binding !== null && sameAuthority(session.binding, authority))) || candidates.length > 1) {
            return { kind: "conflict", evidence: inventory.evidence };
        }
        const observed = candidates[0];
        if (!observed) return { kind: "missing" };
        if (observed.binding === null || !sameAuthority(observed.binding, authority)) {
            return { kind: "conflict", evidence: inventory.evidence };
        }
        return observed;
    }

    function inspectSync(authority: RemoteSyncAuthority, remainingMs?: number): RemoteSyncObservation<Evidence> {
        return selectSync(ports.observeSyncInventory(remainingMs), authority);
    }

    function observeCapturedSync(handle: RemoteSyncHandle, remainingMs?: number): RemoteSyncObservation<Evidence> {
        const inventory = ports.observeSyncInventory(remainingMs);
        if (inventory.kind === "unknown") return inventory;
        const captured = inventory.sessions.filter(session => session.identifier === handle.identifier);
        if (captured.length === 0) return { kind: "missing" };
        const observation = selectSync(inventory, handle.binding);
        if (captured.length !== 1 || observation.kind !== "observed" || observation.identifier !== handle.identifier ||
            observation.name !== handle.name || observation.binding === null || !sameBinding(observation.binding, handle.binding)) {
            return { kind: "conflict", evidence: inventory.evidence };
        }
        return observation;
    }

    function requireObserved(observation: RemoteSyncObservation<Evidence>): RemoteObservedSync<Evidence> {
        if (observation.kind === "missing") ports.fail("sync-missing");
        if (observation.kind === "unknown") ports.fail("sync-unknown", observation.evidence);
        if (observation.kind === "conflict") ports.fail("sync-conflict", observation.evidence);
        return observation;
    }

    async function ensureSync(binding: RemoteSyncBinding, containerDisplayName = binding.containerId): Promise<RemoteSyncHandle> {
        return ports.withLifecycleLockAsync(syncLifecyclePrefix(binding), async () => {
            const name = ports.getScopedMutagenSessionName(binding);
            ports.startSyncDaemon();
            let existing = inspectSync(binding);
            if (existing.kind === "unknown") ports.fail("sync-unknown", existing.evidence);
            if (existing.kind === "conflict") ports.fail("sync-conflict", existing.evidence);
            if (existing.kind === "observed") {
                // Selection already proved the complete authority; only the container may differ.
                if (existing.binding!.containerId !== binding.containerId) {
                    ports.report({ kind: "sync-replacing" });
                    const terminated = ports.terminateSync(existing.identifier);
                    if (!terminated.ok) ports.fail("sync-terminate-failed", terminated.evidence);
                    existing = inspectSync(binding);
                    if (existing.kind === "unknown") ports.fail("sync-unknown", existing.evidence);
                    if (existing.kind !== "missing") ports.fail("sync-conflict", existing.evidence);
                } else {
                    if (existing.paused) {
                        ports.report({ kind: "sync-resuming" });
                        const resumed = ports.resumeSync(existing.identifier);
                        if (!resumed.ok) ports.fail("sync-resume-failed", resumed.evidence);
                    } else {
                        ports.report({ kind: "sync-existing", observation: existing });
                    }
                    return { identifier: existing.identifier, name, binding: { ...binding } };
                }
            }

            ports.report({ kind: "sync-creating", localPath: binding.localPath, containerDisplayName, projectId: binding.projectId, host: binding.host });
            const config = { user: binding.user, host: binding.host, remotePath: "" };
            const created = ports.createSync({ name, localPath: binding.localPath, config, containerId: binding.containerId, projectId: binding.projectId });
            if (!created.ok) ports.fail("sync-create-failed", created.evidence);
            const observed = requireObserved(inspectSync(binding));
            if (observed.binding === null || !sameBinding(observed.binding, binding)) ports.fail("sync-conflict", observed.evidence);
            return { identifier: observed.identifier, name, binding: { ...binding } };
        });
    }

    async function waitForSync(handle: RemoteSyncHandle, timeoutMs: number = 120000): Promise<void> {
        const deadline = ports.now() + timeoutMs;
        const checkInterval = 1000;
        ports.report({ kind: "sync-waiting" });

        while (true) {
            const remainingMs = deadline - ports.now();
            if (!(remainingMs >= 1)) break;
            const observation = requireObserved(observeCapturedSync(handle, remainingMs));
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

    return { ensureSync, inspectSync, observeCapturedSync, waitForSync, syncLifecyclePrefix };
}
