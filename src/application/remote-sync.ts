import type { RemoteCancellation, RemoteFailure, RemoteFault, RemoteSyncAuthority, RemoteSyncBinding, RemoteSyncEnsureOutcome, RemoteSyncHandle, RemoteSyncInventory, RemoteSyncObservation, RemoteSyncWaitOutcome } from "../domain/remote-services.js";
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

    function observationFailure(observation: RemoteSyncObservation<Evidence>): RemoteFailure<Evidence> | null {
        if (observation.kind === "missing") return { kind: "failed", reason: "sync-missing" };
        if (observation.kind === "unknown") return { kind: "failed", reason: "sync-unknown", evidence: observation.evidence };
        if (observation.kind === "conflict") return { kind: "failed", reason: "sync-conflict", evidence: observation.evidence };
        return null;
    }

    async function ensureSync(binding: RemoteSyncBinding, containerDisplayName = binding.containerId,
        interruption: () => RemoteCancellation | RemoteFault | null = () => null): Promise<RemoteSyncEnsureOutcome<Evidence>> {
        try {
            let interrupted = interruption();
            if (interrupted) return interrupted;
            return await ports.withLifecycleLockAsync(syncLifecyclePrefix(binding), async (): Promise<RemoteSyncEnsureOutcome<Evidence>> => {
                let interrupted = interruption();
                if (interrupted) return interrupted;
                const name = ports.getScopedMutagenSessionName(binding);
                if ((interrupted = interruption())) return interrupted;
                ports.startSyncDaemon();
                if ((interrupted = interruption())) return interrupted;
                let existing = inspectSync(binding);
                if (existing.kind === "unknown") return { kind: "failed", reason: "sync-unknown", evidence: existing.evidence };
                if (existing.kind === "conflict") return { kind: "failed", reason: "sync-conflict", evidence: existing.evidence };
                if ((interrupted = interruption())) return interrupted;
                if (existing.kind === "observed") {
                    // Selection already proved the complete authority; only the container may differ.
                    if (existing.binding!.containerId !== binding.containerId) {
                        ports.report({ kind: "sync-replacing" });
                        if ((interrupted = interruption())) return interrupted;
                        const terminated = ports.terminateSync(existing.identifier);
                        if (!terminated.ok) return { kind: "failed", reason: "sync-terminate-failed", evidence: terminated.evidence };
                        if ((interrupted = interruption())) return interrupted;
                        existing = inspectSync(binding);
                        if (existing.kind === "unknown") return { kind: "failed", reason: "sync-unknown", evidence: existing.evidence };
                        if (existing.kind !== "missing") return { kind: "failed", reason: "sync-conflict", evidence: existing.evidence };
                        if ((interrupted = interruption())) return interrupted;
                    } else {
                        if (existing.paused) {
                            ports.report({ kind: "sync-resuming" });
                            if ((interrupted = interruption())) return interrupted;
                            const resumed = ports.resumeSync(existing.identifier);
                            if (!resumed.ok) return { kind: "failed", reason: "sync-resume-failed", evidence: resumed.evidence };
                        } else {
                            ports.report({ kind: "sync-existing", observation: existing });
                        }
                        if ((interrupted = interruption())) return interrupted;
                        return { kind: "ready", handle: { identifier: existing.identifier, name, binding: { ...binding } } };
                    }
                }

                ports.report({ kind: "sync-creating", localPath: binding.localPath, containerDisplayName, projectId: binding.projectId, host: binding.host });
                if ((interrupted = interruption())) return interrupted;
                const config = { user: binding.user, host: binding.host, remotePath: "" };
                const created = ports.createSync({ name, localPath: binding.localPath, config, containerId: binding.containerId, projectId: binding.projectId });
                if (!created.ok) return { kind: "failed", reason: "sync-create-failed", evidence: created.evidence };
                if ((interrupted = interruption())) return interrupted;
                const observed = inspectSync(binding);
                if (observed.kind !== "observed") return observationFailure(observed)!;
                if (observed.binding === null || !sameBinding(observed.binding, binding)) return { kind: "failed", reason: "sync-conflict", evidence: observed.evidence };
                if ((interrupted = interruption())) return interrupted;
                return { kind: "ready", handle: { identifier: observed.identifier, name, binding: { ...binding } } };
            });
        } catch (error) {
            return { kind: "fault", error };
        }
    }

    async function waitForSync(handle: RemoteSyncHandle, timeoutMs: number = 120000,
        interruption: () => RemoteCancellation | RemoteFault | null = () => null): Promise<RemoteSyncWaitOutcome<Evidence>> {
        try {
            let interrupted = interruption();
            if (interrupted) return interrupted;
            const deadline = ports.now() + timeoutMs;
            const checkInterval = 1000;
            ports.report({ kind: "sync-waiting" });

            while (true) {
                if ((interrupted = interruption())) return interrupted;
                const remainingMs = deadline - ports.now();
                if (!(remainingMs >= 1)) break;
                if ((interrupted = interruption())) return interrupted;
                const observation = observeCapturedSync(handle, remainingMs);
                if (observation.kind !== "observed") return observationFailure(observation)!;
                if ((interrupted = interruption())) return interrupted;
                const remainingAfterObservation = deadline - ports.now();
                if (observation.watching && remainingAfterObservation > 0) {
                    ports.report({ kind: "sync-completed" });
                    return interruption() ?? { kind: "ready" };
                }
                if (observation.failed) {
                    ports.report({ kind: "sync-failed", observation });
                    return { kind: "failed", reason: "sync-failed", evidence: observation.evidence };
                }
                if (!(remainingAfterObservation > 0)) break;
                ports.report({ kind: "sync-poll" });
                if ((interrupted = interruption())) return interrupted;
                const sleepMs = Math.min(checkInterval, deadline - ports.now());
                if (!(sleepMs > 0)) break;
                if ((interrupted = interruption())) return interrupted;
                await ports.sleep(sleepMs).completion;
            }

            if ((interrupted = interruption())) return interrupted;
            ports.report({ kind: "sync-timeout" });
            return { kind: "failed", reason: "sync-timeout" };
        } catch (error) {
            return { kind: "fault", error };
        }
    }

    return { ensureSync, inspectSync, observeCapturedSync, waitForSync, syncLifecyclePrefix };
}
