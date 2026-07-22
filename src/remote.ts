// src/remote.ts - ccc remote functionality for Tailscale + Mutagen sync

import {spawn, spawnSync} from "child_process";
import {randomBytes} from "crypto";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "fs";
import {join, resolve} from "path";
import {hashPath, getProjectId, getClaudeDir, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE, prompt, REMOTE_CONFIG_DIR, IMAGE_NAME, CONTAINER_PID_LIMIT, COMMON_IGNORE_DIRS, MISE_VOLUME_NAME, collectForwardedEnv, isValidEnvKey} from "./utils.js";
import {getContainerName} from "./docker.js";
import {createSessionLock, removeSessionLock, withContainerLifecycleLock, withContainerLifecycleLockAsync} from "./session.js";

// === Types ===

interface RemoteConfig {
    host: string;
    user: string;
    remotePath: string;
}

// === Tool Detection ===

function checkTool(cmd: string, args: string[]): {installed: boolean; version?: string} {
    const result = spawnSync(cmd, args, {encoding: "utf-8"});
    if (result.error || result.status !== 0) {
        return {installed: false};
    }
    const version = (result.stdout ?? "").split("\n")[0].trim();
    return {installed: true, version};
}

export const checkTailscale = () => checkTool("tailscale", ["version"]);
export const checkMutagen = () => checkTool("mutagen", ["version"]);

// === Connectivity ===

export function isHostReachable(host: string): boolean {
    const result = spawnSync("ping", ["-c", "1", "-W", "1", host], {encoding: "utf-8"});
    return result.status === 0;
}

export function getMutagenSyncStatus(sessionName: string): string | null {
    const result = spawnSync("mutagen", ["sync", "list", sessionName], {encoding: "utf-8"});
    if (result.error || result.status !== 0) {
        return null;
    }
    const output = result.stdout ?? "";
    const statusMatch = output.match(/Status:\s*(.+)/);
    return statusMatch ? statusMatch[1].trim() : "Unknown";
}

// === Shell Safety Helpers ===

/**
 * Validate that a hostname/user string contains only safe characters.
 * Prevents shell injection via crafted hostnames or usernames.
 */
export function isValidHostOrUser(value: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(value) && value.length > 0 && value.length <= 253;
}

export { isValidEnvKey };

/**
 * Escape a single argument for safe interpolation inside a shell command.
 * Wraps the value in single quotes and escapes any embedded single quotes.
 */
