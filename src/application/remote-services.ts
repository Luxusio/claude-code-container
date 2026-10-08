import { isValidHostOrUser, shellEscapeArg, type RemoteConfig, type RemoteHeartbeat, type RemoteSshChannel, type RemoteSignal } from "../domain/remote-services.js";
import type { RemoteServicesPorts } from "../ports/remote-services.js";
import { createRemoteSync, observeRemoteSyncStatus } from "./remote-sync.js";

export function createRemoteServices(ports: RemoteServicesPorts) {
    for (const name of REMOTE_SERVICE_PORT_NAMES) {
        if (typeof ports?.[name] !== "function") throw new TypeError(`Remote services require a callable ${name} port.`);
    }
    const { ensureSync, waitForSync } = createRemoteSync(ports);
function checkTool(cmd: "tailscale" | "mutagen"): {installed: boolean; version?: string} {
    const result = ports.observeTool(cmd);
    if (result.error || result.status !== 0) {
        return {installed: false};
    }
    const version = (result.stdout ?? "").split("\n")[0].trim();
    return {installed: true, version};
}

const checkTailscale = () => checkTool("tailscale");
const checkMutagen = () => checkTool("mutagen");

// === Connectivity ===

function isHostReachable(host: string): boolean {
    const result = ports.observeHostReachability(host);
    return result.status === 0;
}

function getMutagenSyncStatus(sessionName: string): string | null { return observeRemoteSyncStatus(ports, sessionName); }
async function ensureRemoteImage(config: RemoteConfig): Promise<void> {
    // Check if image exists on remote
    const result = ports.observeRemoteImage(config);

    if (!result.stdout?.trim()) {
        ports.captureLog()("Building ccc image on remote host...");
        // Need to sync Dockerfile and build on remote, or pull from registry
        // For now, assume ccc is installed on remote and image exists
        throw new Error("ccc image not found on remote. Run 'ccc' on the remote host first to build the image.");
    }
}

async function startRemoteContainer(config: RemoteConfig, projectPath: string, reservationToken: string, reservationLeaseSeconds: number, profile?: string): Promise<{ name: string; id: string }> {
    const containerName = ports.getContainerName(projectPath, profile);
    const dockerCmd = ports.buildContainerStartShell(projectPath, profile);

    const result = ports.runReservation(config, () => ports.buildReservationShell(containerName, reservationToken, reservationLeaseSeconds, dockerCmd, true));

    if (result.status !== 0) {
        throw new Error(`Failed to start remote container: ${result.stderr}`);
    }

    const match = (result.stdout ?? "").match(/^ccc-container-id=([a-fA-F0-9]{12,64})$/m);
    if (!match) {
        throw new Error("Failed to start remote container: stable container ID was not returned");
    }
    return { name: containerName, id: match[1] };
}

/**
 * Create directory in container for project
 */
async function createContainerProjectDir(config: RemoteConfig, containerName: string, projectId: string): Promise<void> {
    const result = ports.prepareRemoteProject(config, containerName, projectId);
    if (result.error || result.status !== 0) {
        throw new Error(`Failed to prepare remote container project directory: ${result.stderr || result.error?.message || "unknown error"}`);
    }
}

function printSection(title: string): void {
    ports.captureLog()(`\n=== ${title} ===\n`);
}

function printStatus(label: string, ok: boolean, detail?: string): void {
    const icon = ok ? "[OK]" : "[--]";
    const detailStr = detail ? ` (${detail})` : "";
    ports.captureLog()(`  ${icon} ${label}${detailStr}`);
}

// === Config Storage ===

// Remote configs live in ~/.ccc/config.json under "remote"; configs saved by
// older versions in ~/.ccc/remote/<hash>.json are still read
// (doc/common/REQ__ccc-home-layout.md).
function loadRemoteConfig(projectPath: string): RemoteConfig | null {
    const hash = ports.getProjectHash(projectPath);
    const remote = ports.readSettings().remote;
    if (remote && typeof remote === "object" && !Array.isArray(remote)) {
        const saved = (remote as Record<string, unknown>)[hash];
        if (saved && typeof saved === "object") return saved as RemoteConfig;
    }
    const legacyReader = ports.captureLegacyConfigReader(hash);
    if (!legacyReader.exists()) {
        return null;
    }
    try {
        return JSON.parse(legacyReader.readText()) as RemoteConfig;
    } catch {
        return null;
    }
}

function saveRemoteConfig(projectPath: string, config: RemoteConfig): void {
    const hash = ports.getProjectHash(projectPath);
    ports.updateSettings((settings) => {
        const remote = settings.remote && typeof settings.remote === "object" && !Array.isArray(settings.remote)
            ? settings.remote as Record<string, unknown>
            : {};
        remote[hash] = config;
        settings.remote = remote;
        return undefined;
    });
}

async function remoteExec(projectPath: string, host?: string, args: string[] = []): Promise<void> {
    const fullPath = ports.resolveProjectPath(projectPath);
    const projectId = ports.getProjectId(fullPath);

    // Check required tools
    const mutagen = checkMutagen();
    if (!mutagen.installed) {
        ports.captureError()("Mutagen is not installed. Run 'ccc remote setup' for installation guide.");
        ports.exit(1);
    }

    // Load or create config
    let config = loadRemoteConfig(fullPath);

    if (config && !host) {
        // Validate loaded config values (defense against tampered config files)
        if (!isValidHostOrUser(config.host) || !isValidHostOrUser(config.user)) {
            ports.captureError()("Saved remote config contains invalid host or user. Please reconfigure with 'ccc remote <host>'.");
            ports.exit(1);
        }
        // Use saved config
        ports.captureLog()(`Using saved config: ${config.user}@${config.host}`);
    } else if (host) {
        // Create/update config with provided host
        if (!isValidHostOrUser(host)) {
            ports.captureError()(`Invalid hostname: ${host}. Only alphanumeric, dots, hyphens, and underscores allowed.`);
            ports.exit(1);
        }

        if (!isHostReachable(host)) {
            ports.captureError()(`Host ${host} is not reachable. Check if it's online and accessible.`);
            ports.exit(1);
        }

        const defaultUser = ports.readUser() || "user";
        const userInput = await ports.prompt(`Remote user [${defaultUser}]: `);
        const user = userInput || defaultUser;

        if (!isValidHostOrUser(user)) {
            ports.captureError()(`Invalid username: ${user}. Only alphanumeric, dots, hyphens, and underscores allowed.`);
            ports.exit(1);
        }

        config = {host, user, remotePath: ""};  // remotePath not used anymore
        saveRemoteConfig(fullPath, config);
        ports.captureLog()("Config saved.");
    } else {
        // No config and no host provided
        ports.captureError()("No saved remote config found.");
        ports.captureError()("Usage: ccc remote <host>");
        ports.captureError()("       ccc remote           (after initial setup)");
        ports.exit(1);
    }

    if (!config) {
        throw new Error("Remote configuration could not be resolved");
    }
    const resolvedConfig = config;
    const remoteContainerPrefix = `remote--${ports.captureHashPath()(`${resolvedConfig.user}@${resolvedConfig.host}`)}--${projectId}`;
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
        ports.runRelease(resolvedConfig, () => ports.buildReleaseShell(expectedContainerName, remoteReservationToken));
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
        ports.resignalSelf( signal);
    };
    const handleSigint = () => forwardSignalAfterCleanup("SIGINT");
    const handleSigterm = () => forwardSignalAfterCleanup("SIGTERM");
    ports.onceSignal("SIGINT", handleSigint);
    ports.onceSignal("SIGTERM", handleSigterm);

    try {
        // 1. Ensure ccc image exists on remote
        await ensureRemoteImage(resolvedConfig);

        // 2. Start container on remote (without project volume mount)
        ports.captureLog()("Starting remote container...");
        remoteReservationActive = true;
        const remoteContainer = await ports.withLifecycleLockAsync(
            remoteContainerPrefix,
            () => startRemoteContainer(resolvedConfig, fullPath, remoteReservationToken, remoteReservationLeaseSeconds),
        );
        remoteReservationHeartbeat = ports.startHeartbeat(() => {
            if (!remoteReservationActive) return;
            const refreshed = ports.runRefresh(resolvedConfig, () => ports.buildRefreshShell(remoteContainer.name, remoteReservationToken, remoteReservationLeaseSeconds, true, remoteContainer.id));
            if (refreshed.status !== 0) ports.captureError()("Remote session lease refresh failed; container stop protection may expire.");
        }, 30_000);
        remoteReservationHeartbeat.unref();

        // 3. Create project directory in container
        await createContainerProjectDir(resolvedConfig, remoteContainer.id, projectId);

        // 4. Ensure mutagen sync to container is running
        const sessionName = await ensureSync(fullPath, resolvedConfig, remoteContainer.id, remoteContainer.name);

        // 5. Wait for initial sync
        await waitForSync(sessionName);

        // 6. Run claude via docker exec
        ports.captureLog()(`Connecting to ${resolvedConfig.host}...`);

        const claudeArgs = args.length > 0 ? args.map(shellEscapeArg).join(" ") : "--dangerously-skip-permissions";

        // Collect environment variables to forward without blowing up the remote docker exec environment.
        const envFlags: string[] = [];
        // Container marker: enables per-project env separation via mise.toml [env] conditionals
        envFlags.push(`-e ${shellEscapeArg(`${ports.readContainerEnvKey()}=${ports.readContainerEnvValue()}`)}`);
        const forwardedEnvPlan = ports.collectCurrentForwardedEnv();
        for (const [key, value] of forwardedEnvPlan.forwarded) {
            envFlags.push(`-e ${shellEscapeArg(`${key}=${value}`)}`);
        }
        if (forwardedEnvPlan.skippedDueToLimit.length > 0) {
            ports.captureError()(
                `Skipped ${forwardedEnvPlan.skippedDueToLimit.length} host env var(s) to keep remote exec size bounded; use --env KEY=VALUE for required overrides.`,
            );
        }
        const envString = envFlags.join(" ");

        const containerProgram = `cd ${shellEscapeArg(`/project/${projectId}`)} && mise trust . 2>/dev/null; mise install -y || true; exec claude ${claudeArgs}`;
        const encodedProgram = ports.encodeProgram(containerProgram);
        const decoder = `printf %s ${shellEscapeArg(encodedProgram)} | base64 -d | sh`;
        const execCmd = `docker exec ${envString} -it ${remoteContainer.id} sh -c ${shellEscapeArg(decoder)}`;

        const sshProcess = ports.startInteractiveSsh(resolvedConfig, execCmd);
        activeSshProcess = sshProcess;

        // Wait for SSH to exit
        const exitCode = await new Promise<number>((resolve) => {
            sshProcess.onClose( (code) => {
                resolve(code ?? 0);
            });
            sshProcess.onError( (err) => {
                ports.captureError()(`SSH error: ${err.message}`);
                resolve(1);
            });
        });
        activeSshProcess = null;

        // 7. Cleanup prompt on exit
        if (exitCode === 0 && !requestedSignal) {
            const answer = await ports.prompt("\nStop container and pause sync? [y/N]: ", true);
            if (answer === "y" || answer === "yes") {
                ports.withLifecycleLock(remoteContainerPrefix, () => {
                    ports.removeSessionLock(remoteSessionLock);
                    ports.captureLog()("Stopping container...");
                    const stopped = ports.runStop(resolvedConfig, () => ports.buildStopShell(remoteContainer.name, remoteReservationToken, remoteContainer.id));
                    if (stopped.status === 42 || stopped.stdout?.includes("ccc-remote-sessions-active")) {
                        remoteReservationActive = false;
                        if (remoteReservationHeartbeat) remoteReservationHeartbeat.cancel();
                        remoteReservationHeartbeat = null;
                        ports.captureLog()("Remote container remains running: another CCC remote session is active.");
                        return undefined;
                    }
                    if (stopped.status !== 0) throw new Error(`Failed to stop remote container: ${stopped.stderr || stopped.status}`);
                    remoteReservationActive = false;
                    if (remoteReservationHeartbeat) remoteReservationHeartbeat.cancel();
                    remoteReservationHeartbeat = null;
                    ports.captureLog()("Pausing sync...");
                    ports.pauseSync(sessionName);
                    return undefined;
                });
                remoteSessionLock = "";
            }
        }

        requestedExitCode = exitCode;
    } catch (err) {
        ports.captureError()(`Error: ${err instanceof Error ? err.message : err}`);
        requestedExitCode = 1;
    } finally {
        ports.removeSignalListener("SIGINT", handleSigint);
        ports.removeSignalListener("SIGTERM", handleSigterm);
        cleanupRemoteSession();
    }
    if (requestedSignal) ports.resignalSelf( requestedSignal);
    else ports.exit(requestedExitCode);
}

