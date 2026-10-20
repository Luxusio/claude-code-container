import { isValidHostOrUser, type RemoteConfig, type RemoteContainer, type RemoteHeartbeat, type RemoteSshChannel, type RemoteSignal } from "../domain/remote-services.js";
import type { RemoteServicesPorts } from "../ports/remote-services.js";
import { createRemoteSync } from "./remote-sync.js";

export function createRemoteServices<Evidence>(ports: RemoteServicesPorts<Evidence>) {
    const { ensureSync, inspectSync, observeCapturedSync, waitForSync, syncLifecyclePrefix } = createRemoteSync(ports);
    const checkTailscale = () => ports.observeTool("tailscale");
    const checkMutagen = () => ports.observeTool("mutagen");
    const isHostReachable = (host: string): boolean => ports.isHostReachable(host);
    const validConfig = (config: RemoteConfig): boolean => typeof config.host === "string" && typeof config.user === "string" &&
        isValidHostOrUser(config.host) && isValidHostOrUser(config.user);

    async function ensureRemoteImage(config: RemoteConfig): Promise<void> {
        if (!ports.remoteImagePresent(config)) {
            ports.report({ kind: "image-missing" });
            ports.fail("image-missing");
        }
    }

    async function startRemoteContainer(config: RemoteConfig, projectPath: string, token: string, leaseSeconds: number, profile?: string): Promise<RemoteContainer> {
        const result = ports.reserveContainer({ config, projectPath, profile, token, leaseSeconds });
        if (result.kind === "failed") ports.fail(result.reason, result.evidence);
        return result.container;
    }

    async function createContainerProjectDir(config: RemoteConfig, containerId: string, projectId: string): Promise<void> {
        const result = ports.prepareRemoteProject({ config, containerId, projectId });
        if (!result.ok) ports.fail("project-prepare-failed", result.evidence);
    }

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

    async function remoteExec(projectPath: string, host?: string, args: string[] = []): Promise<void> {
        const fullPath = ports.resolveProjectPath(projectPath);
        const projectId = ports.getProjectId(fullPath);

        const mutagen = checkMutagen();
        if (!mutagen.installed) {
            ports.report({ kind: "mutagen-required" });
            ports.exit(1);
        }

        let config = loadRemoteConfig(fullPath);

        if (config && !host) {
            if (!validConfig(config)) {
                ports.report({ kind: "config-invalid" });
                ports.exit(1);
            }
            ports.report({ kind: "saved-config", config });
        } else if (host) {
            if (!isValidHostOrUser(host)) {
                ports.report({ kind: "host-invalid", host });
                ports.exit(1);
            }

            if (!isHostReachable(host)) {
                ports.report({ kind: "host-unreachable", host });
                ports.exit(1);
            }

            const defaultUser = ports.readUser() || "user";
            const userInput = await ports.prompt({ kind: "user", defaultUser });
            const user = userInput || defaultUser;

            if (!isValidHostOrUser(user)) {
                ports.report({ kind: "user-invalid", user });
                ports.exit(1);
            }

            config = { host, user, remotePath: "" };
            saveRemoteConfig(fullPath, config);
            ports.report({ kind: "config-saved" });
        } else {
            ports.report({ kind: "config-required" });
            ports.exit(1);
        }

        if (!config) ports.fail("config-unresolved");
        const resolvedConfig = config;
        const syncAuthority = { localPath: fullPath, user: resolvedConfig.user, host: resolvedConfig.host, projectId };
        const remoteContainerPrefix = `remote--${ports.hashRemoteIdentity(`${resolvedConfig.user}@${resolvedConfig.host}`)}--${projectId}`;
        const expectedContainerName = ports.getContainerName(fullPath);
        const remoteReservationToken = ports.newReservationToken();
        const remoteReservationLeaseSeconds = 300;
        let remoteReservationActive = false;
        let remoteReservationHeartbeat: RemoteHeartbeat | null = null;
        let activeSshProcess: RemoteSshChannel | null = null;
        let requestedSignal: RemoteSignal | null = null;
        const releaseRemoteReservation = () => {
            if (!remoteReservationActive) return;
            remoteReservationActive = false;
            if (remoteReservationHeartbeat) remoteReservationHeartbeat.cancel();
            remoteReservationHeartbeat = null;
            ports.releaseReservation({ config: resolvedConfig, name: expectedContainerName, token: remoteReservationToken });
        };
        let remoteSessionLock = ports.createSessionLock(remoteContainerPrefix);
        let requestedExitCode = 0;
        const cleanupRemoteSession = () => {
            releaseRemoteReservation();
            if (!remoteSessionLock) return;
            ports.removeSessionLock(remoteSessionLock);
            remoteSessionLock = "";
        };
        const forwardSignalAfterCleanup = (signal: RemoteSignal) => {
            requestedSignal = requestedSignal || signal;
            ports.removeSignalListener("SIGINT", handleSigint);
            ports.removeSignalListener("SIGTERM", handleSigterm);
            if (activeSshProcess) {
                activeSshProcess.kill(signal);
                return;
            }
            cleanupRemoteSession();
            ports.resignalSelf(signal);
        };
        const handleSigint = () => forwardSignalAfterCleanup("SIGINT");
        const handleSigterm = () => forwardSignalAfterCleanup("SIGTERM");
        ports.onceSignal("SIGINT", handleSigint);
        ports.onceSignal("SIGTERM", handleSigterm);

        try {
            await ensureRemoteImage(resolvedConfig);

            ports.report({ kind: "starting" });
            remoteReservationActive = true;
            const remoteContainer = await ports.withLifecycleLockAsync(
                syncLifecyclePrefix(syncAuthority),
                () => ports.withLifecycleLockAsync(remoteContainerPrefix,
                    () => startRemoteContainer(resolvedConfig, fullPath, remoteReservationToken, remoteReservationLeaseSeconds)),
            );
            remoteReservationHeartbeat = ports.startHeartbeat(() => {
                if (!remoteReservationActive) return;
                const refreshed = ports.refreshReservation({ config: resolvedConfig, name: remoteContainer.name, containerId: remoteContainer.id, token: remoteReservationToken, leaseSeconds: remoteReservationLeaseSeconds });
                if (!refreshed) ports.report({ kind: "refresh-failed" });
            }, 30_000);
            remoteReservationHeartbeat.unref();

            await createContainerProjectDir(resolvedConfig, remoteContainer.id, projectId);
            const syncHandle = await ensureSync({ ...syncAuthority, containerId: remoteContainer.id }, remoteContainer.name);
            await waitForSync(syncHandle);

            ports.report({ kind: "connecting", host: resolvedConfig.host });
            const forwardedEnvPlan = ports.collectCurrentForwardedEnv();
            if (forwardedEnvPlan.skippedDueToLimit.length > 0) {
                ports.report({ kind: "env-skipped", count: forwardedEnvPlan.skippedDueToLimit.length });
            }
            const sshProcess = ports.startInteractiveSession({ config: resolvedConfig, containerId: remoteContainer.id, projectId, arguments: args, environment: forwardedEnvPlan.forwarded });
            activeSshProcess = sshProcess;

            const exitCode = await new Promise<number>((resolve) => {
                sshProcess.onClose((code) => {
                    resolve(code ?? 0);
                });
                sshProcess.onError((error) => {
                    ports.report({ kind: "ssh-error", error });
                    resolve(1);
                });
            });
            activeSshProcess = null;

            if (exitCode === 0 && !requestedSignal) {
                const answer = await ports.prompt({ kind: "cleanup" });
                if (answer === "y" || answer === "yes") {
                    await ports.withLifecycleLockAsync(syncLifecyclePrefix(syncAuthority), async () => ports.withLifecycleLock(remoteContainerPrefix, () => {
                        ports.removeSessionLockInHeldLifecycleLock(remoteSessionLock);
                        remoteSessionLock = "";
                        ports.report({ kind: "stopping" });
                        const stopped = ports.stopReservedContainer({ config: resolvedConfig, name: remoteContainer.name, containerId: remoteContainer.id, token: remoteReservationToken });
                        if (stopped.kind === "busy") {
                            remoteReservationActive = false;
                            if (remoteReservationHeartbeat) remoteReservationHeartbeat.cancel();
                            remoteReservationHeartbeat = null;
                            ports.report({ kind: "peer-active" });
                            return undefined;
                        }
                        if (stopped.kind === "failed") ports.fail("stop-failed", stopped.evidence);
                        remoteReservationActive = false;
                        if (remoteReservationHeartbeat) remoteReservationHeartbeat.cancel();
                        remoteReservationHeartbeat = null;
                        const observation = observeCapturedSync(syncHandle);
                        if (observation.kind === "missing") return undefined;
                        if (observation.kind === "unknown") ports.fail("sync-unknown", observation.evidence);
                        if (observation.kind === "conflict") ports.fail("sync-conflict", observation.evidence);
                        ports.report({ kind: "pausing" });
                        const paused = ports.pauseSync(syncHandle.identifier);
                        if (!paused.ok) ports.fail("sync-pause-failed", paused.evidence);
                        return undefined;
                    }));
                }
            }

            requestedExitCode = exitCode;
        } catch (error) {
            ports.report({ kind: "unexpected-error", error });
            requestedExitCode = 1;
        } finally {
            ports.removeSignalListener("SIGINT", handleSigint);
            ports.removeSignalListener("SIGTERM", handleSigterm);
            cleanupRemoteSession();
        }
        if (requestedSignal) ports.resignalSelf(requestedSignal);
        else ports.exit(requestedExitCode);
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

    async function remoteTerminate(projectPath: string): Promise<void> {
        const fullPath = ports.resolveProjectPath(projectPath);
        const config = loadRemoteConfig(fullPath);
        if (!config) {
            ports.report({ kind: "config-required" });
            ports.fail("config-unresolved");
        }
        if (!validConfig(config)) {
            ports.report({ kind: "config-invalid" });
            ports.fail("config-invalid");
        }
        const authority = { localPath: fullPath, user: config.user, host: config.host, projectId: ports.getProjectId(fullPath) };
        await ports.withLifecycleLockAsync(syncLifecyclePrefix(authority), async () => {
            const observation = inspectSync(authority);
            if (observation.kind === "missing") {
                ports.report({ kind: "sync-inactive" });
                return;
            }
            if (observation.kind === "unknown") ports.fail("sync-unknown", observation.evidence);
            if (observation.kind === "conflict") ports.fail("sync-conflict", observation.evidence);
            ports.report({ kind: "sync-terminating", sessionName: observation.name });
            const terminated = ports.terminateSync(observation.identifier);
            if (!terminated.ok) ports.fail("sync-terminate-failed", terminated.evidence);
            ports.report({ kind: "sync-terminated" });
        });
    }

    return { checkTailscale, checkMutagen, isHostReachable, remoteExec, remoteSetup, remoteCheck, remoteTerminate };
}