export function shellEscapeArg(arg: string): string {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// === Helpers ===

export function getProjectHash(projectPath: string): string {
    return hashPath(resolve(projectPath));
}

export function getMutagenSessionName(projectPath: string): string {
    return `ccc-${getProjectId(projectPath)}`;
}

// === Remote Container Functions ===

function remoteLifecycleShell(containerName: string, body: string): string {
    const key = hashPath(containerName);
    const token = randomBytes(16).toString("hex");
    return [
        "set -eu",
        `_ccc_lock=/tmp/ccc-remote-lifecycle-${key}.lock`,
        `_ccc_token=${token}`,
        "_ccc_attempt=0",
        "until mkdir \"$_ccc_lock\" 2>/dev/null; do _ccc_attempt=$((_ccc_attempt + 1)); [ \"$_ccc_attempt\" -lt 300 ] || exit 73; if read -r _ccc_owner_pid _ccc_owner_token < \"$_ccc_lock/owner\" 2>/dev/null; then _ccc_owner_command=$(ps -p \"$_ccc_owner_pid\" -o command= 2>/dev/null || true); case \"$_ccc_owner_command\" in *\"$_ccc_owner_token\"*) ;; *) rm -f \"$_ccc_lock/owner\" 2>/dev/null || true; rmdir \"$_ccc_lock\" 2>/dev/null || true ;; esac; else rmdir \"$_ccc_lock\" 2>/dev/null || true; fi; sleep 0.1; done",
        "printf '%s %s\\n' \"$$\" \"$_ccc_token\" > \"$_ccc_lock/owner\"",
        "_ccc_unlock() { if read -r _ccc_owner_pid _ccc_owner_token < \"$_ccc_lock/owner\" 2>/dev/null && [ \"$_ccc_owner_pid\" = \"$$\" ] && [ \"$_ccc_owner_token\" = \"$_ccc_token\" ]; then rm -f \"$_ccc_lock/owner\"; rmdir \"$_ccc_lock\" 2>/dev/null || true; fi; }",
        "trap _ccc_unlock EXIT HUP INT TERM",
        body,
    ].join("; ");
}

function remoteSessionReservationShell(containerName: string, token: string, expiresAt: number, command: string): string {
    const key = hashPath(containerName);
    return remoteLifecycleShell(containerName, [
        `_ccc_sessions=/tmp/ccc-remote-sessions-${key}`,
        "mkdir -p \"$_ccc_sessions\"",
        "chmod 700 \"$_ccc_sessions\"",
        `_ccc_marker=$_ccc_sessions/${token}`,
        `printf '%s\\n' "${expiresAt}" > "$_ccc_marker"`,
        command,
    ].join("; "));
}

function remoteRefreshSessionShell(containerName: string, token: string, expiresAt: number): string {
    const key = hashPath(containerName);
    return remoteLifecycleShell(containerName, [
        `_ccc_marker=/tmp/ccc-remote-sessions-${key}/${token}`,
        `[ -f "$_ccc_marker" ] || exit 44`,
        `printf '%s\\n' "${expiresAt}" > "$_ccc_marker"`,
    ].join("; "));
}

function remoteReleaseSessionShell(containerName: string, token: string): string {
    const key = hashPath(containerName);
    return remoteLifecycleShell(containerName, `rm -f /tmp/ccc-remote-sessions-${key}/${token}`);
}

function remoteStopShell(containerName: string, ownToken: string): string {
    const key = hashPath(containerName);
    return remoteLifecycleShell(containerName, [
        `_ccc_sessions=/tmp/ccc-remote-sessions-${key}`,
        `rm -f "$_ccc_sessions/${ownToken}"`,
        "_ccc_now=$(date +%s)",
        "_ccc_active=0",
        "if [ -d \"$_ccc_sessions\" ]; then for _ccc_marker in \"$_ccc_sessions\"/*; do [ -f \"$_ccc_marker\" ] || continue; _ccc_expiry=$(cat \"$_ccc_marker\" 2>/dev/null || true); case \"$_ccc_expiry\" in ''|*[!0-9]*) rm -f \"$_ccc_marker\" ;; *) if [ \"$_ccc_expiry\" -ge \"$_ccc_now\" ]; then _ccc_active=1; else rm -f \"$_ccc_marker\"; fi ;; esac; done; fi",
        "if [ \"$_ccc_active\" -ne 0 ]; then echo ccc-remote-sessions-active; exit 42; fi",
        `docker stop ${containerName}`,
    ].join("; "));
}

/**
 * Ensure remote ccc image exists, build if needed
 */
async function ensureRemoteImage(config: RemoteConfig): Promise<void> {
    // Check if image exists on remote
    const checkCmd = `docker images -q ${IMAGE_NAME}`;
    const result = spawnSync("ssh", [
        `${config.user}@${config.host}`,
        checkCmd
    ], {encoding: "utf-8", timeout: 10000});

    if (!result.stdout?.trim()) {
        console.log("Building ccc image on remote host...");
        // Need to sync Dockerfile and build on remote, or pull from registry
        // For now, assume ccc is installed on remote and image exists
        throw new Error("ccc image not found on remote. Run 'ccc' on the remote host first to build the image.");
    }
}

/**
 * Start container on remote host without project volume mount.
 * Returns container name.
 */
async function startRemoteContainer(config: RemoteConfig, projectPath: string, reservationToken: string, reservationExpiresAt: number, profile?: string): Promise<string> {
    const projectId = getProjectId(projectPath);
    const containerName = getContainerName(projectPath, profile);
    const claudeDir = getClaudeDir(profile);

    // Build docker run command (no project volume, just credentials and mise cache)
    const dockerCmd = `docker run -d --name ${containerName} \
        --network host \
        -v ${claudeDir}:/home/ccc/.claude \
        -v ${MISE_VOLUME_NAME}:/home/ccc/.local/share/mise \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -w /project/${projectId} \
        --pids-limit ${CONTAINER_PID_LIMIT} \
        ${IMAGE_NAME} sleep infinity 2>/dev/null || docker start ${containerName}`;

    const result = spawnSync("ssh", [
        `${config.user}@${config.host}`,
        remoteSessionReservationShell(containerName, reservationToken, reservationExpiresAt, dockerCmd),
    ], {encoding: "utf-8", timeout: 60000});

    if (result.status !== 0) {
        throw new Error(`Failed to start remote container: ${result.stderr}`);
    }

    return containerName;
}

/**
 * Create directory in container for project
 */
async function createContainerProjectDir(config: RemoteConfig, containerName: string, projectId: string): Promise<void> {
    const cmd = `docker exec ${containerName} mkdir -p /project/${projectId}`;
    spawnSync("ssh", [
        `${config.user}@${config.host}`,
        cmd
    ], {encoding: "utf-8"});
}

function printSection(title: string): void {
    console.log(`\n=== ${title} ===\n`);
}

function printStatus(label: string, ok: boolean, detail?: string): void {
    const icon = ok ? "[OK]" : "[--]";
    const detailStr = detail ? ` (${detail})` : "";
    console.log(`  ${icon} ${label}${detailStr}`);
}

// === Config Storage ===

function getConfigPath(projectPath: string): string {
    const hash = getProjectHash(projectPath);
    return join(REMOTE_CONFIG_DIR, `${hash}.json`);
}

function loadRemoteConfig(projectPath: string): RemoteConfig | null {
    const configPath = getConfigPath(projectPath);
    if (!existsSync(configPath)) {
        return null;
    }
    try {
        const content = readFileSync(configPath, "utf-8");
        return JSON.parse(content) as RemoteConfig;
    } catch {
        return null;
    }
}

function saveRemoteConfig(projectPath: string, config: RemoteConfig): void {
    mkdirSync(REMOTE_CONFIG_DIR, {recursive: true});
    const configPath = getConfigPath(projectPath);
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// === Sync Functions ===

/**
 * Ensure mutagen sync is running for the project.
 * Creates sync if not exists, resumes if paused.
 * Syncs directly to the remote container via SSH.
 * Returns the session name.
 */
async function ensureSync(projectPath: string, config: RemoteConfig, containerName: string): Promise<string> {
    const fullPath = resolve(projectPath);
    const sessionName = getMutagenSessionName(fullPath);
    const projectId = getProjectId(fullPath);

    // Ensure mutagen daemon is running
    spawnSync("mutagen", ["daemon", "start"], {stdio: "ignore"});

    // Check if session already exists
    const existingStatus = getMutagenSyncStatus(sessionName);

    if (existingStatus) {
        // Resume if paused
        if (existingStatus.toLowerCase().includes("paused")) {
            console.log("Resuming paused sync...");
            spawnSync("mutagen", ["sync", "resume", sessionName], {stdio: "inherit"});
        } else {
            console.log(`Sync already running (${existingStatus})`);
        }
        return sessionName;
    }

    // Create new sync session - sync to container via SSH
    console.log("Creating sync session...");
    console.log(`  Local:  ${fullPath}`);
    console.log(`  Remote: docker://${containerName}/project/${projectId} (via ${config.host})`);

    // Mutagen sync to remote docker container
    // Format: user@host:docker://container/path
    const mutagenArgs = [
        "sync", "create",
        fullPath,
        `${config.user}@${config.host}:docker://${containerName}/project/${projectId}`,
        "--name", sessionName,
        "--ignore-vcs",
        ...COMMON_IGNORE_DIRS.map(dir => `--ignore=${dir}`)
    ];
    const createResult = spawnSync("mutagen", mutagenArgs, {stdio: "inherit"});

    if (createResult.status !== 0) {
        throw new Error("Failed to create sync session");
    }

    return sessionName;
}

/**
 * Wait for sync to reach "Watching for changes" state.
 */
async function waitForSync(sessionName: string, timeoutMs: number = 120000): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 1000;

    process.stdout.write("Waiting for initial sync...");

    while (Date.now() - startTime < timeoutMs) {
        const status = getMutagenSyncStatus(sessionName);

        if (status === null) {
            throw new Error("Sync session not found");
        }

        if (status.toLowerCase().includes("watching")) {
            console.log(" done");
            return;
        }

        if (status.toLowerCase().includes("error") || status.toLowerCase().includes("halted")) {
            console.log(` failed: ${status}`);
            throw new Error(`Sync failed: ${status}`);
        }

        process.stdout.write(".");
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    console.log(" timeout");
    throw new Error("Sync timeout - initial sync did not complete");
}

// === Main Remote Execution ===

/**
 * Main function to run ccc on a remote host.
 * New architecture: syncs directly to container via Mutagen.
 * 1. Ensure ccc image exists on remote
 * 2. Start container on remote (without project volume mount)
 * 3. Ensure mutagen sync to container is running
 * 4. Wait for initial sync
 * 5. Run claude via docker exec
 * 6. Cleanup prompt on exit
 */
export async function remoteExec(projectPath: string, host?: string, args: string[] = []): Promise<void> {
    const fullPath = resolve(projectPath);
    const projectId = getProjectId(fullPath);

    // Check required tools
    const mutagen = checkMutagen();
    if (!mutagen.installed) {
        console.error("Mutagen is not installed. Run 'ccc remote setup' for installation guide.");
        process.exit(1);
    }

    // Load or create config
    let config = loadRemoteConfig(fullPath);

    if (config && !host) {
        // Validate loaded config values (defense against tampered config files)
        if (!isValidHostOrUser(config.host) || !isValidHostOrUser(config.user)) {
            console.error("Saved remote config contains invalid host or user. Please reconfigure with 'ccc remote <host>'.");
            process.exit(1);
        }
        // Use saved config
        console.log(`Using saved config: ${config.user}@${config.host}`);
    } else if (host) {
        // Create/update config with provided host
        if (!isValidHostOrUser(host)) {
            console.error(`Invalid hostname: ${host}. Only alphanumeric, dots, hyphens, and underscores allowed.`);
            process.exit(1);
        }

        if (!isHostReachable(host)) {
            console.error(`Host ${host} is not reachable. Check if it's online and accessible.`);
            process.exit(1);
        }

        const defaultUser = process.env.USER || "user";
        const userInput = await prompt(`Remote user [${defaultUser}]: `);
        const user = userInput || defaultUser;

        if (!isValidHostOrUser(user)) {
            console.error(`Invalid username: ${user}. Only alphanumeric, dots, hyphens, and underscores allowed.`);
            process.exit(1);
        }

        config = {host, user, remotePath: ""};  // remotePath not used anymore
        saveRemoteConfig(fullPath, config);
        console.log("Config saved.");
    } else {
        // No config and no host provided
        console.error("No saved remote config found.");
        console.error("Usage: ccc remote <host>");
        console.error("       ccc remote           (after initial setup)");
        process.exit(1);
    }

    if (!config) {
        throw new Error("Remote configuration could not be resolved");
    }
    const resolvedConfig = config;
    const remoteContainerPrefix = `remote--${hashPath(`${resolvedConfig.user}@${resolvedConfig.host}`)}--${projectId}`;
    const expectedContainerName = getContainerName(fullPath);
    const remoteReservationToken = randomBytes(16).toString("hex");
    const reservationExpiry = () => Math.floor(Date.now() / 1000) + 300;
    let remoteReservationActive = false;
    let remoteReservationHeartbeat: NodeJS.Timeout | null = null;
    const releaseRemoteReservation = () => {
        if (!remoteReservationActive) return;
        remoteReservationActive = false;
        if (remoteReservationHeartbeat) clearInterval(remoteReservationHeartbeat);
        remoteReservationHeartbeat = null;
        spawnSync("ssh", [
            `${resolvedConfig.user}@${resolvedConfig.host}`,
            remoteReleaseSessionShell(expectedContainerName, remoteReservationToken),
        ], { encoding: "utf-8", timeout: 10000 });
    };
    let remoteSessionLock = createSessionLock(remoteContainerPrefix);
    let requestedExitCode = 0;
    const cleanupRemoteSession = () => {
        releaseRemoteReservation();
        if (!remoteSessionLock) return;
        removeSessionLock(remoteSessionLock);
        remoteSessionLock = "";
    };
    const forwardSignalAfterCleanup = (signal: NodeJS.Signals) => {
        cleanupRemoteSession();
        process.removeListener("SIGINT", handleSigint);
        process.removeListener("SIGTERM", handleSigterm);
        process.kill(process.pid, signal);
    };
    const handleSigint = () => forwardSignalAfterCleanup("SIGINT");
    const handleSigterm = () => forwardSignalAfterCleanup("SIGTERM");
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);

    try {
        // 1. Ensure ccc image exists on remote
        await ensureRemoteImage(resolvedConfig);

        // 2. Start container on remote (without project volume mount)
        console.log("Starting remote container...");
        remoteReservationActive = true;
        const containerName = await withContainerLifecycleLockAsync(
            remoteContainerPrefix,
            () => startRemoteContainer(resolvedConfig, fullPath, remoteReservationToken, reservationExpiry()),
        );
        remoteReservationHeartbeat = setInterval(() => {
            if (!remoteReservationActive) return;
            const refreshed = spawnSync("ssh", [
                `${resolvedConfig.user}@${resolvedConfig.host}`,
                remoteRefreshSessionShell(containerName, remoteReservationToken, reservationExpiry()),
            ], { encoding: "utf-8", timeout: 10000 });
            if (refreshed.status !== 0) console.error("Remote session lease refresh failed; container stop protection may expire.");
        }, 30_000);
        remoteReservationHeartbeat.unref();

        // 3. Create project directory in container
        await createContainerProjectDir(resolvedConfig, containerName, projectId);

        // 4. Ensure mutagen sync to container is running
        const sessionName = await ensureSync(fullPath, resolvedConfig, containerName);

        // 5. Wait for initial sync
        await waitForSync(sessionName);

        // 6. Run claude via docker exec
        console.log(`Connecting to ${resolvedConfig.host}...`);

        const claudeArgs = args.length > 0 ? args.map(shellEscapeArg).join(" ") : "--dangerously-skip-permissions";

        // Collect environment variables to forward without blowing up the remote docker exec environment.
        const envFlags: string[] = [];
        // Container marker: enables per-project env separation via mise.toml [env] conditionals
        envFlags.push(`-e ${shellEscapeArg(`${CONTAINER_ENV_KEY}=${CONTAINER_ENV_VALUE}`)}`);
        const forwardedEnvPlan = collectForwardedEnv(process.env);
        for (const [key, value] of forwardedEnvPlan.forwarded) {
            envFlags.push(`-e ${shellEscapeArg(`${key}=${value}`)}`);
        }
        if (forwardedEnvPlan.skippedDueToLimit.length > 0) {
            console.error(
                `Skipped ${forwardedEnvPlan.skippedDueToLimit.length} host env var(s) to keep remote exec size bounded; use --env KEY=VALUE for required overrides.`,
            );
        }
        const envString = envFlags.join(" ");

        const containerProgram = `cd ${shellEscapeArg(`/project/${projectId}`)} && mise trust . 2>/dev/null; mise install -y || true; exec claude ${claudeArgs}`;
        const encodedProgram = Buffer.from(containerProgram, "utf8").toString("base64");
        const decoder = `printf %s ${shellEscapeArg(encodedProgram)} | base64 -d | sh`;
        const execCmd = `docker exec ${envString} -it ${containerName} sh -c ${shellEscapeArg(decoder)}`;

        const sshProcess = spawn("ssh", ["-t", `${resolvedConfig.user}@${resolvedConfig.host}`, execCmd], {
            stdio: "inherit"
        });

        // Wait for SSH to exit
        const exitCode = await new Promise<number>((resolve) => {
            sshProcess.on("close", (code) => {
                resolve(code ?? 0);
            });
            sshProcess.on("error", (err) => {
                console.error(`SSH error: ${err.message}`);
                resolve(1);
            });
        });

        // 7. Cleanup prompt on exit
        if (exitCode === 0) {
            const answer = await prompt("\nStop container and pause sync? [y/N]: ", true);
            if (answer === "y" || answer === "yes") {
                withContainerLifecycleLock(remoteContainerPrefix, () => {
                    removeSessionLock(remoteSessionLock);
                    console.log("Stopping container...");
                    const stopped = spawnSync(
                        "ssh",
                        [`${resolvedConfig.user}@${resolvedConfig.host}`, remoteStopShell(containerName, remoteReservationToken)],
                        { encoding: "utf-8" },
                    );
                    if (stopped.status === 42 || stopped.stdout?.includes("ccc-remote-sessions-active")) {
                        remoteReservationActive = false;
                        if (remoteReservationHeartbeat) clearInterval(remoteReservationHeartbeat);
                        remoteReservationHeartbeat = null;
                        console.log("Remote container remains running: another CCC remote session is active.");
                        return;
                    }
                    if (stopped.status !== 0) throw new Error(`Failed to stop remote container: ${stopped.stderr || stopped.status}`);
                    remoteReservationActive = false;
                    if (remoteReservationHeartbeat) clearInterval(remoteReservationHeartbeat);
                    remoteReservationHeartbeat = null;
                    console.log("Pausing sync...");
                    spawnSync("mutagen", ["sync", "pause", sessionName], {stdio: "inherit"});
                });
                remoteSessionLock = "";
            }
        }

        requestedExitCode = exitCode;
    } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        requestedExitCode = 1;
    } finally {
        process.removeListener("SIGINT", handleSigint);
        process.removeListener("SIGTERM", handleSigterm);
        cleanupRemoteSession();
    }
    process.exit(requestedExitCode);
}