async function remoteSetup(): Promise<void> {
    printSection("CCC Remote Setup Guide");

    // Check tools
    ports.captureLog()("Checking required tools:\n");

    const tailscale = checkTailscale();
    const mutagen = checkMutagen();

    printStatus("Tailscale", tailscale.installed, tailscale.version);
    printStatus("Mutagen", mutagen.installed, mutagen.version);

    if (!tailscale.installed) {
        ports.captureLog()(`
  Tailscale not found. Install it:
    macOS:   brew install tailscale
    Linux:   curl -fsSL https://tailscale.com/install.sh | sh
    Manual:  https://tailscale.com/download`);
    }

    if (!mutagen.installed) {
        ports.captureLog()(`
  Mutagen not found. Install it:
    macOS:   brew install mutagen-io/mutagen/mutagen
    Linux:   Download from https://github.com/mutagen-io/mutagen/releases
    Manual:  https://mutagen.io/documentation/introduction/installation`);
    }

    if (!tailscale.installed || !mutagen.installed) {
        ports.captureLog()("\nPlease install missing tools and run 'ccc remote setup' again.");
        return;
    }

    printSection("Usage");

    ports.captureLog()(`First time setup:
  $ ccc remote my-desktop
  Remote user [user]: john
  Config saved.
  Starting remote container...
  Creating sync session...
  Waiting for initial sync... done
  Connecting to my-desktop...
  [Now in claude on desktop]

Subsequent runs:
  $ ccc remote
  Using saved config: john@my-desktop
  Starting remote container...
  Sync already running
  Connecting to my-desktop...

Pass arguments to claude:
  $ ccc remote my-desktop --continue
  $ ccc remote my-desktop --resume`);

    printSection("Architecture");

    ports.captureLog()(`Files sync directly from your Mac to a Docker container on the remote:
  1. Container started on remote (without project volume mount)
  2. Mutagen syncs: MacBook -> Docker container on remote
  3. Claude runs inside the container via docker exec

This avoids intermediate filesystem copies on the remote host.`);

    printSection("Requirements");

    ports.captureLog()(`1. SSH access to remote host (key-based auth recommended)
2. ccc installed on remote host (run 'ccc' once to build the image)
3. Docker running on remote host
4. Network connectivity (Tailscale recommended for remote access)

Config is stored per-project in ~/.ccc/config.json under "remote"`);
}

