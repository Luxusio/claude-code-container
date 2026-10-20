import { isValidHostOrUser, type RemoteCancellation, type RemoteCleanupFailure, type RemoteCleanupPhase, type RemoteConfig, type RemoteExecutionOutcome, type RemoteExecutionResult, type RemoteFault, type RemoteHeartbeat, type RemotePrompt, type RemoteReservationResult, type RemoteSignal, type RemoteSleep, type RemoteSshChannel, type RemoteTerminateOutcome } from "../domain/remote-services.js";
import type { RemoteServicesPorts } from "../ports/remote-services.js";
import { createRemoteSync, settleRemoteLifecycleLock } from "./remote-sync.js";

export function createRemoteServices<Evidence>(ports: RemoteServicesPorts<Evidence>) {
    const { ensureSync, inspectSync, observeCapturedSync, waitForSync, syncLifecyclePrefix } = createRemoteSync(ports);
    const checkTailscale = () => ports.observeTool("tailscale");
    const checkMutagen = () => ports.observeTool("mutagen");
    const isHostReachable = (host: string): boolean => ports.isHostReachable(host);
    const validConfig = (config: RemoteConfig): boolean => typeof config.host === "string" && typeof config.user === "string" &&
        isValidHostOrUser(config.host) && isValidHostOrUser(config.user);

    function loadRemoteConfig(projectPath: string): RemoteConfig | null {
        const hash = ports.getProjectHash(projectPath);
        const remote = ports.readRemoteConfigs();
        if (remote) {
            const saved = remote[hash];
            if (saved && typeof saved === "object") return saved as RemoteConfig;
        }
        const legacyReader = ports.prepareLegacyConfigReader(hash);
        if (!legacyReader.exists()) return null;
        try {
            return legacyReader.readConfig();
        } catch {
            return null;
        }
    }

    function saveRemoteConfig(projectPath: string, config: RemoteConfig): void {
        ports.saveRemoteConfig(ports.getProjectHash(projectPath), config);
    }

    async function remoteExec(projectPath: string, host?: string, args: string[] = []): Promise<RemoteExecutionOutcome<Evidence>> {
        const cleanupFailures: RemoteCleanupFailure<Evidence>[] = [];
        const failedCleanupPhases = new Set<RemoteCleanupPhase>();
        let requestedSignal: RemoteSignal | null = null, retainedFault: RemoteFault | null = null;
        let pendingPrompt: RemotePrompt | null = null, pendingSleep: RemoteSleep | null = null;
        let heartbeat: RemoteHeartbeat | null = null, activeSshProcess: RemoteSshChannel | null = null;
        let remoteSessionLock: string | null = null, childSignalForwarded = false, heartbeatEnabled = false;
        let reservation: { config: RemoteConfig; name: string; token: string } | null = null;
        let reservationNeedsRelease = false;
        const interruption = (): RemoteCancellation | RemoteFault | null => retainedFault ??
            (requestedSignal ? { kind: "cancelled", signal: requestedSignal } : null);
        const recordCleanupFault = (phase: RemoteCleanupPhase, error: unknown) => {
            if (!failedCleanupPhases.has(phase)) {
                failedCleanupPhases.add(phase);
                cleanupFailures.push({ kind: "cleanup-fault", phase, error });
            }
        };
        const cleanup = (phase: RemoteCleanupPhase, operation: () => unknown): boolean => {
            try { operation(); return true; }
            catch (error) { recordCleanupFault(phase, error); return false; }
        };
        const disposePrompt = () => {
            const owned = pendingPrompt; pendingPrompt = null;
            if (owned) cleanup("dispose-prompt", () => owned.cancel());
        };
        const cancelSleep = () => {
            const owned = pendingSleep; pendingSleep = null;
            if (owned) cleanup("cancel-sleep", () => owned.cancel());
        };
        const cancelHeartbeat = () => {
            heartbeatEnabled = false;
            const owned = heartbeat; heartbeat = null;
            if (owned) cleanup("cancel-heartbeat", () => owned.cancel());
        };
        const removeClaim = (held = false): boolean => {
            const owned = remoteSessionLock; remoteSessionLock = null;
            return !owned || cleanup("remove-session-lock", () => held ?
                ports.removeSessionLockInHeldLifecycleLock(owned) : ports.removeSessionLock(owned));
        };
        const forwardSignal = () => {
            if (!requestedSignal || !activeSshProcess || childSignalForwarded) return;
            childSignalForwarded = true;
            const child = activeSshProcess, signal = requestedSignal;
            cleanup("signal-child", () => child.kill(signal));
        };
        const requestSignal = (signal: RemoteSignal) => {
            if (requestedSignal) return;
            requestedSignal = signal;
            disposePrompt();
            cancelSleep();
            forwardSignal();
        };
        const handleSigint = () => requestSignal("SIGINT"), handleSigterm = () => requestSignal("SIGTERM");
        const prompt = async (request: Parameters<typeof ports.prompt>[0]): Promise<string> => {
            const owned = ports.prompt(request, requestSignal); pendingPrompt = owned;
            if (interruption()) disposePrompt();
            try { return await owned.result; }
            finally { if (pendingPrompt === owned) disposePrompt(); }
        };
        const sleep = (milliseconds: number): RemoteSleep => {
            const owned = ports.sleep(milliseconds); pendingSleep = owned;
            if (interruption()) cancelSleep();
            return { completion: owned.completion.then(() => {
                if (pendingSleep === owned) pendingSleep = null;
            }, error => {
                if (pendingSleep === owned) pendingSleep = null;
                throw error;
            }), cancel: () => owned.cancel() };
        };

        async function execute(): Promise<RemoteExecutionResult<Evidence>> {
            let interrupted = interruption();
            if (interrupted) return interrupted;
            const fullPath = ports.resolveProjectPath(projectPath), projectId = ports.getProjectId(fullPath);
            if ((interrupted = interruption())) return interrupted;
            if (!checkMutagen().installed) {
                ports.report({ kind: "mutagen-required" });
                return interruption() ?? { kind: "refused", reason: "mutagen-required" };
            }
            if ((interrupted = interruption())) return interrupted;
            let config = loadRemoteConfig(fullPath);
            if ((interrupted = interruption())) return interrupted;
            if (config && !host) {
                if (!validConfig(config)) {
                    ports.report({ kind: "config-invalid" });
                    return interruption() ?? { kind: "refused", reason: "config-invalid" };
                }
                ports.report({ kind: "saved-config", config });
            } else if (host) {
                if (!isValidHostOrUser(host)) {
                    ports.report({ kind: "host-invalid", host });
                    return interruption() ?? { kind: "refused", reason: "host-invalid" };
                }
                if (!isHostReachable(host)) {
                    ports.report({ kind: "host-unreachable", host });
                    return interruption() ?? { kind: "refused", reason: "host-unreachable" };
                }
                if ((interrupted = interruption())) return interrupted;
                const defaultUser = ports.readUser() || "user";
                if ((interrupted = interruption())) return interrupted;
                const userInput = await prompt({ kind: "user", defaultUser });
                if ((interrupted = interruption())) return interrupted;
                const user = userInput || defaultUser;
                if (!isValidHostOrUser(user)) {
                    ports.report({ kind: "user-invalid", user });
                    return interruption() ?? { kind: "refused", reason: "user-invalid" };
                }
                config = { host, user, remotePath: "" };
                if ((interrupted = interruption())) return interrupted;
                saveRemoteConfig(fullPath, config);
                if ((interrupted = interruption())) return interrupted;
                ports.report({ kind: "config-saved" });
            } else {
                ports.report({ kind: "config-required" });
                return interruption() ?? { kind: "refused", reason: "config-required" };
            }
            if ((interrupted = interruption())) return interrupted;
            if (!config) return { kind: "failed", reason: "config-unresolved" };
            const resolvedConfig = config;
            const syncAuthority = { localPath: fullPath, user: config.user, host: config.host, projectId };
            const remoteContainerPrefix = `remote--${ports.hashRemoteIdentity(`${config.user}@${config.host}`)}--${projectId}`;
            const expectedContainerName = ports.getContainerName(fullPath), token = ports.newReservationToken(), leaseSeconds = 300;
            if ((interrupted = interruption())) return interrupted;
            remoteSessionLock = ports.createSessionLock(remoteContainerPrefix);
            if ((interrupted = interruption())) return interrupted;
            if (!ports.remoteImagePresent(config)) {
                ports.report({ kind: "image-missing" });
                return { kind: "failed", reason: "image-missing" };
            }
            if ((interrupted = interruption())) return interrupted;
            ports.report({ kind: "starting" });
            if ((interrupted = interruption())) return interrupted;
            const reserved = await settleRemoteLifecycleLock(ports, syncLifecyclePrefix(syncAuthority), async () => {
                const interrupted = interruption();
                if (interrupted) return interrupted;
                return settleRemoteLifecycleLock(ports, remoteContainerPrefix,
                    async (): Promise<RemoteReservationResult<Evidence> | RemoteCancellation | RemoteFault> => {
                        const interrupted = interruption();
                        if (interrupted) return interrupted;
                        // Dispatch may create the lease even when no successful result is observed.
                        reservation = { config: resolvedConfig, name: expectedContainerName, token };
                        reservationNeedsRelease = true;
                        return ports.reserveContainer({ config: resolvedConfig, projectPath: fullPath, token, leaseSeconds });
                    }, error => recordCleanupFault("release-container-guard", error));
            }, error => recordCleanupFault("release-sync-guard", error));
            if (reserved.kind === "failed") return { kind: "failed", reason: reserved.reason, evidence: reserved.evidence };
            if (reserved.kind !== "reserved") return reserved;
            if ((interrupted = interruption())) return interrupted;
            const remoteContainer = reserved.container;
            heartbeatEnabled = true;
            heartbeat = ports.startHeartbeat(() => {
                if (!heartbeatEnabled || !reservationNeedsRelease || interruption()) return;
                try {
                    const refreshed = ports.refreshReservation({ config: resolvedConfig, name: remoteContainer.name, containerId: remoteContainer.id, token, leaseSeconds });
                    if (!refreshed && !interruption()) ports.report({ kind: "refresh-failed" });
                } catch (error) {
                    retainedFault ??= { kind: "fault", error };
                    disposePrompt();
                    cancelSleep();
                }
            }, 30_000);
            if ((interrupted = interruption())) return interrupted;
            heartbeat.unref();
            if ((interrupted = interruption())) return interrupted;
            const prepared = ports.prepareRemoteProject({ config: resolvedConfig, containerId: remoteContainer.id, projectId });
            if (!prepared.ok) return { kind: "failed", reason: "project-prepare-failed", evidence: prepared.evidence };
            if ((interrupted = interruption())) return interrupted;
            const ensured = await ensureSync({ ...syncAuthority, containerId: remoteContainer.id }, remoteContainer.name, interruption);
            for (const failure of ensured.cleanupFailures ?? []) {
                if (failure.kind === "cleanup-fault") recordCleanupFault(failure.phase, failure.error);
                else cleanupFailures.push(failure);
            }
            if (ensured.kind !== "ready") return ensured;
            if ((interrupted = interruption())) return interrupted;
            const syncHandle = ensured.handle;
            const waited = await waitForSync(syncHandle, 120000, interruption, sleep);
            if (waited.kind !== "ready") return waited;
            if ((interrupted = interruption())) return interrupted;
            ports.report({ kind: "connecting", host: resolvedConfig.host });
            if ((interrupted = interruption())) return interrupted;
            const forwardedEnvPlan = ports.collectCurrentForwardedEnv();
            if ((interrupted = interruption())) return interrupted;
            if (forwardedEnvPlan.skippedDueToLimit.length > 0) ports.report({ kind: "env-skipped", count: forwardedEnvPlan.skippedDueToLimit.length });
            if ((interrupted = interruption())) return interrupted;
            const sshProcess = ports.startInteractiveSession({ config: resolvedConfig, containerId: remoteContainer.id, projectId, arguments: args, environment: forwardedEnvPlan.forwarded });
            activeSshProcess = sshProcess;
            const exitCode = await new Promise<number>(resolve => {
                let firstCode: number | undefined, errorReported = false;
                sshProcess.onClose(code => { firstCode ??= code ?? 0; resolve(firstCode); });
                sshProcess.onError(error => {
                    firstCode ??= 1;
                    if (!errorReported) {
                        errorReported = true;
                        try { ports.report({ kind: "ssh-error", error }); }
                        catch (error) { retainedFault ??= { kind: "fault", error }; }
                    }
                });
                forwardSignal();
            });
            activeSshProcess = null;
            if ((interrupted = interruption())) return interrupted;
            if (exitCode === 0) {
                const answer = await prompt({ kind: "cleanup" });
                if ((interrupted = interruption())) return interrupted;
                if (answer === "y" || answer === "yes") {
                    const stopContainer = (): RemoteExecutionResult<Evidence> => {
                        let interrupted = interruption();
                        if (interrupted) return interrupted;
                        if (!removeClaim(true)) return { kind: "completed", exitCode };
                        if ((interrupted = interruption())) return interrupted;
                        ports.report({ kind: "stopping" });
                        if ((interrupted = interruption())) return interrupted;
                        const stopped = ports.stopReservedContainer({ config: resolvedConfig, name: remoteContainer.name, containerId: remoteContainer.id, token });
                        if (stopped.kind === "failed") return { kind: "failed", reason: "stop-failed", evidence: stopped.evidence };
                        // Both proved results have consumed this invocation's exact token.
                        reservationNeedsRelease = false;
                        cancelHeartbeat();
                        if ((interrupted = interruption())) return interrupted;
                        if (stopped.kind === "busy") {
                            ports.report({ kind: "peer-active" });
                            return interruption() ?? { kind: "completed", exitCode };
                        }
                        const observation = observeCapturedSync(syncHandle);
                        if (observation.kind === "missing") return interruption() ?? { kind: "completed", exitCode };
                        if (observation.kind === "unknown" || observation.kind === "conflict") {
                            return { kind: "failed", reason: observation.kind === "unknown" ? "sync-unknown" : "sync-conflict", evidence: observation.evidence };
                        }
                        if ((interrupted = interruption())) return interrupted;
                        ports.report({ kind: "pausing" });
                        if ((interrupted = interruption())) return interrupted;
                        const paused = ports.pauseSync(syncHandle.identifier);
                        if (!paused.ok) return { kind: "failed", reason: "sync-pause-failed", evidence: paused.evidence };
                        return interruption() ?? { kind: "completed", exitCode };
                    };
                    const stopOutcome = await settleRemoteLifecycleLock(ports, syncLifecyclePrefix(syncAuthority), async (): Promise<RemoteExecutionResult<Evidence>> => {
                        const interrupted = interruption();
                        if (interrupted) return interrupted;
                        const callback: { outcome?: RemoteExecutionResult<Evidence> } = {};
                        try {
                            ports.withLifecycleLock(remoteContainerPrefix, () => {
                                try { callback.outcome = stopContainer(); }
                                catch (error) { callback.outcome = { kind: "fault", error }; }
                                return undefined;
                            });
                        } catch (error) {
                            if (!callback.outcome) return { kind: "fault", error };
                            if (!["failed", "fault", "cancelled"].includes(callback.outcome.kind)) return { kind: "fault", error };
                            recordCleanupFault("release-container-guard", error);
                        }
                        return callback.outcome!;
                    }, error => recordCleanupFault("release-sync-guard", error));
                    if (stopOutcome.kind !== "completed") return stopOutcome;
                    if ((interrupted = interruption())) return interrupted;
                }
            }
            return { kind: "completed", exitCode };
        }

        let result: RemoteExecutionResult<Evidence>;
        try {
            ports.onSignal("SIGINT", handleSigint);
            ports.onSignal("SIGTERM", handleSigterm);
            result = await execute();
            if (result.kind === "fault") result = retainedFault ?? result;
        } catch (error) { result = retainedFault ?? { kind: "fault", error }; }
        finally {
            disposePrompt();
            cancelSleep();
            cancelHeartbeat();
            if (reservationNeedsRelease && reservation) {
                reservationNeedsRelease = false;
                const owned = reservation;
                cleanup("release-reservation", () => {
                    const released = ports.releaseReservation(owned);
                    if (!released.ok) cleanupFailures.push({ kind: "release-failed", evidence: released.evidence });
                });
            }
            removeClaim();
            cleanup("remove-SIGINT-listener", () => ports.removeSignalListener("SIGINT", handleSigint));
            cleanup("remove-SIGTERM-listener", () => ports.removeSignalListener("SIGTERM", handleSigterm));
        }
        if (result.kind !== "failed" && result.kind !== "fault") result = interruption() ?? result;
        return { ...result, cleanupFailures };
    }

    async function remoteSetup(): Promise<void> {
        ports.report({ kind: "setup-start" });
        const tailscale = checkTailscale();
        const mutagen = checkMutagen();
        ports.report({ kind: "tool-status", tool: "tailscale", observation: tailscale });
        ports.report({ kind: "tool-status", tool: "mutagen", observation: mutagen });
        if (!tailscale.installed) ports.report({ kind: "tool-install-guide", tool: "tailscale" });
        if (!mutagen.installed) ports.report({ kind: "tool-install-guide", tool: "mutagen" });
        if (!tailscale.installed || !mutagen.installed) {
            ports.report({ kind: "setup-tools-missing" });
            return;
        }
        ports.report({ kind: "setup-usage" });
        ports.report({ kind: "setup-architecture" });
        ports.report({ kind: "setup-requirements" });
    }

    async function remoteCheck(projectPath: string): Promise<void> {
        const fullPath = ports.resolveProjectPath(projectPath);
        ports.report({ kind: "status-start" });
        ports.report({ kind: "status-tools" });
        const tailscale = checkTailscale();
        const mutagen = checkMutagen();
        ports.report({ kind: "tool-status", tool: "tailscale", observation: tailscale });
        ports.report({ kind: "tool-status", tool: "mutagen", observation: mutagen });

        ports.report({ kind: "status-config" });
        const config = loadRemoteConfig(fullPath);
        if (config && validConfig(config)) {
            ports.report({ kind: "status-config-saved", config, containerName: ports.getContainerName(fullPath) });
            ports.report({ kind: "host-status", reachable: isHostReachable(config.host) });
        } else if (config) {
            ports.report({ kind: "config-invalid" });
        } else {
            ports.report({ kind: "status-config-missing" });
        }

        ports.report({ kind: "status-sync" });
        if (mutagen.installed) {
            if (config && validConfig(config)) {
                const authority = { localPath: fullPath, user: config.user, host: config.host, projectId: ports.getProjectId(fullPath) };
                const sessionName = ports.getScopedMutagenSessionName(authority);
                const observation = inspectSync(authority);
                if (observation.kind === "observed") ports.report({ kind: "status-sync-active", sessionName, observation });
                else if (observation.kind === "missing") ports.report({ kind: "status-sync-missing", sessionName });
                else if (observation.kind === "unknown") ports.report({ kind: "status-sync-unknown" });
                else ports.report({ kind: "status-sync-conflict" });
            } else {
                ports.report({ kind: "status-sync-unknown" });
            }
        } else {
            ports.report({ kind: "status-sync-unavailable" });
        }
        ports.report({ kind: "status-end" });
    }

    async function remoteTerminate(projectPath: string): Promise<RemoteTerminateOutcome<Evidence>> {
        const cleanupFailures: RemoteCleanupFailure<Evidence>[] = [];
        const finish = (outcome: RemoteTerminateOutcome<Evidence>): RemoteTerminateOutcome<Evidence> =>
            cleanupFailures.length > 0 ? { ...outcome, cleanupFailures } : outcome;
        try {
            const fullPath = ports.resolveProjectPath(projectPath);
            const config = loadRemoteConfig(fullPath);
            if (!config) {
                ports.report({ kind: "config-required" });
                return { kind: "failed", reason: "config-unresolved" };
            }
            if (!validConfig(config)) {
                ports.report({ kind: "config-invalid" });
                return { kind: "failed", reason: "config-invalid" };
            }
            const authority = { localPath: fullPath, user: config.user, host: config.host, projectId: ports.getProjectId(fullPath) };
            return finish(await settleRemoteLifecycleLock(ports, syncLifecyclePrefix(authority), async (): Promise<RemoteTerminateOutcome<Evidence>> => {
                const observation = inspectSync(authority);
                if (observation.kind === "missing") {
                    ports.report({ kind: "sync-inactive" });
                    return { kind: "completed", state: "inactive" };
                }
                if (observation.kind === "unknown") return { kind: "failed", reason: "sync-unknown", evidence: observation.evidence };
                if (observation.kind === "conflict") return { kind: "failed", reason: "sync-conflict", evidence: observation.evidence };
                ports.report({ kind: "sync-terminating", sessionName: observation.name });
                const terminated = ports.terminateSync(observation.identifier);
                if (!terminated.ok) return { kind: "failed", reason: "sync-terminate-failed", evidence: terminated.evidence };
                ports.report({ kind: "sync-terminated" });
                return { kind: "completed", state: "terminated" };
            }, error => cleanupFailures.push({ kind: "cleanup-fault", phase: "release-sync-guard", error })));
        } catch (error) { return finish({ kind: "fault", error }); }
    }

    return { checkTailscale, checkMutagen, isHostReachable, remoteExec, remoteSetup, remoteCheck, remoteTerminate };
}