// === Setup and Check Commands ===

/**
 * Interactive setup guide for remote development
 */
export async function remoteSetup(): Promise<void> {
    printSection("CCC Remote Setup Guide");

    // Check tools
    console.log("Checking required tools:\n");

    const tailscale = checkTailscale();
    const mutagen = checkMutagen();

    printStatus("Tailscale", tailscale.installed, tailscale.version);
    printStatus("Mutagen", mutagen.installed, mutagen.version);

    if (!tailscale.installed) {
        console.log(`
  Tailscale not found. Install it:
    macOS:   brew install tailscale
    Linux:   curl -fsSL https://tailscale.com/install.sh | sh
    Manual:  https://tailscale.com/download`);
    }

    if (!mutagen.installed) {
        console.log(`
  Mutagen not found. Install it:
    macOS:   brew install mutagen-io/mutagen/mutagen
    Linux:   Download from https://github.com/mutagen-io/mutagen/releases
    Manual:  https://mutagen.io/documentation/introduction/installation`);
    }

    if (!tailscale.installed || !mutagen.installed) {
        console.log("\nPlease install missing tools and run 'ccc remote setup' again.");
        return;
    }

    printSection("Usage");

    console.log(`First time setup:
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

    console.log(`Files sync directly from your Mac to a Docker container on the remote:
  1. Container started on remote (without project volume mount)
  2. Mutagen syncs: MacBook -> Docker container on remote
  3. Claude runs inside the container via docker exec

This avoids intermediate filesystem copies on the remote host.`);

    printSection("Requirements");

    console.log(`1. SSH access to remote host (key-based auth recommended)
2. ccc installed on remote host (run 'ccc' once to build the image)
3. Docker running on remote host
4. Network connectivity (Tailscale recommended for remote access)

Config is stored per-project in ~/.ccc/remote/<project-hash>.json`);
}

/**
 * Display connectivity and sync status
 */
export async function remoteCheck(projectPath: string): Promise<void> {
    printSection("CCC Remote Status");

    // Tools
    console.log("Tools:");
    const tailscale = checkTailscale();
    const mutagen = checkMutagen();
    printStatus("Tailscale", tailscale.installed, tailscale.version);
    printStatus("Mutagen", mutagen.installed, mutagen.version);

    // Config
    console.log("\nConfig:");
    const config = loadRemoteConfig(projectPath);
    if (config) {
        console.log(`  Host: ${config.host}`);
        console.log(`  User: ${config.user}`);
        console.log(`  Container: ${getContainerName(projectPath)}`);

        // Check host reachability
        const reachable = isHostReachable(config.host);
        printStatus("Host reachable", reachable);
    } else {
        console.log("  No config saved for this project.");
        console.log("  Run 'ccc remote <host>' to set up.");
    }

    // Mutagen sync status
    console.log("\nSync:");
    if (mutagen.installed) {
        const sessionName = getMutagenSessionName(projectPath);
        const syncStatus = getMutagenSyncStatus(sessionName);

        if (syncStatus) {
            printStatus(`Session '${sessionName}'`, true, syncStatus);
        } else {
            console.log(`  No active sync session.`);
            console.log(`  Session name would be: ${sessionName}`);
        }
    } else {
        console.log("  (mutagen not installed)");
    }

    console.log("");
}

/**
 * Terminate sync session for project
 */
export async function remoteTerminate(projectPath: string): Promise<void> {
    const sessionName = getMutagenSessionName(projectPath);
    const status = getMutagenSyncStatus(sessionName);

    if (!status) {
        console.log("No active sync session for this project.");
        return;
    }

    console.log(`Terminating sync session '${sessionName}'...`);
    spawnSync("mutagen", ["sync", "terminate", sessionName], {stdio: "inherit"});
    console.log("Sync terminated.");
}