/**
 * Display connectivity and sync status
 */
async function remoteCheck(projectPath: string): Promise<void> {
    printSection("CCC Remote Status");

    // Tools
    ports.captureLog()("Tools:");
    const tailscale = checkTailscale();
    const mutagen = checkMutagen();
    printStatus("Tailscale", tailscale.installed, tailscale.version);
    printStatus("Mutagen", mutagen.installed, mutagen.version);

    // Config
    ports.captureLog()("\nConfig:");
    const config = loadRemoteConfig(projectPath);
    if (config) {
        ports.captureLog()(`  Host: ${config.host}`);
        ports.captureLog()(`  User: ${config.user}`);
        ports.captureLog()(`  Container: ${ports.getContainerName(projectPath)}`);

        // Check host reachability
        const reachable = isHostReachable(config.host);
        printStatus("Host reachable", reachable);
    } else {
        ports.captureLog()("  No config saved for this project.");
        ports.captureLog()("  Run 'ccc remote <host>' to set up.");
    }

    // Mutagen sync status
    ports.captureLog()("\nSync:");
    if (mutagen.installed) {
        const sessionName = ports.getMutagenSessionName(projectPath);
        const syncStatus = getMutagenSyncStatus(sessionName);

        if (syncStatus) {
            printStatus(`Session '${sessionName}'`, true, syncStatus);
        } else {
            ports.captureLog()(`  No active sync session.`);
            ports.captureLog()(`  Session name would be: ${sessionName}`);
        }
    } else {
        ports.captureLog()("  (mutagen not installed)");
    }

    ports.captureLog()("");
}

/**
 * Terminate sync session for project
 */
async function remoteTerminate(projectPath: string): Promise<void> {
    const sessionName = ports.getMutagenSessionName(projectPath);
    const status = getMutagenSyncStatus(sessionName);

    if (!status) {
        ports.captureLog()("No active sync session for this project.");
        return;
    }

    ports.captureLog()(`Terminating sync session '${sessionName}'...`);
    ports.terminateSync(sessionName);
    ports.captureLog()("Sync terminated.");
}
    return { checkTailscale, checkMutagen, isHostReachable, getMutagenSyncStatus, remoteExec, remoteSetup, remoteCheck, remoteTerminate };
}

const REMOTE_SERVICE_PORT_NAMES = ["resolveProjectPath", "getProjectId", "getProjectHash", "getMutagenSessionName", "getContainerName", "captureHashPath", "newReservationToken", "observeTool", "observeHostReachability", "observeSync", "startSyncDaemon", "terminateSync", "resumeSync", "createSync", "pauseSync", "readCommonIgnoreDirs", "readSettings", "captureLegacyConfigReader", "updateSettings", "readUser", "prompt", "captureLog", "captureError", "captureProgress", "observeRemoteImage", "buildContainerStartShell", "buildReservationShell", "buildRefreshShell", "buildReleaseShell", "buildStopShell", "runReservation", "prepareRemoteProject", "runRefresh", "runRelease", "runStop", "createSessionLock", "removeSessionLock", "withLifecycleLock", "withLifecycleLockAsync", "startHeartbeat", "onceSignal", "removeSignalListener", "resignalSelf", "exit", "collectCurrentForwardedEnv", "readContainerEnvKey", "readContainerEnvValue", "encodeProgram", "startInteractiveSsh", "now", "sleep"] as const;
